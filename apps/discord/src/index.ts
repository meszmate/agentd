import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ButtonInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { AgentdClient } from "@agentd/client";
import type { DiscordGuildLite, WsServerEvent } from "@agentd/contracts";
import {
  type BotAdapter,
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
  allowedUserIds: Set<string>;
}

function parseIdList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function loadConfig(): BotConfig {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("DISCORD_BOT_TOKEN is required");
    process.exit(2);
  }
  const server = process.env.AGENTD_SERVER ?? "http://127.0.0.1:3773";
  const session = process.env.AGENTD_TOKEN ?? "";
  if (!session) {
    console.error("AGENTD_TOKEN is required (an agentd session token)");
    process.exit(2);
  }
  const allowedUserIds = parseIdList(process.env.DISCORD_ALLOWED_USER_IDS);
  if (allowedUserIds.size === 0) {
    console.error(
      "DISCORD_ALLOWED_USER_IDS must list at least one id. Use !whoami after launch to find yours.",
    );
  }
  return {
    token,
    server,
    session,
    allowedUserIds,
  };
}

function chunkBy(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function buttonStyle(style?: "primary" | "secondary" | "danger"): ButtonStyle {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
}

/**
 * Discord-side `BotAdapter`. Discord renders markdown natively, so the
 * formatters just emit literal markdown — `**bold**`, `_italic_`, etc.
 * Sends pack into 1900-char chunks (under the 2000-char message cap
 * with headroom for the chunk seam).
 */
function buildAdapter(bot: Client): BotAdapter {
  const fmt: Formatter = {
    bold: (s) => `**${s}**`,
    italic: (s) => `_${s}_`,
    code: (s) => `\`${s}\``,
    codeBlock: (s) => "```\n" + s + "\n```",
    escape: (s) => s,
  };

  const fetchSendable = (
    chatId: string,
  ): (TextBasedChannel & { send: (s: string | { content: string; components?: unknown[] }) => Promise<{ id: string }> }) | null => {
    const ch = bot.channels.cache.get(chatId);
    if (!ch || !("send" in ch)) return null;
    return ch as TextBasedChannel & {
      send: (s: string | { content: string; components?: unknown[] }) => Promise<{ id: string }>;
    };
  };

  const sendPlain = async (chatId: string, text: string): Promise<SendResult> => {
    const ch = fetchSendable(chatId);
    if (!ch) return { messageId: "" };
    const parts = chunkBy(text, 1900);
    let firstId: string | null = null;
    for (const part of parts) {
      const sent = await ch.send(part);
      if (firstId == null) firstId = sent.id;
    }
    return { messageId: firstId ?? "" };
  };

  return {
    platform: "discord",
    fmt,
    chunkSize: 1900,
    sendMessage: sendPlain,
    sendCodeBlock: async (chatId, text) => {
      const ch = fetchSendable(chatId);
      if (!ch) return { messageId: "" };
      const parts = chunkBy(text, 1800);
      let firstId: string | null = null;
      for (const part of parts) {
        const sent = await ch.send("```\n" + part + "\n```");
        if (firstId == null) firstId = sent.id;
      }
      return { messageId: firstId ?? "" };
    },
    sendWithButtons: async (chatId, text, rows) => {
      const ch = fetchSendable(chatId);
      if (!ch) return { messageId: "" };
      // Discord caps action rows at 5 buttons each, max 5 rows = 25
      // buttons. We get one row per project from bot-core (24 max
      // projects + 1 cancel row = 25), so flatten + repack into
      // 5-per-row groups to fit Discord's widget shape.
      const flat = rows.flat();
      const packedRows: ActionRowBuilder<ButtonBuilder>[] = [];
      let row = new ActionRowBuilder<ButtonBuilder>();
      let count = 0;
      for (const btn of flat.slice(0, 25)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(btn.id)
            .setLabel(btn.label.slice(0, 80))
            .setStyle(buttonStyle(btn.style)),
        );
        count += 1;
        if (count % 5 === 0) {
          packedRows.push(row);
          row = new ActionRowBuilder<ButtonBuilder>();
        }
      }
      if (row.components.length > 0) packedRows.push(row);
      const sent = await ch.send({
        content: text,
        components: packedRows,
      });
      return { messageId: sent.id };
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

  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  const adapter = buildAdapter(bot);
  const state = createState();

  function isAllowed(_chatId: string, userId: string): boolean {
    if (cfg.allowedUserIds.size === 0) return false;
    return cfg.allowedUserIds.has(userId);
  }

  const ctx: BotContext = { adapter, client, state, isAllowed };

  // GC pickers older than 10 min.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of state.pending) if (v.expiresAt < now) state.pending.delete(k);
  }, 60_000);

  // Per-task project routing cache. Used for the project's dedicated
  // discord channel + per-task thread (autoTaskThread).
  interface TaskRoute {
    projectId: string;
    channelId: string;
    threadId: string | null;
  }
  const projectByTaskRouting = new Map<string, string | null>();
  async function routeForTask(taskId: string): Promise<TaskRoute | null> {
    let projectId = projectByTaskRouting.get(taskId);
    let task;
    try {
      task = (await client.getTask(taskId)).task;
    } catch {
      return null;
    }
    if (projectId === undefined) {
      projectId = task.projectId ?? null;
      projectByTaskRouting.set(taskId, projectId);
    }
    if (!projectId) return null;
    try {
      const { project } = await client.getProject(projectId);
      if (!project.discordChannelId) return null;
      return {
        projectId,
        channelId: project.discordChannelId,
        threadId: task.discordThreadId ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Snapshot the current guild + text-channel list and post it to the
   * daemon so the web UI can render a real channel picker. The daemon
   * caches it; we re-post on Ready, channelCreate / Delete / Update,
   * and guildCreate / Delete.
   */
  async function reportChannels(): Promise<void> {
    const guilds: DiscordGuildLite[] = [];
    for (const [, g] of bot.guilds.cache) {
      const channels: DiscordGuildLite["channels"] = [];
      for (const [, ch] of g.channels.cache) {
        if (
          ch.type === ChannelType.GuildText ||
          ch.type === ChannelType.GuildAnnouncement ||
          ch.type === ChannelType.PublicThread ||
          ch.type === ChannelType.PrivateThread
        ) {
          channels.push({
            id: ch.id,
            name: ch.name,
            type: ch.type as number,
            parentId: "parentId" in ch ? (ch.parentId ?? null) : null,
          });
        }
      }
      channels.sort((a, b) => a.name.localeCompare(b.name));
      guilds.push({
        id: g.id,
        name: g.name,
        iconUrl: g.iconURL?.({ size: 64 }) ?? null,
        channels,
      });
    }
    guilds.sort((a, b) => a.name.localeCompare(b.name));
    try {
      await client.reportDiscordChannels(guilds);
    } catch (e) {
      console.error("failed to report channels:", (e as Error).message);
    }
  }

  bot.once(Events.ClientReady, (c) => {
    console.log(
      `discord bot ready as ${c.user.tag} · ${cfg.allowedUserIds.size} allowed user(s)`,
    );
    void reportChannels();
  });
  bot.on(Events.GuildCreate, () => void reportChannels());
  bot.on(Events.GuildDelete, () => void reportChannels());
  bot.on(Events.ChannelCreate, () => void reportChannels());
  bot.on(Events.ChannelDelete, () => void reportChannels());
  bot.on(Events.ChannelUpdate, () => void reportChannels());

  /**
   * Build an `IncomingMessage` from a Discord message. Reply-thread
   * routing via `message.reference` lets us match the user's reply
   * back to the original bot message in `state.replyMap` /
   * `state.suggestionReplyMap` — same flow as Telegram.
   */
  function wrapIncoming(msg: Message, text: string): IncomingMessage {
    const chatId = msg.channelId;
    const userId = msg.author.id;
    const ref = msg.reference;
    const replyTo =
      ref && ref.messageId
        ? { chatId: ref.channelId ?? chatId, messageId: ref.messageId }
        : null;
    return {
      chatId,
      userId,
      text,
      replyTo,
      isAllowed: isAllowed(chatId, userId),
      reply: async (t: string) => {
        const ch = msg.channel;
        if (!("send" in ch)) return { messageId: "" };
        const parts = chunkBy(t, 1900);
        let firstId: string | null = null;
        for (const part of parts) {
          const sent = await (
            ch as TextBasedChannel & {
              send: (s: string) => Promise<{ id: string }>;
            }
          ).send(part);
          if (firstId == null) firstId = sent.id;
        }
        return { messageId: firstId ?? "" };
      },
      react: async (emoji: string) => {
        await msg.react(emoji).catch(() => {});
      },
    };
  }

  /**
   * Discord uses `!` as the command prefix. Normalize: anything that
   * starts with `!` is a command; otherwise it's plain text routed
   * through the shared text router (which handles suggestion replies,
   * focused-task steering, mirror auto-detect).
   */
  bot.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.bot) return;
    const raw = msg.content.trim();
    if (!raw) return;

    // /whoami works for everyone — used to discover ids before allowlisting.
    if (raw === "!whoami" || raw === "/whoami") {
      const m = wrapIncoming(msg, raw);
      await m.reply(
        `channel id: ${m.chatId}\nuser id: ${m.userId}\nallowed: ${m.isAllowed ? "yes" : "no"}`,
      );
      return;
    }

    if (!isAllowed(msg.channelId, msg.author.id)) return;

    const isCommand = raw.startsWith("!") || raw.startsWith("/");
    if (isCommand) {
      const space = raw.indexOf(" ");
      const verb = (space > 0 ? raw.slice(1, space) : raw.slice(1)).toLowerCase();
      const args = space > 0 ? raw.slice(space + 1) : "";
      const m = wrapIncoming(msg, raw);
      const matched = await runCommand(ctx, m, verb, args);
      if (!matched) {
        await m.reply(
          `unknown command \`${verb}\`. send \`!help\` for the list.`,
        );
      }
      return;
    }

    // Plain-text routing: suggestions → steer → input.
    const m = wrapIncoming(msg, raw);
    await routePlainText(ctx, m);
  });

  /**
   * Project-picker button handler (+ the daemon's discord_* RPCs).
   * Buttons fire here regardless of which command opened the picker —
   * the `pp:` id format encodes the verb via the pending map.
   */
  bot.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const btn = interaction as ButtonInteraction;
    if (!isAllowed(btn.channelId ?? "", btn.user.id)) {
      await btn.reply({ content: "not allowed", ephemeral: true }).catch(() => {});
      return;
    }
    let updated = false;
    const postBack = async (text: string): Promise<void> => {
      if (!updated) {
        updated = true;
        try {
          await btn.update({ content: text.slice(0, 1900), components: [] });
        } catch {
          // The interaction may have already timed out — fall back to a fresh send.
          const ch = bot.channels.cache.get(btn.channelId ?? "");
          if (ch && "send" in ch) {
            await (ch as TextBasedChannel & {
              send: (s: string) => Promise<unknown>;
            })
              .send(text.slice(0, 1900))
              .catch(() => {});
          }
        }
        return;
      }
      const ch = bot.channels.cache.get(btn.channelId ?? "");
      if (ch && "send" in ch) {
        await (ch as TextBasedChannel & {
          send: (s: string) => Promise<unknown>;
        })
          .send(text.slice(0, 1900))
          .catch(() => {});
      }
    };
    const projectMatch = /^pp:([^:]+):(.+)$/.exec(btn.customId);
    if (projectMatch) {
      const pendId = projectMatch[1] ?? "";
      const projectId = projectMatch[2] ?? "";
      await handleProjectPick(ctx, pendId, projectId, postBack);
      return;
    }
    // Idea-question button. Encodes `iq:<suggestionId>:<optionIdx>`;
    // re-fires brainstorm with the operator's clarification answer
    // mirroring the project picker's hand-off pattern.
    const questionMatch = /^iq:([^:]+):(\d+)$/.exec(btn.customId);
    if (questionMatch) {
      const suggestionId = questionMatch[1] ?? "";
      const optionIdx = Number(questionMatch[2] ?? "");
      await handleIdeaQuestionPick(
        ctx,
        btn.channelId ?? "",
        suggestionId,
        optionIdx,
        postBack,
      );
      return;
    }
  });

  /**
   * Send a chat message tagged with the originating task. Records the
   * outbound message id in `state.replyMap` so the operator can reply
   * to it (Discord message reference) and we route the reply back as
   * task input via the shared `routePlainText`.
   */
  function sendForTask(
    chatId: string,
    taskId: string,
    text: string,
    projectId: string | null,
  ): void {
    const ch = bot.channels.cache.get(chatId);
    if (!ch || !("send" in ch)) return;
    void (ch as TextBasedChannel & {
      send: (s: string) => Promise<{ id: string }>;
    })
      .send(text.slice(0, 1900))
      .then((sent) => {
        state.replyMap.set(replyKey(chatId, sent.id), taskId);
        void client.reportDelivery(projectId ?? null, "discord").catch(() => {});
      })
      .catch((e: unknown) => console.error("notify failed:", e));
  }

  // Push notifications + daemon-driven Discord RPCs.
  const ws = client.watch(null, async (event: WsServerEvent) => {
    if (event.type === "suggestion_created") {
      // Project-scoped suggestion → mirror to the project's Discord
      // channel when one is configured. Without project routing we
      // skip Discord entirely (Telegram does the global-broadcast
      // role); Discord is channel-based with no obvious "everyone"
      // target.
      const sug = event.suggestion;
      if (!sug.projectId) return;
      let channelId: string | null = null;
      try {
        const { project } = await client.getProject(sug.projectId);
        channelId = project.discordChannelId ?? null;
      } catch {
        return;
      }
      if (!channelId) return;
      const fmt = adapter.fmt;
      const numbered = sug.options
        .map((o, i) => `${fmt.bold(`${i + 1}.`)} ${o}`)
        .join("\n");
      const body = [
        `💡 ${fmt.bold(sug.title)}`,
        sug.prompt.split("\n")[0] ?? "",
        "",
        numbered,
        "",
        fmt.italic(
          `Reply with a number or your own direction — picking spawns a task in a fresh worktree.`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
      const ch = bot.channels.cache.get(channelId);
      if (!ch || !("send" in ch)) return;
      try {
        const sent = await (ch as TextBasedChannel & {
          send: (s: string) => Promise<{ id: string }>;
        }).send(body.slice(0, 1900));
        state.suggestionReplyMap.set(
          replyKey(channelId, sent.id),
          sug.id,
        );
        state.lastSuggestionByChat.set(channelId, sug.id);
        void client.reportDelivery(sug.projectId ?? null, "discord").catch(() => {});
      } catch (e) {
        console.error("[discord] suggestion notify dropped:", (e as Error).message);
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

    if (event.type === "discord_test_send") {
      try {
        const ch = bot.channels.cache.get(event.channelId);
        if (!ch || !("send" in ch)) {
          await client.reportDiscordCommandResult(
            event.requestId,
            false,
            "channel not found in cache",
          );
          return;
        }
        await (ch as TextBasedChannel & {
          send: (s: string) => Promise<unknown>;
        }).send(event.text.slice(0, 1900));
        await client.reportDiscordCommandResult(event.requestId, true);
      } catch (e) {
        await client.reportDiscordCommandResult(
          event.requestId,
          false,
          (e as Error).message,
        );
      }
      return;
    }

    if (event.type === "discord_create_thread") {
      try {
        const ch = bot.channels.cache.get(event.channelId);
        if (!ch || ch.type !== ChannelType.GuildText) {
          await client.reportDiscordCommandResult(
            event.requestId,
            false,
            "parent channel not text or not in cache",
          );
          return;
        }
        const thread = await (
          ch as { threads: { create: (o: unknown) => Promise<{ id: string }> } }
        ).threads.create({
          name: event.name.slice(0, 100),
          autoArchiveDuration: 1440, // 1 day
          reason: "agentd: per-task thread",
        });
        await client.reportDiscordCommandResult(
          event.requestId,
          true,
          undefined,
          thread.id,
        );
      } catch (e) {
        await client.reportDiscordCommandResult(
          event.requestId,
          false,
          (e as Error).message,
        );
      }
      return;
    }

    if (event.type === "discord_archive_thread") {
      try {
        const t = await bot.channels.fetch(event.threadId).catch(() => null);
        if (
          !t ||
          (t.type !== ChannelType.PublicThread &&
            t.type !== ChannelType.PrivateThread)
        ) {
          await client.reportDiscordCommandResult(
            event.requestId,
            false,
            "thread not found",
          );
          return;
        }
        await (t as { setArchived: (a: boolean) => Promise<unknown> }).setArchived(true);
        await client.reportDiscordCommandResult(event.requestId, true);
      } catch (e) {
        await client.reportDiscordCommandResult(
          event.requestId,
          false,
          (e as Error).message,
        );
      }
      return;
    }

    if (event.type !== "event") return;
    const ev = event.event;
    const taskId = event.taskId;

    const body = formatTaskEvent(ctx, taskId, ev);
    if (!body) return;

    // Fan-out targets: focused channels + the project's dedicated
    // routing target (per-task thread if one exists, else the parent
    // channel). De-dup so a channel that's both focused AND the
    // project's target only gets one copy.
    const focusTargets = new Set<string>();
    for (const [channelId, focusedId] of state.focus.entries()) {
      if (focusedId === taskId) focusTargets.add(channelId);
    }
    // Mirror target (chat the operator pinned via /mirror) routes to
    // discord too — same shape as Telegram. For Discord, the chatId
    // is the channelId.
    let mirrorTarget: string | null = null;
    try {
      const { task } = await client.getTask(taskId);
      if (task.mirrorTo?.platform === "discord") {
        mirrorTarget = task.mirrorTo.chatId;
      }
    } catch {
      // task may have been removed mid-event; nothing to do
    }
    const route = await routeForTask(taskId);
    const projectTarget = route ? (route.threadId ?? route.channelId) : null;

    const seen = new Set<string>();
    const post = (channelId: string, projectId: string | null): void => {
      if (seen.has(channelId)) return;
      seen.add(channelId);
      sendForTask(channelId, taskId, body, projectId);
    };
    for (const channelId of focusTargets) {
      const pid = route && projectTarget === channelId ? route.projectId : null;
      post(channelId, pid);
    }
    if (mirrorTarget) post(mirrorTarget, null);
    if (projectTarget) post(projectTarget, route!.projectId);
  });
  ws.addEventListener("close", () => console.error("ws closed"));
  ws.addEventListener("error", () => console.error("ws error"));

  await bot.login(cfg.token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
