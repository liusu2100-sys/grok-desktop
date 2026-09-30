import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBlock, FileDiff, PlanEntry, SlashCommand, ToolCallState, UsageSnapshot } from "../shared/types";
import { parseCommands, parseUsage } from "./protocol";

export interface DiskSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  model?: string;
}

function grokHome(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

/** Match `urlencoding::encode`: leave A-Z a-z 0-9 - _ . ~ alone. */
export function encodeCwdDirname(cwd: string): string {
  const bytes = new TextEncoder().encode(cwd);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function decodeDirname(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return "";
  }
}

function looksLikeCwd(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function findSessionDir(sessionId: string, cwd: string): string | null {
  const root = join(grokHome(), "sessions");
  if (!existsSync(root)) return null;
  const direct = join(root, encodeCwdDirname(cwd), sessionId);
  if (existsSync(direct)) return direct;
  const legacy = join(root, encodeURIComponent(cwd), sessionId);
  if (legacy !== direct && existsSync(legacy)) return legacy;

  const wanted = normalizePath(cwd);
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupPath = join(root, group.name);
    const candidate = join(groupPath, sessionId);
    if (!existsSync(candidate)) continue;
    const marker = join(groupPath, ".cwd");
    const decoded = existsSync(marker)
      ? readFileSync(marker, "utf8").trim()
      : decodeDirname(group.name);
    if (looksLikeCwd(decoded) && normalizePath(decoded) === wanted) return candidate;
  }
  return null;
}

export interface SessionSnapshot {
  blocks: ChatBlock[];
  usage?: UsageSnapshot;
  commands: SlashCommand[];
}

function parseSummary(file: string): DiskSession | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      info?: { id?: string; cwd?: string };
      session_summary?: string;
      generated_title?: string;
      created_at?: string;
      updated_at?: string;
      last_active_at?: string;
      current_model_id?: string;
    };
    const id = raw.info?.id;
    const cwd = raw.info?.cwd;
    if (!id || !cwd) return null;
    return {
      id,
      cwd,
      title: raw.generated_title || raw.session_summary || "未命名对话",
      createdAt: Date.parse(raw.created_at ?? "") || 0,
      updatedAt: Date.parse(raw.last_active_at ?? raw.updated_at ?? "") || 0,
      model: raw.current_model_id,
    };
  } catch {
    return null;
  }
}

export function listDiskSessions(cwd?: string): DiskSession[] {
  const root = join(grokHome(), "sessions");
  if (!existsSync(root)) return [];
  const out: DiskSession[] = [];
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupPath = join(root, group.name);
    for (const child of readdirSync(groupPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const summary = join(groupPath, child.name, "summary.json");
      if (!existsSync(summary)) continue;
      const parsed = parseSummary(summary);
      if (!parsed) continue;
      if (cwd && normalizePath(parsed.cwd) !== normalizePath(cwd)) continue;
      out.push(parsed);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function loadTranscript(sessionId: string, cwd: string): ChatBlock[] {
  return loadSessionSnapshot(sessionId, cwd).blocks;
}

export function loadSessionSnapshot(sessionId: string, cwd: string): SessionSnapshot {
  const dir = findSessionDir(sessionId, cwd);
  const file = dir ? join(dir, "updates.jsonl") : "";
  if (!file || !existsSync(file)) return { blocks: [], commands: [] };
  const blocks: ChatBlock[] = [];
  const tools = new Map<string, ChatBlock>();
  let user: ChatBlock | null = null;
  let agent: ChatBlock | null = null;
  let thought: ChatBlock | null = null;
  let usage: UsageSnapshot | undefined;
  let commands: SlashCommand[] = [];

  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: { params?: { update?: Record<string, unknown> } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const update = row.params?.update;
    if (!update || typeof update !== "object") continue;
    const kind = String(update.sessionUpdate ?? "");
    if (kind === "user_message_chunk") {
      const chunk = contentText(update.content);
      if (!chunk) continue;
      if (!user || !user.streaming) {
        user = block("user", chunk);
        blocks.push(user);
      } else {
        user.text += chunk;
      }
      agent = null;
      thought = null;
    } else if (kind === "agent_message_chunk") {
      const chunk = contentText(update.content);
      if (!chunk) continue;
      if (!agent) {
        agent = block("agent", chunk);
        blocks.push(agent);
      } else {
        agent.text += chunk;
      }
    } else if (kind === "agent_thought_chunk") {
      const chunk = contentText(update.content);
      if (!chunk) continue;
      if (!thought) {
        thought = block("thought", chunk);
        blocks.push(thought);
      } else {
        thought.text += chunk;
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const tool = mergeTool(update);
      if (!tool.toolCallId) continue;
      const existing = tools.get(tool.toolCallId);
      if (existing?.tool) {
        existing.tool = { ...existing.tool, ...compactTool(tool) };
        existing.text = existing.tool.title;
      } else {
        const next = block("tool", tool.title || tool.toolCallId);
        next.tool = compactTool(tool);
        tools.set(tool.toolCallId, next);
        blocks.push(next);
      }
      agent = null;
      thought = null;
      if (user) user.streaming = false;
    } else if (kind === "plan") {
      const entries = (update.entries as PlanEntry[] | undefined) ?? [];
      const planText = entries.map((e) => e.content).join("\n");
      let planIndex = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === "user") break;
        if (blocks[i].kind === "plan") {
          planIndex = i;
          break;
        }
      }
      const current = planIndex >= 0 ? blocks[planIndex] : undefined;
      if (current) {
        current.text = planText;
        current.plan = entries;
      } else {
        blocks.push({ ...block("plan", planText), plan: entries });
      }
    } else if (kind === "usage_update") {
      usage = parseUsage(update) ?? usage;
    } else if (kind === "available_commands_update") {
      const next = parseCommands(update);
      if (next.length) commands = next;
    }
  }
  return {
    blocks: blocks.map((b) => ({ ...b, streaming: false })),
    usage,
    commands,
  };
}

function compactTool(tool: ToolCallState): ToolCallState {
  return {
    ...tool,
    rawOutput: undefined,
    contentPreview: tool.contentPreview?.slice(0, 4000),
  };
}

function mergeTool(update: Record<string, unknown>): ToolCallState {
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
        preview += contentText(item.content ?? item.text);
      }
    }
  }
  return {
    toolCallId: String(update.toolCallId ?? ""),
    title: String(update.title ?? "tool"),
    kind: update.kind ? String(update.kind) : undefined,
    status: update.status ? String(update.status) : undefined,
    locations: update.locations as ToolCallState["locations"],
    rawInput: update.rawInput,
    contentPreview: preview || undefined,
    diffs: diffs.length ? diffs : undefined,
  };
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

function block(kind: ChatBlock["kind"], text: string): ChatBlock {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    text,
    createdAt: Date.now(),
    streaming: true,
  };
}

export function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}
