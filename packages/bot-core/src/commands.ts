/**
 * Cross-platform command implementations for the Telegram + Discord
 * bridges. Every handler takes the same `BotContext` + `IncomingMessage`
 * and uses `adapter.fmt` for rendering, so platform differences stay
 * out of the dispatch layer.
 *
 * The verbs cover everything operators expect from chat:
 *   tasks:     /new /ls /show /use /in /stop /diff /log
 *   ideation:  /brainstorm /plan /mirrors
 *   routing:   /mirror
 *   templates: /tpl /run
 *   schedules: /sched
 *   meta:      /help /whoami
 *
 * `/new`, `/brainstorm`, `/plan` all open the same project-picker; the
 * pick is resolved by `handleProjectPick` below (button-tap on either
 * platform routes here with the same callback id format).
 */

import type { BotContext, IncomingMessage, BotButton } from "./types.ts";
import { newPickerId, replyKey } from "./types.ts";

const PICKER_TTL_MS = 10 * 60 * 1000;
const HELP_TEXT_LINES = [
  "agentd chat bridge",
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
  "Mirror:",
  "/mirror — toggle mirroring focused task into this chat",
  "",
  "Templates / schedules:",
  "/tpl — list templates",
  "/run <template> [k=v ...] — fire a template",
  "/sched — list schedules",
];

/** Resolve focused taskId: explicit override > /use'd task > null. */
function focused(ctx: BotContext, chatId: string, override?: string): string | null {
  if (override) return override;
  return ctx.state.focus.get(chatId) ?? null;
}

/** Pretty status / task line shared by /ls and /show. */
function shortTaskLine(t: {
  id: string;
  status: string;
  agent: string;
  title: string;
}, fmt: BotContext["adapter"]["fmt"]): string {
  return `${fmt.code(t.id.slice(-8))}  ${t.status}  ${fmt.italic(t.agent)}  ${t.title}`;
}

/**
 * Open a project picker for one of the project-targeted verbs (`new`,
 * `brainstorm`, `plan`). Stashes the verb + prompt in `state.pending`
 * keyed by a fresh short id; the per-platform adapter renders the list
 * of project buttons. Tap routes through `handleProjectPick`.
 */
async function openProjectPicker(
  ctx: BotContext,
  msg: IncomingMessage,
  kind: "new" | "brainstorm" | "plan",
  prompt: string,
  promptVerb: string,
): Promise<void> {
  let projects;
  try {
    projects = (await ctx.client.listProjects()).projects;
  } catch (e) {
    await msg.reply(`failed to list projects: ${(e as Error).message}`);
    return;
  }
  if (projects.length === 0) {
    await msg.reply("no projects yet — open the agentd web UI and add one first.");
    return;
  }
  const pickerId = newPickerId();
  ctx.state.pending.set(pickerId, {
    kind,
    prompt,
    chatId: msg.chatId,
    expiresAt: Date.now() + PICKER_TTL_MS,
  });
  const rows: BotButton[][] = [];
  for (const p of projects.slice(0, 24)) {
    const live =
      kind === "new" && (p.activeCount ?? 0) > 0
        ? ` · ${p.activeCount} live`
        : "";
    rows.push([
      {
        id: `pp:${pickerId}:${p.id}`,
        label: `${p.name}${live}`.slice(0, 80),
        style: "secondary",
      },
    ]);
  }
  rows.push([
    { id: `pp:${pickerId}:cancel`, label: "Cancel", style: "danger" },
  ]);
  const fmt = ctx.adapter.fmt;
  const header = `Pick a project to ${promptVerb} ${fmt.code(prompt.slice(0, 160))}`;
  await ctx.adapter.sendWithButtons(msg.chatId, header, rows);
}

export async function cmdHelp(_ctx: BotContext, msg: IncomingMessage): Promise<void> {
  await msg.reply(HELP_TEXT_LINES.join("\n"));
}

export async function cmdWhoami(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const fmt = ctx.adapter.fmt;
  await msg.reply(
    [
      `chat id: ${fmt.code(msg.chatId)}`,
      `user id: ${fmt.code(msg.userId)}`,
      `allowed: ${msg.isAllowed ? "yes" : "no"}`,
    ].join("\n"),
  );
}

