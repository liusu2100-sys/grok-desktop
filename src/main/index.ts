import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  defaultSettings,
  type AgentInfo,
  type ChatBlock,
  type DesktopSettings,
  type DesktopState,
  type FileDiff,
  type ModelInfo,
  type PermissionRequest,
  type PlanEntry,
  type Project,
  type SessionMode,
  type PromptImage,
  type SlashCommand,
  type Thread,
  type ToolCallState,
  type TurnUsage,
} from "../shared/types";
import { AcpClient } from "./acp";
import { authStatus, getStoredApiKey, runGrok, saveApiKey, upsertCustomModel } from "./auth";
import { gitDiff, gitDiscard, gitSnapshot, gitStage, resolveInside } from "./git";
import { assembleModels, listModelsFromCli, parseModelsListResponse } from "./models";
import {
  agentVersionFromInitialize,
  commandsFromInitialize,
  modelStateFromInitialize,
  parseCommands,
  parseListedSessions,
  parseUsage,
  readSessionConfig,
  responseMeta,
} from "./protocol";
import { hiddenFromTranscript, hiddenPromptOrigin, parseTurnUsage, readUserContent } from "./replay";
import { listDiskSessions, loadSessionSnapshot, normalizePath, searchSessionIds } from "./sessions";
import { loadState, saveState } from "./store";

const acp = new AcpClient();
let state: DesktopState = {
  projects: [],
  threads: [],
  activeProjectId: null,
  activeThreadId: null,
  settings: defaultSettings(),
};
const transcripts = new Map<string, ChatBlock[]>();
const sessionToThread = new Map<string, string>();
const pendingPermissions = new Map<string | number, PermissionRequest>();
const liveSessions = new Set<string>();
const loadingSessions = new Set<string>();
const sessionCommands = new Map<string, SlashCommand[]>();
let bootCommands: SlashCommand[] = [];
let agentInfo: AgentInfo | null = null;
let mainWindow: BrowserWindow | null = null;
let cachedModels: ModelInfo[] = [];

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function persist(): void {
  saveState(state);
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveAgentPath(override?: string): { path: string; source: AgentInfo["source"] } {
  const candidates: Array<{ path: string; source: AgentInfo["source"] }> = [];
  if (override?.trim()) candidates.push({ path: override.trim(), source: "settings" });
  if (state.settings.agentPath.trim()) {
    candidates.push({ path: state.settings.agentPath.trim(), source: "settings" });
  }
  if (process.env.GROK_DESKTOP_AGENT_PATH) {
    candidates.push({ path: process.env.GROK_DESKTOP_AGENT_PATH, source: "env" });
  }
  candidates.push({ path: "grok", source: "path" });
  candidates.push({
    path: join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    source: "home",
  });
  const workspace = process.env.GROK_DESKTOP_WORKSPACE || app.getAppPath();
  candidates.push({
    path: join(
      workspace,
      "target",
      "release",
      process.platform === "win32" ? "xai-grok-pager.exe" : "xai-grok-pager",
    ),
    source: "workspace",
  });
  for (const item of candidates) {
    if (item.source === "path") continue;
    if (existsSync(item.path)) return item;
  }
  return { path: "grok", source: "path" };
}

function threadBySession(sessionId: string): Thread | undefined {
  const threadId = sessionToThread.get(sessionId);
  return state.threads.find((t) => t.id === threadId || t.sessionId === sessionId);
}

function pushBlock(threadId: string, block: ChatBlock): ChatBlock {
  const list = transcripts.get(threadId) ?? [];
  list.push(block);
  transcripts.set(threadId, list);
  send("desktop:transcript", { threadId, blocks: list });
  return block;
}

function patchThread(threadId: string, patch: Partial<Thread>): void {
  state.threads = state.threads.map((t) => (t.id === threadId ? { ...t, ...patch, updatedAt: Date.now() } : t));
  persist();
  send("desktop:state", publicState());
}

function sameUserText(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function appendText(threadId: string, kind: ChatBlock["kind"], chunk: string): void {
  if (!chunk) return;
  const list = transcripts.get(threadId) ?? [];
  const last = list[list.length - 1];
  if (kind === "user" && last?.kind === "user" && sameUserText(last.text, chunk)) {
    if (chunk.trim().length > last.text.trim().length) {
      last.text = chunk;
      transcripts.set(threadId, list);
      send("desktop:transcript", { threadId, blocks: list });
    }
    return;
  }
  if (last && last.kind === kind && last.streaming) {
    last.text += chunk;
    transcripts.set(threadId, list);
    send("desktop:transcript", { threadId, blocks: list });
    return;
  }
  pushBlock(threadId, {
    id: uid(),
    kind,
    text: chunk,
    createdAt: Date.now(),
    streaming: kind !== "user",
  });
}

function endStreams(threadId: string): void {
  const list = transcripts.get(threadId) ?? [];
  for (const block of list) block.streaming = false;
  transcripts.set(threadId, list);
  send("desktop:transcript", { threadId, blocks: list });
}

function applyToolUpdate(threadId: string, update: Record<string, unknown>): void {
  const toolCallId = String(update.toolCallId ?? "");
  if (!toolCallId) return;
  const list = transcripts.get(threadId) ?? [];
  let block = list.find((b) => b.tool?.toolCallId === toolCallId);
  const incoming = toolFromUpdate(update);
  if (!block) {
    block = {
      id: uid(),
      kind: "tool",
      text: incoming.title,
      createdAt: Date.now(),
      tool: incoming,
    };
    list.push(block);
  } else if (block.tool) {
    block.tool = {
      ...block.tool,
      ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined)),
      diffs: incoming.diffs ?? block.tool.diffs,
      locations: incoming.locations ?? block.tool.locations,
    };
    block.text = block.tool.title;
  }
  transcripts.set(threadId, list);
  send("desktop:transcript", { threadId, blocks: list });
  send("desktop:diffs", { threadId, diffs: collectDiffs(threadId) });
}

