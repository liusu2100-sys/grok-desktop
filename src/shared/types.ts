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
  | "system";

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
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
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
