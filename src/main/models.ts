import { CATALOG_MODELS, mergeModelLists } from "../shared/catalog";
import type { ModelInfo, ReasoningOption } from "../shared/types";
import { runGrok } from "./auth";

export function parseModelsOutput(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*[\*\-]\s+(\S+)/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const known = CATALOG_MODELS.find((m) => m.id === id);
    models.push({
      id,
      name: known?.name || id,
      isDefault: line.includes("(default)") || line.trim().startsWith("*"),
      source: "live",
    });
  }
  return models;
}

export async function listModelsFromCli(bin: string): Promise<ModelInfo[]> {
  const result = await runGrok(bin, ["models"]);
  return parseModelsOutput(`${result.stdout}\n${result.stderr}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEfforts(raw: unknown): ReasoningOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReasoningOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ value: item, label: item });
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    const value = String(rec.value ?? rec.id ?? "");
    if (!value) continue;
    out.push({
      value,
      label: String(rec.label ?? value),
      description: rec.description ? String(rec.description) : undefined,
      default: Boolean(rec.default),
    });
  }
  return out.length ? out : undefined;
}

function parseOneModel(id: string, value: unknown, isDefault: boolean): ModelInfo {
  const rec = asRecord(value) ?? {};
  const meta = asRecord(rec._meta) ?? asRecord(rec.meta) ?? {};
  const known = CATALOG_MODELS.find((m) => m.id === id);
  const efforts = parseEfforts(meta.reasoningEfforts ?? rec.reasoningEfforts) ?? known?.efforts;
  const context =
    Number(meta.totalContextTokens ?? rec.contextWindow ?? rec.context_window) || known?.contextWindow;
  return {
    id,
    name: String(rec.name ?? known?.name ?? id),
    description: rec.description ? String(rec.description) : known?.description,
    isDefault,
    isLatest: known?.isLatest,
    contextWindow: context || undefined,
    supportsReasoningEffort: Boolean(
      meta.supportsReasoningEffort ?? rec.supportsReasoningEffort ?? known?.supportsReasoningEffort,
    ),
    defaultEffort: String(meta.reasoningEffort ?? rec.reasoningEffort ?? known?.defaultEffort ?? ""),
    efforts,
    source: known ? "catalog" : "live",
  };
}

export function parseModelsListResponse(raw: unknown): ModelInfo[] {
  const root = asRecord(raw);
  if (!root) return [];
  const payload = asRecord(root.result) ?? root;
  const current = String(payload.currentModelId ?? payload.current_model_id ?? "");
  const available = payload.availableModels ?? payload.available_models ?? payload.models;
  const parsed: ModelInfo[] = [];
  if (Array.isArray(available)) {
    for (const item of available) {
      if (typeof item === "string") {
        parsed.push(parseOneModel(item, {}, item === current));
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      const id = String(rec.modelId ?? rec.id ?? "");
      if (!id) continue;
      parsed.push(parseOneModel(id, rec, id === current || Boolean(rec.isDefault)));
    }
  } else if (asRecord(available)) {
    for (const [id, value] of Object.entries(asRecord(available)!)) {
      parsed.push(parseOneModel(id, value, id === current));
    }
  }
  return parsed;
}

export function assembleModels(live: ModelInfo[], custom?: ModelInfo): ModelInfo[] {
  return mergeModelLists(live, custom);
}