function collectDiffs(threadId: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const block of transcripts.get(threadId) ?? []) {
    if (block.tool?.diffs) out.push(...block.tool.diffs);
  }
  return out;
}

function toolFromUpdate(update: Record<string, unknown>): ToolCallState {
  const content = update.content as Array<Record<string, unknown>> | undefined;
  const diffs: FileDiff[] = [];
  let preview = "";
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "diff") {
        diffs.push({
          path: String(item.path ?? ""),
          oldText: (item.oldText as string | null) ?? null,
          newText: String(item.newText ?? ""),
        });
      } else if (item.type === "content" || item.type === "text") {
        const inner = item.content as { text?: string } | string | undefined;
        if (typeof inner === "string") preview += inner;
        else if (inner?.text) preview += inner.text;
        else if (typeof item.text === "string") preview += item.text;
      }
    }
  }
  return {
    toolCallId: String(update.toolCallId ?? ""),
    title: String(update.title ?? "工具"),
    kind: update.kind ? String(update.kind) : undefined,
    status: update.status ? String(update.status) : undefined,
    locations: update.locations as ToolCallState["locations"],
    rawInput: update.rawInput,
    contentPreview: preview ? preview.slice(0, 4000) : undefined,
    diffs: diffs.length ? diffs : undefined,
  };
}

function publicState(): DesktopState {
  return structuredClone(state);
}

let agentBoot: Promise<AgentInfo> | null = null;

async function ensureAgent(): Promise<AgentInfo> {
  if (acp.running && agentInfo) return agentInfo;
  if (!agentBoot) {
    agentBoot = bootAgent().finally(() => {
      agentBoot = null;
    });
  }
  return agentBoot;
}

async function bootAgent(): Promise<AgentInfo> {
  const resolved = resolveAgentPath();
  const args = ["agent", "--no-leader"];
  if (state.settings.alwaysApprove) args.push("--always-approve");
  if (state.settings.model.trim()) args.push("-m", state.settings.model.trim());
  if (state.settings.reasoningEffort.trim()) {
    args.push("--reasoning-effort", state.settings.reasoningEffort.trim());
  }
  args.push("stdio");
  const apiKey = getStoredApiKey();
  acp.start(resolved.path, args, apiKey ? { XAI_API_KEY: apiKey } : undefined);
  const init = await acp.initialize();
  const seeded = modelStateFromInitialize(init);
  if (seeded.length) {
    cachedModels = assembleModels(seeded, customModelInfo());
    adoptLiveModel(cachedModels);
    send("desktop:models", cachedModels);
  }
  bootCommands = commandsFromInitialize(init);
  publishBootCommands();
  if (init.authMethods?.some((m) => m.id === "xai.api_key") && getStoredApiKey()) {
    try {
      await acp.authenticateApiKey();
    } catch {
      /* login session may already be enough */
    }
  }
  agentInfo = {
    path: resolved.path,
    running: true,
    source: resolved.source,
    protocolVersion: init.protocolVersion,
    agentName: init.agentInfo?.title || init.agentInfo?.name,
    version: agentVersionFromInitialize(init) || init.agentInfo?.version,
    loadSession: Boolean(init.agentCapabilities?.loadSession),
    authRequired: Boolean(init.authMethods && init.authMethods.length > 0),
  };
  send("desktop:agent", agentInfo);
  liveSessions.clear();
  importAllHistory();
  send("desktop:state", publicState());
  const active = state.projects.find((p) => p.id === state.activeProjectId);
  if (active) void syncProjectSessions(active);
  return agentInfo;
}

