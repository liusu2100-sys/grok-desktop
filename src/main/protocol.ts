import type { ModelInfo, SlashCommand, UsageSnapshot } from "../shared/types";
import { parseModelsListResponse } from "./models";

export interface ListedSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  model?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function responseMeta(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  return asRecord(rec._meta) ?? asRecord(rec.meta);
}

export function modelStateFromInitialize(raw: unknown): ModelInfo[] {
  const meta = responseMeta(raw);
  if (!meta) return [];
  return parseModelsListResponse(meta.modelState ?? meta);
}

export function agentVersionFromInitialize(raw: unknown): string | undefined {
  const meta = responseMeta(raw);
  const version = meta?.agentVersion;
  return typeof version === "string" && version ? version : undefined;
}

export function parseUsage(update: Record<string, unknown>): UsageSnapshot | null {
  const used = Number(update.used);
  const size = Number(update.size);
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
  return { used, size };
}

export function commandsFromInitialize(raw: unknown): SlashCommand[] {
  const meta = responseMeta(raw);
  return parseCommands(meta?.availableCommands ?? meta);
}

export function parseCommands(raw: unknown): SlashCommand[] {
  const rec = asRecord(raw);
  const nested = asRecord(rec?.result);
  const list =
    rec?.commands ?? rec?.availableCommands ?? nested?.commands ?? nested?.availableCommands ?? raw;
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const item of list) {
    const row = asRecord(item);
    const name = String(row?.name ?? "");
    if (!name) continue;
    const input = asRecord(row?.input);
    const hint = typeof input?.hint === "string" ? input.hint : undefined;
    out.push({
      name: name.replace(/^\//, ""),
      description: row?.description ? String(row.description) : undefined,
      hint,
    });
  }
  return out;
}

function stamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

export function parseListedSessions(raw: unknown, cwd: string): ListedSession[] {
  const root = asRecord(raw);
  const payload = asRecord(root?.result) ?? root;
  const sessions = payload?.sessions ?? payload?.sessionSummaries;
  if (!Array.isArray(sessions)) return [];
  const out: ListedSession[] = [];
  for (const item of sessions) {
    const row = asRecord(item);
    if (!row) continue;
    const id = String(row.sessionId ?? row.id ?? "");
    if (!id) continue;
    const rowCwd = String(row.cwd ?? cwd);
    out.push({
      id,
      cwd: rowCwd || cwd,
      title: String(row.title || row.generatedTitle || row.summary || row.firstPrompt || "未命名对话"),
      updatedAt: stamp(row.updatedAt ?? row.lastActiveAt),
      createdAt: stamp(row.createdAt),
      model: row.modelId ? String(row.modelId) : row.currentModelId ? String(row.currentModelId) : undefined,
    });
  }
  return out;
}

export interface AppliedSessionConfig {
  model?: string;
  reasoningEffort?: string;
  mode?: "default" | "plan" | "ask";
}

export function readSessionConfig(raw: unknown): AppliedSessionConfig {
  const rec = asRecord(raw);
  const meta = responseMeta(raw);
  const applied: AppliedSessionConfig = {};
  const detail = meta ? asRecord(meta["x.ai/sessionDetail"]) : null;
  if (detail?.currentModelId) applied.model = String(detail.currentModelId);

  const grokConfig = meta ? asRecord(meta["x.ai/sessionConfig"]) : null;
  const grokOptions = grokConfig?.options;
  if (Array.isArray(grokOptions)) {
    for (const item of grokOptions) {
      const opt = asRecord(item);
      if (!opt?.selected) continue;
      if (opt.category === "model" && opt.id) applied.model = String(opt.id);
      if (opt.category === "mode" && opt.id) applied.reasoningEffort = String(opt.id);
    }
  }

  const acpOptions = rec?.configOptions;
  if (Array.isArray(acpOptions)) {
    for (const item of acpOptions) {
      const opt = asRecord(item);
      if (!opt) continue;
      const id = String(opt.id ?? "");
      const current = opt.currentValue ?? opt.value;
      if (typeof current !== "string" || !current) continue;
      if (id === "model") applied.model = current;
      if (id === "reasoning_effort") applied.reasoningEffort = current;
    }
  }

  const modes = asRecord(rec?.modes);
  const modeId = String(modes?.currentModeId ?? "");
  if (modeId === "default" || modeId === "plan" || modeId === "ask") applied.mode = modeId;
  return applied;
}
