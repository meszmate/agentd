import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { AgentdClient } from "@agentd/client";
import type { WsServerEvent } from "@agentd/contracts";
import {
  type BotAdapter,
  type BotButton,
  type BotContext,
  type Formatter,
  type IncomingMessage,
  type SendResult,
  createState,
  formatTaskEvent,
  handleIdeaQuestionPick,
  handleProjectPick,
  replyKey,
  routePlainText,
  runCommand,
} from "@agentd/bot-core";

interface BotConfig {
  token: string;
  server: string;
  session: string;
  allowedUserIds: Set<number>;
}

function parseIdList(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );
}

function loadConfig(): BotConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is required");
    process.exit(2);
  }
  const server = process.env.AGENTD_SERVER ?? "http://127.0.0.1:3773";
  const session = process.env.AGENTD_TOKEN ?? "";
  if (!session) {
    console.error("AGENTD_TOKEN is required (an agentd session token, not a pairing token)");
    process.exit(2);
  }
  const allowedUserIds = parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowedUserIds.size === 0) {
    console.error(
      "TELEGRAM_ALLOWED_USER_IDS must list at least one id. Use /whoami after launch to find yours.",
    );
  }
  return {
    token,
    server,
    session,
    allowedUserIds,
  };
}

/**
 * Escape MarkdownV2 reserved characters. Used by the suggestion-broadcast
 * path (which sends with `parse_mode: MarkdownV2` for nicer styling). The
 * adapter's plain-mode sends don't need it — the body's `_` / `*` / `[`
 * just appear as literal characters in chat. That matches the previous
 * Telegram behavior on the event-routing path.
 */
function mvEscape(s: string): string {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (c) => `\\${c}`);
}

