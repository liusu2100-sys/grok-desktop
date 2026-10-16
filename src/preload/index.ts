import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentInfo,
  AuthStatus,
  ChatBlock,
  DesktopSettings,
  DesktopState,
  SessionMode,
  FileDiff,
  GitSnapshot,
  ModelInfo,
  ElicitRequest,
  PermissionRequest,
  PlanApprovalRequest,
  Project,
  PromptImage,
  SlashCommand,
  Thread,
  UserQuestionRequest,
} from "../shared/types";

const api = {
  platform: process.platform,
  getState: (): Promise<DesktopState> => ipcRenderer.invoke("desktop:get-state"),
  getAgent: (): Promise<AgentInfo | null> => ipcRenderer.invoke("desktop:get-agent"),
  getTranscript: (threadId: string): Promise<ChatBlock[]> =>
    ipcRenderer.invoke("desktop:get-transcript", threadId),
  getDiffs: (threadId: string): Promise<FileDiff[]> => ipcRenderer.invoke("desktop:get-diffs", threadId),
  getCommands: (threadId: string): Promise<SlashCommand[]> =>
    ipcRenderer.invoke("desktop:get-commands", threadId),
  startAgent: (): Promise<AgentInfo> => ipcRenderer.invoke("desktop:start-agent"),
  stopAgent: (): Promise<AgentInfo | null> => ipcRenderer.invoke("desktop:stop-agent"),
  updateSettings: (patch: Partial<DesktopSettings>): Promise<DesktopSettings> =>
    ipcRenderer.invoke("desktop:update-settings", patch),
  openProject: (): Promise<Project | null> => ipcRenderer.invoke("desktop:open-project"),
  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:pick-directory", current),
  ensureOutputProject: (): Promise<Project | null> => ipcRenderer.invoke("desktop:ensure-output-project"),
  addProjectPath: (path: string): Promise<Project> => ipcRenderer.invoke("desktop:add-project-path", path),
  removeProject: (projectId: string): Promise<void> => ipcRenderer.invoke("desktop:remove-project", projectId),
  setActive: (payload: { projectId?: string | null; threadId?: string | null }): Promise<DesktopState> =>
    ipcRenderer.invoke("desktop:set-active", payload),
  newThread: (projectId: string): Promise<Thread> => ipcRenderer.invoke("desktop:new-thread", projectId),
  deleteThread: (threadId: string): Promise<void> => ipcRenderer.invoke("desktop:delete-thread", threadId),
  listModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke("desktop:list-models"),
  setModel: (modelId: string, threadId?: string | null, reasoningEffort?: string): Promise<void> =>
    ipcRenderer.invoke("desktop:set-model", { modelId, threadId, reasoningEffort }),
  setMode: (modeId: SessionMode, threadId?: string | null): Promise<void> =>
    ipcRenderer.invoke("desktop:set-mode", { modeId, threadId }),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("desktop:auth-status"),
  logout: (): Promise<AuthStatus> => ipcRenderer.invoke("desktop:logout"),
  saveApi: (payload: {
    apiKey: string;
    signOutAccount?: boolean;
    customBaseUrl?: string;
    customModelId?: string;
    customBackend?: DesktopSettings["customBackend"];
  }): Promise<AuthStatus> => ipcRenderer.invoke("desktop:save-api", payload),
  clearApi: (): Promise<AuthStatus> => ipcRenderer.invoke("desktop:clear-api"),
  importSessions: (projectId: string): Promise<Thread[]> =>
    ipcRenderer.invoke("desktop:import-sessions", projectId),
  refreshHistory: (): Promise<DesktopState> => ipcRenderer.invoke("desktop:refresh-history"),
  sendPrompt: (threadId: string, text: string, images?: PromptImage[]): Promise<void> =>
    ipcRenderer.invoke("desktop:send-prompt", { threadId, text, images: images ?? [] }),
  cancel: (threadId: string): Promise<void> => ipcRenderer.invoke("desktop:cancel", threadId),
  respondPermission: (requestId: number | string, optionId?: string, cancelled?: boolean): Promise<boolean> =>
    ipcRenderer.invoke("desktop:respond-permission", { requestId, optionId, cancelled }),
  respondPlan: (
    requestId: number | string,
    outcome: "approved" | "cancelled" | "abandoned",
    feedback?: string,
  ): Promise<boolean> => ipcRenderer.invoke("desktop:respond-plan", { requestId, outcome, feedback }),
  respondQuestion: (payload: {
    requestId: number | string;
    outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
    answers?: Record<string, string[]>;
    partialAnswers?: Record<string, string>;
  }): Promise<boolean> => ipcRenderer.invoke("desktop:respond-question", payload),
  respondElicit: (payload: {
    requestId: number | string;
    outcome: "accept" | "decline" | "cancel";
    content?: Record<string, string>;
  }): Promise<boolean> => ipcRenderer.invoke("desktop:respond-elicit", payload),
  gitStatus: (cwd: string): Promise<GitSnapshot> => ipcRenderer.invoke("desktop:git-status", cwd),
  gitDiff: (cwd: string, path?: string): Promise<string> =>
    ipcRenderer.invoke("desktop:git-diff", { cwd, path }),
  gitStage: (cwd: string, paths?: string[]): Promise<void> =>
    ipcRenderer.invoke("desktop:git-stage", { cwd, paths }),
  gitDiscard: (cwd: string, paths?: string[]): Promise<void> =>
    ipcRenderer.invoke("desktop:git-discard", { cwd, paths }),
  searchHistory: (query: string): Promise<string[]> => ipcRenderer.invoke("desktop:search-history", query),
  openPath: (target: string): Promise<string> => ipcRenderer.invoke("desktop:open-path", target),
  openProjectFile: (cwd: string, path: string): Promise<string> =>
    ipcRenderer.invoke("desktop:open-project-file", { cwd, path }),
  login: (): Promise<AuthStatus> => ipcRenderer.invoke("desktop:login"),
  window: (action: "min" | "max" | "close"): Promise<void> => ipcRenderer.invoke("desktop:window", action),
  onState: (fn: (state: DesktopState) => void) => on("desktop:state", fn),
  onAgent: (fn: (agent: AgentInfo | null) => void) => on("desktop:agent", fn),
  onTranscript: (fn: (payload: { threadId: string; blocks: ChatBlock[] }) => void) =>
    on("desktop:transcript", fn),
  onDiffs: (fn: (payload: { threadId: string; diffs: FileDiff[] }) => void) => on("desktop:diffs", fn),
  onPermission: (fn: (req: PermissionRequest) => void) => on("desktop:permission", fn),
  onPlanApproval: (fn: (req: PlanApprovalRequest) => void) => on("desktop:plan-approval", fn),
  onUserQuestion: (fn: (req: UserQuestionRequest) => void) => on("desktop:user-question", fn),
  onElicitation: (fn: (req: ElicitRequest) => void) => on("desktop:elicitation", fn),
  onInteractionResolved: (fn: (payload: { toolCallId: string }) => void) => on("desktop:interaction-resolved", fn),
  onInteractionsClear: (fn: () => void) => on("desktop:interactions-clear", fn),
  onPendingDismissed: (fn: (payload: { requestIds: Array<number | string> }) => void) =>
    on("desktop:pending-dismissed", fn),
  onError: (fn: (message: string) => void) => on("desktop:error", fn),
  onLog: (fn: (line: string) => void) => on("desktop:log", fn),
  onModels: (fn: (models: ModelInfo[]) => void) => on("desktop:models", fn),
  onCommands: (fn: (payload: { threadId: string; commands: SlashCommand[] }) => void) =>
    on("desktop:commands", fn),
  onAuth: (fn: (auth: AuthStatus) => void) => on("desktop:auth", fn),
};

function on<T>(channel: string, fn: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("grok", api);

export type DesktopApi = typeof api;
