import type {
  ChatBlock,
  FileDiff,
  PlanEntry,
  PromptImage,
  SlashCommand,
  ToolCallState,
  TurnUsage,
  UsageSnapshot,
} from "../shared/types";

export interface ReplayHooks {
  parseUsage: (update: Record<string, unknown>) => UsageSnapshot | null;
  parseCommands: (update: Record<string, unknown>) => SlashCommand[];
}

export interface ReplaySnapshot {
  blocks: ChatBlock[];
  usage?: UsageSnapshot;
  commands: SlashCommand[];
}

/** ACP image blocks carry base64 `data` and `mimeType`. Text blocks carry `text`. */
export function readUserContent(content: unknown): { text: string; images: PromptImage[] } {
  if (!content) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  if (typeof content !== "object") return { text: "", images: [] };
  const rec = content as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown };
  if (rec.type === "image" && typeof rec.data === "string" && rec.data) {
    const mimeType = typeof rec.mimeType === "string" && rec.mimeType ? rec.mimeType : "image/png";
    return { text: "", images: [{ mimeType, data: rec.data }] };
  }
  if ("text" in rec) return { text: String(rec.text ?? ""), images: [] };
  return { text: "", images: [] };
}

/**
 * The terminal omits these user echoes from scrollback. They are model-only
 * reminders, monitor wakes, or the blank separator those wakes used to emit.
 */
export function hiddenFromTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const start = text.trimStart();
  if (start.startsWith("<system-reminder>") || start.startsWith("<monitor-event")) return true;
  if (trimmed === "---") return true;
  const first = trimmed.split("\n", 1)[0] ?? "";
  return (
    /^\d/.test(first) && first.includes(" monitor events from ") && first.includes(" (use ")
  );
}

function finiteCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/**
 * Whole-turn bill from `turn_completed.usage` or the prompt response `_meta.usage`.
 * Those objects use camelCase. A last-call-only sibling uses the same names one level up;
 * callers pass the whole-prompt object so a multi-call turn is not undercounted.
 */
export function parseTurnUsage(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const inputTokens = finiteCount(row.inputTokens ?? row.input_tokens);
  const outputTokens = finiteCount(row.outputTokens ?? row.output_tokens);
  const cachedReadTokens = finiteCount(row.cachedReadTokens ?? row.cached_read_tokens);
  const reasoningTokens = finiteCount(row.reasoningTokens ?? row.reasoning_tokens);
  const modelCalls = finiteCount(row.modelCalls ?? row.model_calls);
  const reported = finiteCount(row.totalTokens ?? row.total_tokens);
  const totalTokens = reported || inputTokens + outputTokens;
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens,
    reasoningTokens,
    modelCalls,
  };
}

/** Prompt origins whose user echo the terminal keeps out of scrollback. */
export function hiddenPromptOrigin(promptId: string): boolean {
  return (
    promptId.startsWith("task-completed-") ||
    promptId.startsWith("subagent-completed-") ||
    promptId.startsWith("workflow-completed-") ||
    promptId.startsWith("notifications-") ||
    promptId.startsWith("goal-summary-") ||
    promptId.startsWith("goal-classifier-nudge-")
  );
}

function block(kind: ChatBlock["kind"], text: string): ChatBlock {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    text,
    createdAt: Date.now(),
    streaming: true,
  };
}

function contentText(content: unknown): string {
  const part = readUserContent(content);
  if (part.text) return part.text;
  if (part.images.length) return "［图片］";
  return "";
}

/**
 * Rebuild the visible transcript from `updates.jsonl`.
 * Each user text chunk is its own bubble. An image chunk with no text sticks
 * to the user bubble immediately before it, which is how one sent message is
 * stored. Agent text still concatenates across stream chunks.
 */
