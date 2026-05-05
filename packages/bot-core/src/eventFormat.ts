/**
 * Format an `AgentEvent` (from the daemon's `/ws` stream) into the
 * curated body that should be posted to the chat. Only the events
 * operators care about turn into chat lines; everything else (raw
 * stdout, every individual tool call / result, message_deltas, usage
 * metrics) returns null and the caller drops them.
 *
 * Side effects: updates `state.latestOptions` for `ask` /
 * `permission_request` events (so a numeric reply resolves cleanly)
 * and `state.awaitingDone` for `progress { done: true }`.
 */

import type { AgentEvent } from "@agentd/contracts";
import type { BotContext } from "./types.ts";

export function formatTaskEvent(
  ctx: BotContext,
  taskId: string,
  ev: AgentEvent,
): string | null {
  const fmt = ctx.adapter.fmt;
  const tag = fmt.code(taskId.slice(-8));
  if (ev.kind === "message" && ev.role === "agent") {
    const txt = ev.text.trim();
    if (txt.length === 0) return null;
    return `[${tag}] ${txt}`;
  }
  if (ev.kind === "progress") {
    if (ev.done) ctx.state.awaitingDone.add(taskId);
    const glyph = ev.done ? "✓ done" : "↻";
    return `${glyph} [${tag}] ${ev.text}`;
  }
  if (ev.kind === "share") {
    return `💭 [${tag}] ${ev.text}\n${fmt.italic(
      "(reply to steer; the agent will keep working unless you do)",
    )}`;
  }
  if (ev.kind === "ask") {
    ctx.state.latestOptions.set(taskId, ev.options);
    const numbered =
      ev.options.length > 0
        ? "\n" + ev.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
        : "";
    return `❓ [${tag}] ${ev.prompt}${numbered}\n${fmt.italic(
      "reply with a number or your own answer — the agent is waiting.",
    )}`;
  }
  if (ev.kind === "answer") {
    return `↳ [${tag}] answered: ${ev.answer.slice(0, 200)}`;
  }
  if (ev.kind === "permission_request") {
    const opts = ["approve", "deny"];
    ctx.state.latestOptions.set(taskId, opts);
    return `❓ [${tag}] ${ev.tool} wants permission. Reply 1 to approve, 2 to deny — or write your reasoning.`;
  }
  if (ev.kind === "status") {
    if (
      ev.status === "done" ||
      ev.status === "failed" ||
      ev.status === "stopped" ||
      ev.status === "waiting_input"
    ) {
      const glyph =
        ev.status === "done"
          ? "✓"
          : ev.status === "failed"
            ? "✗"
            : ev.status === "stopped"
              ? "■"
              : "…";
      return `${glyph} [${tag}] ${ev.status}`;
    }
    return null;
  }
  if (ev.kind === "exit") {
    const code = ev.code;
    return `${code === 0 ? "✓" : "✗"} [${tag}] exited code=${code ?? "?"}`;
  }
  // message_delta / message_end / tool_call / tool_result / raw / usage /
  // queue_updated / todos_updated / rate_limit / auto_compacted / system
  // messages — intentionally not mirrored.
  return null;
}
