/**
 * Format an `AgentEvent` (from the daemon's `/ws` stream) into the
 * curated body that should be posted to the chat. We mirror the same
 * "meaningful" surface the dashboard renders: agent prose, tool calls
 * (one-line summaries), failed tool results, asks, permission
 * requests, progress / share notes, status transitions, rate-limit
 * warnings, and compaction events. The truly noisy events
 * (`message_delta`, `raw`, `usage`, `queue_updated`, `todos_updated`,
 * `system` messages, individual successful tool_results) return null
 * and the caller drops them.
 *
 * Side effects: updates `state.latestOptions` for `ask` /
 * `permission_request` events (so a numeric reply resolves cleanly)
 * and `state.awaitingDone` for `progress { done: true }`.
 */

import type { AgentEvent } from "@agentd/contracts";
import type { BotContext } from "./types.ts";

/**
 * Trim a path so chat output stays single-line readable. Keeps the
 * tail (file name + parent dir) which is what the operator actually
 * scans, drops everything before that with an ellipsis.
 */
function shortPath(p: string): string {
  if (p.length <= 60) return p;
  const parts = p.split("/");
  if (parts.length <= 2) return p.slice(-60);
  const tail = parts.slice(-2).join("/");
  return `…/${tail}`;
}

/**
 * One-line summary of a tool call, mirroring `parseToolCall` in
 * `apps/web/src/components/tool-line.tsx`. Each tool gets its
 * canonical "what is the agent operating on" snippet — same shape the
 * dashboard shows in the timeline. Unknown tools fall back to
 * `firstKey: firstValue`.
 */
function summarizeToolCall(tool: string, args: unknown): string {
  if (args == null || typeof args !== "object") return tool;
  const a = args as Record<string, unknown>;
  switch (tool) {
    case "Read": {
      const p = typeof a.file_path === "string" ? shortPath(a.file_path) : "";
      const off = typeof a.offset === "number" ? ` @${a.offset}` : "";
      const lim = typeof a.limit === "number" ? ` ×${a.limit}` : "";
      return `${tool} ${p}${off}${lim}`;
    }
    case "Write":
    case "NotebookEdit": {
      const p =
        typeof a.file_path === "string"
          ? shortPath(a.file_path)
          : typeof a.notebook_path === "string"
            ? shortPath(a.notebook_path)
            : "";
      return `${tool} ${p}`;
    }
    case "Edit":
    case "MultiEdit": {
      const p = typeof a.file_path === "string" ? shortPath(a.file_path) : "";
      const all = a.replace_all === true ? " (all)" : "";
      return `${tool} ${p}${all}`;
    }
    case "Bash": {
      const cmd = typeof a.command === "string" ? a.command : "";
      const firstLine = cmd.split("\n")[0] ?? "";
      const trimmed =
        firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
      return `${tool} ${trimmed}`;
    }
    case "Glob":
      return `${tool} ${typeof a.pattern === "string" ? a.pattern : ""}`;
    case "Grep": {
      const pat = typeof a.pattern === "string" ? a.pattern : "";
      const path = typeof a.path === "string" ? ` in ${shortPath(a.path)}` : "";
      return `${tool} ${pat}${path}`;
    }
    case "WebFetch":
      return `${tool} ${typeof a.url === "string" ? a.url : ""}`;
    case "WebSearch":
      return `${tool} ${typeof a.query === "string" ? a.query : ""}`;
    case "Task": {
      const sub =
        typeof a.subagent_type === "string" ? a.subagent_type : "agent";
      const desc =
        typeof a.description === "string" ? ` · ${a.description}` : "";
      return `${tool} ${sub}${desc}`;
    }
    case "TodoWrite": {
      const todos = Array.isArray(a.todos) ? a.todos.length : 0;
      return `${tool} ${todos} item${todos === 1 ? "" : "s"}`;
    }
    case "update_plan": {
      const plan = Array.isArray(a.plan) ? a.plan.length : 0;
      return `${tool} ${plan} step${plan === 1 ? "" : "s"}`;
    }
    default: {
      const keys = Object.keys(a);
      if (keys.length === 0) return tool;
      const k = keys[0]!;
      const v = a[k];
      const s =
        typeof v === "string"
          ? v.length > 80
            ? v.slice(0, 80) + "…"
            : v
          : JSON.stringify(v).slice(0, 80);
      return `${tool} ${k}: ${s}`;
    }
  }
}

/** Trim and clamp tool output for failed-result mirror lines. */
function summarizeToolOutput(text: string): string {
  const trimmed = text.replace(/\[[0-9;]*[mGKHF]/g, "").trim();
  if (trimmed.length === 0) return "(no output)";
  if (trimmed.length <= 400) return trimmed;
  return trimmed.slice(0, 400) + "…";
}

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
  if (ev.kind === "tool_call") {
    return `🔧 [${tag}] ${summarizeToolCall(ev.tool, ev.args)}`;
  }
  if (ev.kind === "tool_result") {
    // Successful tool results are dashboard-collapsed by default — they'd
    // flood the chat with unread noise. Failures, however, are usually
    // why the agent stalls; surface those.
    if (ev.ok) return null;
    return `✗ [${tag}] ${ev.tool} failed\n${fmt.codeBlock(summarizeToolOutput(ev.output))}`;
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
  if (ev.kind === "rate_limit") {
    // Allowed → quiet (the dashboard chip flips green silently). Warn /
    // exceeded → meaningful: the agent is about to / just hit a wall.
    if (ev.status === "allowed") return null;
    const resets = new Date(ev.resetsAt * 1000).toLocaleString();
    const overage = ev.isUsingOverage ? " · using overage" : "";
    return `⚠ [${tag}] rate limit ${ev.status} (${ev.rateLimitType}) — resets ${resets}${overage}`;
  }
  if (ev.kind === "auto_compacted") {
    const trigger = ev.trigger ?? "auto";
    const pre = ev.preTokens ? ` (was ${ev.preTokens.toLocaleString()} tokens)` : "";
    return `↻ [${tag}] context compacted (${trigger})${pre}`;
  }
  // message_delta / message_end / raw / usage / queue_updated /
  // todos_updated / system messages — intentionally not mirrored.
  return null;
}
