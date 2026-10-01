import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBlock, SlashCommand, UsageSnapshot } from "../shared/types";
import { parseCommands, parseUsage } from "./protocol";
import { replayUpdateDocument } from "./replay";

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
    const generated = raw.generated_title?.trim() ?? "";
    const summary = raw.session_summary?.trim() ?? "";
    return {
      id,
      cwd,
      title: generated || summary || "未命名对话",
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

export function searchSessionIds(query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: string[] = [];
  for (const disk of listDiskSessions()) {
    const dir = findSessionDir(disk.id, disk.cwd);
    if (!dir) continue;
    const file = join(dir, "updates.jsonl");
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").toLowerCase().includes(needle)) hits.push(disk.id);
    } catch {
      continue;
    }
    if (hits.length >= 80) break;
  }
  return hits;
}

export function loadTranscript(sessionId: string, cwd: string): ChatBlock[] {
  return loadSessionSnapshot(sessionId, cwd).blocks;
}

export function loadSessionSnapshot(sessionId: string, cwd: string): SessionSnapshot {
  const dir = findSessionDir(sessionId, cwd);
  const file = dir ? join(dir, "updates.jsonl") : "";
  if (!file || !existsSync(file)) return { blocks: [], commands: [] };
  return replayUpdateDocument(readFileSync(file, "utf8"), { parseUsage, parseCommands });
}

export function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}
