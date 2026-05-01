import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { AgentdClient } from "@agentd/client";
import type { Task, WsServerEvent } from "@agentd/contracts";

interface BotConfig {
  token: string;
  server: string;
  session: string;
  allowedChatIds: Set<number>;
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
  const allowedChatIds = parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const allowedUserIds = parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowedChatIds.size === 0 && allowedUserIds.size === 0) {
    console.error(
      "TELEGRAM_ALLOWED_USER_IDS or TELEGRAM_ALLOWED_CHAT_IDS must list at least one id. Use /whoami in a chat to discover yours after launch.",
    );
  }
  return {
    token,
    server,
    session,
    allowedChatIds,
    allowedUserIds,
  };
}

function fmtTask(t: Task): string {
  return `*${escape(t.id.slice(-8))}*  ${escape(t.status)}  _${escape(t.agent)}_\n${escape(t.title)}`;
}

function escape(s: string): string {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (c) => `\\${c}`);
}

function chunk(text: string, size = 3500): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function main() {
  const cfg = loadConfig();
  const client = new AgentdClient(cfg.server, cfg.session);

  // Verify session
  try {
    await client.health();
    await client.listTasks();
  } catch (e) {
    console.error(`agentd unreachable or session invalid: ${(e as Error).message}`);
    process.exit(2);
  }

  const bot = new Bot(cfg.token);

  // Per-chat current task focus, so user can `/in <text>` without an id.
  const focus = new Map<number, string>();

  // Pending /new prompts waiting for a project tap. Cleared on tap or after 10m.
  interface PendingNew {
    prompt: string;
    chatId: number;
    expiresAt: number;
  }
  const pending = new Map<string, PendingNew>(); // key = short id
  const newPendingId = (): string =>
    Math.random().toString(36).slice(2, 10);
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  }, 60_000);

  /**
   * Two-axis check: a request is allowed only if the chat is on the chat
   * allowlist OR the user is on the user allowlist (whichever is configured).
   * If only user ids are configured, chat ids are not required (and vice
   * versa) — but at least one axis MUST match. If neither list is configured,
   * everything is denied. This keeps personal DMs and shared groups both
   * lockable, and it lets a user-id allowlist work even in groups where the
   * chat id varies.
   */
  function isAllowed(chatId: number | undefined, userId: number | undefined): boolean {
    if (cfg.allowedUserIds.size === 0 && cfg.allowedChatIds.size === 0) return false;
    const userOk = userId != null && cfg.allowedUserIds.has(userId);
    const chatOk = chatId != null && cfg.allowedChatIds.has(chatId);
    if (cfg.allowedUserIds.size > 0 && cfg.allowedChatIds.size > 0) {
      return userOk && chatOk;
    }
    return userOk || chatOk;
  }

  bot.command("whoami", async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    await ctx.reply(
      `chat id: \`${chatId}\`\nuser id: \`${userId}\`\nallowed: ${isAllowed(chatId, userId) ? "yes" : "no"}`,
      { parse_mode: "MarkdownV2" },
    );
  });

  bot.use(async (ctx, next) => {
    if (ctx.message?.text?.startsWith("/whoami")) return next();
    if (!isAllowed(ctx.chat?.id, ctx.from?.id)) {
      await ctx.reply("not allowed. ask the operator to add this chat id and/or user id to the allowlist.");
      return;
    }
    return next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "agentd telegram bridge",
        "",
        "Tasks:",
        "/new <prompt> — spawn a task (you'll be asked which project)",
        "/ls — list tasks",
        "/show <id?> — show task (or focused)",
        "/in <text> — send input to focused task",
        "/use <id> — set focused task",
        "/stop — stop focused task",
        "/diff — show diff for focused task",
        "/log — show commits for focused task",
        "",
        "Templates / schedules:",
        "/tpl — list templates",
        "/run <template> [k=v ...] — fire a template",
        "/sched — list schedules",
      ].join("\n"),
    );
  });

  bot.command("ls", async (ctx) => {
    try {
      const { tasks } = await client.listTasks();
      if (tasks.length === 0) return ctx.reply("(no tasks)");
      const lines = tasks.slice(0, 20).map((t) => fmtTask(t)).join("\n\n");
      await ctx.reply(lines, { parse_mode: "MarkdownV2" });
    } catch (e) {
      await ctx.reply(`ls failed: ${(e as Error).message}`);
    }
  });

  /**
   * /new spawns a task. We never accept a path here — instead we always
   * list saved projects as inline buttons and let the user tap one. The
   * tap fires a callback handled below, which spawns the task at the
   * chosen project's path.
   */
  bot.command("new", async (ctx) => {
    const prompt = (ctx.match || "").toString().trim();
    if (!prompt) return ctx.reply("usage: /new <prompt>");

    let projects: Awaited<ReturnType<typeof client.listProjects>>["projects"];
    try {
      projects = (await client.listProjects()).projects;
    } catch (e) {
      return ctx.reply(`failed to list projects: ${(e as Error).message}`);
    }
    if (projects.length === 0) {
      return ctx.reply(
        "No projects yet — open the agentd web UI and add one (composer → 'Add project').",
      );
    }

    const id = newPendingId();
    pending.set(id, {
      prompt,
      chatId: ctx.chat!.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const kb = new InlineKeyboard();
    for (const p of projects.slice(0, 24)) {
      const live = (p.activeCount ?? 0) > 0 ? ` · ${p.activeCount} live` : "";
      kb.text(`${p.name}${live}`, `new:${id}:${p.id}`).row();
    }
    kb.text("Cancel", `new:${id}:cancel`);

    await ctx.reply(
      `Pick a project for: \`${escape(prompt.slice(0, 200))}\``,
      { parse_mode: "MarkdownV2", reply_markup: kb },
    );
  });

  // Callback router for the /new project picker.
  bot.callbackQuery(/^new:([^:]+):(.+)$/, async (ctx) => {
    const m = ctx.match;
    const pendId = m[1] ?? "";
    const projectId = m[2] ?? "";
    const p = pending.get(pendId);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "expired — re-run /new" });
      try { await ctx.editMessageText("(expired)"); } catch {}
      return;
    }
    if (projectId === "cancel") {
      pending.delete(pendId);
      await ctx.answerCallbackQuery({ text: "cancelled" });
      try { await ctx.editMessageText("cancelled."); } catch {}
      return;
    }
    let project: Awaited<ReturnType<typeof client.getProject>>["project"];
    try {
      project = (await client.getProject(projectId)).project;
    } catch (e) {
      await ctx.answerCallbackQuery({ text: "project gone" });
      try {
        await ctx.editMessageText(`project lookup failed: ${(e as Error).message}`);
      } catch {}
      return;
    }
    pending.delete(pendId);
    await ctx.answerCallbackQuery({ text: `spawning in ${project.name}` });
    try {
      const { task } = await client.createTask({
        agent: "claude",
        repoPath: project.path,
        baseBranch: "main",
        prompt: p.prompt,
      });
      focus.set(p.chatId, task.id);
      try {
        await ctx.editMessageText(
          `spawned in *${escape(project.name)}*\nid: \`${escape(task.id.slice(-8))}\`\nbranch: \`${escape(task.branch)}\`\n_focused — your next plain message goes to this task._`,
          { parse_mode: "MarkdownV2" },
        );
      } catch {
        await bot.api.sendMessage(p.chatId, `spawned ${task.id} in ${project.name}`);
      }
    } catch (e) {
      try {
        await ctx.editMessageText(`new failed: ${(e as Error).message}`);
      } catch {
        await bot.api.sendMessage(p.chatId, `new failed: ${(e as Error).message}`);
      }
    }
  });

  function focused(ctx: { chat?: { id: number } }, override?: string): string | null {
    if (override) return override;
    return focus.get(ctx.chat?.id ?? -1) ?? null;
  }

  bot.command("use", async (ctx) => {
    const id = (ctx.match || "").toString().trim();
    if (!id) return ctx.reply("usage: /use <task-id-or-suffix>");
    try {
      const { tasks } = await client.listTasks();
      const match = tasks.find((t) => t.id === id || t.id.endsWith(id));
      if (!match) return ctx.reply("no match");
      focus.set(ctx.chat!.id, match.id);
      await ctx.reply(`focused ${match.id}`);
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("show", async (ctx) => {
    const arg = (ctx.match || "").toString().trim();
    const id = focused(ctx, arg || undefined);
    if (!id) return ctx.reply("no task. /use <id> first or pass an id.");
    try {
      const { task, messages } = await client.getTask(id);
      const last = messages.slice(-6).map((m) => `[${m.role}] ${m.content}`).join("\n\n");
      const body = `${task.id}\n${task.status} · ${task.agent} · ${task.branch}\n\n${last || "(no messages)"}`;
      for (const part of chunk(body)) await ctx.reply(part);
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("in", async (ctx) => {
    const text = (ctx.match || "").toString();
    const id = focused(ctx);
    if (!id) return ctx.reply("no focused task. /use <id> first.");
    if (!text.trim()) return ctx.reply("usage: /in <text>");
    try {
      await client.sendInput(id, text);
      await ctx.reply("sent.");
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("stop", async (ctx) => {
    const id = focused(ctx);
    if (!id) return ctx.reply("no focused task.");
    try {
      await client.stopTask(id);
      await ctx.reply("stopped.");
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("diff", async (ctx) => {
    const id = focused(ctx);
    if (!id) return ctx.reply("no focused task.");
    try {
      const d = await client.getDiff(id);
      const body = (d.stat ? d.stat + "\n\n" : "") + (d.diff || "(no changes)");
      for (const part of chunk(body)) await ctx.reply("```\n" + part + "\n```", { parse_mode: "MarkdownV2" }).catch(() => ctx.reply(part));
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("log", async (ctx) => {
    const id = focused(ctx);
    if (!id) return ctx.reply("no focused task.");
    try {
      const { log } = await client.getLog(id, 20);
      if (log.length === 0) return ctx.reply("(no commits)");
      const body = log.map((c) => `${c.sha.slice(0, 7)}  ${c.subject}`).join("\n");
      await ctx.reply(body);
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("tpl", async (ctx) => {
    try {
      const { templates } = await client.listTemplates();
      if (templates.length === 0) return ctx.reply("(no templates) use /run <name> after creating one with the CLI or web UI.");
      const body = templates
        .map((t) => `• ${t.name} (${t.agent}, ${t.repoPath})`)
        .join("\n");
      await ctx.reply(body);
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("run", async (ctx) => {
    const text = (ctx.match || "").toString().trim();
    if (!text) return ctx.reply("usage: /run <template-name> [key=value ...]");
    const parts = text.split(/\s+/);
    const name = parts[0];
    if (!name) return ctx.reply("usage: /run <template-name> [key=value ...]");
    const args: Record<string, string> = {};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf("=");
      if (eq > 0) args[p.slice(0, eq)] = p.slice(eq + 1);
    }
    try {
      const { task } = await client.runTemplate(name, { args });
      focus.set(ctx.chat!.id, task.id);
      await ctx.reply(`fired '${name}' → ${task.id.slice(-8)} (focused)`);
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  /**
   * /mirror toggles whether the focused (or specified) task mirrors its
   * curated events into THIS chat. Running it again with no args toggles
   * off. With an explicit task id, scopes to that one.
   */
  bot.command("mirror", async (ctx) => {
    const arg = (ctx.match || "").toString().trim();
    const id = focused(ctx, arg || undefined);
    if (!id) return ctx.reply("no task. /use <id> first or pass an id.");
    try {
      const { task } = await client.getTask(id);
      const mirrored =
        task.mirrorTo?.platform === "telegram" &&
        task.mirrorTo.chatId === String(ctx.chat!.id);
      const next = mirrored
        ? null
        : { platform: "telegram" as const, chatId: String(ctx.chat!.id) };
      await client.setTaskMirror(id, next);
      await ctx.reply(
        next
          ? `mirroring ${id.slice(-8)} into this chat. progress notes + permission asks land here. reply to a message to steer.`
          : `unmirrored ${id.slice(-8)}.`,
      );
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.command("sched", async (ctx) => {
    try {
      const { schedules } = await client.listSchedules();
      if (schedules.length === 0) return ctx.reply("(no schedules)");
      const body = schedules
        .map((s) => {
          const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—";
          return `• ${s.name} ${s.enabled ? "✓" : "✗"} '${s.cron}' next=${next}`;
        })
        .join("\n");
      await ctx.reply(body);
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  // Anything not a command becomes input. Resolution order:
  //   1. Reply-to a previous bot message → route to that task.
  //   2. The chat has a `/use`-focused task → route there.
  //   3. The chat is the mirror target of exactly one running task → route there.
  //   4. Otherwise, ignore.
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    let taskId: string | null = null;
    const replyTo = ctx.message.reply_to_message;
    if (replyTo) {
      const k = replyKey(ctx.chat!.id, replyTo.message_id);
      taskId = replyMap.get(k) ?? null;
    }
    if (!taskId) taskId = focused(ctx);
    if (!taskId) {
      // Auto-detect: which task currently mirrors to this chat?
      try {
        const { tasks } = await client.listTasks();
        const matches = tasks.filter(
          (t) =>
            t.mirrorTo?.platform === "telegram" &&
            t.mirrorTo.chatId === String(ctx.chat!.id) &&
            !t.closedAt,
        );
        if (matches.length === 1) taskId = matches[0]!.id;
      } catch {
        // ignore
      }
    }
    if (!taskId) return;

    let text = ctx.message.text.trim();
    // Numeric reply that maps to a known option list resolves to the
    // option's text. Lets the user tap "1" to approve a permission
    // request without typing the word.
    const numeric = /^\d+$/.test(text) ? Number(text) : NaN;
    const opts = latestOptions.get(taskId);
    if (opts && Number.isFinite(numeric) && numeric >= 1 && numeric <= opts.length) {
      text = opts[numeric - 1]!;
      latestOptions.delete(taskId);
    }
    // "Done" acknowledgement — short affirmations after a `done: true`
    // progress note shouldn't requeue, just acknowledge.
    if (awaitingDone.has(taskId)) {
      const ack = /^(y|yes|ok|okay|👍|cool|nice|done|good|sgtm)\b/i.test(text);
      if (ack) {
        awaitingDone.delete(taskId);
        await ctx.reply("ack — task is closed-out on agentd.");
        return;
      }
    }

    try {
      const r = await client.steerTask(taskId, text, "queue");
      await ctx.reply(
        `→ ${r.mode} for ${taskId.slice(-8)}${r.queued > 1 ? ` (depth ${r.queued})` : ""}`,
      );
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.catch((err) => {
    if (err.error instanceof GrammyError) console.error("grammy:", err.error.description);
    else if (err.error instanceof HttpError) console.error("http:", err.error.message);
    else console.error(err);
  });

  // Maps a Telegram chatId+messageId we sent → the taskId it referred to.
  // When the user replies to one of our messages we use this to route
  // their reply back to the right task as steered input.
  const replyMap = new Map<string, string>();
  const replyKey = (chatId: number, msgId: number): string =>
    `${chatId}:${msgId}`;

  // Latest set of options offered to the user, keyed per-task. Lets a
  // numeric reply in chat ("1", "2") resolve to the option text.
  const latestOptions = new Map<string, string[]>();

  // Track tasks that just emitted `done: true` so a single-word
  // "yes"/"ok"/"go" reply doesn't get queued as steer noise.
  const awaitingDone = new Set<string>();

  /**
   * Send a chat message tagged with the originating task. Records the
   * outbound message id in replyMap so the operator can reply to it
   * (Telegram threading) and we route the reply back as task input.
   */
  async function sendForTask(
    chatId: number,
    taskId: string,
    text: string,
  ): Promise<void> {
    try {
      const sent = await bot.api.sendMessage(
        chatId,
        text.slice(0, 4000),
      );
      replyMap.set(replyKey(chatId, sent.message_id), taskId);
    } catch (e) {
      console.error("notify failed:", (e as Error).message);
    }
  }

  /**
   * Resolve the chat target for a given event's taskId. Tasks pinned via
   * `/use` (focus map) get notified as before; tasks with their server-
   * side `mirrorTo.platform === "telegram"` field set get notified at
   * that chatId. The two paths can both fire for the same task.
   */
  function targetsForTask(taskId: string): number[] {
    const out: number[] = [];
    for (const [chatId, focusedId] of focus) {
      if (focusedId === taskId) out.push(chatId);
    }
    return out;
  }

  // Push notifications. We only forward the curated set: `progress`
  // (the agent's own curated report), `permission_request`, top-level
  // `status` changes, and `exit`. Every-message / every-tool noise stays
  // off so the chat is a digest, not a firehose.
  const ws = client.watch(null, async (event: WsServerEvent) => {
    if (event.type === "task_updated") {
      // Pull mirrorTo.chatId for the explicit-mirror path. We only do
      // this on task_updated so we always have the latest mirror config.
      const m = event.task.mirrorTo;
      if (m?.platform === "telegram") {
        const id = Number(m.chatId);
        if (Number.isFinite(id) && !focus.has(id)) {
          // No-op — we don't auto-add to focus. The mirror routing is
          // handled inline below per event.
        }
      }
      return;
    }
    if (event.type !== "event") return;
    const ev = event.event;
    const taskId = event.taskId;

    // Resolve which chats should hear about this task.
    const focusChats = targetsForTask(taskId);
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
    const allChats = new Set<number>([
      ...focusChats,
      ...(mirrorChat != null ? [mirrorChat] : []),
    ]);
    if (allChats.size === 0) return;

    // Format per-event-kind. Drop everything that isn't on the curated list.
    let body: string | null = null;
    if (ev.kind === "progress") {
      const tag = ev.done ? "✓ done" : "↻";
      body = `${tag} [${taskId.slice(-8)}] ${ev.text}`;
      if (ev.done) awaitingDone.add(taskId);
    } else if (ev.kind === "permission_request") {
      // Standardize as a 1/2 prompt so a numeric reply is enough.
      const opts = ["approve", "deny"];
      latestOptions.set(taskId, opts);
      body = `❓ [${taskId.slice(-8)}] ${ev.tool} wants permission. Reply 1 to approve, 2 to deny — or write your reasoning.`;
    } else if (ev.kind === "status") {
      // Only the terminal transitions matter for chat.
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
        body = `${glyph} [${taskId.slice(-8)}] ${ev.status}`;
      }
    } else if (ev.kind === "exit") {
      const code = ev.code;
      body = `${code === 0 ? "✓" : "✗"} [${taskId.slice(-8)}] exited code=${code ?? "?"}`;
    }
    // message / tool_call / tool_result / message_delta / raw / usage —
    // intentionally not mirrored. The agent surfaces what's worth
    // surfacing via `agentd-progress`.
    if (!body) return;

    for (const chatId of allChats) {
      void sendForTask(chatId, taskId, body);
    }
  });
  ws.addEventListener("close", () => console.error("ws closed"));
  ws.addEventListener("error", () => console.error("ws error"));

  console.log(
    `telegram bot ready · server=${cfg.server} · ${cfg.allowedUserIds.size} allowed user(s) · ${cfg.allowedChatIds.size} allowed chat(s)`,
  );
  await bot.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
