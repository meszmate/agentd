import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { AgentdClient } from "@agentd/client";
import type { Task, WsServerEvent } from "@agentd/contracts";

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

  // Pending project-picker prompts (one map covers /new, /brainstorm,
  // /plan — they all share the "type something, then tap a project"
  // shape). Each entry carries the original verb so the callback
  // dispatch knows which path to take. Cleared on tap or after 10m.
  type PendingKind = "new" | "brainstorm" | "plan";
  interface PendingNew {
    kind: PendingKind;
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
   * Single-axis user-id allowlist. Trusted users are trusted no matter
   * which chat they message from — there's no separate chat-id gate.
   * (The chat-id gate used to be a thing but it was redundant: if a
   * user is allowlisted, we trust them; otherwise we don't.)
   */
  function isAllowed(_chatId: number | undefined, userId: number | undefined): boolean {
    if (cfg.allowedUserIds.size === 0) return false;
    return userId != null && cfg.allowedUserIds.has(userId);
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

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(
      [
        "agentd telegram bridge",
        "",
        "Tasks:",
        "/new <prompt> — spawn a task (asks which project)",
        "/ls — list tasks",
        "/show <id?> — show task (or focused)",
        "/in <text> — send input to focused task",
        "/use <id> — set focused task",
        "/stop — stop focused task",
        "/diff — show diff for focused task",
        "/log — show commits for focused task",
        "",
        "Brainstorm + plan:",
        "/brainstorm <brief> — agent reads the repo and proposes 5 angles",
        "/plan <idea> — agent drafts a full implementation plan and saves it",
        "/mirrors — list which projects mirror brainstorm here",
        "",
        "Mirror works both ways: when a project's chat-target is this",
        "chat, brainstorm suggestions land here AND your replies feed",
        "back into the same conversation. Reply with a number to pick,",
        "or with free text to refine.",
        "",
        "Templates / schedules:",
        "/tpl — list templates",
        "/run <template> [k=v ...] — fire a template",
        "/sched — list schedules",
      ].join("\n"),
    );
  });

  /**
   * /brainstorm — quick "agent, what should I build next?" entry. Same
   * project picker as /new; once the operator taps a project, runs
   * `ideateForProject` and posts the suggestion options as a single
   * message that doubles as a reply target (any reply routes through
   * the conversational suggestion router, same as the auto-pushes).
   */
  bot.command("brainstorm", async (ctx) => {
    const prompt = (ctx.match || "").toString().trim();
    if (!prompt) return ctx.reply("usage: /brainstorm <one-line brief>");
    await askForProject(ctx, "brainstorm", prompt, "brainstorm");
  });

  /**
   * /plan — "I have an idea, help me plan it". Same project picker;
   * runs `planIdea` which creates a SavedIdea + drains the plan-mode
   * helper synchronously, then posts the plan back. The full plan
   * also lives at the deep link so they can read it on the dashboard.
   */
  bot.command("plan", async (ctx) => {
    const prompt = (ctx.match || "").toString().trim();
    if (!prompt) return ctx.reply("usage: /plan <one-line idea>");
    await askForProject(ctx, "plan", prompt, "plan");
  });

  /**
   * /mirrors — list which projects' brainstorm currently mirrors to
   * a chat (i.e. has a Telegram chatId configured). Configure these
   * via the project's chat-connect sheet in the dashboard.
   */
  bot.command("mirrors", async (ctx) => {
    try {
      const { projects } = await client.listProjects();
      const mirrored = projects.filter((p) => !!p.telegramChatId);
      if (mirrored.length === 0) {
        await ctx.reply(
          "no projects mirror brainstorm to telegram yet. open a project's chat-connect sheet in the web UI to attach this chat.",
        );
        return;
      }
      const lines = mirrored
        .map((p) => `• ${p.name} → \`${p.telegramChatId}\``)
        .join("\n");
      await ctx.reply(`brainstorm mirroring active for:\n${lines}`, {
        parse_mode: "MarkdownV2",
      });
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
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
      kind: "new",
      prompt,
      chatId: ctx.chat!.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const kb = new InlineKeyboard();
    for (const p of projects.slice(0, 24)) {
      const live = (p.activeCount ?? 0) > 0 ? ` · ${p.activeCount} live` : "";
      kb.text(`${p.name}${live}`, `pp:${id}:${p.id}`).row();
    }
    kb.text("Cancel", `pp:${id}:cancel`);

    await ctx.reply(
      `Pick a project for: \`${escape(prompt.slice(0, 200))}\``,
      { parse_mode: "MarkdownV2", reply_markup: kb },
    );
  });

  /**
   * Helper used by the project-picker commands (/new, /brainstorm,
   * /plan). Stashes the verb + prompt, lists projects as inline
   * buttons, and lets the shared `pp:` callback below dispatch on
   * tap. Cuts the boilerplate from each command.
   */
  async function askForProject(
    ctx: { chat?: { id: number }; reply: (m: string, o?: object) => Promise<unknown> },
    kind: PendingKind,
    prompt: string,
    promptLabel: string,
  ): Promise<void> {
    let projects: Awaited<ReturnType<typeof client.listProjects>>["projects"];
    try {
      projects = (await client.listProjects()).projects;
    } catch (e) {
      await ctx.reply(`failed to list projects: ${(e as Error).message}`);
      return;
    }
    if (projects.length === 0) {
      await ctx.reply("no projects yet — add one in the web UI first.");
      return;
    }
    const id = newPendingId();
    pending.set(id, {
      kind,
      prompt,
      chatId: ctx.chat!.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const kb = new InlineKeyboard();
    for (const p of projects.slice(0, 24)) {
      kb.text(p.name, `pp:${id}:${p.id}`).row();
    }
    kb.text("Cancel", `pp:${id}:cancel`);
    await ctx.reply(`Pick a project to ${promptLabel} \`${escape(prompt.slice(0, 160))}\``, {
      parse_mode: "MarkdownV2",
      reply_markup: kb,
    });
  }

  // Callback router for every project-picker (new / brainstorm / plan).
  bot.callbackQuery(/^pp:([^:]+):(.+)$/, async (ctx) => {
    const m = ctx.match;
    const pendId = m[1] ?? "";
    const projectId = m[2] ?? "";
    const p = pending.get(pendId);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "expired — re-run the command" });
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

    if (p.kind === "new") {
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
      return;
    }

    if (p.kind === "brainstorm") {
      await ctx.answerCallbackQuery({ text: `brainstorming on ${project.name}…` });
      try {
        await ctx.editMessageText(
          `brainstorming on *${escape(project.name)}* — agent is reading the repo…`,
          { parse_mode: "MarkdownV2" },
        );
      } catch {}
      try {
        const r = await client.ideateForProject(project.id, {
          prompt: p.prompt,
          max: 5,
        });
        if (r.ok === false) {
          await bot.api.sendMessage(
            p.chatId,
            `brainstorm failed (${r.source}): ${r.error}`,
          );
          return;
        }
        const opts = r.suggestion.options
          .map((o, i) => `*${i + 1}\\.* ${escape(o)}`)
          .join("\n");
        const body = [
          `💡 *${escape(r.suggestion.title)}* · ${escape(project.name)}`,
          "",
          opts,
          "",
          `_Reply with a number, "skip", or your own direction\\._`,
        ].join("\n");
        const sent = await bot.api.sendMessage(p.chatId, body, {
          parse_mode: "MarkdownV2",
        });
        suggestionReplyMap.set(replyKey(p.chatId, sent.message_id), r.suggestion.id);
        lastSuggestionByChat.set(p.chatId, r.suggestion.id);
      } catch (e) {
        await bot.api.sendMessage(p.chatId, `brainstorm failed: ${(e as Error).message}`);
      }
      return;
    }

    if (p.kind === "plan") {
      await ctx.answerCallbackQuery({ text: `planning on ${project.name}…` });
      try {
        await ctx.editMessageText(
          `planning *${escape(p.prompt.slice(0, 80))}* on *${escape(project.name)}* — agent is reading the repo…`,
          { parse_mode: "MarkdownV2" },
        );
      } catch {}
      try {
        const r = await client.planIdea(project.id, { text: p.prompt });
        if (!r.ok) {
          await bot.api.sendMessage(
            p.chatId,
            `plan failed: ${(r as { error: string }).error}`,
          );
          return;
        }
        // Telegram cap: 4096 chars per message. Send a tight summary
        // up top + chunk the full plan body if it's longer than the
        // remaining budget. The full plan also lives at the deep link
        // so they can read it on the dashboard.
        const link = `${client.baseUrl}/projects/${project.slug}/ideas/${r.idea.id}`;
        const header = `📐 *plan ready* · ${escape(project.name)}\n_${escape(p.prompt.slice(0, 200))}_\n${escape(link)}`;
        await bot.api.sendMessage(p.chatId, header, { parse_mode: "MarkdownV2" });
        const body = r.plan;
        for (let i = 0; i < body.length; i += 3800) {
          const chunk = body.slice(i, i + 3800);
          // Send as plain text — markdown escaping a 4kb plan is brittle.
          await bot.api.sendMessage(p.chatId, chunk);
        }
      } catch (e) {
        await bot.api.sendMessage(p.chatId, `plan failed: ${(e as Error).message}`);
      }
      return;
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
    const text = ctx.message.text.trim();
    const chatId = ctx.chat!.id;
    const replyTo = ctx.message.reply_to_message;

    // ── Suggestions get first crack ──────────────────────────────
    // Either a reply-thread to a known suggestion bubble, OR (when
    // the user just types in the chat) the most recent pending
    // suggestion we sent here.
    let suggestionId: string | null = null;
    if (replyTo) {
      const k = replyKey(chatId, replyTo.message_id);
      suggestionId = suggestionReplyMap.get(k) ?? null;
    }
    if (!suggestionId) {
      suggestionId = lastSuggestionByChat.get(chatId) ?? null;
    }
    if (suggestionId) {
      try {
        const r = await client.replyToSuggestion(suggestionId, text);
        if (r.kind === "spawned") {
          await ctx.reply(
            `✓ spawning [${r.task.id.slice(-8)}] (${r.agent}${r.model ? "/" + r.model : ""}${r.thinkingLevel !== "high" ? ", " + r.thinkingLevel : ""}): ${r.task.title.slice(0, 100)}`,
          );
          // Suggestion is resolved — drop the per-chat fallback.
          if (lastSuggestionByChat.get(chatId) === suggestionId) {
            lastSuggestionByChat.delete(chatId);
          }
        } else if (r.kind === "dismissed") {
          await ctx.reply("ok, skipped.");
          if (lastSuggestionByChat.get(chatId) === suggestionId) {
            lastSuggestionByChat.delete(chatId);
          }
        } else if (r.kind === "clarify") {
          await ctx.reply(`🤔 ${r.question}`);
          // Suggestion stays pending — user can reply again.
        } else {
          await ctx.reply(`(suggestion ${r.reason})`);
        }
      } catch (e) {
        await ctx.reply(`reply failed: ${(e as Error).message}`);
      }
      return;
    }

    // ── Task replies fall through to steer ──────────────────────
    let taskId: string | null = null;
    if (replyTo) {
      const k = replyKey(chatId, replyTo.message_id);
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

    let resolvedText = text;
    // Numeric reply that maps to a known option list resolves to the
    // option's text. Lets the user tap "1" to approve a permission
    // request without typing the word.
    const numeric = /^\d+$/.test(resolvedText) ? Number(resolvedText) : NaN;
    const opts = latestOptions.get(taskId);
    if (opts && Number.isFinite(numeric) && numeric >= 1 && numeric <= opts.length) {
      resolvedText = opts[numeric - 1]!;
      latestOptions.delete(taskId);
    }
    // "Done" acknowledgement — short affirmations after a `done: true`
    // progress note shouldn't requeue, just acknowledge.
    if (awaitingDone.has(taskId)) {
      const ack = /^(y|yes|ok|okay|👍|cool|nice|done|good|sgtm)\b/i.test(resolvedText);
      if (ack) {
        awaitingDone.delete(taskId);
        await ctx.reply("ack — task is closed-out on agentd.");
        return;
      }
    }

    try {
      const r = await client.steerTask(taskId, resolvedText, "queue");
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

  // Same idea for suggestions — separate map so a reply to a suggestion
  // bubble routes through the conversational reply endpoint, not steer.
  const suggestionReplyMap = new Map<string, string>(); // chat:msg → suggestionId
  // Per-chat fallback when the user doesn't reply-thread: latest pending suggestion.
  const lastSuggestionByChat = new Map<number, string>();

  // Latest set of options offered to the user, keyed per-task. Lets a
  // numeric reply in chat ("1", "2") resolve to the option text.
  const latestOptions = new Map<string, string[]>();

  // Track tasks that just emitted `done: true` so a single-word
  // "yes"/"ok"/"go" reply doesn't get queued as steer noise.
  const awaitingDone = new Set<string>();

  // Cache of per-project Bot instances keyed by token. The global
  // bot handles polling + commands; project-specific bots are send-
  // only so events for that project appear from a dedicated DM
  // identity (different name, sound profile, etc).
  const projectBotsByToken = new Map<string, Bot>();
  function getProjectBot(token: string): Bot {
    let b = projectBotsByToken.get(token);
    if (!b) {
      b = new Bot(token);
      projectBotsByToken.set(token, b);
    }
    return b;
  }

  // Per-task project resolution cache. Avoids hammering the API on
  // every event. Cleared lazily — the next event for the same task
  // re-uses the cached project pointer.
  const projectByTask = new Map<string, string | null>();
  async function projectForTask(
    taskId: string,
  ): Promise<{
    projectId: string;
    telegramBotToken: string | null;
    telegramChatId: string | null;
  } | null> {
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
      return {
        projectId,
        telegramBotToken: project.telegramBotToken ?? null,
        telegramChatId: project.telegramChatId ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Send a chat message tagged with the originating task. Records the
   * outbound message id in replyMap so the operator can reply to it
   * (Telegram threading) and we route the reply back as task input.
   *
   * The `botOverride` lets a per-project bot send the notification.
   * When omitted, the global bot is used. Replies route back through
   * the global bot's polling regardless, so command interaction
   * still works from any chat.
   */
  async function sendForTask(
    chatId: number,
    taskId: string,
    text: string,
    botOverride?: Bot,
    projectId?: string | null,
  ): Promise<void> {
    const sender = botOverride ?? bot;
    try {
      const sent = await sender.api.sendMessage(
        chatId,
        text.slice(0, 4000),
      );
      replyMap.set(replyKey(chatId, sent.message_id), taskId);
      // Bump the daemon's per-project delivery counter so the Plugins
      // page + Connect-chat panel can show "last delivered Xm ago".
      void client.reportDelivery(projectId ?? null, "telegram").catch(() => {});
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
    // Ideation suggestions — broadcast to every allowed chat. We
    // record the outbound message id per chat so reply-threads route
    // back through the conversational reply endpoint.
    if (event.type === "suggestion_created") {
      const sug = event.suggestion;
      const numbered = sug.options
        .map((o, i) => `${i + 1}. ${o}`)
        .join("\n");
      const body = [
        `💡 *${escape(sug.title)}*`,
        "",
        escape(sug.prompt.split("\n")[0] ?? ""),
        "",
        numbered.length > 0 ? escape(numbered) : "",
        "",
        // Italic delimiters (`_`) frame the prose, but everything
        // INSIDE the italic still has to escape MarkdownV2 reserved
        // chars (`.`, `,`, `(`, `)`, `"`, em-dash, etc) or Telegram
        // rejects the message with "Character '.' is reserved".
        `_${escape(`Reply with a number, "skip", or just say what you want — e.g. "do option 2 with opus".`)}_`,
      ]
        .filter((s) => s.length > 0)
        .join("\n");

      // Brainstorm in agentd is a continuous mirror, not a notification
      // stream. The chat target IS the opt-in: configure a project's
      // telegramChatId (via the chat-connect sheet or `/brainstorm`
      // here) and brainstorm events flow into that chat — same shape as
      // the web brainstorm thread. Replies route back through the
      // suggestion router below, so it's fully bidirectional. Projects
      // without a configured chat target stay silent (no broadcast).
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
            // chat target set, no per-project bot → use the global bot
            const id = Number(project.telegramChatId);
            if (Number.isFinite(id)) projectChatId = id;
          } else {
            // project has no chat target → don't fan out anywhere.
            return;
          }
        } catch {
          // project gone — drop silently
          return;
        }
      }

      const sendOne = async (
        chatId: number,
        sender: Bot,
      ): Promise<void> => {
        // Try MarkdownV2 first (preserves bold + italic). If telegram
        // rejects it (usually a stray reserved char that slipped past
        // escape()), retry as plain text by stripping the markup so
        // the operator still gets the suggestion. Better than dropping
        // it on the floor and spamming stderr.
        const tryWithMode = async (
          text: string,
          mode: "MarkdownV2" | "plain",
        ) => {
          return mode === "plain"
            ? sender.api.sendMessage(chatId, text)
            : sender.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
        };
        try {
          const sent = await tryWithMode(body, "MarkdownV2");
          suggestionReplyMap.set(replyKey(chatId, sent.message_id), sug.id);
          lastSuggestionByChat.set(chatId, sug.id);
          void client
            .reportDelivery(sug.projectId ?? null, "telegram")
            .catch(() => {});
        } catch (e) {
          // Strip every MarkdownV2 escape (`\X` → `X`) and then any
          // leftover delimiters so the plain-text fallback reads
          // naturally. Won't recover styling but at least delivers.
          const plain = body
            .replace(/\\([_*\[\]()~`>#+=|{}.!\-\\])/g, "$1")
            .replace(/[*_`]/g, "");
          try {
            const sent = await tryWithMode(plain, "plain");
            suggestionReplyMap.set(replyKey(chatId, sent.message_id), sug.id);
            lastSuggestionByChat.set(chatId, sug.id);
            void client
              .reportDelivery(sug.projectId ?? null, "telegram")
              .catch(() => {});
          } catch (e2) {
            // Both modes failed — likely auth / network / chat gone.
            // Log once with enough context to debug.
            console.warn(
              `[telegram] suggestion notify dropped chat=${chatId}: ${(e2 as Error).message} (markdown try: ${(e as Error).message})`,
            );
          }
        }
      };

      // Project chat target = mirror destination. Use the per-project
      // bot when one's configured, otherwise fall back to the global
      // bot pointing at the same chatId. No global DM broadcast: the
      // chat target presence IS the opt-in.
      if (projectChatId != null) {
        await sendOne(projectChatId, projectBot ?? bot);
      } else if (!sug.projectId) {
        // Ad-hoc suggestion (no project). Keep the legacy broadcast
        // for these so direct CLI invocations still surface — they
        // aren't part of the project mirror surface.
        for (const chatId of cfg.allowedUserIds) {
          await sendOne(chatId, bot);
        }
      }
      return;
    }
    if (event.type === "suggestion_updated") {
      // No outbound message — the bot already acked when the user
      // replied. Just drop it from the per-chat fallback map if it
      // was the last one tracked there.
      const sug = event.suggestion;
      for (const [chatId, id] of lastSuggestionByChat) {
        if (id === sug.id) lastSuggestionByChat.delete(chatId);
      }
      return;
    }
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

    // Per-project bot routing. When the task's project has a
    // dedicated bot token + chat id, fan the event to that bot's
    // chat (so each project lives in its own DM identity). Falls
    // back to the global bot when the project hasn't configured
    // its own routing.
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

    // Format per-event-kind. Drop everything that isn't on the curated list.
    let body: string | null = null;
    if (ev.kind === "message" && ev.role === "agent") {
      // The agent's natural-language reply for a turn. Without this
      // an operator who steered the task from chat sees nothing
      // beyond the steer ack — they need the actual answer.
      const txt = ev.text.trim();
      if (txt.length > 0) body = `[${taskId.slice(-8)}] ${txt}`;
    } else if (ev.kind === "progress") {
      const tag = ev.done ? "✓ done" : "↻";
      body = `${tag} [${taskId.slice(-8)}] ${ev.text}`;
      if (ev.done) awaitingDone.add(taskId);
    } else if (ev.kind === "share") {
      // The agent sharing what it's thinking BEFORE acting. Ideal nudge moment.
      body = `💭 [${taskId.slice(-8)}] ${ev.text}\n_(reply to steer; the agent will keep working unless you do)_`;
    } else if (ev.kind === "ask") {
      // The agent is BLOCKED waiting for an answer. Format options
      // as a numbered list so a reply of "1" / "2" / etc resolves
      // cleanly via the latestOptions map below.
      latestOptions.set(taskId, ev.options);
      const numbered =
        ev.options.length > 0
          ? "\n" +
            ev.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
          : "";
      body = `❓ [${taskId.slice(-8)}] ${ev.prompt}${numbered}\n_reply with a number or your own answer — the agent is waiting._`;
    } else if (ev.kind === "answer") {
      // Quiet ack so the operator sees their reply landed.
      body = `↳ [${taskId.slice(-8)}] answered: ${ev.answer.slice(0, 200)}`;
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

    const routedProjectId = projectRouting?.projectId ?? null;
    // Global-bot fan-out: focused chats + mirror target.
    for (const chatId of allChats) {
      void sendForTask(chatId, taskId, body, undefined, routedProjectId);
    }
    // Per-project bot fan-out: dedicated DM for that project.
    if (projectBot && projectChatId != null) {
      void sendForTask(
        projectChatId,
        taskId,
        body,
        projectBot,
        routedProjectId,
      );
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
 * Wraps `bot.start()` so a 409 ("terminated by other getUpdates request")
 * doesn't crash the subprocess. Telegram's long-poll TTL is ~30s, so a
 * stale previous poll always releases within that window — we just have
 * to outwait it. Crashing instead burns the daemon's per-hour restart
 * budget (8 tries) before any natural recovery can happen.
 *
 * Only 409 is retried in-process; any other error still propagates so
 * fatal config issues (bad token, network down) surface promptly.
 */
async function startWithConflictRetry(bot: Bot): Promise<void> {
  let consecutiveConflicts = 0;
  while (true) {
    try {
      await bot.start();
      return;
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 409) {
        consecutiveConflicts += 1;
        const waitMs = 35_000;
        console.error(
          `telegram: 409 conflict (another getUpdates poller holds the slot). ` +
            `Waiting ${waitMs / 1000}s for it to release. ` +
            `If this repeats, another agentd / bot instance is running with the same TELEGRAM_BOT_TOKEN. ` +
            `(consecutive=${consecutiveConflicts})`,
        );
        if (consecutiveConflicts >= 6) {
          throw new Error(
            "telegram: 409 conflict persisted across 6 retries (~3.5min) — another bot instance is using this token. Stop it or rotate the token.",
          );
        }
        await new Promise((r) => setTimeout(r, waitMs));
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
