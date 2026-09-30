import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultState, type DesktopState } from "../shared/types";

export function statePath(): string {
  return join(app.getPath("userData"), "desktop-state.json");
}

export function loadState(): DesktopState {
  const path = statePath();
  if (!existsSync(path)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopState>;
    const base = defaultState();
    return {
      ...base,
      ...raw,
      settings: { ...base.settings, ...(raw.settings ?? {}) },
      projects: raw.projects ?? [],
      threads: raw.threads ?? [],
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: DesktopState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}
