import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  type ButtonInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { AgentdClient } from "@agentd/client";
import type { WsServerEvent } from "@agentd/contracts";

interface BotConfig {
  token: string;
  server: string;
  session: string;
  allowedChannelIds: Set<string>;
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
  const allowedChannelIds = parseIdList(process.env.DISCORD_ALLOWED_CHANNEL_IDS);
  const allowedUserIds = parseIdList(process.env.DISCORD_ALLOWED_USER_IDS);
  if (allowedChannelIds.size === 0 && allowedUserIds.size === 0) {
    console.error(
      "DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOWED_CHANNEL_IDS must list at least one id. Use !whoami to discover yours after launch.",
    );
  }
  return {
    token,
    server,
    session,
    allowedChannelIds,
    allowedUserIds,
  };
}

function chunk(text: string, size = 1900): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function send(channel: TextBasedChannel, text: string): Promise<void> {
  if (!("send" in channel)) return;
  for (const part of chunk(text)) {
    await channel.send(part);
  }
}

async function sendCode(channel: TextBasedChannel, text: string): Promise<void> {
  if (!("send" in channel)) return;
  for (const part of chunk(text, 1800)) {
    await channel.send("```\n" + part + "\n```");
  }
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

  // channelId → focused taskId
  const focus = new Map<string, string>();

  // Pending /new prompts waiting on a project button. key → prompt + chan + ts.
  interface PendingNew {
    prompt: string;
    channelId: string;
    expiresAt: number;
  }
  const pending = new Map<string, PendingNew>();
  const newPendingId = (): string => Math.random().toString(36).slice(2, 10);
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  }, 60_000);

  /**
   * Same two-axis rule as Telegram. If both lists are configured, BOTH must
   * match (channel allowed AND user allowed). If only one is configured, that
   * one alone gates access.
   */
  function isAllowed(channelId: string, userId: string): boolean {
    if (cfg.allowedChannelIds.size === 0 && cfg.allowedUserIds.size === 0) return false;
    const channelOk = cfg.allowedChannelIds.has(channelId);
    const userOk = cfg.allowedUserIds.has(userId);
    if (cfg.allowedChannelIds.size > 0 && cfg.allowedUserIds.size > 0) {
      return channelOk && userOk;
    }
    return channelOk || userOk;
  }

  bot.once(Events.ClientReady, (c) => {
    console.log(
      `discord bot ready as ${c.user.tag} · ${cfg.allowedUserIds.size} allowed user(s) · ${cfg.allowedChannelIds.size} allowed channel(s)`,
    );
  });

  bot.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.bot) return;
    const text = msg.content.trim();
    if (!text) return;
    const channel = msg.channel;
    const channelId = msg.channelId;

    const userId = msg.author.id;
    if (text === "!whoami") {
      await send(
        channel,
        `channel id: \`${channelId}\`\nuser id: \`${userId}\`\nallowed: ${isAllowed(channelId, userId) ? "yes" : "no"}`,
      );
      return;
    }
    if (!isAllowed(channelId, userId)) return;

    if (text.startsWith("!new ")) {
      const prompt = text.slice(5).trim();
      if (!prompt) return send(channel, "usage: !new <prompt>");
      let projects: Awaited<ReturnType<typeof client.listProjects>>["projects"];
      try {
        projects = (await client.listProjects()).projects;
      } catch (e) {
        return send(channel, `failed to list projects: ${(e as Error).message}`);
      }
      if (projects.length === 0) {
        return send(
          channel,
          "No projects yet — open the agentd web UI and add one.",
        );
      }
      const id = newPendingId();
      pending.set(id, {
        prompt,
        channelId,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      // Discord caps action rows at 5 buttons each, max 5 rows = 25 buttons.
      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      let row = new ActionRowBuilder<ButtonBuilder>();
      let count = 0;
      for (const p of projects.slice(0, 24)) {
        const live = (p.activeCount ?? 0) > 0 ? ` · ${p.activeCount}↑` : "";
        const label = `${p.name}${live}`.slice(0, 80);
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`new:${id}:${p.id}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary),
        );
        count += 1;
        if (count % 5 === 0) {
          rows.push(row);
          row = new ActionRowBuilder<ButtonBuilder>();
        }
      }
      if (row.components.length > 0) rows.push(row);
      // Cancel row
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`new:${id}:cancel`)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
        ),
      );
      if ("send" in channel) {
        await (channel as TextBasedChannel & {
          send: (m: { content: string; components: typeof rows }) => Promise<unknown>;
        }).send({
          content: `Pick a project for: \`${prompt.slice(0, 200)}\``,
          components: rows,
        });
      }
      return;
    }

    if (text === "!ls") {
      try {
        const { tasks } = await client.listTasks();
        if (tasks.length === 0) return send(channel, "(no tasks)");
        const body = tasks.slice(0, 20).map((t) => `\`${t.id.slice(-8)}\`  ${t.status}  _${t.agent}_  ${t.title}`).join("\n");
        await send(channel, body);
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text.startsWith("!use ")) {
      const id = text.slice(5).trim();
      try {
        const { tasks } = await client.listTasks();
        const match = tasks.find((t) => t.id === id || t.id.endsWith(id));
        if (!match) return send(channel, "no match");
        focus.set(channelId, match.id);
        await send(channel, `focused **${match.id}**`);
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    const id = focus.get(channelId);

    if (text.startsWith("!show")) {
      if (!id) return send(channel, "no focused task. !use <id>");
      try {
        const { task, messages } = await client.getTask(id);
        const last = messages.slice(-6).map((m) => `[${m.role}] ${m.content}`).join("\n\n");
        await send(channel, `**${task.id}** · ${task.status} · ${task.agent} · \`${task.branch}\`\n\n${last || "(no messages)"}`);
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text === "!stop") {
      if (!id) return send(channel, "no focused task");
      try {
        await client.stopTask(id);
        await send(channel, "stopped");
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text === "!diff") {
      if (!id) return send(channel, "no focused task");
      try {
        const d = await client.getDiff(id);
        const body = (d.stat ? d.stat + "\n" : "") + (d.diff || "(no changes)");
        await sendCode(channel, body);
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text === "!log") {
      if (!id) return send(channel, "no focused task");
      try {
        const { log } = await client.getLog(id, 20);
        if (log.length === 0) return send(channel, "(no commits)");
        await sendCode(channel, log.map((c) => `${c.sha.slice(0, 7)}  ${c.subject}`).join("\n"));
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text === "!help") {
      await send(channel, [
        "**agentd discord bridge**",
        "`!new <prompt>` — spawn a task (you'll be asked which project)",
        "`!ls` — list tasks",
        "`!use <id>` — focus a task",
        "`!show` — show focused task",
        "`!stop` — stop focused task",
        "`!diff` — show diff",
        "`!log` — show commits",
        "`!tpl` — list templates",
        "`!run <name> [k=v ...]` — fire a template",
        "`!sched` — list schedules",
        "anything else in this channel becomes input to the focused task.",
      ].join("\n"));
      return;
    }

    if (text === "!tpl") {
      try {
        const { templates } = await client.listTemplates();
        if (templates.length === 0) return send(channel, "(no templates)");
        await send(
          channel,
          templates.map((t) => `• \`${t.name}\` (${t.agent}, ${t.repoPath})`).join("\n"),
        );
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text.startsWith("!run ")) {
      const parts = text.slice(5).trim().split(/\s+/);
      const name = parts[0];
      if (!name) return send(channel, "usage: !run <template-name> [k=v ...]");
      const args: Record<string, string> = {};
      for (const p of parts.slice(1)) {
        const eq = p.indexOf("=");
        if (eq > 0) args[p.slice(0, eq)] = p.slice(eq + 1);
      }
      try {
        const { task } = await client.runTemplate(name, { args });
        focus.set(channelId, task.id);
        await send(channel, `fired \`${name}\` → **${task.id.slice(-8)}** (focused)`);
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    if (text === "!sched") {
      try {
        const { schedules } = await client.listSchedules();
        if (schedules.length === 0) return send(channel, "(no schedules)");
        await send(
          channel,
          schedules
            .map((s) => {
              const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—";
              return `• \`${s.name}\` ${s.enabled ? "✓" : "✗"} \`${s.cron}\` next=${next}`;
            })
            .join("\n"),
        );
      } catch (e) {
        await send(channel, (e as Error).message);
      }
      return;
    }

    // No command prefix → send as input to the focused task
    if (!id) return;
    try {
      await client.sendInput(id, text);
      await msg.react("✅").catch(() => {});
    } catch (e) {
      await send(channel, (e as Error).message);
    }
  });

  // Project-picker button handler.
  bot.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const btn = interaction as ButtonInteraction;
    const m = /^new:([^:]+):(.+)$/.exec(btn.customId);
    if (!m) return;
    const pendId = m[1] ?? "";
    const projectId = m[2] ?? "";
    if (!isAllowed(btn.channelId ?? "", btn.user.id)) {
      await btn.reply({ content: "not allowed", ephemeral: true }).catch(() => {});
      return;
    }
    const p = pending.get(pendId);
    if (!p) {
      await btn.update({ content: "(expired)", components: [] }).catch(() => {});
      return;
    }
    if (projectId === "cancel") {
      pending.delete(pendId);
      await btn.update({ content: "cancelled.", components: [] }).catch(() => {});
      return;
    }
    let project: Awaited<ReturnType<typeof client.getProject>>["project"];
    try {
      project = (await client.getProject(projectId)).project;
    } catch (e) {
      await btn
        .update({
          content: `project lookup failed: ${(e as Error).message}`,
          components: [],
        })
        .catch(() => {});
      return;
    }
    pending.delete(pendId);
    try {
      const { task } = await client.createTask({
        agent: "claude",
        repoPath: project.path,
        baseBranch: "main",
        prompt: p.prompt,
      });
      focus.set(p.channelId, task.id);
      await btn
        .update({
          content: `spawned in **${project.name}** → \`${task.id.slice(-8)}\` on \`${task.branch}\` _(focused)_`,
          components: [],
        })
        .catch(() => {});
    } catch (e) {
      await btn
        .update({
          content: `new failed: ${(e as Error).message}`,
          components: [],
        })
        .catch(() => {});
    }
  });

  // Cache project lookup per task to avoid hitting the API every event.
  const projectByTask = new Map<string, string | null>();
  async function projectChannelForTask(
    taskId: string,
  ): Promise<string | null> {
    let projectId = projectByTask.get(taskId);
    if (projectId === undefined) {
      try {
        const { task } = await client.getTask(taskId);
        projectId = task.projectId ?? null;
        projectByTask.set(taskId, projectId);
      } catch {
        projectByTask.set(taskId, null);
        return null;
      }
    }
    if (!projectId) return null;
    try {
      const { project } = await client.getProject(projectId);
      return project.discordChannelId ?? null;
    } catch {
      return null;
    }
  }

  function sendToChannel(channelId: string, text: string): void {
    const ch = bot.channels.cache.get(channelId);
    if (ch && "send" in ch) {
      void (ch as TextBasedChannel & { send: (s: string) => Promise<unknown> })
        .send(text.slice(0, 1900))
        .catch((e: unknown) => console.error("notify failed:", e));
    }
  }

  // Push notifications. Curated: agent messages, progress notes,
  // shares, asks, terminal status. Skip the firehose stuff.
  const ws = client.watch(null, async (event: WsServerEvent) => {
    if (event.type !== "event") return;
    const ev = event.event;
    const taskId = event.taskId;

    // Compose the message body per event kind.
    let body: string | null = null;
    if (ev.kind === "message" && ev.role === "agent") {
      body = `**[${taskId.slice(-8)}]** ${ev.text.trim()}`;
    } else if (ev.kind === "progress") {
      body = `${ev.done ? "✓ done" : "↻"} **[${taskId.slice(-8)}]** ${ev.text}`;
    } else if (ev.kind === "share") {
      body = `💭 **[${taskId.slice(-8)}]** ${ev.text}`;
    } else if (ev.kind === "ask") {
      const numbered = ev.options.length
        ? "\n" + ev.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
        : "";
      body = `❓ **[${taskId.slice(-8)}]** ${ev.prompt}${numbered}`;
    } else if (
      ev.kind === "status" &&
      (ev.status === "done" ||
        ev.status === "failed" ||
        ev.status === "stopped" ||
        ev.status === "waiting_input")
    ) {
      body = `**[${taskId.slice(-8)}]** ${ev.status}`;
    }
    if (!body) return;

    // Fan-out targets: focused channels + the project's dedicated
    // channel (if it has one configured). De-dup so a channel that's
    // both focused AND the project's channel only gets one copy.
    const targets = new Set<string>();
    for (const [channelId, focusedId] of focus.entries()) {
      if (focusedId === taskId) targets.add(channelId);
    }
    const projectChannel = await projectChannelForTask(taskId);
    if (projectChannel) targets.add(projectChannel);

    for (const channelId of targets) {
      sendToChannel(channelId, body);
    }
  });
  ws.addEventListener("close", () => console.error("ws closed"));
  ws.addEventListener("error", () => console.error("ws error"));

  await bot.login(cfg.token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