function chunkBy(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Telegram-side `BotAdapter` implementation. Sends in plain mode (no
 * parse_mode) — the markup characters from `fmt.*` show literally,
 * matching the previous bot's event-format behavior. The suggestion
 * broadcast (which DOES want rich styling + per-project bot routing)
 * lives in `main()` below and uses MarkdownV2 directly.
 */
function buildAdapter(globalBot: Bot): BotAdapter {
  const fmt: Formatter = {
    bold: (s) => `*${s}*`,
    italic: (s) => `_${s}_`,
    code: (s) => `\`${s}\``,
    codeBlock: (s) => `\`\`\`\n${s}\n\`\`\``,
    escape: (s) => s,
  };
  const send = async (
    chatId: string,
    text: string,
  ): Promise<SendResult> => {
    const id = Number(chatId);
    const parts = chunkBy(text, 3500);
    let firstId: number | null = null;
    for (const part of parts) {
      const sent = await globalBot.api.sendMessage(id, part);
      if (firstId == null) firstId = sent.message_id;
    }
    return { messageId: String(firstId ?? 0) };
  };
  return {
    platform: "telegram",
    fmt,
    chunkSize: 3500,
    sendMessage: send,
    sendCodeBlock: async (chatId, text) => {
      const id = Number(chatId);
      const parts = chunkBy(text, 3300);
      let firstId: number | null = null;
      for (const part of parts) {
        try {
          const sent = await globalBot.api.sendMessage(
            id,
            "```\n" + part + "\n```",
            { parse_mode: "MarkdownV2" },
          );
          if (firstId == null) firstId = sent.message_id;
        } catch {
          const sent = await globalBot.api.sendMessage(id, part);
          if (firstId == null) firstId = sent.message_id;
        }
      }
      return { messageId: String(firstId ?? 0) };
    },
    sendWithButtons: async (chatId, text, rows) => {
      const id = Number(chatId);
      const kb = new InlineKeyboard();
      for (const row of rows) {
        for (const btn of row) {
          kb.text(btn.label, btn.id);
        }
        kb.row();
      }
      const sent = await globalBot.api.sendMessage(id, text, {
        reply_markup: kb,
      });
      return { messageId: String(sent.message_id) };
    },
  };
}

async function main() {
  const cfg = loadConfig();
  const client = new AgentdClient(cfg.server, cfg.session);

  try {
    await client.health();
    await client.listTasks();
  } catch (e) {
    console.error(`agentd unreachable or session invalid: ${(e as Error).message}`);
    process.exit(2);
  }

  const bot = new Bot(cfg.token);
  const adapter = buildAdapter(bot);
  const state = createState();

  function isAllowed(_chatId: string, userId: string): boolean {
    if (cfg.allowedUserIds.size === 0) return false;
    const n = Number(userId);
    return Number.isFinite(n) && cfg.allowedUserIds.has(n);
  }

  const ctx: BotContext = { adapter, client, state, isAllowed };

  // Per-project bot cache keyed by token. Lets each project DM from
  // its own bot identity (different name, sound profile). Telegram-
  // specific — Discord uses one bot for all guilds.
  const projectBotsByToken = new Map<string, Bot>();
  function getProjectBot(token: string): Bot {
    let b = projectBotsByToken.get(token);
    if (!b) {
      b = new Bot(token);
      projectBotsByToken.set(token, b);
    }
    return b;
  }

  // Per-task project routing cache. Avoids hammering the API on every
  // event fan-out.
  const projectByTaskRouting = new Map<string, string | null>();
  async function projectForTask(taskId: string): Promise<{
    projectId: string;
    telegramBotToken: string | null;
    telegramChatId: string | null;
  } | null> {
    let projectId = projectByTaskRouting.get(taskId);
    if (projectId === undefined) {
      try {
        const { task } = await client.getTask(taskId);
        projectId = task.projectId ?? null;
        projectByTaskRouting.set(taskId, projectId);
      } catch {
        projectByTaskRouting.set(taskId, null);
        return null;
      }
    }
    if (!projectId) return null;
    try {
      const { project } = await client.getProject(projectId);
      return {
        projectId,
        telegramBotToken: project.telegramBotToken ?? null,
        telegramChatId: project.telegramChatId ?? null,
      };
    } catch {
      return null;
    }
  }

  // GC pickers older than 10 min. Same TTL as the picker's `expiresAt`.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of state.pending) if (v.expiresAt < now) state.pending.delete(k);
  }, 60_000);

  /**
   * Wrap a grammy ctx into a platform-agnostic `IncomingMessage`. The
   * `replyTo` link is what makes reply-thread routing work — the user
   * tapping "reply" on one of our previous messages routes back to
   * the right task / suggestion.
   */
  function wrapIncoming(grammyCtx: {
    chat?: { id: number };
    from?: { id: number };
    message?: {
      text?: string;
      reply_to_message?: { message_id: number; chat?: { id: number } };
    };
  }): IncomingMessage {
    const chatId = String(grammyCtx.chat?.id ?? "");
    const userId = String(grammyCtx.from?.id ?? "");
    const text = grammyCtx.message?.text ?? "";
    const replyTo = grammyCtx.message?.reply_to_message
      ? {
          chatId,
          messageId: String(grammyCtx.message.reply_to_message.message_id),
        }
      : null;
    return {
      chatId,
      userId,
      text,
      replyTo,
      isAllowed: isAllowed(chatId, userId),
      reply: async (t: string) => {
        const parts = chunkBy(t, 3500);
        let firstId: number | null = null;
        for (const part of parts) {
          const sent = await bot.api.sendMessage(Number(chatId), part);
          if (firstId == null) firstId = sent.message_id;
        }
        return { messageId: String(firstId ?? 0) };
      },
    };
  }

  // /whoami works for everyone — used to discover ids before allowlisting.
  bot.command("whoami", async (g) => {
    const msg = wrapIncoming(g);
    await msg.reply(
      `chat id: ${msg.chatId}\nuser id: ${msg.userId}\nallowed: ${msg.isAllowed ? "yes" : "no"}`,
    );
  });

  // Allowlist gate for everything else.
  bot.use(async (g, next) => {
    if (g.message?.text?.startsWith("/whoami")) return next();
    const userId = String(g.from?.id ?? "");
    const chatId = String(g.chat?.id ?? "");
    if (!isAllowed(chatId, userId)) {
      await g.reply(
        "not allowed. ask the operator to add this chat id and/or user id to the allowlist.",
      );
      return;
    }
    return next();
  });

  // Single command handler covers the whole verb set. Args = the text
  // after `/verb` (grammy gives this as `ctx.match`).
  const VERBS = [
    "start",
    "help",
    "new",
    "ls",
    "show",
    "use",
    "in",
    "stop",
    "diff",
    "log",
    "tpl",
    "run",
    "sched",
    "brainstorm",
    "plan",
    "mirrors",
    "mirror",
  ];
  for (const verb of VERBS) {
    bot.command(verb, async (g) => {
      const msg = wrapIncoming(g);
      const args = String(g.match ?? "");
      await runCommand(ctx, msg, verb, args);
    });
  }

  // Project-picker callback router. The `pp:<pendId>:<projectId>` shape
  // matches what `openProjectPicker` emits. `handleProjectPick` carries
  // out the verb-specific work; we just provide the `postBack` that
  // edits the original picker message and answers the callback query
  // so the spinner stops.
  bot.callbackQuery(/^pp:([^:]+):(.+)$/, async (g) => {
    const m = g.match;
    const pendId = m[1] ?? "";
    const projectId = m[2] ?? "";
    let acked = false;
    const postBack = async (text: string): Promise<void> => {
      if (!acked) {
        try {
          await g.answerCallbackQuery({ text: text.slice(0, 200) });
        } catch {
          // ignore — older callback ids time out, we still want the edit
        }
        acked = true;
        try {
          await g.editMessageText(text);
        } catch {
          // edit can fail if the message moved out of view — fall back to a fresh send
          try {
            await bot.api.sendMessage(Number(g.chat?.id ?? 0), text);
          } catch {
            // give up
          }
        }
        return;
      }
      try {
        await bot.api.sendMessage(Number(g.chat?.id ?? 0), text);
      } catch {
        // ignore
      }
    };
    await handleProjectPick(ctx, pendId, projectId, postBack);
  });

  // Idea-question callback router. Same shape as the project picker:
  // adapter decodes `iq:<suggestionId>:<optionIdx>` and hands chatId
  // off so the shared handler can re-fire brainstorm with the picked
  // clarification answer in the originating chat.
  bot.callbackQuery(/^iq:([^:]+):(\d+)$/, async (g) => {
    const m = g.match;
    const suggestionId = m[1] ?? "";
    const optionIdx = Number(m[2] ?? "");
    const chatId = String(g.chat?.id ?? "");
    let acked = false;
    const postBack = async (text: string): Promise<void> => {
      if (!acked) {
        try {
          await g.answerCallbackQuery({ text: text.slice(0, 200) });
        } catch {
          // expired callback — keep going so the edit still lands
        }
        acked = true;
        try {
          await g.editMessageText(text);
        } catch {
          try {
            await bot.api.sendMessage(Number(chatId || 0), text);
          } catch {
            // give up
          }
        }
        return;
      }
      try {
        await bot.api.sendMessage(Number(chatId || 0), text);
      } catch {
        // ignore
      }
    };
    await handleIdeaQuestionPick(
      ctx,
      chatId,
      suggestionId,
      optionIdx,
      postBack,
    );
  });

  // Plain-text routing: suggestions → steer → input.
  bot.on("message:text", async (g) => {
    if (g.message.text.startsWith("/")) return;
    const msg = wrapIncoming(g);
    await routePlainText(ctx, msg);
  });

  bot.catch((err) => {
    if (err.error instanceof GrammyError) console.error("grammy:", err.error.description);
    else if (err.error instanceof HttpError) console.error("http:", err.error.message);
    else console.error(err);
  });

  /**
   * Send a chat message tagged with the originating task. Records the
   * outbound message id in `state.replyMap` so the operator can reply
   * to it (Telegram threading) and we route the reply back as task
   * input via the shared `routePlainText`.
   */
  async function sendForTask(
    chatId: number,
    taskId: string,
    text: string,
    senderBot: Bot,
    projectId: string | null,
  ): Promise<void> {
    try {
      const sent = await senderBot.api.sendMessage(chatId, text.slice(0, 4000));
      state.replyMap.set(
        replyKey(String(chatId), String(sent.message_id)),
        taskId,
      );
      void client.reportDelivery(projectId ?? null, "telegram").catch(() => {});
    } catch (e) {
      console.error("notify failed:", (e as Error).message);
    }
  }

  // Push notifications. The shared `formatTaskEvent` handles event
  // formatting + state mutations; this layer adds the Telegram-specific
  // fan-out (focused chats + mirror target + per-project bot DM) and
  // the MarkdownV2-with-fallback suggestion broadcast.
  const ws = client.watch(null, async (event: WsServerEvent) => {
    if (event.type === "suggestion_created") {
      const sug = event.suggestion;
      const numbered = sug.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
      const body = [
        `💡 *${mvEscape(sug.title)}*`,
        "",
        mvEscape(sug.prompt.split("\n")[0] ?? ""),
        "",
        numbered.length > 0 ? mvEscape(numbered) : "",
        "",
        // Italic delimiters frame the prose, but everything INSIDE the
        // italic still has to escape MarkdownV2 reserved chars.
        `_${mvEscape(`Reply with a number, "skip", or just say what you want — e.g. "do option 2 with opus".`)}_`,
      ]
        .filter((s) => s.length > 0)
        .join("\n");

      // Brainstorm in agentd is a continuous mirror, not a notification
      // stream. The chat target IS the opt-in: configure a project's
      // telegramChatId (or set it via /brainstorm here) and brainstorm
      // events flow into that chat. Replies route back through the
      // shared text router. Projects without a chat target stay silent.
      let projectBot: Bot | null = null;
      let projectChatId: number | null = null;
      if (sug.projectId) {
        try {
          const { project } = await client.getProject(sug.projectId);
          if (project.telegramBotToken && project.telegramChatId) {
            projectBot = getProjectBot(project.telegramBotToken);
            const id = Number(project.telegramChatId);
            if (Number.isFinite(id)) projectChatId = id;
          } else if (project.telegramChatId) {
            const id = Number(project.telegramChatId);
            if (Number.isFinite(id)) projectChatId = id;
          } else {
            return;
          }
        } catch {
          return;
        }
      }

      const sendOne = async (chatId: number, sender: Bot): Promise<void> => {
        // Try MarkdownV2 first (preserves bold + italic). On failure,
        // strip every MV2 escape and retry as plain text. Better than
        // dropping a suggestion on the floor.
        try {
          const sent = await sender.api.sendMessage(chatId, body, {
            parse_mode: "MarkdownV2",
          });
          state.suggestionReplyMap.set(
            replyKey(String(chatId), String(sent.message_id)),
            sug.id,
          );
          state.lastSuggestionByChat.set(String(chatId), sug.id);
          void client.reportDelivery(sug.projectId ?? null, "telegram").catch(() => {});
        } catch (e) {
          const plain = body
            .replace(/\\([_*\[\]()~`>#+=|{}.!\-\\])/g, "$1")
            .replace(/[*_`]/g, "");
          try {
            const sent = await sender.api.sendMessage(chatId, plain);
            state.suggestionReplyMap.set(
              replyKey(String(chatId), String(sent.message_id)),
              sug.id,
            );
            state.lastSuggestionByChat.set(String(chatId), sug.id);
            void client.reportDelivery(sug.projectId ?? null, "telegram").catch(() => {});
          } catch (e2) {
            console.warn(
              `[telegram] suggestion notify dropped chat=${chatId}: ${(e2 as Error).message} (markdown try: ${(e as Error).message})`,
            );
          }
        }
      };

      if (projectChatId != null) {
        await sendOne(projectChatId, projectBot ?? bot);
      } else if (!sug.projectId) {
        // Ad-hoc suggestion (no project). Keep the legacy broadcast
        // for these so direct CLI invocations still surface.
        for (const chatId of cfg.allowedUserIds) {
          await sendOne(chatId, bot);
        }
      }
      return;
    }

    if (event.type === "suggestion_updated") {
      const sug = event.suggestion;
      for (const [chatId, id] of state.lastSuggestionByChat) {
        if (id === sug.id) state.lastSuggestionByChat.delete(chatId);
      }
      return;
    }

    if (event.type !== "event") return;
    const ev = event.event;
    const taskId = event.taskId;

    // Resolve fan-out targets: chats with this task /use'd, plus the
    // explicit mirrorTo chat, plus the project's per-bot DM (if set).
    const focusChats: number[] = [];
    for (const [chatId, focusedId] of state.focus) {
      if (focusedId === taskId) {
        const n = Number(chatId);
        if (Number.isFinite(n)) focusChats.push(n);
      }
    }
    let mirrorChat: number | null = null;
    try {
      const { task } = await client.getTask(taskId);
      if (task.mirrorTo?.platform === "telegram") {
        const id = Number(task.mirrorTo.chatId);
        if (Number.isFinite(id)) mirrorChat = id;
      }
    } catch {
      // task may have been removed mid-event; nothing to do
    }
    const projectRouting = await projectForTask(taskId);
    const allChats = new Set<number>([
      ...focusChats,
      ...(mirrorChat != null ? [mirrorChat] : []),
    ]);
    let projectBot: Bot | null = null;
    let projectChatId: number | null = null;
    if (projectRouting?.telegramBotToken && projectRouting.telegramChatId) {
      projectBot = getProjectBot(projectRouting.telegramBotToken);
      const id = Number(projectRouting.telegramChatId);
      if (Number.isFinite(id)) projectChatId = id;
    }
    if (allChats.size === 0 && projectChatId == null) return;

    const body = formatTaskEvent(ctx, taskId, ev);
    if (!body) return;

    const routedProjectId = projectRouting?.projectId ?? null;
    for (const chatId of allChats) {
      void sendForTask(chatId, taskId, body, bot, routedProjectId);
    }
    if (projectBot && projectChatId != null) {
      void sendForTask(projectChatId, taskId, body, projectBot, routedProjectId);
    }
  });
  ws.addEventListener("close", () => console.error("ws closed"));
  ws.addEventListener("error", () => console.error("ws error"));

  console.log(
    `telegram bot ready · server=${cfg.server} · ${cfg.allowedUserIds.size} allowed user(s)`,
  );
  await startWithConflictRetry(bot);
}

