import type { ElicitField, ElicitRequest, PlanApprovalRequest, UserQuestionItem, UserQuestionOption, UserQuestionRequest } from "../shared/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function field(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Ext methods arrive either as `_x.ai/...` with the body at the top, or wrapped
 * as `{ method, params }` under that same name. `ext_method` uses the inner name.
 */
export function resolveClientCall(method: string, params: unknown): { method: string; params: unknown } {
  const name = method.startsWith("_") ? method.slice(1) : method;
  const top = asRecord(params);
  if (name === "ext_method" || name === "ext_notification") {
    const inner = typeof top?.method === "string" ? top.method : "";
    return { method: inner.startsWith("_") ? inner.slice(1) : inner, params: top?.params ?? {} };
  }
  if (top && typeof top.method === "string" && top.method.includes("/") && "params" in top) {
    const inner = top.method.startsWith("_") ? top.method.slice(1) : top.method;
    return { method: inner, params: top.params ?? {} };
  }
  return { method: name, params };
}

export function parsePlanApproval(requestId: number | string, params: unknown): Omit<PlanApprovalRequest, "threadId"> | null {
  const row = asRecord(params);
  if (!row) return null;
  const plan = row.planContent ?? row.plan_content;
  return {
    requestId,
    sessionId: field(row, "sessionId", "session_id"),
    toolCallId: field(row, "toolCallId", "tool_call_id"),
    planContent: typeof plan === "string" ? plan : "",
  };
}

function parseOption(raw: unknown): UserQuestionOption | null {
  const row = asRecord(raw);
  if (!row) return null;
  const label = field(row, "label");
  if (!label) return null;
  const preview = field(row, "preview");
  return { label, description: field(row, "description"), ...(preview ? { preview } : {}) };
}

function parseQuestion(raw: unknown): UserQuestionItem | null {
  const row = asRecord(raw);
  if (!row) return null;
  const options = Array.isArray(row.options) ? row.options.flatMap((item) => {
    const option = parseOption(item);
    return option ? [option] : [];
  }) : [];
  const multi = row.multiSelect ?? row.multi_select;
  return {
    question: field(row, "question"),
    options,
    multiSelect: multi === true,
  };
}

export function parseUserQuestion(requestId: number | string, params: unknown): Omit<UserQuestionRequest, "threadId"> | null {
  const row = asRecord(params);
  if (!row) return null;
  const mode = field(row, "mode") === "plan" ? "plan" : "default";
  const questions = Array.isArray(row.questions) ? row.questions.flatMap((item) => {
    const question = parseQuestion(item);
    return question ? [question] : [];
  }) : [];
  return {
    requestId,
    sessionId: field(row, "sessionId", "session_id"),
    toolCallId: field(row, "toolCallId", "tool_call_id"),
    mode,
    questions,
  };
}

function parseFields(schema: unknown): ElicitField[] {
  const row = asRecord(schema);
  const properties = asRecord(row?.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(row?.required) ? row.required.filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties).flatMap(([name, spec]) => {
    const meta = asRecord(spec);
    const label = (meta && (field(meta, "title") || field(meta, "description"))) || name;
    return [{ name, label, required: required.has(name) }];
  });
}

export function parseElicit(requestId: number | string, params: unknown): Omit<ElicitRequest, "threadId"> | null {
  const row = asRecord(params);
  if (!row) return null;
  const url = field(row, "url");
  const mode = field(row, "mode") === "url" || url ? "url" : "form";
  return {
    requestId,
    sessionId: field(row, "sessionId", "session_id"),
    toolCallId: field(row, "toolCallId", "tool_call_id"),
    serverName: field(row, "serverName", "server_name"),
    message: field(row, "message"),
    mode,
    ...(url ? { url } : {}),
    fields: mode === "form" ? parseFields(row.requestedSchema ?? row.requested_schema) : [],
  };
}
