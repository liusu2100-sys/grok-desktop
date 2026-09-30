import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: Record<string, boolean>;
  };
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: Array<{ id: string; name?: string }>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: unknown;
  modes?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function formatAcpError(error: { code?: number; message?: string; data?: unknown }): string {
  const message = error.message || `ACP error ${error.code ?? ""}`;
  if (error.data === undefined || error.data === null) return message;
  const detail = typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  return detail && detail !== message ? `${message}: ${detail}` : message;
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrBuf = "";

  get running(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null);
  }

  start(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
    this.stop();
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...env, NO_COLOR: "1" },
    });
    this.proc = proc;
    this.nextId = 1;
    this.pending.clear();

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.onLine(line));

    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
      const parts = this.stderrBuf.split(/\r?\n/);
      this.stderrBuf = parts.pop() ?? "";
      for (const part of parts) {
        const text = part.trim();
        if (text) this.emit("stderr", text);
      }
    });

    proc.on("exit", (code, signal) => {
      const err = new Error(`代理已退出（${code ?? signal ?? "未知原因"}）`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
      this.emit("exit", { code, signal });
    });

    proc.on("error", (err) => {
      this.emit("error", err);
    });
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    for (const [, p] of this.pending) p.reject(new Error("代理已停止"));
    this.pending.clear();
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("代理还没有连接"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    const payload = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id: number | string, result: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number | string, message: string, code = -32000): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
    );
  }

  async initialize(): Promise<AcpInitializeResult> {
    return (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "grok-desktop",
        title: "Grok Build",
        version: "0.1.0",
      },
      _meta: {
        clientSource: "grok-desktop",
        clientType: "grok-desktop",
        clientVersion: "0.1.0",
      },
    })) as AcpInitializeResult;
  }

  async newSession(cwd: string, meta?: Record<string, unknown>): Promise<AcpSessionNewResult> {
    return (await this.request("session/new", {
      cwd,
      mcpServers: [],
      ...(meta ? { _meta: meta } : {}),
    })) as AcpSessionNewResult;
  }

  async loadSession(sessionId: string, cwd: string): Promise<unknown> {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async resumeSession(sessionId: string, cwd: string): Promise<unknown> {
    return this.request("session/resume", { sessionId, cwd, mcpServers: [] });
  }

  async prompt(
    sessionId: string,
    text: string,
    images: Array<{ mimeType: string; data: string }> = [],
  ): Promise<unknown> {
    const prompt: Array<Record<string, string>> = [];
    if (text.trim()) prompt.push({ type: "text", text });
    for (const image of images) {
      if (!image.data) continue;
      prompt.push({ type: "image", mimeType: image.mimeType || "image/png", data: image.data });
    }
    if (!prompt.length) throw new Error("消息是空的");
    return this.request("session/prompt", { sessionId, prompt });
  }

  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request("session/set_mode", { sessionId, modeId });
  }

  async setModel(sessionId: string, modelId: string, reasoningEffort?: string): Promise<unknown> {
    return this.request("session/set_model", {
      sessionId,
      modelId,
      ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
    });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  async listSessions(cwd: string): Promise<unknown> {
    return this.request("session/list", { cwd });
  }

  async listSessionsExt(cwd: string): Promise<unknown> {
    return this.extension("x.ai/session/list", {
      cwd,
      limit: 200,
      allowRelax: false,
      headless: "exclude",
    });
  }

  async listCommands(sessionId: string, cwd: string): Promise<unknown> {
    return this.extension("x.ai/commands/list", { sessionId, cwd, kind: "build" });
  }

  async listModels(): Promise<unknown> {
    return this.extension("x.ai/models/list", {});
  }

  async deleteSession(sessionId: string, cwd: string): Promise<unknown> {
    return this.extension("x.ai/session/delete", { sessionId, cwd });
  }

  /**
   * Custom ACP methods travel as JSON-RPC names prefixed with `_`.
   * The agent rejects the bare `x.ai/...` name with method-not-found.
   */
  private extension(method: string, params?: unknown): Promise<unknown> {
    const name = method.startsWith("_") ? method : `_${method}`;
    return this.request(name, params ?? {});
  }

  async authenticateApiKey(): Promise<unknown> {
    return this.request("authenticate", {
      methodId: "xai.api_key",
      _meta: { headless: true },
    });
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed[0] !== "{") {
      this.emit("stderr", trimmed);
      return;
    }
    let msg: {
      jsonrpc?: string;
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit("stderr", trimmed);
      return;
    }

    if (msg.id !== undefined && msg.method) {
      this.emit("request", { id: msg.id, method: msg.method, params: msg.params });
      return;
    }

    if (msg.method && msg.id === undefined) {
      this.emit("notification", { method: msg.method, params: msg.params });
      return;
    }

    if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
      const pending = this.pending.get(Number(msg.id));
      this.pending.delete(Number(msg.id));
      if (!pending) return;
      if (msg.error) {
        pending.reject(new Error(formatAcpError(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}