/**
 * Clear any webhook that's set on this bot before we start polling.
 *
 * A leftover webhook is the other common cause of 409s: as long as one
 * is configured, every `getUpdates` call fails forever (Telegram won't
 * let you mix the two delivery modes). `deleteWebhook` is idempotent —
 * returns `true` if there was nothing to clear — so it's safe to call
 * unconditionally. `drop_pending_updates: false` preserves any queued
 * updates so we still see messages sent during the swap.
 */
async function clearWebhookDefensively(bot: Bot): Promise<void> {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (e) {
    // Non-fatal: if the token is bad, bot.start() will surface it
    // properly. Just log and move on.
    console.warn(
      `telegram: deleteWebhook preflight failed (continuing): ${(e as Error).message}`,
    );
  }
}

/**
 * Wraps `bot.start()` so a 409 ("terminated by other getUpdates request")
 * doesn't crash the subprocess.
 *
 * 409 is purely environmental — it means another poller (another agentd
 * instance, a stale process, a configured webhook) is holding the slot.
 * Once that other party goes away we can claim it instantly, so the
 * right strategy is to retry indefinitely with bounded backoff rather
 * than give up. Giving up just burns the daemon's per-hour restart
 * budget (8 tries) and produces louder failure modes without helping.
 *
 * Backoff schedule: 35s, 35s, 70s, 140s, 280s, then steady at 300s.
 * The first two short retries cover the common case (stale poll, ~30s
 * TTL on Telegram's side). After that we back off so we don't spam
 * Telegram or the operator's logs while waiting for a live competitor
 * to go away.
 *
 * Only 409 is retried; any other error still propagates so fatal
 * config issues (bad token, network down) surface promptly.
 */