export function replayUpdateDocument(text: string, hooks: ReplayHooks): ReplaySnapshot {
  const blocks: ChatBlock[] = [];
  const tools = new Map<string, ChatBlock>();
  let agent: ChatBlock | null = null;
  let thought: ChatBlock | null = null;
  let usage: UsageSnapshot | undefined;
  let commands: SlashCommand[] = [];
  let openUser = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: { params?: { update?: Record<string, unknown>; _meta?: { promptId?: string } } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const update = row.params?.update;
    if (!update || typeof update !== "object") continue;
    const kind = String(update.sessionUpdate ?? "");
    if (kind === "user_message_chunk") {
      const promptId = String(row.params?._meta?.promptId ?? "");
      agent = null;
      thought = null;
      if (hiddenPromptOrigin(promptId)) {
        openUser = false;
        continue;
      }
      const part = readUserContent(update.content);
      if (part.images.length && !part.text.trim()) {
        const last = blocks[blocks.length - 1];
        if (openUser && last?.kind === "user") last.images = [...(last.images ?? []), ...part.images];
        else blocks.push({ ...block("user", ""), streaming: false, images: part.images });
        openUser = true;
        continue;
      }
      if (!part.text || hiddenFromTranscript(part.text)) {
        openUser = false;
        continue;
      }
      const user = block("user", part.text);
      user.streaming = false;
      if (part.images.length) user.images = part.images;
      blocks.push(user);
      openUser = true;
    } else if (kind === "agent_message_chunk") {
      openUser = false;
      const chunk = contentText(update.content);
      if (!chunk) continue;
      if (!agent) {
        agent = block("agent", chunk);
        blocks.push(agent);
      } else {
        agent.text += chunk;
      }
    } else if (kind === "agent_thought_chunk") {
      openUser = false;
      const chunk = contentText(update.content);
      if (!chunk) continue;
      if (!thought) {
        thought = block("thought", chunk);
        blocks.push(thought);
      } else {
        thought.text += chunk;
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      openUser = false;
      const tool = mergeTool(update);
      if (!tool.toolCallId) continue;
      const existing = tools.get(tool.toolCallId);
      if (existing?.tool) {
        existing.tool = { ...existing.tool, ...compactTool(tool) };
        existing.text = existing.tool.title;
      } else {
        const next = block("tool", tool.title || tool.toolCallId);
        next.tool = compactTool(tool);
        tools.set(tool.toolCallId, next);
        blocks.push(next);
      }
      agent = null;
      thought = null;
    } else if (kind === "plan") {
      openUser = false;
      const entries = (update.entries as PlanEntry[] | undefined) ?? [];
      const planText = entries.map((entry) => entry.content).join("\n");
      let planIndex = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === "user") break;
        if (blocks[i].kind === "plan") {
          planIndex = i;
          break;
        }
      }
      const current = planIndex >= 0 ? blocks[planIndex] : undefined;
      if (current) {
        current.text = planText;
        current.plan = entries;
      } else {
        blocks.push({ ...block("plan", planText), plan: entries });
      }
    } else if (kind === "turn_completed") {
      openUser = false;
      const turnUsage = parseTurnUsage(update.usage);
      if (turnUsage) blocks.push({ ...block("usage", ""), streaming: false, turnUsage });
    } else {
      openUser = false;
    }
    if (kind === "usage_update") {
      usage = hooks.parseUsage(update) ?? usage;
    } else if (kind === "available_commands_update") {
      const next = hooks.parseCommands(update);
      if (next.length) commands = next;
    }
  }

  return {
    blocks: blocks.map((item) => ({ ...item, streaming: false })),
    usage,
    commands,
  };
}

function compactTool(tool: ToolCallState): ToolCallState {
  return {
    ...tool,
    rawOutput: undefined,
    contentPreview: tool.contentPreview?.slice(0, 4000),
  };
}

function mergeTool(update: Record<string, unknown>): ToolCallState {
  const content = update.content as Array<Record<string, unknown>> | undefined;
  const diffs: FileDiff[] = [];
  let preview = "";
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "diff") {
        diffs.push({
          path: String(item.path ?? ""),
          oldText: (item.oldText as string | null) ?? null,
          newText: String(item.newText ?? ""),
        });
      } else if (item.type === "content" || item.type === "text") {
        preview += contentText(item.content ?? item.text);
      }
    }
  }
  return {
    toolCallId: String(update.toolCallId ?? ""),
    title: String(update.title ?? "tool"),
    kind: update.kind ? String(update.kind) : undefined,
    status: update.status ? String(update.status) : undefined,
    locations: update.locations as ToolCallState["locations"],
    rawInput: update.rawInput,
    contentPreview: preview || undefined,
    diffs: diffs.length ? diffs : undefined,
  };
}