export async function cmdNew(
  ctx: BotContext,
  msg: IncomingMessage,
  prompt: string,
): Promise<void> {
  if (!prompt) {
    await msg.reply("usage: /new <prompt>");
    return;
  }
  await openProjectPicker(ctx, msg, "new", prompt, "spawn");
}

export async function cmdBrainstorm(
  ctx: BotContext,
  msg: IncomingMessage,
  prompt: string,
): Promise<void> {
  if (!prompt) {
    await msg.reply("usage: /brainstorm <one-line brief>");
    return;
  }
  await openProjectPicker(ctx, msg, "brainstorm", prompt, "brainstorm");
}

export async function cmdPlan(
  ctx: BotContext,
  msg: IncomingMessage,
  prompt: string,
): Promise<void> {
  if (!prompt) {
    await msg.reply("usage: /plan <one-line idea>");
    return;
  }
  await openProjectPicker(ctx, msg, "plan", prompt, "plan");
}

/**
 * /mirrors — list which projects currently mirror brainstorm to a
 * chat target on THIS platform. Configure via the project's
 * chat-connect sheet in the dashboard.
 */
export async function cmdMirrors(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  try {
    const { projects } = await ctx.client.listProjects();
    const platform = ctx.adapter.platform;
    const mirrored = projects.filter((p) =>
      platform === "telegram" ? !!p.telegramChatId : !!p.discordChannelId,
    );
    if (mirrored.length === 0) {
      await msg.reply(
        `no projects mirror brainstorm to ${platform} yet. open a project's chat-connect sheet in the web UI to attach this chat.`,
      );
      return;
    }
    const fmt = ctx.adapter.fmt;
    const lines = mirrored
      .map((p) => {
        const target =
          platform === "telegram" ? p.telegramChatId : p.discordChannelId;
        return `• ${p.name} → ${fmt.code(String(target))}`;
      })
      .join("\n");
    await msg.reply(`brainstorm mirroring active for:\n${lines}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdLs(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  try {
    const { tasks } = await ctx.client.listTasks();
    if (tasks.length === 0) {
      await msg.reply("(no tasks)");
      return;
    }
    const fmt = ctx.adapter.fmt;
    const body = tasks
      .slice(0, 20)
      .map((t) => shortTaskLine(t, fmt))
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply(`ls failed: ${(e as Error).message}`);
  }
}

export async function cmdUse(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  if (!arg) {
    await msg.reply("usage: /use <task-id-or-suffix>");
    return;
  }
  try {
    const { tasks } = await ctx.client.listTasks();
    const match = tasks.find((t) => t.id === arg || t.id.endsWith(arg));
    if (!match) {
      await msg.reply("no match");
      return;
    }
    ctx.state.focus.set(msg.chatId, match.id);
    await msg.reply(`focused ${match.id}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdShow(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId, arg || undefined);
  if (!id) {
    await msg.reply("no task. /use <id> first or pass an id.");
    return;
  }
  try {
    const { task, messages } = await ctx.client.getTask(id);
    const last = messages
      .slice(-6)
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");
    const fmt = ctx.adapter.fmt;
    const body = `${task.id}\n${task.status} · ${task.agent} · ${fmt.code(task.branch)}\n\n${
      last || "(no messages)"
    }`;
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdIn(
  ctx: BotContext,
  msg: IncomingMessage,
  text: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task. /use <id> first.");
    return;
  }
  if (!text.trim()) {
    await msg.reply("usage: /in <text>");
    return;
  }
  try {
    await ctx.client.sendInput(id, text);
    await msg.reply("sent.");
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdStop(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    await ctx.client.stopTask(id);
    await msg.reply("stopped.");
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdDiff(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const d = await ctx.client.getDiff(id);
    const body = (d.stat ? d.stat + "\n\n" : "") + (d.diff || "(no changes)");
    await ctx.adapter.sendCodeBlock(msg.chatId, body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdLog(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const { log } = await ctx.client.getLog(id, 20);
    if (log.length === 0) {
      await msg.reply("(no commits)");
      return;
    }
    const body = log.map((c) => `${c.sha.slice(0, 7)}  ${c.subject}`).join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdTpl(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  try {
    const { templates } = await ctx.client.listTemplates();
    if (templates.length === 0) {
      await msg.reply(
        "(no templates) use /run <name> after creating one in the CLI or web UI.",
      );
      return;
    }
    const body = templates
      .map((t) => `• ${t.name} (${t.agent}, ${t.repoPath})`)
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdRun(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const text = arg.trim();
  if (!text) {
    await msg.reply("usage: /run <template-name> [k=v ...]");
    return;
  }
  const parts = text.split(/\s+/);
  const name = parts[0];
  if (!name) {
    await msg.reply("usage: /run <template-name> [k=v ...]");
    return;
  }
  const args: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) args[p.slice(0, eq)] = p.slice(eq + 1);
  }
  try {
    const { task } = await ctx.client.runTemplate(name, { args });
    ctx.state.focus.set(msg.chatId, task.id);
    await msg.reply(`fired '${name}' → ${task.id.slice(-8)} (focused)`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdSched(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  try {
    const { schedules } = await ctx.client.listSchedules();
    if (schedules.length === 0) {
      await msg.reply("(no schedules)");
      return;
    }
    const body = schedules
      .map((s) => {
        const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—";
        return `• ${s.name} ${s.enabled ? "✓" : "✗"} '${s.cron}' next=${next}`;
      })
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

/**
 * /mirror — toggle whether the focused (or specified) task mirrors its
 * curated events into THIS chat. Running again with no args toggles off.
 * Same chatId as the operator's chat — tasks already mirrored elsewhere
 * get repointed here on retoggle.
 */
export async function cmdMirror(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId, arg || undefined);
  if (!id) {
    await msg.reply("no task. /use <id> first or pass an id.");
    return;
  }
  try {
    const { task } = await ctx.client.getTask(id);
    const platform = ctx.adapter.platform;
    const mirrored =
      task.mirrorTo?.platform === platform &&
      task.mirrorTo.chatId === msg.chatId;
    const next = mirrored ? null : { platform, chatId: msg.chatId };
    await ctx.client.setTaskMirror(id, next);
    await msg.reply(
      next
        ? `mirroring ${id.slice(-8)} into this chat. progress notes + permission asks land here. reply to a message to steer.`
        : `unmirrored ${id.slice(-8)}.`,
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

/**
 * Project-picker callback handler. The button id encodes the verb +
 * prompt via a `state.pending` lookup, so the same router serves
 * /new, /brainstorm, /plan. Adapters call this when their button
 * widget fires.
 *
 * `onAck` lets the adapter post a transient ack on the platform-native
 * widget (Telegram answerCallbackQuery, Discord btn.update).
 */
export async function handleProjectPick(
  ctx: BotContext,
  pickerId: string,
  projectId: string,
  postBack: (text: string) => Promise<void>,
): Promise<void> {
  const p = ctx.state.pending.get(pickerId);
  if (!p) {
    await postBack("(expired — re-run the command)");
    return;
  }
  if (projectId === "cancel") {
    ctx.state.pending.delete(pickerId);
    await postBack("cancelled.");
    return;
  }
  let project;
  try {
    project = (await ctx.client.getProject(projectId)).project;
  } catch (e) {
    await postBack(`project lookup failed: ${(e as Error).message}`);
    return;
  }
  ctx.state.pending.delete(pickerId);
  const fmt = ctx.adapter.fmt;

  if (p.kind === "new") {
    try {
      const { task } = await ctx.client.createTask({
        agent: "claude",
        repoPath: project.path,
        baseBranch: "main",
        prompt: p.prompt,
      });
      ctx.state.focus.set(p.chatId, task.id);
      await postBack(
        `spawned in ${fmt.bold(project.name)}\nid: ${fmt.code(task.id.slice(-8))}\nbranch: ${fmt.code(task.branch)}\n${fmt.italic("focused — your next plain message goes to this task.")}`,
      );
    } catch (e) {
      await postBack(`new failed: ${(e as Error).message}`);
    }
    return;
  }

  if (p.kind === "brainstorm") {
    await postBack(
      `brainstorming on ${fmt.bold(project.name)} — agent is reading the repo…`,
    );
    try {
      const r = await ctx.client.ideateForProject(project.id, {
        prompt: p.prompt,
        max: 5,
      });
      if (r.ok === false) {
        await ctx.adapter.sendMessage(
          p.chatId,
          `brainstorm failed (${r.source}): ${r.error}`,
        );
        return;
      }
      const opts = r.suggestion.options
        .map((o, i) => `${fmt.bold(`${i + 1}.`)} ${o}`)
        .join("\n");
      const body = [
        `💡 ${fmt.bold(r.suggestion.title)} · ${project.name}`,
        "",
        opts,
        "",
        fmt.italic(
          `Reply with a number, "skip", or your own direction.`,
        ),
      ].join("\n");
      const sent = await ctx.adapter.sendMessage(p.chatId, body);
      ctx.state.suggestionReplyMap.set(
        replyKey(p.chatId, sent.messageId),
        r.suggestion.id,
      );
      ctx.state.lastSuggestionByChat.set(p.chatId, r.suggestion.id);
    } catch (e) {
      await ctx.adapter.sendMessage(
        p.chatId,
        `brainstorm failed: ${(e as Error).message}`,
      );
    }
    return;
  }

  if (p.kind === "plan") {
    await postBack(
      `planning ${fmt.bold(p.prompt.slice(0, 80))} on ${fmt.bold(project.name)} — agent is reading the repo…`,
    );
    try {
      const r = await ctx.client.planIdea(project.id, { text: p.prompt });
      if (!r.ok) {
        await ctx.adapter.sendMessage(
          p.chatId,
          `plan failed: ${(r as { error: string }).error}`,
        );
        return;
      }
      const link = `${ctx.client.baseUrl}/projects/${project.slug}/ideas/${r.idea.id}`;
      const header = `📐 ${fmt.bold("plan ready")} · ${project.name}\n${fmt.italic(p.prompt.slice(0, 200))}\n${link}`;
      await ctx.adapter.sendMessage(p.chatId, header);
      const body = r.plan;
      // Plan bodies routinely run >2k chars — chunk to the smaller of
      // the two adapter limits so neither platform clips silently.
      const chunkSize = Math.max(1500, ctx.adapter.chunkSize - 200);
      for (let i = 0; i < body.length; i += chunkSize) {
        await ctx.adapter.sendMessage(p.chatId, body.slice(i, i + chunkSize));
      }
    } catch (e) {
      await ctx.adapter.sendMessage(
        p.chatId,
        `plan failed: ${(e as Error).message}`,
      );
    }
    return;
  }
}

/**
 * Drive the command from a parsed `/verb args` text. Returns true when
 * the verb was matched (regardless of success); false when this isn't
 * a recognized command and the caller should fall through to
 * non-command text routing.
 */
export async function runCommand(
  ctx: BotContext,
  msg: IncomingMessage,
  verb: string,
  args: string,
): Promise<boolean> {
  switch (verb) {
    case "help":
    case "start":
      await cmdHelp(ctx, msg);
      return true;
    case "whoami":
      await cmdWhoami(ctx, msg);
      return true;
    case "new":
      await cmdNew(ctx, msg, args.trim());
      return true;
    case "brainstorm":
      await cmdBrainstorm(ctx, msg, args.trim());
      return true;
    case "plan":
      await cmdPlan(ctx, msg, args.trim());
      return true;
    case "mirrors":
      await cmdMirrors(ctx, msg);
      return true;
    case "ls":
      await cmdLs(ctx, msg);
      return true;
    case "use":
      await cmdUse(ctx, msg, args.trim());
      return true;
    case "show":
      await cmdShow(ctx, msg, args.trim());
      return true;
    case "in":
      await cmdIn(ctx, msg, args);
      return true;
    case "stop":
      await cmdStop(ctx, msg);
      return true;
    case "diff":
      await cmdDiff(ctx, msg);
      return true;
    case "log":
      await cmdLog(ctx, msg);
      return true;
    case "tpl":
      await cmdTpl(ctx, msg);
      return true;
    case "run":
      await cmdRun(ctx, msg, args);
      return true;
    case "sched":
      await cmdSched(ctx, msg);
      return true;
    case "mirror":
      await cmdMirror(ctx, msg, args.trim());
      return true;
    default:
      return false;
  }
}