function wireAcp(): void {
  acp.on("notification", (msg: { method: string; params?: unknown }) => {
    const method = wireMethod(msg.method);
    if (method === "session/update") {
      const params = msg.params as {
        sessionId?: string;
        update?: Record<string, unknown>;
        _meta?: { promptId?: string };
      };
      const sessionId = params.sessionId;
      const update = params.update;
      if (!sessionId || !update) return;
      if (loadingSessions.has(sessionId)) return;
      const thread = threadBySession(sessionId);
      if (!thread) return;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "agent_message_chunk") {
        appendText(thread.id, "agent", contentText(update.content));
      } else if (kind === "agent_thought_chunk") {
        appendText(thread.id, "thought", contentText(update.content));
      } else if (kind === "user_message_chunk") {
        applyLiveUserChunk(thread.id, update.content, String(params._meta?.promptId ?? ""));
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        applyToolUpdate(thread.id, update);
      } else if (kind === "plan") {
        const entries = (update.entries as PlanEntry[] | undefined) ?? [];
        const text = entries.map((e) => e.content).join("\n");
        const list = transcripts.get(thread.id) ?? [];
        let planIndex = -1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].kind === "user") break;
          if (list[i].kind === "plan") {
            planIndex = i;
            break;
          }
        }
        const current = planIndex >= 0 ? list[planIndex] : undefined;
        if (current) {
          current.text = text;
          current.plan = entries;
          transcripts.set(thread.id, list);
          send("desktop:transcript", { threadId: thread.id, blocks: list });
        } else {
          pushBlock(thread.id, {
            id: uid(),
            kind: "plan",
            text,
            createdAt: Date.now(),
            plan: entries,
          });
        }
      } else if (kind === "current_mode_update") {
        const modeId = String(update.currentModeId ?? update.modeId ?? update.mode ?? "");
        if (modeId === "default" || modeId === "plan" || modeId === "ask") {
          patchThread(thread.id, { mode: modeId });
        }
      } else if (kind === "usage_update") {
        const usage = parseUsage(update);
        if (usage) patchThread(thread.id, { usage });
      } else if (kind === "available_commands_update") {
        const commands = parseCommands(update);
        if (commands.length) publishCommands(thread.id, sessionId, commands);
      } else if (kind === "config_option_update") {
        const applied = readSessionConfig({ configOptions: update.configOptions });
        if (applied.model || applied.reasoningEffort) {
          patchThread(thread.id, {
            ...(applied.model ? { model: applied.model } : {}),
            ...(applied.reasoningEffort ? { reasoningEffort: applied.reasoningEffort } : {}),
          });
        }
      }
    } else if (method === "x.ai/session_notification") {
      const params = unwrapExtParams(msg.params);
      const sessionId = params.sessionId;
      const update = params.update;
      if (!sessionId || !update) return;
      const thread = threadBySession(sessionId);
      if (!thread) return;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "model_changed") {
        const model = update.model_id ? String(update.model_id) : undefined;
        const effort = update.reasoning_effort ? String(update.reasoning_effort) : undefined;
        if (model || effort) {
          patchThread(thread.id, {
            ...(model ? { model } : {}),
            ...(effort ? { reasoningEffort: effort } : {}),
          });
        }
      } else if (kind === "turn_completed") {
        pushTurnUsage(thread.id, parseTurnUsage(update.usage));
      }
    }
  });

  acp.on("request", (msg: { id: number | string; method: string; params?: unknown }) => {
    const method = wireMethod(msg.method);
    if (method === "session/request_permission") {
      const params = msg.params as {
        sessionId?: string;
        toolCall?: Record<string, unknown>;
        options?: Array<{ optionId: string; name: string; kind: string }>;
      };
      const sessionId = params.sessionId ?? "";
      const thread = threadBySession(sessionId);
      const tool = params.toolCall ? toolFromUpdate(params.toolCall) : undefined;
      const request: PermissionRequest = {
        requestId: msg.id,
        sessionId,
        threadId: thread?.id,
        title: tool?.title || "需要确认",
        summary: summarizeTool(tool),
        toolCall: tool,
        options: params.options ?? [],
      };
      pendingPermissions.set(msg.id, request);
      send("desktop:permission", request);
      return;
    }
    acp.respondError(msg.id, `Unsupported client method: ${method}`);
  });

  acp.on("stderr", (line: string) => send("desktop:log", line));
  acp.on("exit", () => {
    liveSessions.clear();
    agentInfo = agentInfo ? { ...agentInfo, running: false } : null;
    send("desktop:agent", agentInfo);
    for (const thread of state.threads) {
      if (thread.status === "running") patchThread(thread.id, { status: "idle" });
    }
  });
  acp.on("error", (err: Error) => send("desktop:error", err.message));
}

function sameTurnUsage(a: TurnUsage, b: TurnUsage): boolean {
  return a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.totalTokens === b.totalTokens;
}

/** One bill per send. The notification and the prompt response both carry it. */
function pushTurnUsage(threadId: string, turnUsage: TurnUsage | null): void {
  if (!turnUsage) return;
  const list = transcripts.get(threadId) ?? [];
  const last = list[list.length - 1];
  if (last?.kind === "usage" && last.turnUsage && sameTurnUsage(last.turnUsage, turnUsage)) return;
  pushBlock(threadId, {
    id: uid(),
    kind: "usage",
    text: "",
    createdAt: Date.now(),
    turnUsage,
  });
}

function applyLiveUserChunk(threadId: string, content: unknown, promptId: string): void {
  if (hiddenPromptOrigin(promptId)) return;
  const part = readUserContent(content);
  if (part.images.length && !part.text.trim()) {
    if (!attachUserImages(threadId, part.images)) {
      pushBlock(threadId, {
        id: uid(),
        kind: "user",
        text: "",
        createdAt: Date.now(),
        images: part.images,
      });
    }
    return;
  }
  if (!part.text || hiddenFromTranscript(part.text)) return;
  appendText(threadId, "user", part.text);
  if (part.images.length) attachUserImages(threadId, part.images);
}

function attachUserImages(threadId: string, images: PromptImage[]): boolean {
  const list = transcripts.get(threadId) ?? [];
  const last = list[list.length - 1];
  if (last?.kind !== "user") return false;
  const existing = last.images ?? [];
  const added = images.filter((image) => !existing.some((item) => item.data === image.data));
  if (!added.length) return true;
  last.images = [...existing, ...added];
  transcripts.set(threadId, list);
  send("desktop:transcript", { threadId, blocks: list });
  return true;
}

function contentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    const rec = content as { type?: string; text?: unknown };
    if (rec.type === "image") return "［图片］";
    if ("text" in rec) return String(rec.text ?? "");
  }
  return "";
}

function placeholderTitle(title: string): boolean {
  return (
    title === "New thread" ||
    title === "Untitled thread" ||
    title === "新对话" ||
    title === "未命名对话"
  );
}

function summarizeTool(tool?: ToolCallState): string {
  if (!tool) return "代理想要运行一个工具。";
  const input = tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : "";
  return [tool.title, tool.kind, input].filter(Boolean).join("\n");
}

function projectById(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id);
}

function ensureProject(path: string): Project {
  const existing = state.projects.find((p) => normalizePath(p.path) === normalizePath(path));
  if (existing) return existing;
  const project: Project = {
    id: uid(),
    name: basename(path) || path,
    path,
    createdAt: Date.now(),
  };
  state.projects = [...state.projects, project];
  return project;
}

function prepareOutputDir(dir: string): Project {
  const target = dir.trim();
  if (!target) throw new Error("请填写默认输出目录");
  try {
    mkdirSync(target, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`无法创建输出目录：${detail}`);
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error("默认输出目录必须是一个文件夹");
  }
  return ensureProject(target);
}

