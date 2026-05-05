/**
 * Routes a plain-text message (no command prefix) to the right place:
 *
 *   1. A reply-to-suggestion-bubble or per-chat "latest suggestion"
 *      pointer → conversational suggestion reply (`replyToSuggestion`).
 *   2. A reply-to-task-message (or focused task / single-mirror match)
 *      → steer the task. Numeric replies map back to the most recent
 *      offered options. Single-word ack after a `done: true` progress
 *      note is treated as acknowledgement, not steer noise.
 *   3. Otherwise: ignore (don't echo).
 *
 * Returns true when a route fired (the message has been handled);
 * false when it should be dropped / passed elsewhere.
 */

import type { BotContext, IncomingMessage } from "./types.ts";
import { replyKey } from "./types.ts";

const ACK_RE = /^(y|yes|ok|okay|👍|cool|nice|done|good|sgtm)\b/i;

export async function routePlainText(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const text = msg.text.trim();
  if (!text) return;
  const chatId = msg.chatId;

  // ── Suggestions get first crack ──────────────────────────────
  let suggestionId: string | null = null;
  if (msg.replyTo) {
    suggestionId =
      ctx.state.suggestionReplyMap.get(
        replyKey(msg.replyTo.chatId, msg.replyTo.messageId),
      ) ?? null;
  }
  if (!suggestionId) {
    suggestionId = ctx.state.lastSuggestionByChat.get(chatId) ?? null;
  }
  if (suggestionId) {
    try {
      const r = await ctx.client.replyToSuggestion(suggestionId, text);
      if (r.kind === "spawned") {
        await msg.reply(
          `✓ spawning [${r.task.id.slice(-8)}] (${r.agent}${
            r.model ? "/" + r.model : ""
          }${
            r.thinkingLevel !== "high" ? ", " + r.thinkingLevel : ""
          }): ${r.task.title.slice(0, 100)}`,
        );
        if (ctx.state.lastSuggestionByChat.get(chatId) === suggestionId) {
          ctx.state.lastSuggestionByChat.delete(chatId);
        }
      } else if (r.kind === "dismissed") {
        await msg.reply("ok, skipped.");
        if (ctx.state.lastSuggestionByChat.get(chatId) === suggestionId) {
          ctx.state.lastSuggestionByChat.delete(chatId);
        }
      } else if (r.kind === "clarify") {
        await msg.reply(`🤔 ${r.question}`);
      } else {
        await msg.reply(`(suggestion ${r.reason})`);
      }
    } catch (e) {
      await msg.reply(`reply failed: ${(e as Error).message}`);
    }
    return;
  }

  // ── Task replies fall through to steer ──────────────────────
  let taskId: string | null = null;
  if (msg.replyTo) {
    taskId =
      ctx.state.replyMap.get(
        replyKey(msg.replyTo.chatId, msg.replyTo.messageId),
      ) ?? null;
  }
  if (!taskId) taskId = ctx.state.focus.get(chatId) ?? null;
  if (!taskId) {
    // Last-resort auto-detect: which task currently mirrors to this chat?
    try {
      const { tasks } = await ctx.client.listTasks();
      const matches = tasks.filter(
        (t) =>
          t.mirrorTo?.platform === ctx.adapter.platform &&
          t.mirrorTo.chatId === chatId &&
          !t.closedAt,
      );
      if (matches.length === 1) taskId = matches[0]!.id;
    } catch {
      // ignore — we'll just drop the message
    }
  }
  if (!taskId) return;

  let resolved = text;
  // Numeric reply that maps to a known option list resolves to the
  // option's text. Lets the user tap "1" to approve a permission
  // request without typing the word.
  const n = /^\d+$/.test(resolved) ? Number(resolved) : NaN;
  const opts = ctx.state.latestOptions.get(taskId);
  if (opts && Number.isFinite(n) && n >= 1 && n <= opts.length) {
    resolved = opts[n - 1]!;
    ctx.state.latestOptions.delete(taskId);
  }
  // Done-acknowledgement: a single "yes"/"ok"/"sgtm" right after a
  // `done: true` progress note shouldn't requeue.
  if (ctx.state.awaitingDone.has(taskId) && ACK_RE.test(resolved)) {
    ctx.state.awaitingDone.delete(taskId);
    await msg.reply("ack — task is closed-out on agentd.");
    return;
  }

  try {
    const r = await ctx.client.steerTask(taskId, resolved, "queue");
    await msg.reply(
      `→ ${r.mode} for ${taskId.slice(-8)}${
        r.queued > 1 ? ` (depth ${r.queued})` : ""
      }`,
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}
