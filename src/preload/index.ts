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
  PermissionRequest,
  Project,
  PromptImage,
  SlashCommand,
  Thread,
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
  respondPermission: (requestId: number | string, optionId?: string, cancelled?: boolean): Promise<void> =>
    ipcRenderer.invoke("desktop:respond-permission", { requestId, optionId, cancelled }),
  gitStatus: (cwd: string): Promise<GitSnapshot> => ipcRenderer.invoke("desktop:git-status", cwd),
  gitDiff: (cwd: string, path?: string): Promise<string> =>
    ipcRenderer.invoke("desktop:git-diff", { cwd, path }),
  openPath: (target: string): Promise<string> => ipcRenderer.invoke("desktop:open-path", target),
  login: (): Promise<AuthStatus> => ipcRenderer.invoke("desktop:login"),
  window: (action: "min" | "max" | "close"): Promise<void> => ipcRenderer.invoke("desktop:window", action),
  onState: (fn: (state: DesktopState) => void) => on("desktop:state", fn),
  onAgent: (fn: (agent: AgentInfo | null) => void) => on("desktop:agent", fn),
  onTranscript: (fn: (payload: { threadId: string; blocks: ChatBlock[] }) => void) =>
    on("desktop:transcript", fn),
  onDiffs: (fn: (payload: { threadId: string; diffs: FileDiff[] }) => void) => on("desktop:diffs", fn),
  onPermission: (fn: (req: PermissionRequest) => void) => on("desktop:permission", fn),
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