function adoptSavedOutputDir(): void {
  const dir = state.settings.outputDir.trim();
  if (!dir || !existsSync(dir)) return;
  try {
    if (!statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  const before = state.projects.length;
  const project = ensureProject(dir);
  let changed = state.projects.length !== before;
  if (!state.activeProjectId || !projectById(state.activeProjectId)) {
    state.activeProjectId = project.id;
    changed = true;
  }
  if (changed) persist();
}

function addProject(path: string): Project {
  const project = ensureProject(path);
  state.projects = [project, ...state.projects.filter((p) => p.id !== project.id)];
  state.activeProjectId = project.id;
  persist();
  importDiskSessions(project);
  if (acp.running) void syncProjectSessions(project);
  return project;
}

function adoptDiskTitle(current: string, diskTitle: string): string {
  if (!placeholderTitle(diskTitle)) return diskTitle;
  if (placeholderTitle(current)) return diskTitle;
  return current;
}

function importAllHistory(): void {
  const disks = listDiskSessions();
  const bySession = new Map(
    state.threads.filter((t) => t.sessionId).map((t) => [t.sessionId as string, t]),
  );
  let changed = false;
  for (const disk of disks) {
    const project = ensureProject(disk.cwd);
    const title = placeholderTitle(disk.title) ? "未命名对话" : disk.title;
    const existing = bySession.get(disk.id);
    if (existing) {
      if (existing.projectId !== project.id) {
        existing.projectId = project.id;
        changed = true;
      }
      const nextTitle = adoptDiskTitle(existing.title, title);
      if (nextTitle !== existing.title) {
        existing.title = nextTitle;
        changed = true;
      }
      if (disk.updatedAt > existing.updatedAt) {
        existing.updatedAt = disk.updatedAt;
        changed = true;
      }
      if (!existing.model && disk.model) {
        existing.model = disk.model;
        changed = true;
      }
      continue;
    }
    const thread: Thread = {
      id: uid(),
      projectId: project.id,
      sessionId: disk.id,
      title,
      status: "idle",
      createdAt: disk.createdAt || Date.now(),
      updatedAt: disk.updatedAt || Date.now(),
      model: disk.model,
    };
    state.threads.push(thread);
    sessionToThread.set(disk.id, thread.id);
    bySession.set(disk.id, thread);
    changed = true;
  }
  const present = new Set(disks.map((disk) => disk.id));
  const kept: Thread[] = [];
  for (const thread of state.threads) {
    const missing =
      Boolean(thread.sessionId) &&
      !present.has(thread.sessionId as string) &&
      !liveSessions.has(thread.sessionId as string) &&
      thread.status !== "running";
    if (!missing) {
      kept.push(thread);
      continue;
    }
    transcripts.delete(thread.id);
    sessionToThread.delete(thread.sessionId as string);
    if (state.activeThreadId === thread.id) state.activeThreadId = null;
    changed = true;
  }
  if (kept.length !== state.threads.length) state.threads = kept;
  if (changed) persist();
}

function importDiskSessions(project: Project): void {
  const existing = new Set(
    state.threads.filter((t) => t.projectId === project.id).map((t) => t.sessionId).filter(Boolean),
  );
  for (const disk of listDiskSessions(project.path)) {
    if (existing.has(disk.id)) continue;
    const thread: Thread = {
      id: uid(),
      projectId: project.id,
      sessionId: disk.id,
      title: disk.title,
      status: "idle",
      createdAt: disk.createdAt || Date.now(),
      updatedAt: disk.updatedAt || Date.now(),
      model: disk.model,
    };
    state.threads.push(thread);
    sessionToThread.set(disk.id, thread.id);
    rememberSnapshot(thread.id, disk.id, project.path);
  }
  persist();
}

async function createThread(projectId: string, title?: string): Promise<Thread> {
  const project = projectById(projectId);
  if (!project) throw new Error("找不到对应的项目目录");
  await ensureAgent();
  const meta: Record<string, unknown> = {};
  if (state.settings.alwaysApprove) meta.yoloMode = true;
  const modelId = selectedModelId();
  if (modelId) meta.modelId = modelId;
  const effort = state.settings.reasoningEffort.trim();
  if (effort) meta.reasoningEffort = effort;
  const created = await acp.newSession(project.path, meta);
  if (created.sessionId && state.settings.mode && state.settings.mode !== "default") {
    try {
      await acp.setMode(created.sessionId, state.settings.mode);
    } catch {
      /* mode applies on next prompt if set later */
    }
  }
  const thread: Thread = {
    id: uid(),
    projectId,
    sessionId: created.sessionId,
    title: title || "新对话",
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: modelId || undefined,
    reasoningEffort: effort || undefined,
    mode: state.settings.mode || "default",
  };
  state.threads = [thread, ...state.threads];
  state.activeThreadId = thread.id;
  sessionToThread.set(created.sessionId, thread.id);
  liveSessions.add(created.sessionId);
  transcripts.set(thread.id, []);
  applyLiveConfig(thread.id, created);
  persist();
  send("desktop:state", publicState());
  send("desktop:transcript", { threadId: thread.id, blocks: [] });
  void refreshCommands(created.sessionId, project.path);
  return thread;
}

function wireMethod(method: string): string {
  return method.startsWith("_") ? method.slice(1) : method;
}

function unwrapExtParams(params: unknown): { sessionId?: string; update?: Record<string, unknown> } {
  const rec = (params ?? {}) as {
    sessionId?: string;
    update?: Record<string, unknown>;
    params?: { sessionId?: string; update?: Record<string, unknown> };
  };
  if (rec.sessionId || rec.update) return rec;
  return rec.params ?? {};
}

function publishCommands(threadId: string, sessionId: string, commands: SlashCommand[]): void {
  sessionCommands.set(sessionId, commands);
  send("desktop:commands", { threadId, commands });
}

function publishBootCommands(): void {
  if (!bootCommands.length) return;
  const active = state.threads.find((t) => t.id === state.activeThreadId);
  if (active?.sessionId && sessionCommands.has(active.sessionId)) return;
  if (active?.sessionId) {
    publishCommands(active.id, active.sessionId, bootCommands);
    return;
  }
  send("desktop:commands", { threadId: active?.id ?? "", commands: bootCommands });
}

function adoptLiveModel(models: ModelInfo[]): void {
  const saved = state.settings.model.trim();
  if (!saved || saved === "desktop-custom") return;
  if (models.some((m) => m.id === saved)) return;
  const next = models.find((m) => m.isDefault)?.id ?? models[0]?.id;
  if (!next) return;
  state.settings.model = next;
  const info = models.find((m) => m.id === next);
  const effort = state.settings.reasoningEffort;
  if (info?.efforts?.length && !info.efforts.some((option) => option.value === effort)) {
    state.settings.reasoningEffort =
      info.efforts.find((option) => option.default)?.value || info.defaultEffort || effort;
  }
  persist();
  send("desktop:state", publicState());
}

function rememberSnapshot(threadId: string, sessionId: string, cwd: string): void {
  const snapshot = loadSessionSnapshot(sessionId, cwd);
  transcripts.set(threadId, snapshot.blocks);
  if (snapshot.commands.length) sessionCommands.set(sessionId, snapshot.commands);
  if (snapshot.usage) {
    state.threads = state.threads.map((t) =>
      t.id === threadId ? { ...t, usage: snapshot.usage } : t,
    );
  }
}

function customModelInfo() {
  if (!(state.settings.customBaseUrl.trim() && state.settings.customModelId.trim())) return undefined;
  return {
    id: "desktop-custom",
    name: "自定义接口",
    description: state.settings.customModelId,
    source: "custom" as const,
  };
}

function applyLiveConfig(threadId: string, raw: unknown): void {
  const applied = readSessionConfig(raw);
  if (!applied.model && !applied.reasoningEffort && !applied.mode) return;
  patchThread(threadId, {
    ...(applied.model ? { model: applied.model } : {}),
    ...(applied.reasoningEffort ? { reasoningEffort: applied.reasoningEffort } : {}),
    ...(applied.mode ? { mode: applied.mode } : {}),
  });
}

async function refreshCommands(sessionId: string, cwd: string): Promise<void> {
  const thread = threadBySession(sessionId);
  if (!thread) return;
  if (bootCommands.length && !sessionCommands.has(sessionId)) {
    publishCommands(thread.id, sessionId, bootCommands);
  }
  try {
    const commands = parseCommands(await acp.listCommands(sessionId, cwd));
    if (commands.length) publishCommands(thread.id, sessionId, commands);
  } catch {
    const cached = sessionCommands.get(sessionId) ?? bootCommands;
    if (cached.length) send("desktop:commands", { threadId: thread.id, commands: cached });
  }
}

async function syncProjectSessions(project: Project): Promise<void> {
  importDiskSessions(project);
  if (!acp.running) {
    send("desktop:state", publicState());
    return;
  }
  let listed: ReturnType<typeof parseListedSessions> = [];
  try {
    listed = parseListedSessions(await acp.listSessions(project.path), project.path);
  } catch {
    listed = [];
  }
  if (!listed.length) {
    try {
      listed = parseListedSessions(await acp.listSessionsExt(project.path), project.path);
    } catch {
      listed = [];
    }
  }
  const wanted = normalizePath(project.path);
  const existing = new Set(
    state.threads.filter((t) => t.projectId === project.id).map((t) => t.sessionId).filter(Boolean),
  );
  for (const disk of listed) {
    if (normalizePath(disk.cwd) !== wanted) continue;
    if (existing.has(disk.id)) {
      state.threads = state.threads.map((t) => {
        if (t.sessionId !== disk.id) return t;
        return {
          ...t,
          title: adoptDiskTitle(t.title, disk.title),
          model: t.model || disk.model,
          updatedAt: Math.max(t.updatedAt, disk.updatedAt || t.updatedAt),
        };
      });
      continue;
    }
    const thread: Thread = {
      id: uid(),
      projectId: project.id,
      sessionId: disk.id,
      title: disk.title,
      status: "idle",
      createdAt: disk.createdAt || Date.now(),
      updatedAt: disk.updatedAt || Date.now(),
      model: disk.model,
    };
    state.threads.push(thread);
    sessionToThread.set(disk.id, thread.id);
    rememberSnapshot(thread.id, disk.id, project.path);
  }
  persist();
  send("desktop:state", publicState());
}

function selectedModelId(): string {
  if (state.settings.model.trim()) return state.settings.model.trim();
  if (state.settings.customBaseUrl.trim() && state.settings.customModelId.trim()) {
    return "desktop-custom";
  }
  return "";
}

async function refreshModels(): Promise<ModelInfo[]> {
  const bin = resolveAgentPath().path;
  let models: ModelInfo[] = [];
  if (acp.running) {
    try {
      models = parseModelsListResponse(await acp.listModels());
    } catch {
      models = [];
    }
  }
  if (!models.length) {
    try {
      models = await listModelsFromCli(bin);
    } catch {
      models = [];
    }
  }
  models = assembleModels(models, customModelInfo());
  cachedModels = models;
  adoptLiveModel(models);
  send("desktop:models", models);
  return models;
}

async function applyModel(
  modelId: string,
  threadId?: string | null,
  reasoningEffort?: string,
): Promise<void> {
  state.settings.model = modelId;
  if (reasoningEffort) state.settings.reasoningEffort = reasoningEffort;
  persist();
  const effort = reasoningEffort ?? state.settings.reasoningEffort;
  const target = threadId
    ? state.threads.find((t) => t.id === threadId)
    : state.threads.find((t) => t.id === state.activeThreadId);
  if (target?.sessionId && acp.running) {
    try {
      const project = projectById(target.projectId);
      if (project && !liveSessions.has(target.sessionId)) {
        await attachSession(target, project);
      }
      try {
        await acp.setConfigOption(target.sessionId, "model", modelId);
      } catch {
        await acp.setModel(target.sessionId, modelId, effort || undefined);
      }
      if (effort) {
        try {
          await acp.setConfigOption(target.sessionId, "reasoning_effort", effort);
        } catch {
          /* set_model already carried the effort when the config method is absent */
        }
      }
      patchThread(target.id, { model: modelId, reasoningEffort: effort || undefined });
    } catch (err) {
      send("desktop:error", err instanceof Error ? err.message : String(err));
    }
  } else if (target) {
    patchThread(target.id, { model: modelId, reasoningEffort: effort || undefined });
  }
  send("desktop:state", publicState());
}

async function applyMode(modeId: SessionMode, threadId?: string | null): Promise<void> {
  state.settings.mode = modeId;
  persist();
  const target = threadId
    ? state.threads.find((t) => t.id === threadId)
    : state.threads.find((t) => t.id === state.activeThreadId);
  if (target?.sessionId && acp.running) {
    try {
      const project = projectById(target.projectId);
      if (project && !liveSessions.has(target.sessionId)) {
        await attachSession(target, project);
      }
      await acp.setMode(target.sessionId, modeId);
      patchThread(target.id, { mode: modeId });
    } catch (err) {
      send("desktop:error", err instanceof Error ? err.message : String(err));
    }
  } else if (target) {
    patchThread(target.id, { mode: modeId });
  }
  send("desktop:state", publicState());
}

async function deleteThread(threadId: string): Promise<void> {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return;
  if (thread.status === "running" && thread.sessionId) {
    acp.cancel(thread.sessionId);
  }
  const project = projectById(thread.projectId);
  if (thread.sessionId) {
    if (acp.running && project) {
      try {
        await acp.deleteSession(thread.sessionId, project.path);
      } catch {
        /* fall through to CLI */
      }
    }
    try {
      await runGrok(resolveAgentPath().path, ["sessions", "delete", thread.sessionId]);
    } catch {
      /* local-only thread */
    }
    sessionCommands.delete(thread.sessionId);
    sessionToThread.delete(thread.sessionId);
  }
  transcripts.delete(thread.id);
  state.threads = state.threads.filter((t) => t.id !== threadId);
  if (state.activeThreadId === threadId) {
    const next = state.threads.find((t) => t.projectId === thread.projectId);
    state.activeThreadId = next?.id ?? null;
  }
  persist();
  send("desktop:state", publicState());
}

const attaching = new Map<string, Promise<void>>();

function loadDiskTranscript(thread: Thread, project: Project): void {
  if (!thread.sessionId) return;
  if (thread.status !== "running" || !transcripts.has(thread.id)) {
    rememberSnapshot(thread.id, thread.sessionId, project.path);
  }
  send("desktop:transcript", { threadId: thread.id, blocks: transcripts.get(thread.id) ?? [] });
}

async function attachSession(thread: Thread, project: Project): Promise<void> {
  if (!thread.sessionId) return;
  const sessionId = thread.sessionId;
  if (liveSessions.has(sessionId)) {
    sessionToThread.set(sessionId, thread.id);
    return;
  }
  const pending = attaching.get(sessionId);
  if (pending) return pending;
  const job = attachSessionInner(thread, project, sessionId).finally(() => {
    attaching.delete(sessionId);
  });
  attaching.set(sessionId, job);
  return job;
}

async function attachSessionInner(thread: Thread, project: Project, sessionId: string): Promise<void> {
  const suppressReplay = (transcripts.get(thread.id)?.length ?? 0) > 0;
  if (suppressReplay) loadingSessions.add(sessionId);
  try {
    try {
      const resumed = await acp.resumeSession(sessionId, project.path);
      liveSessions.add(sessionId);
      sessionToThread.set(sessionId, thread.id);
      applyLiveConfig(thread.id, resumed);
      void refreshCommands(sessionId, project.path);
      return;
    } catch {
      /* resume is optional; load still attaches the same session */
    }
    const loaded = await acp.loadSession(sessionId, project.path);
    liveSessions.add(sessionId);
    sessionToThread.set(sessionId, thread.id);
    applyLiveConfig(thread.id, loaded);
    void refreshCommands(sessionId, project.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`无法继续这段对话：${message}`);
  } finally {
    loadingSessions.delete(sessionId);
  }
}

async function openSession(thread: Thread, project: Project): Promise<string> {
  await ensureAgent();
  if (thread.sessionId) {
    await attachSession(thread, project);
    const desired = thread.mode || state.settings.mode || "default";
    try {
      await acp.setMode(thread.sessionId, desired);
    } catch {
      /* keep going */
    }
    return thread.sessionId;
  }
  const meta: Record<string, unknown> = {};
  if (state.settings.alwaysApprove) meta.yoloMode = true;
  const modelId = selectedModelId();
  if (modelId) meta.modelId = modelId;
  if (state.settings.reasoningEffort.trim()) {
    meta.reasoningEffort = state.settings.reasoningEffort.trim();
  }
  const created = await acp.newSession(project.path, meta);
  thread.sessionId = created.sessionId;
  sessionToThread.set(created.sessionId, thread.id);
  liveSessions.add(created.sessionId);
  applyLiveConfig(thread.id, created);
  void refreshCommands(created.sessionId, project.path);
  const desired = thread.mode || state.settings.mode || "default";
  if (desired !== "default") {
    try {
      await acp.setMode(created.sessionId, desired);
    } catch {
      /* next prompt still works in default */
    }
  }
  persist();
  return created.sessionId;
}

let resumeGeneration = 0;

async function resumeThread(thread: Thread): Promise<void> {
  if (!thread.sessionId) return;
  const project = projectById(thread.projectId);
  if (!project) return;
  const generation = ++resumeGeneration;
  loadDiskTranscript(thread, project);
  try {
    await ensureAgent();
    if (generation !== resumeGeneration || state.activeThreadId !== thread.id) return;
    await attachSession(thread, project);
  } catch (err) {
    if (generation !== resumeGeneration) return;
    send("desktop:error", err instanceof Error ? err.message : String(err));
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]),
  );
}

