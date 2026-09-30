import type { ModelInfo, ReasoningOption } from "./types";
import raw from "./default-models.json";

interface CatalogFile {
  default: string;
  models: Array<{
    id: string;
    name: string;
    description?: string;
    context_window?: number;
    supports_reasoning_effort?: boolean;
    reasoning_effort?: string;
    reasoning_efforts?: Array<{
      value: string;
      label: string;
      description?: string;
      default?: boolean;
    }>;
  }>;
}

const catalog = raw as CatalogFile;

export const CATALOG_DEFAULT_MODEL = catalog.default;

export const CATALOG_MODELS: ModelInfo[] = catalog.models.map((m, index) => ({
  id: m.id,
  name: m.name,
  description: m.description,
  isDefault: m.id === catalog.default,
  isLatest: index === 0,
  contextWindow: m.context_window,
  supportsReasoningEffort: Boolean(m.supports_reasoning_effort),
  defaultEffort: m.reasoning_effort,
  efforts: m.reasoning_efforts as ReasoningOption[] | undefined,
  source: "catalog",
}));

export function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}

export function displayName(modelId?: string, models: ModelInfo[] = CATALOG_MODELS): string {
  if (!modelId) return models.find((m) => m.isDefault)?.name || "Grok";
  return models.find((m) => m.id === modelId)?.name || modelId;
}

export function findModel(modelId?: string, models: ModelInfo[] = CATALOG_MODELS): ModelInfo | undefined {
  if (!modelId) return models.find((m) => m.isDefault) ?? models[0];
  return models.find((m) => m.id === modelId);
}

export function mergeModelLists(live: ModelInfo[], custom?: ModelInfo): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const item of CATALOG_MODELS) byId.set(item.id, { ...item });
  for (const item of live) {
    const existing = byId.get(item.id);
    if (existing) {
      byId.set(item.id, {
        ...existing,
        ...item,
        name: existing.name || item.name,
        description: existing.description || item.description,
        efforts: item.efforts?.length ? item.efforts : existing.efforts,
        contextWindow: item.contextWindow || existing.contextWindow,
        supportsReasoningEffort: item.supportsReasoningEffort ?? existing.supportsReasoningEffort,
        isLatest: existing.isLatest,
        source: existing.source,
      });
    } else {
      byId.set(item.id, { ...item, source: item.source ?? "live" });
    }
  }
  const ordered: ModelInfo[] = [];
  for (const known of CATALOG_MODELS) {
    const item = byId.get(known.id);
    if (item) {
      ordered.push(item);
      byId.delete(known.id);
    }
  }
  if (custom && !byId.has(custom.id)) ordered.push(custom);
  for (const extra of byId.values()) ordered.push(extra);
  const defaultId = live.find((m) => m.isDefault)?.id ?? CATALOG_DEFAULT_MODEL;
  return ordered.map((m) => ({ ...m, isDefault: m.id === defaultId }));
}
