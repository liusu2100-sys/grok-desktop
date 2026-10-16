import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInfo,
  AuthStatus,
  ChatBlock,
  DesktopSettings,
  DesktopState,
  FileDiff,
  GitChange,
  GitSnapshot,
  ElicitRequest,
  ModelInfo,
  PermissionRequest,
  PlanApprovalRequest,
  SessionMode,
  SlashCommand,
  TurnUsage,
  UserQuestionRequest,
} from "@shared/types";
import { defaultState, normalizeTextScale, SESSION_MODES, TEXT_SCALES } from "@shared/types";
import { CATALOG_MODELS, displayName, findModel, formatContext } from "@shared/catalog";
import { Markdown } from "./markdown";

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 10000) {
    const scaled = n / 1000;
    const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${text}k`;
  }
  return Math.round(n).toLocaleString("zh-CN");
}

function turnUsageText(usage: TurnUsage): string {
  const parts = [`输入 ${formatTokens(usage.inputTokens)}`, `输出 ${formatTokens(usage.outputTokens)}`];
  if (usage.reasoningTokens > 0) parts.push(`推理 ${formatTokens(usage.reasoningTokens)}`);
  if (usage.cachedReadTokens > 0) parts.push(`缓存 ${formatTokens(usage.cachedReadTokens)}`);
  if (usage.modelCalls > 1) parts.push(`${usage.modelCalls} 次调用`);
  return `本次请求 · ${parts.join(" · ")} · 合计 ${formatTokens(usage.totalTokens)}`;
}

function imageCarryNote(images: Array<{ data: string }>): string {
  const bytes = Math.round(images.reduce((sum, image) => sum + image.data.length, 0) * 0.75);
  const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `图片约 ${size}，会留在这条对话里，之后每一轮请求都会再带上`;
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

function dayBucket(ts: number): string {
  if (!ts) return "更早";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const diff = (start.getTime() - day.getTime()) / 86_400_000;
  if (diff < 1) return "今天";
  if (diff < 2) return "昨天";
  if (diff < 7) return "近 7 天";
  return "更早";
}

function threadWhen(ts: number): string {
  if (!ts) return "";
  const date = new Date(ts);
  const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (dayBucket(ts) === "今天") return clock;
  if (dayBucket(ts) === "昨天") return `昨天 ${clock}`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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

function upsertById<T extends { requestId: number | string }>(queue: T[], item: T): T[] {
  const index = queue.findIndex((entry) => entry.requestId === item.requestId);
  if (index === -1) return [...queue, item];
  const next = queue.slice();
  next[index] = item;
  return next;
}

function dropToolCall<T extends { toolCallId: string }>(queue: T[], toolCallId: string): T[] {
  if (!toolCallId) return queue;
  return queue.filter((item) => item.toolCallId !== toolCallId);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.disabled) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function dropRequestIds<T extends { requestId: number | string }>(queue: T[], requestIds: Array<number | string>): T[] {
  const ids = new Set(requestIds.map((id) => String(id)));
  return queue.filter((item) => !ids.has(String(item.requestId)));
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
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [bodyHits, setBodyHits] = useState<string[]>([]);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [plans, setPlans] = useState<PlanApprovalRequest[]>([]);
  const [questions, setQuestions] = useState<UserQuestionRequest[]>([]);
  const [elicits, setElicits] = useState<ElicitRequest[]>([]);
  const [planNote, setPlanNote] = useState("");
  const [planHint, setPlanHint] = useState("");
  const [questionPicks, setQuestionPicks] = useState<Record<number, string[]>>({});
  const [questionHint, setQuestionHint] = useState("");
  const [elicitValues, setElicitValues] = useState<Record<string, string>>({});
  const [elicitHint, setElicitHint] = useState("");
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
  const planRef = useRef<PlanApprovalRequest | null>(null);
  const answeringRef = useRef(false);
  const reviseRef = useRef<HTMLTextAreaElement>(null);
  const modalRef = useRef({ settings: false, confirm: false, discard: false });
  const shortcutRef = useRef<{
    newThread: () => Promise<void>;
    respond: (optionId?: string, cancelled?: boolean) => void;
    decidePlan: (outcome: "approved" | "abandoned") => void;
    revisePlan: () => void;
  }>({
    newThread: async () => undefined,
    respond: () => undefined,
    decidePlan: () => undefined,
    revisePlan: () => undefined,
  });

  const project = state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const thread = state.threads.find((t) => t.id === state.activeThreadId) ?? null;
  const outputDir = state.settings.outputDir.trim();
  const canCompose = Boolean(thread || project || outputDir);
  const isMac = window.grok.platform === "darwin";
  const perm = perms[0] ?? null;
  const plan = plans[0] ?? null;
  const question = questions[0] ?? null;
  const elicit = elicits[0] ?? null;
  const dockLabel = plan ? "等待你批准计划" : question ? "等待你回答" : perm || elicit ? "等待你确认工具" : null;

  function waitingText(threadId: string): string | null {
    if (plans.some((item) => item.threadId === threadId)) return "等待你批准计划";
    if (questions.some((item) => item.threadId === threadId)) return "等待你回答";
    if (perms.some((item) => item.threadId === threadId) || elicits.some((item) => item.threadId === threadId)) {
      return "等待你确认工具";
    }
    return null;
  }
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
  const projectRows = useMemo(() => {
    const latest = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const item of state.threads) {
      counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
      const prev = latest.get(item.projectId) ?? 0;
      if (item.updatedAt > prev) latest.set(item.projectId, item.updatedAt);
    }
    return [...state.projects]
      .sort((a, b) => {
        if (a.id === state.activeProjectId) return -1;
        if (b.id === state.activeProjectId) return 1;
        return (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0);
      })
      .map((item) => ({ ...item, count: counts.get(item.id) ?? 0 }));
  }, [state.projects, state.threads, state.activeProjectId]);
  const visibleProjects = projectsExpanded ? projectRows : projectRows.slice(0, 4);
  const hiddenProjects = projectRows.length - visibleProjects.length;

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
        setPerms((queue) => upsertById(queue, request));
        if (document.hidden) notify("需要你确认", request.title);
      }),
      window.grok.onPlanApproval((request) => {
        setPlans((queue) => upsertById(queue, request));
        if (document.hidden) notify("计划需要你决定", "批准、要求修改，或放弃");
      }),
      window.grok.onUserQuestion((request) => {
        setQuestions((queue) => upsertById(queue, request));
        if (document.hidden) notify("需要你回答", request.questions[0]?.question || "有一个问题在等你");
      }),
      window.grok.onElicitation((request) => {
        setElicits((queue) => upsertById(queue, request));
        if (document.hidden) notify("需要你确认", request.message || request.serverName || "外部工具");
      }),
      window.grok.onInteractionResolved(({ toolCallId }) => {
        setPlans((queue) => dropToolCall(queue, toolCallId));
        setQuestions((queue) => dropToolCall(queue, toolCallId));
        setElicits((queue) => dropToolCall(queue, toolCallId));
      }),
      window.grok.onInteractionsClear(() => {
        setPlans([]);
        setQuestions([]);
        setElicits([]);
        setPerms([]);
      }),
      window.grok.onPendingDismissed(({ requestIds }) => {
        setPlans((queue) => dropRequestIds(queue, requestIds));
        setQuestions((queue) => dropRequestIds(queue, requestIds));
        setElicits((queue) => dropRequestIds(queue, requestIds));
        setPerms((queue) => dropRequestIds(queue, requestIds));
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
  }, [blocks]);

  useEffect(() => {
    if (!dockLabel) return;
    composerRef.current?.blur();
  }, [dockLabel, plan?.requestId, question?.requestId, perm?.requestId, elicit?.requestId]);

  useEffect(() => {
    setPlanNote("");
    setPlanHint("");
  }, [plan?.requestId]);

  useEffect(() => {
    setQuestionPicks({});
    setQuestionHint("");
  }, [question?.requestId]);

  useEffect(() => {
    setElicitValues({});
    setElicitHint("");
  }, [elicit?.requestId]);

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
      if (!event.metaKey && !event.ctrlKey && !event.altKey && planRef.current) {
        const planKey = event.key.toLowerCase();
        if (planKey === "a" || planKey === "s" || planKey === "q") {
          event.preventDefault();
          if (planKey === "a") shortcutRef.current.decidePlan("approved");
          if (planKey === "q") shortcutRef.current.decidePlan("abandoned");
          if (planKey === "s") shortcutRef.current.revisePlan();
          return;
        }
      }
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

  async function respond(optionId?: string, cancelled = false) {
    const current = permRef.current;
    if (!current || answeringRef.current) return;
    answeringRef.current = true;
    const requestId = current.requestId;
    try {
      const ok = await window.grok.respondPermission(requestId, optionId, cancelled);
      if (!ok) return;
      setPerms((queue) => queue.filter((item) => item.requestId !== requestId));
    } finally {
      answeringRef.current = false;
    }
  }

  async function decidePlan(outcome: "approved" | "cancelled" | "abandoned", feedback?: string) {
    const current = planRef.current;
    if (!current || answeringRef.current) return;
    if (outcome === "cancelled" && !feedback?.trim()) {
      setPlanHint("写一下要改的地方，再点要求修改");
      reviseRef.current?.focus();
      return;
    }
    answeringRef.current = true;
    const requestId = current.requestId;
    try {
      const ok = await window.grok.respondPlan(requestId, outcome, feedback);
      if (!ok) {
        setPlanHint("没能送出，请再试一次");
        return;
      }
      setPlans((queue) => queue.filter((item) => item.requestId !== requestId));
      setPlanNote("");
      setPlanHint("");
    } finally {
      answeringRef.current = false;
    }
  }

  function revisePlan() {
    decidePlan("cancelled", planNote);
  }

  function answerKey(item: UserQuestionRequest["questions"][number], index: number): string {
    return item.question.trim() || `问题 ${index + 1}`;
  }

  async function submitQuestion(kind: "accepted" | "chat_about_this" | "skip_interview") {
    if (!question || answeringRef.current) return;
    const answers: Record<string, string[]> = {};
    const partialAnswers: Record<string, string> = {};
    question.questions.forEach((item, index) => {
      const labels = questionPicks[index] ?? [];
      if (!labels.length) return;
      const key = answerKey(item, index);
      answers[key] = labels;
      partialAnswers[key] = labels[0];
    });
    if (kind === "accepted" && !Object.keys(answers).length) {
      setQuestionHint("先选一个选项，或点取消");
      return;
    }
    const requestId = question.requestId;
    answeringRef.current = true;
    try {
      const ok = await window.grok.respondQuestion({
        requestId,
        outcome: kind,
        ...(kind === "accepted" ? { answers } : { partialAnswers }),
      });
      if (!ok) {
        setQuestionHint("没能送出，请再试一次");
        return;
      }
      setQuestions((queue) => queue.filter((item) => item.requestId !== requestId));
      setQuestionPicks({});
      setQuestionHint("");
    } finally {
      answeringRef.current = false;
    }
  }

  async function cancelQuestion() {
    if (!question || answeringRef.current) return;
    const requestId = question.requestId;
    answeringRef.current = true;
    try {
      const ok = await window.grok.respondQuestion({ requestId, outcome: "cancelled" });
      if (!ok) {
        setQuestionHint("没能送出，请再试一次");
        return;
      }
      setQuestions((queue) => queue.filter((item) => item.requestId !== requestId));
      setQuestionPicks({});
      setQuestionHint("");
    } finally {
      answeringRef.current = false;
    }
  }

  function toggleQuestionOption(index: number, label: string, multi: boolean) {
    setQuestionHint("");
    setQuestionPicks((prev) => {
      const current = prev[index] ?? [];
      if (!multi) return { ...prev, [index]: current[0] === label ? [] : [label] };
      const has = current.includes(label);
      return { ...prev, [index]: has ? current.filter((item) => item !== label) : [...current, label] };
    });
  }

  async function finishElicit(outcome: "accept" | "decline" | "cancel") {
    if (!elicit || answeringRef.current) return;
    const requestId = elicit.requestId;
    let content: Record<string, string> | undefined;
    if (outcome === "accept") {
      const missing = elicit.fields.filter((field) => field.required && !elicitValues[field.name]?.trim());
      if (missing.length) {
        setElicitHint(`请填写 ${missing.map((field) => field.label).join("、")}`);
        return;
      }
      content = {};
      for (const field of elicit.fields) {
        const value = elicitValues[field.name]?.trim();
        if (value) content[field.name] = value;
      }
    }
    answeringRef.current = true;
    try {
      const ok = await window.grok.respondElicit({ requestId, outcome, ...(content ? { content } : {}) });
      if (!ok) {
        setElicitHint("没能送出，请再试一次");
        return;
      }
      setElicits((queue) => queue.filter((item) => item.requestId !== requestId));
      setElicitValues({});
      setElicitHint("");
    } finally {
      answeringRef.current = false;
    }
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
  const turnBills = blocks.flatMap((block) => (block.kind === "usage" && block.turnUsage ? [block.turnUsage] : []));
  const lastTurn = turnBills[turnBills.length - 1];
  const sessionBilled = turnBills.reduce((sum, bill) => sum + bill.totalTokens, 0);
  const usagePct = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  const liveScale = normalizeTextScale(settingsOpen ? settingsDraft.textScale : state.settings.textScale);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--text-scale", String(liveScale));
  }, [liveScale]);

  function acceptSlash(cmd: SlashCommand) {
    setDraft(`/${cmd.name} `);
    setSlashIndex(0);
  }

  settingsOpenRef.current = settingsOpen;
  permRef.current = perm;
  planRef.current = plan;
  modalRef.current = {
    settings: settingsOpen,
    confirm: confirmDelete !== null,
    discard: confirmDiscard,
  };
  shortcutRef.current = { newThread, respond, decidePlan, revisePlan };

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
          {dockLabel && <span className="agent-pill wait">{dockLabel}</span>}
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
          <div className="side-actions">
            <button className="btn primary block" disabled={!canCompose || busy} onClick={() => void newThread()}>
              新对话
            </button>
            <button className="icon-btn folder-btn" title="打开文件夹" onClick={() => void openProject()}>
              +
            </button>
          </div>
          <div className="side-head">
            <h2>项目</h2>
          </div>
          <div className={`project-list ${projectsExpanded ? "expanded" : ""}`}>
            {visibleProjects.map((p) => (
              <div
                key={p.id}
                className={`item project-item ${p.id === state.activeProjectId ? "active" : ""}`}
                role="button"
                tabIndex={0}
                title={p.path}
                onClick={() => {
                  setHistoryScope("project");
                  if (thread?.projectId === p.id) {
                    void window.grok.setActive({ projectId: p.id });
                    return;
                  }
                  const latest = state.threads
                    .filter((item) => item.projectId === p.id)
                    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
                  void window.grok.setActive({ projectId: p.id, threadId: latest?.id ?? null });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  (e.currentTarget as HTMLDivElement).click();
                }}
              >
                <div className="name-row">
                  <span className="name">{p.name}</span>
                  {samePath(p.path, outputDir) ? <span className="badge">默认</span> : null}
                  {p.count > 0 ? <span className="count">{p.count}</span> : null}
                </div>
                <div className="meta">{shortPath(p.path)}</div>
              </div>
            ))}
            {!projectRows.length && (
              <div className="side-empty">{outputDir ? "将使用默认输出目录" : "打开一个文件夹，对话会按目录归在这里"}</div>
            )}
            {projectRows.length > 4 && (
              <button type="button" className="text-btn more-projects" onClick={() => setProjectsExpanded((v) => !v)}>
                {projectsExpanded ? "收起项目" : `还有 ${hiddenProjects} 个项目`}
              </button>
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
            {historyQuery && (
              <button type="button" className="text-btn search-clear" onClick={() => setHistoryQuery("")}>
                清除
              </button>
            )}
          </div>
          <div className="thread-list">
            {(() => {
              const groups: Array<{ label: string; items: typeof history }> = [];
              for (const item of history) {
                const label = dayBucket(item.updatedAt);
                const last = groups[groups.length - 1];
                if (last?.label === label) last.items.push(item);
                else groups.push({ label, items: [item] });
              }
              const showGroups = groups.length > 1;
              return groups.map((group) => (
                <div key={group.label}>
                  {showGroups && <div className="day-label">{group.label}</div>}
                  {group.items.map((t) => {
                    const folder = state.projects.find((p) => p.id === t.projectId);
                    const wait = waitingText(t.id);
                    return (
                      <div
                        key={t.id}
                        className={`item thread-item ${t.id === state.activeThreadId ? "active" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => void selectThread(t.id)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          void selectThread(t.id);
                        }}
                      >
                        <div className="thread-main">
                          <div className="name">{t.title}</div>
                          <div className="meta">
                            {wait ? (
                              <span className="badge run">{wait}</span>
                            ) : t.status === "running" ? (
                              <span className="badge run">进行中</span>
                            ) : null}
                            {historyScope === "all" && folder ? <span className="meta-folder">{folder.name}</span> : null}
                            <span className="meta-time">{threadWhen(t.updatedAt)}</span>
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
                </div>
              ));
            })()}
            {!history.length && (
              <div className="side-empty">
                {historyQuery
                  ? "没有匹配的对话"
                  : historyScope === "project" && project
                    ? "这个项目还没有对话"
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

          {dockLabel && (
            <div className="decision-dock">
              {question && (
                <QuestionCard
                  request={question}
                  queued={questions.length - 1}
                  picks={questionPicks}
                  hint={questionHint}
                  onToggle={toggleQuestionOption}
                  onSubmit={() => void submitQuestion("accepted")}
                  onChat={() => void submitQuestion("chat_about_this")}
                  onSkip={() => void submitQuestion("skip_interview")}
                  onCancel={() => void cancelQuestion()}
                />
              )}
              {plan && (
                <PlanDecisionCard
                  request={plan}
                  queued={plans.length - 1}
                  note={planNote}
                  hint={planHint}
                  reviseRef={reviseRef}
                  onNote={(value) => {
                    setPlanNote(value);
                    if (value.trim()) setPlanHint("");
                  }}
                  onDecide={(outcome) => void decidePlan(outcome, outcome === "cancelled" ? planNote : undefined)}
                />
              )}
              {elicit && (
                <ElicitCard
                  request={elicit}
                  queued={elicits.length - 1}
                  values={elicitValues}
                  hint={elicitHint}
                  onChange={(name, value) => {
                    setElicitValues((prev) => ({ ...prev, [name]: value }));
                    setElicitHint("");
                  }}
                  onOpen={(url) => void window.grok.openPath(url)}
                  onDecide={(outcome) => void finishElicit(outcome)}
                />
              )}
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
                        onClick={() => void respond(opt.optionId)}
                      >
                        {index < 9 ? `${index + 1}  ` : ""}
                        {opt.name}
                      </button>
                    ))}
                    <button className="btn ghost" onClick={() => void respond(undefined, true)}>
                      取消
                    </button>
                  </div>
                  <div className="perm-hint">1–9 选择 · Esc 取消</div>
                </div>
              )}
            </div>
          )}

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
              {images.length > 0 && <div className="attach-note">{imageCarryNote(images)}</div>}
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
                  dockLabel
                    ? "先处理上方的决定"
                    : project || thread
                      ? "让 Grok 构建、修复或审查…  输入 / 调用命令，可拖入图片"
                      : outputDir
                        ? "新对话会写到默认输出目录…  输入 / 调用命令，可拖入图片"
                        : "请先设置默认输出目录，或打开项目"
                }
                disabled={!canCompose || Boolean(dockLabel)}
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
                <span
                  className="model-chip"
                  title={
                    currentMode === "plan"
                      ? "计划模式会先读仓库并写计划，同一件事通常比常规多一轮工具调用"
                      : currentInfo?.description
                  }
                >
                  {displayName(currentModel, modelList)}
                  {currentInfo?.supportsReasoningEffort ? ` · ${effortLabel(currentEffort)}` : ""}
                  {currentMode !== "default" ? ` · ${modeLabel}` : ""}
                </span>
                {lastTurn && (
                  <span
                    className="usage"
                    title={`${turnUsageText(lastTurn)}。推理已包含在输出里，缓存是输入里命中的部分。本对话已统计 ${formatTokens(sessionBilled)}。`}
                  >
                    上次 {formatTokens(lastTurn.totalTokens)}
                  </span>
                )}
                {usage && (
                  <span
                    className={`usage ${usagePct >= 70 ? "warn" : ""}`}
                    title={`当前上下文 ${usage.used.toLocaleString("zh-CN")} / ${usage.size.toLocaleString("zh-CN")}。这是窗口占用，不是这一次请求的账单。`}
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
                    disabled={busy || thread?.status === "running" || Boolean(dockLabel)}
                    title="发送 /compact，腾出上下文"
                    onClick={() => void send("/compact")}
                  >
                    压缩上下文
                  </button>
                )}
                <button className="btn ghost" type="button" disabled={!canCompose || Boolean(dockLabel)} onClick={() => fileRef.current?.click()}>
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
                    disabled={busy || (!draft.trim() && images.length === 0) || !canCompose || Boolean(dockLabel)}
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

            <h3>界面</h3>
            <p className="help">
              字号立刻作用到整个窗口。点保存后记住；直接关闭则恢复原来的大小。对话正文、按钮和侧栏一起变。
            </p>
            <div className="scale-picks" role="radiogroup" aria-label="界面字号">
              {TEXT_SCALES.map((opt) => {
                const on = normalizeTextScale(settingsDraft.textScale) === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={on ? "on" : ""}
                    onClick={() => setSettingsDraft({ ...settingsDraft, textScale: opt.id })}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

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
  if (block.kind === "usage" && block.turnUsage) {
    return (
      <div
        className="turn-usage"
        title="推理已包含在输出里。缓存是输入里命中的部分，仍会计入输入。"
      >
        {turnUsageText(block.turnUsage)}
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

function PlanDecisionCard({
  request,
  queued,
  note,
  hint,
  reviseRef,
  onNote,
  onDecide,
}: {
  request: PlanApprovalRequest;
  queued: number;
  note: string;
  hint: string;
  reviseRef: { current: HTMLTextAreaElement | null };
  onNote: (value: string) => void;
  onDecide: (outcome: "approved" | "cancelled" | "abandoned") => void;
}) {
  const body = request.planContent.trim()
    ? request.planContent
    : "还没有写成计划。批准会离开计划模式并开始实现；要求修改会退回去重写；放弃会关掉计划模式。";
  return (
    <div className="decision">
      <h3>计划需要你决定</h3>
      {queued > 0 && <div className="perm-queue">还有 {queued} 条待决定</div>}
      <div className="decision-body">
        <Markdown text={body} />
      </div>
      <textarea
        ref={(node) => {
          reviseRef.current = node;
        }}
        className="decision-note"
        placeholder="要改哪里。要求修改时会把这段话退回给计划"
        value={note}
        onChange={(event) => onNote(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            onDecide("cancelled");
          }
        }}
      />
      {hint && <div className="perm-hint">{hint}</div>}
      <div className="perm-actions">
        <button className="btn primary" onClick={() => onDecide("approved")}>
          批准并实现
        </button>
        <button className="btn" onClick={() => onDecide("cancelled")}>
          要求修改
        </button>
        <button className="btn ghost" onClick={() => onDecide("abandoned")}>
          放弃
        </button>
      </div>
      <div className="perm-hint">a 批准并实现 · 写好意见后 s 要求修改 · q 放弃并退出计划 · Ctrl+Enter 发送修改</div>
    </div>
  );
}

function QuestionCard({
  request,
  queued,
  picks,
  hint,
  onToggle,
  onSubmit,
  onChat,
  onSkip,
  onCancel,
}: {
  request: UserQuestionRequest;
  queued: number;
  picks: Record<number, string[]>;
  hint: string;
  onToggle: (index: number, label: string, multi: boolean) => void;
  onSubmit: () => void;
  onChat: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="decision">
      <h3>需要你回答</h3>
      {queued > 0 && <div className="perm-queue">还有 {queued} 个问题待回答</div>}
      {request.questions.map((item, index) => {
        const selected = picks[index] ?? [];
        const chosen = item.options.find((option) => selected.length === 1 && option.label === selected[0]);
        return (
          <div key={`${item.question}-${index}`}>
            <div className="decision-q">{item.question || `问题 ${index + 1}`}</div>
            <div className="choice-list">
              {item.options.map((option) => (
                <button
                  key={option.label}
                  className={`choice ${selected.includes(option.label) ? "on" : ""}`}
                  onClick={() => onToggle(index, option.label, item.multiSelect)}
                >
                  {option.label}
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
            {chosen?.preview && <pre className="choice-preview">{chosen.preview}</pre>}
          </div>
        );
      })}
      {hint && <div className="perm-hint">{hint}</div>}
      <div className="perm-actions">
        <button className="btn primary" onClick={onSubmit}>
          提交
        </button>
        {request.mode === "plan" && (
          <button className="btn" onClick={onChat}>
            先讨论
          </button>
        )}
        {request.mode === "plan" && (
          <button className="btn" onClick={onSkip}>
            跳过提问
          </button>
        )}
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function ElicitCard({
  request,
  queued,
  values,
  hint,
  onChange,
  onOpen,
  onDecide,
}: {
  request: ElicitRequest;
  queued: number;
  values: Record<string, string>;
  hint: string;
  onChange: (name: string, value: string) => void;
  onOpen: (url: string) => void;
  onDecide: (outcome: "accept" | "decline" | "cancel") => void;
}) {
  return (
    <div className="decision">
      <h3>{request.serverName ? `${request.serverName} 需要确认` : "需要确认"}</h3>
      {queued > 0 && <div className="perm-queue">还有 {queued} 条待确认</div>}
      {request.message && <div className="decision-q">{request.message}</div>}
      {request.mode === "url" && request.url && (
        <div className="perm-actions">
          <button className="btn" onClick={() => onOpen(request.url || "")}>
            打开链接
          </button>
        </div>
      )}
      {request.fields.map((field) => (
        <label key={field.name} className="field-row">
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
          <input
            value={values[field.name] ?? ""}
            onChange={(event) => onChange(field.name, event.target.value)}
          />
        </label>
      ))}
      {hint && <div className="perm-hint">{hint}</div>}
      <div className="perm-actions">
        <button className="btn primary" onClick={() => onDecide("accept")}>
          {request.mode === "url" ? "已完成" : "接受"}
        </button>
        <button className="btn" onClick={() => onDecide("decline")}>
          拒绝
        </button>
        <button className="btn ghost" onClick={() => onDecide("cancel")}>
          取消
        </button>
      </div>
    </div>
  );
}
