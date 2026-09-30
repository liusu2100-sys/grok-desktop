import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { AuthStatus, DesktopSettings } from "../shared/types";

function grokHome(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

function secretsPath(): string {
  return join(app.getPath("userData"), "secrets.json");
}

export function readAccount(): { email?: string; name?: string } | null {
  const file = join(grokHome(), "auth.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      { email?: string; first_name?: string; last_name?: string }
    >;
    const entry = Object.values(raw)[0];
    if (!entry) return null;
    const name = [entry.first_name, entry.last_name].filter(Boolean).join(" ").trim();
    return { email: entry.email, name: name || undefined };
  } catch {
    return null;
  }
}

export function getStoredApiKey(): string {
  const file = secretsPath();
  if (!existsSync(file)) return "";
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { apiKey?: string };
    return raw.apiKey?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveApiKey(apiKey: string): void {
  const file = secretsPath();
  mkdirSync(dirname(file), { recursive: true });
  if (!apiKey.trim()) {
    if (existsSync(file)) unlinkSync(file);
    return;
  }
  writeFileSync(file, JSON.stringify({ apiKey: apiKey.trim() }, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function authStatus(): AuthStatus {
  const account = readAccount();
  const apiKey = getStoredApiKey();
  const hint = apiKey ? `…${apiKey.slice(-4)}` : undefined;
  if (account?.email) {
    return {
      kind: "account",
      email: account.email,
      name: account.name,
      hasApiKey: Boolean(apiKey),
      apiKeyHint: hint,
    };
  }
  if (apiKey) {
    return { kind: "api-key", hasApiKey: true, apiKeyHint: hint };
  }
  return { kind: "none", hasApiKey: false };
}

export function runGrok(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      windowsHide: false,
      env: { ...process.env, ...(getStoredApiKey() ? { XAI_API_KEY: getStoredApiKey() } : {}) },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const CUSTOM_HEADER = "[model.desktop-custom]";

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function upsertCustomModel(settings: DesktopSettings, apiKey: string): void {
  const file = join(grokHome(), "config.toml");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const without = existing.replace(
    /\n?\[model\.desktop-custom\][\s\S]*?(?=\n\[|\n#|$)/,
    "",
  ).trimEnd();
  if (!settings.customBaseUrl.trim() || !settings.customModelId.trim()) {
    if (without !== existing.trimEnd()) {
      mkdirSync(grokHome(), { recursive: true });
      writeFileSync(file, `${without}\n`, "utf8");
    }
    return;
  }
  const block = [
    CUSTOM_HEADER,
    `model = "${escapeToml(settings.customModelId.trim())}"`,
    `base_url = "${escapeToml(settings.customBaseUrl.trim())}"`,
    `name = "Custom API"`,
    `api_backend = "${settings.customBackend}"`,
    apiKey ? `api_key = "${escapeToml(apiKey)}"` : `env_key = "XAI_API_KEY"`,
  ].join("\n");
  mkdirSync(grokHome(), { recursive: true });
  writeFileSync(file, `${without}\n\n${block}\n`, "utf8");
}
