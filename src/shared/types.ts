export type ThreadStatus = "idle" | "running" | "error";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface Thread {
  id: string;
  projectId: string;
  sessionId: string | null;
  title: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  model?: string;
  reasoningEffort?: string;
  mode?: SessionMode;
  usage?: UsageSnapshot;
}

export interface UsageSnapshot {
  used: number;
  size: number;
}

/** Billed tokens for one user send, summed across the model calls in that turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  modelCalls: number;
}

export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
}

export type BlockKind =
  | "user"
  | "agent"
  | "thought"
  | "tool"
  | "plan"
  | "system"
  | "usage";

export interface ToolCallState {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  contentPreview?: string;
  diffs?: FileDiff[];
}

export interface PlanEntry {
  content: string;
  status?: string;
  priority?: string;
}

export interface FileDiff {
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface PromptImage {
  mimeType: string;
  data: string;
  name?: string;
}

export interface ChatBlock {
  id: string;
  kind: BlockKind;
  text: string;
  createdAt: number;
  streaming?: boolean;
  tool?: ToolCallState;
  plan?: PlanEntry[];
  images?: PromptImage[];
  turnUsage?: TurnUsage;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** `x.ai/exit_plan_mode`. a 批准, s 要求修改, q 放弃. */
export interface PlanApprovalRequest {
  requestId: number | string;
  sessionId: string;
  threadId?: string;
  toolCallId: string;
  planContent: string;
}

export interface UserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface UserQuestionItem {
  question: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

/** `x.ai/ask_user_question`. */
export interface UserQuestionRequest {
  requestId: number | string;
  sessionId: string;
  threadId?: string;
  toolCallId: string;
  mode: "default" | "plan";
  questions: UserQuestionItem[];
}

export interface ElicitField {
  name: string;
  label: string;
  required: boolean;
}

/** `x.ai/mcp/elicit`. */
export interface ElicitRequest {
  requestId: number | string;
  sessionId: string;
  threadId?: string;
  toolCallId: string;
  serverName: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  fields: ElicitField[];
}

export interface PermissionRequest {
  requestId: number | string;
  sessionId: string;
  threadId?: string;
  title: string;
  summary: string;
  toolCall?: ToolCallState;
  options: PermissionOption[];
}

export interface GitChange {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitSnapshot {
  branch: string;
  changes: GitChange[];
}

export interface AgentInfo {
  path: string;
  running: boolean;
  source: "settings" | "env" | "path" | "home" | "workspace";
  protocolVersion?: number;
  agentName?: string;
  version?: string;
  loadSession?: boolean;
  authRequired?: boolean;
}

export interface ReasoningOption {
  value: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  isLatest?: boolean;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
  defaultEffort?: string;
  efforts?: ReasoningOption[];
  source?: "catalog" | "live" | "custom";
}

export interface AuthStatus {
  kind: "account" | "api-key" | "none";
  email?: string;
  name?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
}

export type ApiBackend = "chat_completions" | "responses" | "messages";

export type SessionMode = "default" | "plan" | "ask";

export const TEXT_SCALES = [
  { id: 0.92, label: "较小" },
  { id: 1, label: "标准" },
  { id: 1.12, label: "舒适" },
  { id: 1.28, label: "大" },
  { id: 1.45, label: "更大" },
] as const;

export type TextScale = (typeof TEXT_SCALES)[number]["id"];

export function normalizeTextScale(value: unknown): TextScale {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  let best: TextScale = 1;
  let bestDist = Infinity;
  for (const step of TEXT_SCALES) {
    const dist = Math.abs(step.id - n);
    if (dist < bestDist) {
      best = step.id;
      bestDist = dist;
    }
  }
  return bestDist <= 0.08 ? best : 1;
}

export const SESSION_MODES: Array<{ id: SessionMode; label: string; description: string }> = [
  { id: "default", label: "常规", description: "按通常方式编写代码并运行工具" },
  { id: "plan", label: "计划", description: "先探索并写出计划，你批准后再改代码" },
  { id: "ask", label: "提问", description: "以更少的自主操作回答问题" },
];

export interface DesktopSettings {
  agentPath: string;
  alwaysApprove: boolean;
  model: string;
  reasoningEffort: string;
  mode: SessionMode;
  showThoughts: boolean;
  textScale: TextScale;
  outputDir: string;
  customBaseUrl: string;
  customModelId: string;
  customBackend: ApiBackend;
}

export interface DesktopState {
  projects: Project[];
  threads: Thread[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  settings: DesktopSettings;
}

export const defaultSettings = (): DesktopSettings => ({
  agentPath: "",
  alwaysApprove: false,
  model: "grok-4.7",
  reasoningEffort: "high",
  mode: "default",
  showThoughts: true,
  textScale: 1,
  outputDir: "",
  customBaseUrl: "",
  customModelId: "",
  customBackend: "chat_completions",
});

export const defaultState = (): DesktopState => ({
  projects: [],
  threads: [],
  activeProjectId: null,
  activeThreadId: null,
  settings: defaultSettings(),
});
