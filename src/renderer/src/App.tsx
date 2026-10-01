import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInfo,
  AuthStatus,
  ChatBlock,
  DesktopSettings,
  DesktopState,
  FileDiff,
  GitChange,
  GitSnapshot,
  ModelInfo,
  PermissionRequest,
  SessionMode,
  SlashCommand,
} from "@shared/types";
import { defaultState, SESSION_MODES } from "@shared/types";
import { CATALOG_MODELS, displayName, findModel, formatContext } from "@shared/catalog";
import { Markdown } from "./markdown";

function timeAgo(ts: number): string {
  if (!ts) return "";
  const delta = Date.now() - ts;
  const min = Math.round(delta / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

function effortLabel(value: string, label?: string): string {
  const known: Record<string, string> = { xhigh: "超高", high: "高", medium: "中", low: "低" };
  return known[value] || label || value;
}

const IMAGE_LIMIT = 6;
const IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function imageMime(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") {
    return type;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? null;
}

interface PendingImage {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  preview: string;
}

function readImage(file: File, mimeType: string): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取「${file.name || "图片"}」`));
    reader.onload = () => {
      const url = String(reader.result || "");
      const comma = url.indexOf(",");
      const data = comma >= 0 ? url.slice(comma + 1) : "";
      if (!data) {
        reject(new Error(`无法读取「${file.name || "图片"}」`));
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || "图片",
        mimeType,
        data,
        preview: url,
      });
    };
    reader.readAsDataURL(file);
  });
}

function gitStatusLabel(status: string): string {
  const known: Record<string, string> = {
    M: "已修改",
    A: "新增",
    D: "删除",
    R: "重命名",
    C: "复制",
    U: "冲突",
    "?": "未跟踪",
  };
  return known[status] || status;
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return Boolean(norm(a)) && norm(a) === norm(b);
}

function notify(title: string, body: string): void {
  if (!document.hidden || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    /* notifications can fail when the window has no permission */
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function statusLabel(status?: string): string {
  if (!status) return "";
  const known: Record<string, string> = {
    completed: "已完成",
    in_progress: "进行中",
    pending: "等待",
    failed: "失败",
    running: "进行中",
  };
  return known[status] || status.replace(/_/g, " ");
}

export default function App() {
  const [state, setState] = useState<DesktopState>(defaultState());
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [git, setGit] = useState<GitSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [showRight, setShowRight] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<DesktopSettings>(state.settings);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({ kind: "none", hasApiKey: false });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyScope, setHistoryScope] = useState<"project" | "all">("project");
  const [bodyHits, setBodyHits] = useState<string[]>([]);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef<Map<string, string>>(new Map());
  const draftRef = useRef("");
  const prevThread = useRef<string | null>(null);
  const runningIds = useRef<Set<string>>(new Set());
  const runsPrimed = useRef(false);
  const busyRef = useRef(false);
  const settingsOpenRef = useRef(false);
  const permRef = useRef<PermissionRequest | null>(null);
  const modalRef = useRef({ settings: false, confirm: false, discard: false });
  const shortcutRef = useRef<{
    newThread: () => Promise<void>;
    respond: (optionId?: string, cancelled?: boolean) => void;
  }>({
    newThread: async () => undefined,
    respond: () => undefined,
  });

  const project = state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const thread = state.threads.find((t) => t.id === state.activeThreadId) ?? null;
  const outputDir = state.settings.outputDir.trim();
  const canCompose = Boolean(thread || project || outputDir);
  const isMac = window.grok.platform === "darwin";
  const perm = perms[0] ?? null;
  draftRef.current = draft;
  const reviewFiles = useMemo(() => {
    const grouped = new Map<string, GitChange[]>();
    for (const change of git?.changes ?? []) {
      const list = grouped.get(change.path) ?? [];
      list.push(change);
      grouped.set(change.path, list);
    }
    return [...grouped.entries()];
  }, [git]);
  const history = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    const hits = new Set(bodyHits);
    return state.threads
      .filter((item) => {
        if (historyScope === "project" && project && item.projectId !== project.id) return false;
        if (!query) return true;
        const folder = state.projects.find((p) => p.id === item.projectId);
        return (
          item.title.toLowerCase().includes(query) ||
          folder?.name.toLowerCase().includes(query) ||
          folder?.path.toLowerCase().includes(query) ||
          (item.sessionId ? hits.has(item.sessionId) : false)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.threads, state.projects, historyQuery, historyScope, project, bodyHits]);

  useEffect(() => {
    const unsubs = [
      window.grok.onState(setState),
      window.grok.onAgent(setAgent),
      window.grok.onTranscript((payload) => {
        if (payload.threadId === state.activeThreadId || !state.activeThreadId) {
          setBlocks(payload.blocks);
        }
      }),
      window.grok.onDiffs((payload) => {
        if (payload.threadId === state.activeThreadId) setDiffs(payload.diffs);
      }),
      window.grok.onPermission((request) => {
        setPerms((queue) => {
          const index = queue.findIndex((item) => item.requestId === request.requestId);
          if (index === -1) return [...queue, request];
          const next = queue.slice();
          next[index] = request;
          return next;
        });
        if (document.hidden) notify("需要你确认", request.title);
      }),
      window.grok.onError(setError),
      window.grok.onModels(setModels),
      window.grok.onAuth(setAuth),
      window.grok.onCommands((payload) => {
        if (payload.threadId === state.activeThreadId || (!payload.threadId && !state.activeThreadId)) {
          setCommands(payload.commands);
        }
      }),
    ];
    const preventFileNav = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNav);
    window.addEventListener("drop", preventFileNav);
    void window.grok.getState().then((next) => {
      if (!runsPrimed.current) {
        runningIds.current = new Set(
          next.threads.filter((item) => item.status === "running").map((item) => item.id),
        );
        runsPrimed.current = true;
      }
      setState(next);
    });
    void window.grok.getAgent().then(setAgent);
    void window.grok.listModels().then((list) => setModels(list.length ? list : CATALOG_MODELS));
    void window.grok.authStatus().then(setAuth);
    return () => {
      unsubs.forEach((u) => u());
      window.removeEventListener("dragover", preventFileNav);
      window.removeEventListener("drop", preventFileNav);
    };
  }, [state.activeThreadId]);

  useEffect(() => {
    if (!state.activeThreadId) {
      setBlocks([]);
      setDiffs([]);
      void window.grok.getCommands("").then(setCommands);
      return;
    }
    void window.grok.getTranscript(state.activeThreadId).then(setBlocks);
    void window.grok.getDiffs(state.activeThreadId).then(setDiffs);
    void window.grok.getCommands(state.activeThreadId).then(setCommands);
  }, [state.activeThreadId]);

  useEffect(() => {
    void window.grok.refreshHistory().then(setState).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!project) {
      setGit(null);
      return;
    }
    void window.grok.gitStatus(project.path).then(setGit);
    const timer = window.setInterval(() => {
      void window.grok.gitStatus(project.path).then(setGit);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [project?.path]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, perm]);

  useEffect(() => {
    const prev = prevThread.current;
    const next = state.activeThreadId;
    if (prev !== next) {
      drafts.current.set(prev ?? "", draftRef.current);
      setImages([]);
      prevThread.current = next;
      setDraft(drafts.current.get(next ?? "") ?? "");
    }
  }, [state.activeThreadId]);

  useEffect(() => {
    const query = historyQuery.trim();
    if (query.length < 2) {
      setBodyHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void window.grok.searchHistory(query).then(setBodyHits).catch(() => setBodyHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [historyQuery]);

  useEffect(() => {
    const box = composerRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    if (!runsPrimed.current) return;
    const running = new Set(state.threads.filter((item) => item.status === "running").map((item) => item.id));
    const started = [...running].some((id) => !runningIds.current.has(id));
    if (started && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
    if (document.hidden) {
      for (const id of runningIds.current) {
        if (running.has(id)) continue;
        const done = state.threads.find((item) => item.id === id);
        if (done) notify("对话已完成", done.title || "当前对话");
      }
    }
    runningIds.current = running;
  }, [state.threads]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const modal = modalRef.current.settings || modalRef.current.confirm || modalRef.current.discard;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && !event.altKey && !modal) {
        const key = event.key.toLowerCase();
        if (key === "n" || key === "k" || key === "l") {
          event.preventDefault();
          if (key === "n") void shortcutRef.current.newThread();
          if (key === "k") {
            searchRef.current?.focus();
            searchRef.current?.select();
          }
          if (key === "l") composerRef.current?.focus();
          return;
        }
      }
      if (modal || isTypingTarget(event.target)) return;
      const current = permRef.current;
      if (!current || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        shortcutRef.current.respond(undefined, true);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const option = current.options[Number(event.key) - 1];
        if (!option) return;
        event.preventDefault();
        shortcutRef.current.respond(option.optionId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openProject() {
    setError(null);
    await window.grok.openProject();
  }

  async function resolveProjectId(): Promise<string | null> {
    if (project) return project.id;
    if (!outputDir) return null;
    const ensured = await window.grok.ensureOutputProject();
    return ensured?.id ?? null;
  }

  async function newThread() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const projectId = await resolveProjectId();
      if (!projectId) {
        setError("请先在设置中指定默认输出目录，或打开一个项目文件夹");
        return;
      }
      await window.grok.newThread(projectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function selectThread(threadId: string) {
    const next = state.threads.find((item) => item.id === threadId);
    await window.grok.setActive({ projectId: next?.projectId ?? null, threadId });
  }

  async function addImageFiles(files: Iterable<File>) {
    const incoming = Array.from(files);
    const accepted: PendingImage[] = [];
    let note = "";
    for (const file of incoming) {
      const mimeType = imageMime(file);
      if (!mimeType) {
        note = "请使用 png、jpg、gif 或 webp 图片";
        continue;
      }
      if (file.size > IMAGE_BYTES) {
        note = `「${file.name || "图片"}」超过 6MB`;
        continue;
      }
      try {
        accepted.push(await readImage(file, mimeType));
      } catch (e) {
        note = e instanceof Error ? e.message : String(e);
      }
    }
    if (!accepted.length) {
      if (incoming.length) setError(note || "请拖入图片文件");
      return;
    }
    setImages((current) => [...current, ...accepted].slice(0, IMAGE_LIMIT));
    if (images.length >= IMAGE_LIMIT) note = `最多添加 ${IMAGE_LIMIT} 张图片`;
    else if (images.length + accepted.length > IMAGE_LIMIT) {
      note = `最多添加 ${IMAGE_LIMIT} 张图片，其余未加入`;
    }
    setError(note || null);
  }

  async function send(override?: string) {
    if (thread?.status === "running" || busyRef.current) return;
    const preset = override !== undefined;
    const text = preset ? override : draft;
    const outgoing = preset ? [] : images;
    if (!text.trim() && outgoing.length === 0) return;
    if (!preset) {
      draftRef.current = "";
      if (thread?.id) drafts.current.set(thread.id, "");
      setDraft("");
      setImages([]);
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let threadId = thread?.id;
    try {
      if (!threadId) {
        const projectId = await resolveProjectId();
        if (!projectId) {
          if (!preset) {
            draftRef.current = text;
            setDraft(text);
            setImages(outgoing);
          }
          setError("请先在设置中指定默认输出目录，或打开一个项目文件夹");
          return;
        }
        const created = await window.grok.newThread(projectId);
        threadId = created.id;
      }
      await window.grok.sendPrompt(
        threadId,
        text,
        outgoing.map(({ mimeType, data, name }) => ({ mimeType, data, name })),
      );
      if (!preset) drafts.current.set(threadId, "");
    } catch (e) {
      if (!preset) {
        draftRef.current = text;
        if (threadId) drafts.current.set(threadId, text);
        setDraft(text);
        setImages(outgoing);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function respond(optionId?: string, cancelled = false) {
    const current = permRef.current;
    if (!current) return;
    const requestId = current.requestId;
    permRef.current = perms.find((item) => item.requestId !== requestId) ?? null;
    void window.grok.respondPermission(requestId, optionId, cancelled);
    setPerms((queue) => queue.filter((item) => item.requestId !== requestId));
  }

  function mention(path: string) {
    const token = `\`${path}\``;
    const current = draftRef.current;
    const next = !current ? token : /\s$/.test(current) ? `${current}${token}` : `${current} ${token}`;
    draftRef.current = next;
    drafts.current.set(state.activeThreadId ?? "", next);
    setDraft(next);
    composerRef.current?.focus();
  }

  function editMessage(text: string) {
    draftRef.current = text;
    drafts.current.set(state.activeThreadId ?? "", text);
    setDraft(text);
    setImages([]);
    composerRef.current?.focus();
  }

  async function refreshReview(focus: string | null) {
    if (!project) return;
    const snap = await window.grok.gitStatus(project.path);
    setGit(snap);
    if (focus && snap.changes.some((change) => change.path === focus)) {
      setSelectedFile(focus);
      setFileDiff(await window.grok.gitDiff(project.path, focus));
      return;
    }
    setSelectedFile(null);
    setFileDiff("");
  }

  async function stagePaths(paths?: string[]) {
    if (!project || gitBusy) return;
    setGitBusy(true);
    setError(null);
    try {
      await window.grok.gitStage(project.path, paths);
      await refreshReview(paths?.length === 1 ? paths[0] : selectedFile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function discardPaths(paths?: string[]) {
    if (!project || gitBusy) return;
    setGitBusy(true);
    setError(null);
    try {
      await window.grok.gitDiscard(project.path, paths);
      await refreshReview(paths?.length === 1 ? paths[0] : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function openFile(path: string) {
    if (!project) return;
    const message = await window.grok.openProjectFile(project.path, path);
    if (message) setError(message);
  }

  async function pickFile(path: string) {
    if (!project) return;
    setSelectedFile(path);
    setFileDiff(await window.grok.gitDiff(project.path, path));
  }

  async function changeModel(modelId: string, effort?: string) {
    setError(null);
    const next = findModel(modelId, models);
    const nextEffort =
      effort ||
      (next?.efforts?.some((e) => e.value === state.settings.reasoningEffort)
        ? state.settings.reasoningEffort
        : next?.defaultEffort);
    try {
      await window.grok.setModel(modelId, thread?.id, nextEffort);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function changeMode(modeId: SessionMode) {
    setError(null);
    try {
      await window.grok.setMode(modeId, thread?.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmDeleteThread() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    setError(null);
    try {
      await window.grok.deleteThread(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const modelList = models.length ? models : CATALOG_MODELS;
  const currentModel =
    thread?.model || state.settings.model || modelList.find((m) => m.isDefault)?.id || "grok-4.7";
  const currentEffort = thread?.reasoningEffort || state.settings.reasoningEffort || "high";
  const currentMode = thread?.mode || state.settings.mode || "default";
  const currentInfo = findModel(currentModel, modelList);
  const modeLabel = SESSION_MODES.find((m) => m.id === currentMode)?.label ?? "常规";
  const authLabel =
    auth.kind === "account"
      ? auth.email || auth.name || "已登录"
      : auth.kind === "api-key"
        ? `API ${auth.apiKeyHint ?? "密钥"}`
        : "登录";

  const visibleBlocks = state.settings.showThoughts ? blocks : blocks.filter((b) => b.kind !== "thought");
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n") ? draft.slice(1) : null;
  const slashMatches =
    slashQuery === null
      ? []
      : commands.filter((cmd) => cmd.name.toLowerCase().startsWith(slashQuery.toLowerCase())).slice(0, 8);
  const usage = thread?.usage;
  const usagePct = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;

  function acceptSlash(cmd: SlashCommand) {
    setDraft(`/${cmd.name} `);
    setSlashIndex(0);
  }

  settingsOpenRef.current = settingsOpen;
  permRef.current = perm;
  modalRef.current = {
    settings: settingsOpen,
    confirm: confirmDelete !== null,
    discard: confirmDiscard,
  };
  shortcutRef.current = { newThread, respond };

  return (
    <div className={isMac ? "app mac" : "app"}>
      <header className="titlebar">
        {isMac && <div className="traffic-spacer" />}
        <div className="titlebar-left">
          <div className="brand">
            <span className="brand-mark" />
            Grok Build
          </div>
          <span className="agent-pill">
            <span className={`dot ${agent?.running ? "on" : ""}`} />
            {agent?.running
              ? `${agent.agentName || "Grok"}${agent.version ? ` ${agent.version}` : ""}`
              : "未连接"}
          </span>
          <button
            className="agent-pill clickable"
            title="账号 / API"
            onClick={() => {
              setSettingsDraft(state.settings);
              setApiKeyDraft("");
              setSettingsError(null);
              setSettingsOpen(true);
            }}
          >
            <span className={`dot ${auth.kind !== "none" ? "on" : ""}`} />
            {authLabel}
          </button>
        </div>
        <div className="titlebar-right">
          <button className="btn ghost" onClick={() => void window.grok.startAgent()}>
            连接
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              setSettingsDraft(state.settings);
              setApiKeyDraft("");
              setSettingsError(null);
              setSettingsOpen(true);
            }}
          >
            设置
          </button>
          <button className="btn ghost" onClick={() => setShowRight((v) => !v)}>
            {showRight ? "隐藏改动" : "改动"}
          </button>
          {!isMac && (
            <div className="win-btns">
              <button onClick={() => void window.grok.window("min")}>–</button>
              <button onClick={() => void window.grok.window("max")}>□</button>
              <button className="close" onClick={() => void window.grok.window("close")}>
                ×
              </button>
            </div>
          )}
        </div>
      </header>

      <div className={`shell ${showRight ? "" : "no-right"}`}>
        <aside className="sidebar">
          <div className="side-head">
            <h2>项目</h2>
            <button className="icon-btn" title="打开文件夹" onClick={() => void openProject()}>
              +
            </button>
          </div>
          <div className="side-actions">
            <button className="btn primary block" disabled={!canCompose || busy} onClick={() => void newThread()}>
              新对话
            </button>
          </div>
          <div className="project-list">
            {state.projects.map((p) => (
              <div
                key={p.id}
                className={`item ${p.id === state.activeProjectId ? "active" : ""}`}
                onClick={() => void window.grok.setActive({ projectId: p.id })}
              >
                <div className="name">
                  {p.name}{" "}
                  {samePath(p.path, outputDir) ? <span className="badge">默认</span> : null}
                </div>
                <div className="meta">{p.path}</div>
              </div>
            ))}
            {!state.projects.length && (
              <div className="section-label">{outputDir ? "将使用默认输出目录" : "打开一个仓库开始"}</div>
            )}
          </div>
          <div className="side-head history-head">
            <h2>对话</h2>
            <div className="history-tools">
              <div className="scope-toggle" title="当前项目或全部历史">
                <button
                  type="button"
                  className={historyScope === "project" ? "active" : ""}
                  disabled={!project}
                  onClick={() => setHistoryScope("project")}
                >
                  当前
                </button>
                <button
                  type="button"
                  className={historyScope === "all" ? "active" : ""}
                  onClick={() => setHistoryScope("all")}
                >
                  全部
                </button>
              </div>
              <button
                className="icon-btn"
                title="重新读取 ~/.grok 里的会话"
                onClick={() => void window.grok.refreshHistory().then(setState)}
              >
                ↻
              </button>
            </div>
          </div>
          <div className="history-search">
            <input
              ref={searchRef}
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder="搜索标题、目录或内容"
            />
          </div>
          <div className="thread-list">
            {history.map((t) => {
              const folder = state.projects.find((p) => p.id === t.projectId);
              return (
                <div
                  key={t.id}
                  className={`item thread-item ${t.id === state.activeThreadId ? "active" : ""}`}
                  onClick={() => void selectThread(t.id)}
                >
                  <div className="thread-main">
                    <div className="name">{t.title}</div>
                    <div className="meta">
                      {t.status === "running" ? <span className="badge run">进行中</span> : null}{" "}
                      {folder ? <span>{folder.name}</span> : null}{" "}
                      {t.model ? <span className="badge">{displayName(t.model, modelList)}</span> : null}{" "}
                      {timeAgo(t.updatedAt)}
                    </div>
                  </div>
                  <button
                    className="icon-btn danger-icon"
                    title="删除对话"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete({ id: t.id, title: t.title });
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {!history.length && (
              <div className="section-label">
                {historyQuery
                  ? "没有匹配的对话"
                  : historyScope === "project" && project
                    ? "当前项目还没有对话"
                    : "还没有对话记录"}
              </div>
            )}
          </div>
        </aside>

        <main
          className="main"
          onDragEnter={(e) => {
            if (![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void addImageFiles(e.dataTransfer.files);
          }}
        >
          <div className="thread-bar">
            <div>
              <h1>{thread?.title ?? "指挥台"}</h1>
              <div className="path">{project?.path ?? (outputDir || "打开项目文件夹后即可与 Grok 协作")}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ModelPicker
                models={modelList}
                modelId={currentModel}
                effort={currentEffort}
                mode={currentMode}
                open={pickerOpen}
                onToggle={() => setPickerOpen((v) => !v)}
                onClose={() => setPickerOpen(false)}
                onSelect={(id, effort) => {
                  setPickerOpen(false);
                  void changeModel(id, effort);
                }}
                onSelectMode={(mode) => {
                  void changeMode(mode);
                }}
              />
              {thread && (
                <button
                  className="btn danger"
                  onClick={() => setConfirmDelete({ id: thread.id, title: thread.title })}
                >
                  删除
                </button>
              )}
              {project && (
                <button className="btn ghost" onClick={() => void window.grok.openPath(project.path)}>
                  打开目录
                </button>
              )}
            </div>
          </div>

          <div className="transcript" ref={scrollRef}>
            {error && <div className="system block">{error}</div>}
            {perm && (
              <div className="perm">
                <h3>{perm.title}</h3>
                {perms.length > 1 && <div className="perm-queue">还有 {perms.length - 1} 条待确认</div>}
                <pre>{perm.summary}</pre>
                <div className="perm-actions">
                  {perm.options.map((opt, index) => (
                    <button
                      key={opt.optionId}
                      className={`btn ${opt.kind.startsWith("allow") ? "primary" : ""}`}
                      onClick={() => respond(opt.optionId)}
                    >
                      {index < 9 ? `${index + 1}  ` : ""}
                      {opt.name}
                    </button>
                  ))}
                  <button className="btn ghost" onClick={() => respond(undefined, true)}>
                    取消
                  </button>
                </div>
                <div className="perm-hint">1–9 选择 · Esc 取消</div>
              </div>
            )}

            {!thread && (
              <div className="empty">
                <h3>从左侧选一段历史，或开始一段新对话</h3>
                <p>
                  {outputDir
                    ? `未选择其他项目时，新对话会把文件写到 ${outputDir}。也可以从左侧打开别的文件夹。`
                    : "在设置里指定默认输出目录后，新对话会直接写到那个文件夹。也可以先打开一个项目。"}
                </p>
                <div className="empty-actions">
                  {outputDir && (!project || samePath(project.path, outputDir)) ? (
                    <button className="btn primary" disabled={busy} onClick={() => void newThread()}>
                      在默认目录新对话
                    </button>
                  ) : (
                    <button className="btn primary" disabled={!project || busy} onClick={() => void newThread()}>
                      新对话
                    </button>
                  )}
                  <button className="btn ghost" onClick={() => void openProject()}>
                    打开项目
                  </button>
                </div>
              </div>
            )}

            {visibleBlocks.map((block) => (
              <BlockView
                key={block.id}
                block={block}
                onEdit={editMessage}
                onOpen={(path) => void openFile(path)}
                onMention={mention}
              />
            ))}
          </div>

          <div className={`composer-wrap ${dragOver ? "dragover" : ""}`}>
            {dragOver && <div className="drop-hint">松开以添加图片</div>}
            <div className="composer">
              {slashMatches.length > 0 && (
                <div className="slash-menu">
                  {slashMatches.map((cmd, index) => (
                    <button
                      key={cmd.name}
                      className={`slash-item ${index === slashIndex ? "active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptSlash(cmd);
                      }}
                    >
                      <strong>/{cmd.name}</strong>
                      {cmd.hint && <code>{cmd.hint}</code>}
                      {cmd.description && <span>{cmd.description}</span>}
                    </button>
                  ))}
                </div>
              )}
              {images.length > 0 && (
                <div className="attach-row">
                  {images.map((image) => (
                    <div key={image.id} className="attach-card" title={image.name}>
                      <img src={image.preview} alt={image.name} />
                      <button
                        type="button"
                        title="移除"
                        onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addImageFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <textarea
                ref={composerRef}
                value={draft}
                spellCheck={false}
                placeholder={
                  project || thread
                    ? "让 Grok 构建、修复或审查…  输入 / 调用命令，可拖入图片"
                    : outputDir
                      ? "新对话会写到默认输出目录…  输入 / 调用命令，可拖入图片"
                      : "请先设置默认输出目录，或打开项目"
                }
                disabled={!canCompose}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files).filter((file) => imageMime(file));
                  if (!files.length) return;
                  e.preventDefault();
                  void addImageFiles(files);
                }}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSlashIndex(0);
                }}
                onKeyDown={(e) => {
                  if (slashMatches.length && e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % slashMatches.length);
                    return;
                  }
                  if (slashMatches.length && e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  if (slashMatches.length && e.key === "Tab") {
                    e.preventDefault();
                    const cmd = slashMatches[slashIndex] ?? slashMatches[0];
                    if (cmd) acceptSlash(cmd);
                    return;
                  }
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-row">
                <span className="model-chip" title={currentInfo?.description}>
                  {displayName(currentModel, modelList)}
                  {currentInfo?.supportsReasoningEffort ? ` · ${effortLabel(currentEffort)}` : ""}
                  {currentMode !== "default" ? ` · ${modeLabel}` : ""}
                </span>
                {usage && (
                  <span
                    className={`usage ${usagePct >= 70 ? "warn" : ""}`}
                    title={`${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`}
                  >
                    <span className="usage-track">
                      <span className="usage-fill" style={{ width: `${usagePct}%` }} />
                    </span>
                    {usagePct}%
                  </span>
                )}
                {usagePct >= 70 && (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy || thread?.status === "running"}
                    title="发送 /compact，腾出上下文"
                    onClick={() => void send("/compact")}
                  >
                    压缩上下文
                  </button>
                )}
                <button className="btn ghost" type="button" disabled={!canCompose} onClick={() => fileRef.current?.click()}>
                  图片
                </button>
                <span className="hint">Enter 发送 · Shift+Enter 换行</span>
                {thread?.status === "running" ? (
                  <button className="btn danger" type="button" onClick={() => void window.grok.cancel(thread.id)}>
                    停止
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    disabled={busy || (!draft.trim() && images.length === 0) || !canCompose}
                    onClick={() => void send()}
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>

        {showRight && (
          <aside className="rightbar">
            <div className="right-head">
              <h2>改动 {git?.branch ? `· ${git.branch}` : ""}</h2>
              <button
                className="icon-btn"
                title="刷新"
                onClick={() => project && void window.grok.gitStatus(project.path).then(setGit)}
              >
                ↻
              </button>
            </div>
            <div className="file-list">
              {diffs.length > 0 && <div className="section-label">本轮差异</div>}
              {diffs.map((d) => (
                <div
                  key={`acp-${d.path}`}
                  className={`file-row ${selectedFile === d.path ? "active" : ""}`}
                  onClick={() => void pickFile(d.path)}
                >
                  <div className="file-main">
                    <span className="name" title={d.path}>{d.path}</span>
                    <span className="st">本轮</span>
                  </div>
                  {selectedFile === d.path && project && (
                    <div className="review-actions">
                      <button type="button" className="btn mini" onClick={(e) => { e.stopPropagation(); mention(d.path); }}>
                        提起
                      </button>
                      <button type="button" className="btn mini" onClick={(e) => { e.stopPropagation(); void openFile(d.path); }}>
                        打开
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {reviewFiles.length > 0 && <div className="section-label">工作区</div>}
              {reviewFiles.map(([path, entries]) => (
                <div
                  key={path}
                  className={`file-row ${selectedFile === path ? "active" : ""}`}
                  onClick={() => void pickFile(path)}
                >
                  <div className="file-main">
                    <span className="name" title={path}>{path}</span>
                    <span className="file-meta">
                      {entries.map((entry, index) => (
                        <span key={`${entry.staged}-${entry.status}-${index}`} className={`st ${entry.staged ? "staged" : ""}`}>
                          {entry.staged ? "已暂存" : "未暂存"} · {gitStatusLabel(entry.status)}
                        </span>
                      ))}
                    </span>
                  </div>
                  {selectedFile === path && (
                    <div className="review-actions">
                      <button type="button" className="btn mini" disabled={gitBusy} onClick={(e) => { e.stopPropagation(); void stagePaths([path]); }}>
                        留下此文件
                      </button>
                      <button type="button" className="btn mini danger" disabled={gitBusy} onClick={(e) => { e.stopPropagation(); void discardPaths([path]); }}>
                        放弃此文件
                      </button>
                      <button type="button" className="btn mini" onClick={(e) => { e.stopPropagation(); mention(path); }}>
                        提起
                      </button>
                      <button type="button" className="btn mini" onClick={(e) => { e.stopPropagation(); void openFile(path); }}>
                        打开
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!git?.changes.length && !diffs.length && (
                <div className="section-label">没有本地改动</div>
              )}
            </div>
            {git?.changes.length ? (
              <div className="review-footer">
                <button className="btn ghost" type="button" disabled={gitBusy} onClick={() => void stagePaths()}>
                  全部留下
                </button>
                <button className="btn danger" type="button" disabled={gitBusy} onClick={() => setConfirmDiscard(true)}>
                  放弃未提交改动
                </button>
              </div>
            ) : null}
            <div className="diff-caption">{selectedFile ?? "选择一个文件查看差异"}</div>
            <div className="diff-view">
              {fileDiff
                ? fileDiff.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "add"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "del"
                            : line.startsWith("@@")
                              ? "hunk"
                              : ""
                      }
                    >
                      {line || " "}
                    </div>
                  ))
                : selectedFile
                  ? "没有文本差异"
                  : "选择一个文件查看"}
            </div>
          </aside>
        )}
      </div>

      {settingsOpen && (
        <div className="modal-back" onClick={() => setSettingsOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h2>设置</h2>

            <h3>账号</h3>
            <p className="help">
              {auth.kind === "account"
                ? `已登录：${auth.email || auth.name}`
                : auth.kind === "api-key"
                  ? `正在使用已保存的 API 密钥 ${auth.apiKeyHint ?? ""}`
                  : "尚未登录。可以使用 grok.com，或粘贴 API 密钥。"}
            </p>
            <div className="modal-actions left">
              <button
                className="btn primary"
                disabled={authBusy}
                onClick={async () => {
                  setAuthBusy(true);
                  setError(null);
                  try {
                    setAuth(await window.grok.login());
                    setModels(await window.grok.listModels());
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setAuthBusy(false);
                  }
                }}
              >
                {authBusy ? "等待浏览器…" : "使用 grok.com 登录"}
              </button>
              {auth.kind === "account" && (
                <button
                  className="btn danger"
                  disabled={authBusy}
                  onClick={async () => {
                    setAuthBusy(true);
                    try {
                      setAuth(await window.grok.logout());
                    } finally {
                      setAuthBusy(false);
                    }
                  }}
                >
                  退出登录
                </button>
              )}
            </div>

            <h3>API 连接</h3>
            <p className="help">
              可以使用 console.x.ai 的密钥，或兼容 OpenAI 的接口。在退出之前，grok.com 登录优先。
            </p>
            <div className="field">
              <label>API 密钥 {auth.apiKeyHint ? `（已保存 ${auth.apiKeyHint}）` : ""}</label>
              <div className="inline-field">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder={auth.hasApiKey ? "留空则保留当前密钥" : "xai-… 或 sk-…"}
                />
                <button className="btn ghost" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? "隐藏" : "显示"}
                </button>
              </div>
            </div>
            <div className="field">
              <label>自定义接口地址（可选）</label>
              <input
                value={settingsDraft.customBaseUrl}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, customBaseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="two-col">
              <div className="field">
                <label>自定义模型 ID</label>
                <input
                  value={settingsDraft.customModelId}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, customModelId: e.target.value })}
                  placeholder="gpt-4.1"
                />
              </div>
              <div className="field">
                <label>API 协议</label>
                <select
                  value={settingsDraft.customBackend}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      customBackend: e.target.value as DesktopSettings["customBackend"],
                    })
                  }
                >
                  <option value="chat_completions">OpenAI Chat Completions</option>
                  <option value="responses">OpenAI Responses</option>
                  <option value="messages">Anthropic Messages</option>
                </select>
              </div>
            </div>
            <div className="modal-actions left">
              <button
                className="btn primary"
                disabled={authBusy}
                onClick={async () => {
                  setAuthBusy(true);
                  try {
                    setAuth(
                      await window.grok.saveApi({
                        apiKey: apiKeyDraft,
                        customBaseUrl: settingsDraft.customBaseUrl,
                        customModelId: settingsDraft.customModelId,
                        customBackend: settingsDraft.customBackend,
                      }),
                    );
                    setApiKeyDraft("");
                    setModels(await window.grok.listModels());
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setAuthBusy(false);
                  }
                }}
              >
                保存 API
              </button>
              <button
                className="btn ghost"
                disabled={authBusy || (!auth.hasApiKey && !apiKeyDraft.trim())}
                onClick={async () => {
                  setAuth(await window.grok.saveApi({
                    apiKey: apiKeyDraft,
                    signOutAccount: true,
                    customBaseUrl: settingsDraft.customBaseUrl,
                    customModelId: settingsDraft.customModelId,
                    customBackend: settingsDraft.customBackend,
                  }));
                  setApiKeyDraft("");
                }}
              >
                仅使用 API（并退出账号）
              </button>
              {auth.hasApiKey && (
                <button className="btn danger" onClick={async () => setAuth(await window.grok.clearApi())}>
                  清除密钥
                </button>
              )}
            </div>

            <h3>代理</h3>
            <div className="two-col">
              <div className="field">
                <label>默认模型</label>
                <select
                  value={settingsDraft.model}
                  onChange={(e) => {
                    const next = findModel(e.target.value, modelList);
                    setSettingsDraft({
                      ...settingsDraft,
                      model: e.target.value,
                      reasoningEffort: next?.defaultEffort || settingsDraft.reasoningEffort,
                    });
                  }}
                >
                  {modelList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.isLatest ? " · 最新" : ""}
                      {m.isDefault ? " · 默认" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>推理力度</label>
                <select
                  value={settingsDraft.reasoningEffort}
                  onChange={(e) =>
                    setSettingsDraft({ ...settingsDraft, reasoningEffort: e.target.value })
                  }
                >
                  {(findModel(settingsDraft.model, modelList)?.efforts ?? [
                    { value: "high", label: "High" },
                    { value: "medium", label: "Medium" },
                    { value: "low", label: "Low" },
                  ]).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {effortLabel(opt.value, opt.label)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>默认会话模式</label>
              <select
                value={settingsDraft.mode}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    mode: e.target.value as SessionMode,
                  })
                }
              >
                {SESSION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>默认输出目录</label>
              <p className="help">
                没有选中其他项目时，新对话在这个文件夹里读写文件。目录不存在时，保存后会自动创建。
              </p>
              <div className="inline-field">
                <input
                  value={settingsDraft.outputDir}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, outputDir: e.target.value })}
                  placeholder={isMac ? "例如 /Users/you/Documents/grok-output" : "例如 D:\\work\\grok-output"}
                />
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    void window.grok.pickDirectory(settingsDraft.outputDir).then((picked) => {
                      if (picked) setSettingsDraft({ ...settingsDraft, outputDir: picked });
                    });
                  }}
                >
                  浏览
                </button>
              </div>
            </div>
            <div className="field">
              <label>Grok 程序路径（留空则自动查找）</label>
              <input
                value={settingsDraft.agentPath}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, agentPath: e.target.value })}
                placeholder={isMac ? "/Users/you/.grok/bin/grok" : "C:\\Users\\you\\.grok\\bin\\grok.exe"}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={settingsDraft.alwaysApprove}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, alwaysApprove: e.target.checked })
                }
              />
              始终批准工具（不再询问）
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={settingsDraft.showThoughts}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, showThoughts: e.target.checked })
                }
              />
              显示推理过程
            </label>
            {settingsError && <p className="help" style={{ color: "var(--red)" }}>{settingsError}</p>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setSettingsOpen(false)}>
                关闭
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setSettingsError(null);
                  void window.grok
                    .updateSettings(settingsDraft)
                    .then(() => setSettingsOpen(false))
                    .catch((e: unknown) => {
                      setSettingsError(e instanceof Error ? e.message : String(e));
                    });
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-back" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>删除对话</h2>
            <p className="help">
              确定永久删除「{confirmDelete.title}」？它会从左侧列表和 ~/.grok/sessions 中移除。
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button className="btn danger" onClick={() => void confirmDeleteThread()}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="modal-back" onClick={() => setConfirmDiscard(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>放弃未提交的改动</h2>
            <p className="help">
              这会丢弃当前项目里所有未提交的修改，包括未跟踪的新文件。被忽略的依赖目录不会删除。
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmDiscard(false)}>
                取消
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirmDiscard(false);
                  void discardPaths();
                }}
              >
                放弃
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelPicker({
  models,
  modelId,
  effort,
  mode,
  open,
  onToggle,
  onClose,
  onSelect,
  onSelectMode,
}: {
  models: ModelInfo[];
  modelId: string;
  effort: string;
  mode: SessionMode;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (modelId: string, effort?: string) => void;
  onSelectMode: (mode: SessionMode) => void;
}) {
  const current = findModel(modelId, models);
  const modeMeta = SESSION_MODES.find((m) => m.id === mode);
  return (
    <div className="picker">
      <button className="btn ghost picker-btn" onClick={onToggle} title={current?.description}>
        <span className="picker-name">{displayName(modelId, models)}</span>
        {current?.supportsReasoningEffort && <span className="picker-effort">({effortLabel(effort)})</span>}
        {mode !== "default" && <span className="badge latest">{modeMeta?.label ?? mode}</span>}
      </button>
      {open && (
        <>
          <div className="picker-back" onClick={onClose} />
          <div className="picker-menu">
            {models.map((m) => (
              <button
                key={m.id}
                className={`picker-item ${m.id === modelId ? "active" : ""}`}
                onClick={() => onSelect(m.id)}
              >
                <div className="picker-item-head">
                  <strong>{m.name}</strong>
                  {m.isLatest && <span className="badge latest">最新</span>}
                  {m.isDefault && <span className="badge">默认</span>}
                  {m.contextWindow ? <span className="meta">{formatContext(m.contextWindow)}</span> : null}
                </div>
                {m.description && <div className="meta">{m.description}</div>}
              </button>
            ))}
            {current?.supportsReasoningEffort && current.efforts && (
              <div className="effort-row">
                <div className="section-label">推理力度</div>
                <div className="effort-chips">
                  {current.efforts.map((opt) => (
                    <button
                      key={opt.value}
                      className={`chip ${opt.value === effort ? "active" : ""}`}
                      title={opt.description}
                      onClick={() => onSelect(modelId, opt.value)}
                    >
                      {effortLabel(opt.value, opt.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="effort-row">
              <div className="section-label">模式</div>
              <div className="effort-chips">
                {SESSION_MODES.map((opt) => (
                  <button
                    key={opt.id}
                    className={`chip ${opt.id === mode ? "active" : ""}`}
                    title={opt.description}
                    onClick={() => onSelectMode(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BlockView({
  block,
  onEdit,
  onOpen,
  onMention,
}: {
  block: ChatBlock;
  onEdit?: (text: string) => void;
  onOpen?: (path: string) => void;
  onMention?: (path: string) => void;
}) {
  const [open, setOpen] = useState(block.tool?.status !== "completed");
  if (block.kind === "user") {
    return (
      <div className="block user">
        <div className="who-row">
          <div className="who">你</div>
          {block.text && onEdit && (
            <button
              type="button"
              className="text-btn"
              title="填回输入框。不会撤回已经发出的内容"
              onClick={() => onEdit(block.text)}
            >
              编辑
            </button>
          )}
        </div>
        {block.text ? <Markdown text={block.text} /> : null}
        {block.images?.map((image, index) => (
          <img
            key={index}
            className="prompt-image"
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={image.name || "图片"}
          />
        ))}
      </div>
    );
  }
  if (block.kind === "thought") {
    return (
      <div className="block thought">
        <div className="who thought">思考</div>
        {block.text}
      </div>
    );
  }
  if (block.kind === "tool" && block.tool) {
    return (
      <div className="block tool">
        <div className="tool-head" onClick={() => setOpen((v) => !v)}>
          <div className="left">
            <span className="kind">{block.tool.kind || "工具"}</span>
            <strong>{block.tool.title}</strong>
          </div>
          <span className={`status ${block.tool.status ?? ""}`}>{statusLabel(block.tool.status)}</span>
        </div>
        {block.tool.locations?.length ? (
          <div className="path-links">
            {block.tool.locations.map((loc) => (
              <span key={`${loc.path}:${loc.line ?? 0}`} className="path-link">
                <button type="button" onClick={() => onOpen?.(loc.path)}>
                  {loc.path}
                  {loc.line ? `:${loc.line}` : ""}
                </button>
                <button type="button" onClick={() => onMention?.(loc.path)}>
                  提起
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {open && Boolean(block.tool.contentPreview || block.tool.rawInput) && (
          <div className="tool-body">
            {block.tool.contentPreview || JSON.stringify(block.tool.rawInput, null, 2)}
          </div>
        )}
      </div>
    );
  }
  if (block.kind === "plan" && block.plan) {
    return (
      <div className="block plan">
        <div className="who">计划</div>
        <ul>
          {block.plan.map((entry, i) => (
            <li key={i} className={entry.status === "completed" ? "done" : ""}>
              {entry.content}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (block.kind === "system") {
    return <div className="block system">{block.text}</div>;
  }
  return (
    <div className="block">
      <div className="who agent">Grok</div>
      <Markdown text={block.text} />
    </div>
  );
}