function createWindow(): void {
  const mac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    show: false,
    frame: !mac,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("desktop:get-state", () => publicState());
  ipcMain.handle("desktop:get-agent", () => agentInfo);
  ipcMain.handle("desktop:get-transcript", (_e, threadId: string) => {
    const thread = state.threads.find((t) => t.id === threadId);
    const project = thread ? projectById(thread.projectId) : undefined;
    if (thread?.sessionId && project && (thread.status !== "running" || !transcripts.has(threadId))) {
      rememberSnapshot(thread.id, thread.sessionId, project.path);
    }
    return transcripts.get(threadId) ?? [];
  });
  ipcMain.handle("desktop:get-diffs", (_e, threadId: string) => collectDiffs(threadId));
  ipcMain.handle("desktop:get-commands", (_e, threadId: string) => {
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread?.sessionId) return bootCommands;
    return sessionCommands.get(thread.sessionId) ?? bootCommands;
  });

  ipcMain.handle("desktop:start-agent", async () => ensureAgent());
  ipcMain.handle("desktop:stop-agent", () => {
    acp.stop();
    agentInfo = agentInfo ? { ...agentInfo, running: false } : null;
    return agentInfo;
  });

  ipcMain.handle("desktop:update-settings", async (_e, patch: Partial<DesktopSettings>) => {
    const restartKeys = ["alwaysApprove", "agentPath", "customBaseUrl", "customModelId", "customBackend"] as const;
    const restart = restartKeys.some((key) => key in patch);
    const next = { ...state.settings, ...patch };
    const prevDir = state.settings.outputDir.trim();
    if ("outputDir" in patch) next.outputDir = (patch.outputDir ?? "").trim();
    const nextDir = next.outputDir.trim();
    let outputProject: Project | undefined;
    if (nextDir && nextDir !== prevDir) outputProject = prepareOutputDir(nextDir);
    state.settings = next;
    if (outputProject && !state.activeThreadId) state.activeProjectId = outputProject.id;
    persist();
    if (restart && acp.running) {
      acp.stop();
      agentInfo = null;
      await ensureAgent();
    }
    send("desktop:state", publicState());
    return state.settings;
  });

  ipcMain.handle("desktop:list-models", () => refreshModels());
  ipcMain.handle(
    "desktop:set-model",
    (_e, payload: { modelId: string; threadId?: string | null; reasoningEffort?: string }) =>
      applyModel(payload.modelId, payload.threadId, payload.reasoningEffort),
  );
  ipcMain.handle(
    "desktop:set-mode",
    (_e, payload: { modeId: SessionMode; threadId?: string | null }) =>
      applyMode(payload.modeId, payload.threadId),
  );
  ipcMain.handle("desktop:delete-thread", (_e, threadId: string) => deleteThread(threadId));
  ipcMain.handle("desktop:auth-status", () => authStatus());
  ipcMain.handle("desktop:login", async () => {
    const bin = resolveAgentPath().path;
    await runGrok(bin, ["login", "--oauth"]);
    send("desktop:auth", authStatus());
    await refreshModels();
    return authStatus();
  });
  ipcMain.handle("desktop:logout", async () => {
    const bin = resolveAgentPath().path;
    await runGrok(bin, ["logout"]);
    send("desktop:auth", authStatus());
    return authStatus();
  });
  ipcMain.handle(
    "desktop:save-api",
    async (
      _e,
      payload: {
        apiKey: string;
        signOutAccount?: boolean;
        customBaseUrl?: string;
        customModelId?: string;
        customBackend?: DesktopSettings["customBackend"];
      },
    ) => {
      if (payload.apiKey.trim()) saveApiKey(payload.apiKey.trim());
      if (payload.signOutAccount) {
        try {
          await runGrok(resolveAgentPath().path, ["logout"]);
        } catch {
          /* ignore */
        }
      }
      if (payload.customBaseUrl !== undefined) state.settings.customBaseUrl = payload.customBaseUrl;
      if (payload.customModelId !== undefined) state.settings.customModelId = payload.customModelId;
      if (payload.customBackend !== undefined) state.settings.customBackend = payload.customBackend;
      if (state.settings.customBaseUrl.trim() && state.settings.customModelId.trim()) {
        state.settings.model = "desktop-custom";
      }
      persist();
      upsertCustomModel(state.settings, getStoredApiKey());
      if (acp.running) {
        acp.stop();
        agentInfo = null;
      }
      send("desktop:state", publicState());
      send("desktop:auth", authStatus());
      return authStatus();
    },
  );
  ipcMain.handle("desktop:clear-api", () => {
    saveApiKey("");
    send("desktop:auth", authStatus());
    return authStatus();
  });

  ipcMain.handle("desktop:pick-directory", async (_e, current?: string) => {
    const start = current?.trim();
    const picked = await dialog.showOpenDialog(mainWindow!, {
      title: "选择默认输出目录",
      defaultPath: start && existsSync(start) ? start : undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return picked.filePaths[0];
  });

  ipcMain.handle("desktop:ensure-output-project", () => {
    const dir = state.settings.outputDir.trim();
    if (!dir) return null;
    const project = prepareOutputDir(dir);
    state.activeProjectId = project.id;
    persist();
    send("desktop:state", publicState());
    return project;
  });

  ipcMain.handle("desktop:open-project", async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, {
      title: "打开项目文件夹",
      properties: ["openDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const project = addProject(picked.filePaths[0]);
    send("desktop:state", publicState());
    return project;
  });

  ipcMain.handle("desktop:add-project-path", (_e, path: string) => {
    const project = addProject(path);
    send("desktop:state", publicState());
    return project;
  });

  ipcMain.handle("desktop:remove-project", (_e, projectId: string) => {
    state.projects = state.projects.filter((p) => p.id !== projectId);
    const removed = state.threads.filter((t) => t.projectId === projectId);
    for (const thread of removed) transcripts.delete(thread.id);
    state.threads = state.threads.filter((t) => t.projectId !== projectId);
    if (state.activeProjectId === projectId) {
      state.activeProjectId = state.projects[0]?.id ?? null;
    }
    if (state.activeThreadId && !state.threads.some((t) => t.id === state.activeThreadId)) {
      state.activeThreadId = state.threads[0]?.id ?? null;
    }
    persist();
    send("desktop:state", publicState());
  });

  ipcMain.handle("desktop:set-active", async (_e, payload: { projectId?: string | null; threadId?: string | null }) => {
    if (payload.projectId !== undefined) state.activeProjectId = payload.projectId;
    if (payload.threadId !== undefined) {
      state.activeThreadId = payload.threadId;
      const thread = state.threads.find((t) => t.id === payload.threadId);
      const project = thread ? projectById(thread.projectId) : undefined;
      if (thread?.sessionId && project) loadDiskTranscript(thread, project);
    }
    persist();
    send("desktop:state", publicState());
    const thread = payload.threadId ? state.threads.find((t) => t.id === payload.threadId) : undefined;
    if (thread?.sessionId) void resumeThread(thread);
    return publicState();
  });

  ipcMain.handle("desktop:new-thread", async (_e, projectId: string) => createThread(projectId));

  ipcMain.handle("desktop:import-sessions", (_e, projectId: string) => {
    const project = projectById(projectId);
    if (!project) return [];
    importDiskSessions(project);
    send("desktop:state", publicState());
    return state.threads.filter((t) => t.projectId === projectId);
  });

  ipcMain.handle("desktop:refresh-history", () => {
    importAllHistory();
    const active = state.threads.find((thread) => thread.id === state.activeThreadId);
    const project = active ? projectById(active.projectId) : undefined;
    if (active?.sessionId && project && active.status !== "running") {
      rememberSnapshot(active.id, active.sessionId, project.path);
      send("desktop:transcript", { threadId: active.id, blocks: transcripts.get(active.id) ?? [] });
    }
    send("desktop:state", publicState());
    return publicState();
  });

  ipcMain.handle(
    "desktop:send-prompt",
    async (_e, payload: { threadId: string; text: string; images?: PromptImage[] }) => {
    const thread = state.threads.find((t) => t.id === payload.threadId);
    if (!thread) throw new Error("找不到这段对话");
    const project = projectById(thread.projectId);
    if (!project) throw new Error("找不到对应的项目目录");
    const sessionId = await openSession(thread, project);
    const images = (payload.images ?? []).filter((image) => image.data);
    const caption = payload.text.trim() || (images.length ? "［图片］" : "");
    if (placeholderTitle(thread.title)) {
      patchThread(thread.id, { title: caption.slice(0, 72) });
    }
    pushBlock(thread.id, {
      id: uid(),
      kind: "user",
      text: payload.text,
      createdAt: Date.now(),
      images: images.length ? images : undefined,
    });
    patchThread(thread.id, { status: "running" });
    try {
      const result = await acp.prompt(sessionId, payload.text, images);
      pushTurnUsage(thread.id, parseTurnUsage(responseMeta(result)?.usage));
      endStreams(thread.id);
      patchThread(thread.id, { status: "idle" });
    } catch (err) {
      endStreams(thread.id);
      patchThread(thread.id, { status: "error" });
      pushBlock(thread.id, {
        id: uid(),
        kind: "system",
        text: err instanceof Error ? err.message : String(err),
        createdAt: Date.now(),
      });
      throw err;
    }
    },
  );

  ipcMain.handle("desktop:cancel", (_e, threadId: string) => {
    const thread = state.threads.find((t) => t.id === threadId);
    if (thread?.sessionId) acp.cancel(thread.sessionId);
    endStreams(threadId);
    patchThread(threadId, { status: "idle" });
  });

  ipcMain.handle("desktop:respond-permission", (_e, payload: { requestId: number | string; optionId?: string; cancelled?: boolean }) => {
    if (payload.cancelled || !payload.optionId) {
      acp.respond(payload.requestId, { outcome: { outcome: "cancelled" } });
    } else {
      acp.respond(payload.requestId, {
        outcome: { outcome: "selected", optionId: payload.optionId },
      });
    }
    pendingPermissions.delete(payload.requestId);
  });

  ipcMain.handle("desktop:git-status", (_e, cwd: string) => gitSnapshot(cwd));
  ipcMain.handle("desktop:git-diff", (_e, payload: { cwd: string; path?: string }) =>
    gitDiff(payload.cwd, payload.path),
  );
  ipcMain.handle("desktop:git-stage", (_e, payload: { cwd: string; paths?: string[] }) =>
    gitStage(payload.cwd, payload.paths),
  );
  ipcMain.handle("desktop:git-discard", (_e, payload: { cwd: string; paths?: string[] }) =>
    gitDiscard(payload.cwd, payload.paths),
  );
  ipcMain.handle("desktop:search-history", (_e, query: string) => searchSessionIds(query));
  ipcMain.handle("desktop:open-path", (_e, target: string) => shell.openPath(target));
  ipcMain.handle("desktop:open-project-file", (_e, payload: { cwd: string; path: string }) =>
    shell.openPath(resolveInside(payload.cwd, payload.path)),
  );
  ipcMain.handle("desktop:window", (_e, action: "min" | "max" | "close") => {
    if (!mainWindow) return;
    if (action === "min") mainWindow.minimize();
    if (action === "max") {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    if (action === "close") mainWindow.close();
  });
}

app.whenReady().then(() => {
  state = loadState();
  importAllHistory();
  adoptSavedOutputDir();
  for (const thread of state.threads) {
    if (thread.sessionId) sessionToThread.set(thread.sessionId, thread.id);
  }
  const active = state.threads.find((t) => t.id === state.activeThreadId);
  if (active?.sessionId) {
    const project = projectById(active.projectId);
    if (project) rememberSnapshot(active.id, active.sessionId, project.path);
  }
  wireAcp();
  registerIpc();
  installApplicationMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  acp.stop();
  persist();
});