async function startWithConflictRetry(bot: Bot): Promise<void> {
  await clearWebhookDefensively(bot);
  const BACKOFF_MS = [35_000, 35_000, 70_000, 140_000, 280_000];
  const BACKOFF_CAP_MS = 300_000;
  let consecutiveConflicts = 0;
  while (true) {
    try {
      await bot.start();
      return;
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 409) {
        consecutiveConflicts += 1;
        const waitMs =
          BACKOFF_MS[consecutiveConflicts - 1] ?? BACKOFF_CAP_MS;
        // Loud the first couple of times so the operator notices, then
        // quiet down — at that point we're just waiting out a live
        // competing instance and repeating the same line every few
        // minutes adds nothing.
        const verbose = consecutiveConflicts <= 2;
        const msg = verbose
          ? `telegram: 409 conflict (another getUpdates poller holds the slot). ` +
            `Waiting ${waitMs / 1000}s for it to release. ` +
            `If this repeats, another agentd / bot instance is running with the same TELEGRAM_BOT_TOKEN. ` +
            `(consecutive=${consecutiveConflicts})`
          : `telegram: still 409 (consecutive=${consecutiveConflicts}), waiting ${waitMs / 1000}s`;
        console.error(msg);
        await new Promise((r) => setTimeout(r, waitMs));
        // Re-clear webhook on persistent conflict — if the other party
        // is actually a webhook that got (re)configured externally,
        // dropping it again lets us recover without a process restart.
        if (consecutiveConflicts % 5 === 0) {
          await clearWebhookDefensively(bot);
        }
        continue;
      }
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
