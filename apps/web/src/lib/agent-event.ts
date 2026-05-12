import type { AgentEvent, Message } from "@agentd/contracts";
import type { TaskPlanItem } from "@/views/TaskPlan";

/**
 * Shape an in-flight AgentEvent into the exact Message row the daemon
 * persists for it (apps/daemon/src/taskManager.ts:1283-1386). Returning
 * the same shape lets the realtime bus patch the qk.task cache the
 * moment an event lands so a tab-switch+return shows the chat already
 * up to date. The synthetic `live_` id keeps the row distinct until a
 * refetch replaces it with the real `msg_…` row from the DB.
 *
 * Returns null for kinds the daemon doesn't write as messages
 * (status, exit, usage, message_delta, etc.).
 */
export function shapeMessageFromEvent(
  event: AgentEvent,
  ts: number,
  taskId: string,
): Message | null {
  if (event.kind === "message" && event.role === "agent") {
    return {
      id: liveId(ts),
      taskId,
      role: "agent",
      content: event.text,
      ts,
    };
  }
  if (event.kind === "tool_call") {
    const persistedArgs =
      event.args &&
      typeof event.args === "object" &&
      !Array.isArray(event.args)
        ? (() => {
            const { codex_diff: _diff, ...rest } = event.args as Record<
              string,
              unknown
            >;
            if (event.parentToolUseId) rest._agentdParent = event.parentToolUseId;
            if (event.toolUseId) rest._agentdToolId = event.toolUseId;
            return rest;
          })()
        : event.args;
    return {
      id: liveId(ts),
      taskId,
      role: "tool",
      content: `[call ${event.tool}] ${JSON.stringify(persistedArgs ?? {}).slice(
        0,
        32_000,
      )}`,
      ts,
    };
  }
  if (event.kind === "raw" && event.stream === "stderr") {
    const text = event.text.trim();
    if (text.length === 0) return null;
    return {
      id: liveId(ts),
      taskId,
      role: "system",
      content: text,
      ts,
    };
  }
  if (event.kind === "tool_result") {
    const okFlag = event.ok ? "ok" : "err";
    const PERSIST_LIMIT = 1500;
    const raw = event.output;
    const trimmed =
      raw.length > PERSIST_LIMIT
        ? `${raw.slice(0, PERSIST_LIMIT)}\n… (${raw.length - PERSIST_LIMIT} more chars truncated)`
        : raw;
    const meta = [
      event.parentToolUseId ? `p:${event.parentToolUseId}` : null,
      event.toolUseId ? `u:${event.toolUseId}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const header = meta
      ? `[result ${event.tool} ${okFlag} ${meta}]`
      : `[result ${event.tool} ${okFlag}]`;
    return {
      id: liveId(ts),
      taskId,
      role: "tool",
      content: `${header} ${trimmed}`,
      ts,
    };
  }
  return null;
}

function liveId(ts: number): string {
  return `live_${ts}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Mirror of the parsePlan helper that used to live inside TaskDetail.
 * Both Claude (TodoWrite) and Codex (update_plan) ship the full plan
 * snapshot per call, so we replace the cached plan wholesale on every
 * matching tool_call.
 */
export function parsePlanFromTool(
  tool: string,
  args: unknown,
): TaskPlanItem[] | null {
  if (
    tool !== "TodoWrite" &&
    tool !== "todo_write" &&
    tool !== "update_plan" &&
    tool !== "UpdatePlan" &&
    tool !== "Plan"
  ) {
    return null;
  }
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const list =
    (Array.isArray(a.todos) && (a.todos as unknown[])) ||
    (Array.isArray(a.plan) && (a.plan as unknown[])) ||
    (Array.isArray(a.items) && (a.items as unknown[])) ||
    null;
  if (!list) return null;
  const out: TaskPlanItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const content = String(r.content ?? r.step ?? r.task ?? r.title ?? "").trim();
    if (!content) continue;
    const rawStatus = String(r.status ?? r.state ?? "pending").toLowerCase();
    const status: TaskPlanItem["status"] =
      rawStatus === "completed" ||
      rawStatus === "done" ||
      rawStatus === "complete"
        ? "completed"
        : rawStatus === "in_progress" ||
            rawStatus === "in-progress" ||
            rawStatus === "active" ||
            rawStatus === "running"
          ? "in_progress"
          : "pending";
    const item: TaskPlanItem = { content, status };
    if (typeof r.activeForm === "string" && r.activeForm) {
      item.activeForm = r.activeForm;
    }
    out.push(item);
  }
  return out;
}
