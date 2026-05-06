/**
 * Cross-platform command implementations for the Telegram + Discord
 * bridges. Every handler takes the same `BotContext` + `IncomingMessage`
 * and uses `adapter.fmt` for rendering, so platform differences stay
 * out of the dispatch layer.
 *
 * The verbs cover what operators do in the dashboard:
 *   project session:  /projects /project /pclear
 *   tasks:            /new /ls /show /use /in /stop /diff /log /close /reopen /rm
 *   git workflow:     /commit /push /pr /revert /files /st
 *   task metadata:    /model /think /autocommit /autopush /skills
 *   steer:            /steer /ask /compact
 *   ideation:         /brainstorm /plan /ideas /idea /mirrors
 *   github:           /issues /prs /issue /prview
 *   routing:          /mirror
 *   templates:        /tpl /run
 *   schedules:        /sched /schedon /schedoff
 *   context:          /ctx
 *   meta:             /help /whoami
 *
 * Project-targeted verbs (`/new`, `/brainstorm`, `/plan`, etc.) check
 * `state.focusProject` first — if set, the picker is skipped and the
 * verb dispatches directly. Otherwise the picker opens; the pick is
 * resolved by `handleProjectPick` below (button-tap on either platform
 * routes here with the same callback id format).
 */

import type { BotContext, IncomingMessage, BotButton, PendingKind } from "./types.ts";
import { newPickerId, replyKey } from "./types.ts";

const PICKER_TTL_MS = 10 * 60 * 1000;
const HELP_TEXT_LINES = [
  "agentd chat bridge",
  "",
  "Project session:",
  "/projects — list projects (with focus marker)",
  "/project <id-or-name> — focus a project (verbs skip the picker)",
  "/pclear — clear focused project",
  "",
  "Tasks:",
  "/new <prompt> — spawn a task in focused project (or asks)",
  "/ls — list tasks",
  "/show <id?> — show task (or focused)",
  "/in <text> — send input to focused task",
  "/use <id> — set focused task",
  "/stop — stop focused task",
  "/diff — show diff for focused task",
  "/log — show commits for focused task",
  "/files — list changed files",
  "/st — git status",
  "/close [reason] — mark focused task closed",
  "/reopen — reopen the focused task",
  "/rm — delete focused task (worktree + db)",
  "",
  "Steer:",
  "/steer <text> — interrupt-and-fire input to focused task",
  "/ask <text> — append a question turn to focused task",
  "/compact [focus?] — compact context on focused task",
  "",
  "Git workflow (focused task):",
  "/commit [msg?] — commit changes (auto-generates msg if blank)",
  "/push — push branch",
  "/pr <title> | <body?> — open pull request",
  "/revert <sha> — revert a commit",
  "",
  "Task metadata (focused task):",
  "/model <id|clear> — set per-task model override",
  "/think <minimal|low|medium|high|xhigh|max> — set thinking level",
  "/autocommit on|off — toggle auto-commit",
  "/autopush on|off — toggle auto-push",
  "/skills — list skills active on focused task",
  "",
  "Brainstorm + ideas:",
  "/brainstorm <brief> — agent reads repo, proposes 5 angles",
  "/plan <idea> — agent drafts a plan and saves it",
  "/ideas — list saved ideas in focused project",
  "/idea <id> — show a saved idea (last 6 messages, slices, plan)",
  "/mirrors — list projects that mirror brainstorm here",
  "",
  "GitHub (focused project):",
  "/issues — list open issues",
  "/prs — list open PRs",
  "/issue <number> — view an issue",
  "/prview <number> — view a pull request",
  "",
  "Mirror:",
  "/mirror — toggle mirroring focused task into this chat",
  "",
  "Templates / schedules:",
  "/tpl — list templates",
  "/run <template> [k=v ...] — fire a template",
  "/sched — list schedules",
  "/schedon <id> — enable schedule",
  "/schedoff <id> — disable schedule",
  "",
  "Context:",
  "/ctx — show focused task's context window + skills",
];

/** Resolve focused taskId: explicit override > /use'd task > null. */
function focused(ctx: BotContext, chatId: string, override?: string): string | null {
  if (override) return override;
  return ctx.state.focus.get(chatId) ?? null;
}

/** Resolve focused projectId for a chat. Returns null when none set. */
function focusedProject(ctx: BotContext, chatId: string): string | null {
  return ctx.state.focusProject.get(chatId) ?? null;
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

/** Match a project by exact id, exact slug, or case-insensitive name prefix. */
function findProject<T extends { id: string; slug?: string; name: string }>(
  projects: T[],
  query: string,
): T | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    projects.find(
      (p) => p.id === query || p.slug === query || p.name.toLowerCase() === q,
    ) ??
    projects.find((p) => p.name.toLowerCase().startsWith(q)) ??
    projects.find((p) => p.name.toLowerCase().includes(q)) ??
    null
  );
}

/**
 * Resolve the project to act on for a project-targeted verb. Honors
 * `focusProject`; otherwise opens the picker and returns null (caller
 * stops; `handleProjectPick` continues asynchronously). When focused,
 * dispatches the action directly via `runProjectAction`.
 */
async function resolveProjectOrPick(
  ctx: BotContext,
  msg: IncomingMessage,
  kind: PendingKind,
  prompt: string,
  promptVerb: string,
): Promise<void> {
  const focusedId = focusedProject(ctx, msg.chatId);
  if (focusedId) {
    await runProjectAction(ctx, msg.chatId, kind, prompt, focusedId);
    return;
  }
  await openProjectPicker(ctx, msg, kind, prompt, promptVerb);
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
  await resolveProjectOrPick(ctx, msg, "new", prompt, "spawn");
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
  await resolveProjectOrPick(ctx, msg, "brainstorm", prompt, "brainstorm");
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
  await resolveProjectOrPick(ctx, msg, "plan", prompt, "plan");
}

/**
 * /projects — list all projects with a marker for the focused one.
 * Names are case-insensitively unique enough that operators recognize
 * them; the id slice doubles as the `/project` lookup key.
 */
export async function cmdProjects(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  try {
    const { projects } = await ctx.client.listProjects();
    if (projects.length === 0) {
      await msg.reply("no projects yet. open the agentd web UI to add one.");
      return;
    }
    const fmt = ctx.adapter.fmt;
    const focusedId = focusedProject(ctx, msg.chatId);
    const lines = projects.map((p) => {
      const mark = p.id === focusedId ? "★ " : "  ";
      const live = (p.activeCount ?? 0) > 0 ? ` · ${p.activeCount} live` : "";
      return `${mark}${fmt.bold(p.name)} ${fmt.code(p.id.slice(-8))}${live}`;
    });
    const hint = focusedId
      ? `\n\n${fmt.italic("★ = focused. /pclear to unfocus.")}`
      : `\n\n${fmt.italic("/project <name|id> to focus. focused project skips the picker.")}`;
    await msg.reply(lines.join("\n") + hint);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

/**
 * /project <id|slug|name> — focus a project for this chat. Argument
 * is matched (in order) against id, slug, exact name, then prefix and
 * substring of name. /project alone shows the current focus.
 */
export async function cmdProject(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  if (!arg.trim()) {
    const id = focusedProject(ctx, msg.chatId);
    if (!id) {
      await msg.reply("no focused project. /project <name|id> to focus one.");
      return;
    }
    try {
      const { project } = await ctx.client.getProject(id);
      const fmt = ctx.adapter.fmt;
      await msg.reply(
        `focused: ${fmt.bold(project.name)} ${fmt.code(project.id.slice(-8))}\npath: ${fmt.code(project.path)}`,
      );
    } catch {
      ctx.state.focusProject.delete(msg.chatId);
      await msg.reply("focused project no longer exists. cleared.");
    }
    return;
  }
  if (arg.trim().toLowerCase() === "clear") {
    ctx.state.focusProject.delete(msg.chatId);
    await msg.reply("cleared focused project.");
    return;
  }
  try {
    const { projects } = await ctx.client.listProjects();
    const match = findProject(projects, arg);
    if (!match) {
      await msg.reply(`no project matches '${arg}'. /projects to list.`);
      return;
    }
    ctx.state.focusProject.set(msg.chatId, match.id);
    const fmt = ctx.adapter.fmt;
    await msg.reply(
      `focused ${fmt.bold(match.name)} ${fmt.code(match.id.slice(-8))}\n${fmt.italic("/new, /brainstorm, /plan, /issues, /prs, /ideas now skip the picker.")}`,
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdPClear(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  if (!ctx.state.focusProject.has(msg.chatId)) {
    await msg.reply("no focused project.");
    return;
  }
  ctx.state.focusProject.delete(msg.chatId);
  await msg.reply("cleared focused project.");
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
 * Run a project-targeted verb against a known project. Shared by
 * `handleProjectPick` (button tap) and `resolveProjectOrPick` (focused
 * project shortcut). All output goes via `adapter.sendMessage` to
 * `chatId` so a tap-style flow can ack out-of-band.
 */
export async function runProjectAction(
  ctx: BotContext,
  chatId: string,
  kind: PendingKind,
  prompt: string,
  projectId: string,
): Promise<void> {
  let project;
  try {
    project = (await ctx.client.getProject(projectId)).project;
  } catch (e) {
    await ctx.adapter.sendMessage(
      chatId,
      `project lookup failed: ${(e as Error).message}`,
    );
    return;
  }
  const fmt = ctx.adapter.fmt;

  if (kind === "new") {
    try {
      const { task } = await ctx.client.createTask({
        agent: "claude",
        repoPath: project.path,
        baseBranch: "main",
        prompt,
      });
      ctx.state.focus.set(chatId, task.id);
      await ctx.adapter.sendMessage(
        chatId,
        `spawned in ${fmt.bold(project.name)}\nid: ${fmt.code(task.id.slice(-8))}\nbranch: ${fmt.code(task.branch)}\n${fmt.italic("focused — your next plain message goes to this task.")}`,
      );
    } catch (e) {
      await ctx.adapter.sendMessage(chatId, `new failed: ${(e as Error).message}`);
    }
    return;
  }

  if (kind === "brainstorm") {
    await ctx.adapter.sendMessage(
      chatId,
      `brainstorming on ${fmt.bold(project.name)} — agent is reading the repo…`,
    );
    try {
      const r = await ctx.client.ideateForProject(project.id, {
        prompt,
        max: 5,
      });
      if (r.ok === false) {
        await ctx.adapter.sendMessage(
          chatId,
          `brainstorm failed (${r.source}): ${r.error}`,
        );
        return;
      }
      // Structured `<ask-user>` clarifying question — agent decided
      // the brief was too vague to commit to options yet. Render the
      // question + options as inline buttons so the operator can pick
      // a direction in one tap; tapping re-fires brainstorm with the
      // disambiguated brief, mirroring the web flow. Free-form replies
      // still work — textRouter detects question-bearing suggestions
      // and re-fires brainstorm with the typed answer instead of
      // running the legacy reply-to-suggestion path.
      if (r.suggestion.question) {
        const q = r.suggestion.question;
        const lines: string[] = [
          `❓ ${fmt.bold(q.header)} · ${project.name}`,
          "",
          fmt.italic(q.question),
          "",
        ];
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i]!;
          if (opt.description) {
            lines.push(
              `${fmt.bold(`${i + 1}.`)} ${opt.label} — ${fmt.italic(opt.description)}`,
            );
          } else {
            lines.push(`${fmt.bold(`${i + 1}.`)} ${opt.label}`);
          }
        }
        lines.push("");
        lines.push(
          fmt.italic("Tap an option or reply with your own answer."),
        );
        // Two buttons per row keeps short labels readable on phones
        // (Telegram inline keyboards default to wide buttons; Discord
        // action rows hold up to 5 buttons but two-per-row reads
        // cleaner alongside the description list).
        const rows: BotButton[][] = [];
        for (let i = 0; i < q.options.length; i += 2) {
          const row: BotButton[] = q.options
            .slice(i, i + 2)
            .map((opt, j) => ({
              id: `iq:${r.suggestion.id}:${i + j}`,
              label: opt.label,
              style: "primary" as const,
            }));
          rows.push(row);
        }
        const sent = await ctx.adapter.sendWithButtons(
          chatId,
          lines.join("\n"),
          rows,
        );
        ctx.state.suggestionReplyMap.set(
          replyKey(chatId, sent.messageId),
          r.suggestion.id,
        );
        ctx.state.lastSuggestionByChat.set(chatId, r.suggestion.id);
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
        fmt.italic(`Reply with a number, "skip", or your own direction.`),
      ].join("\n");
      const sent = await ctx.adapter.sendMessage(chatId, body);
      ctx.state.suggestionReplyMap.set(
        replyKey(chatId, sent.messageId),
        r.suggestion.id,
      );
      ctx.state.lastSuggestionByChat.set(chatId, r.suggestion.id);
    } catch (e) {
      await ctx.adapter.sendMessage(
        chatId,
        `brainstorm failed: ${(e as Error).message}`,
      );
    }
    return;
  }

  if (kind === "plan") {
    await ctx.adapter.sendMessage(
      chatId,
      `planning ${fmt.bold(prompt.slice(0, 80))} on ${fmt.bold(project.name)} — agent is reading the repo…`,
    );
    try {
      const r = await ctx.client.planIdea(project.id, { text: prompt });
      if (!r.ok) {
        await ctx.adapter.sendMessage(
          chatId,
          `plan failed: ${(r as { error: string }).error}`,
        );
        return;
      }
      const link = `${ctx.client.baseUrl}/projects/${project.slug}/ideas/${r.idea.id}`;
      const header = `📐 ${fmt.bold("plan ready")} · ${project.name}\n${fmt.italic(prompt.slice(0, 200))}\n${link}`;
      await ctx.adapter.sendMessage(chatId, header);
      const body = r.plan;
      // Plan bodies routinely run >2k chars — chunk to the smaller of
      // the two adapter limits so neither platform clips silently.
      const chunkSize = Math.max(1500, ctx.adapter.chunkSize - 200);
      for (let i = 0; i < body.length; i += chunkSize) {
        await ctx.adapter.sendMessage(chatId, body.slice(i, i + chunkSize));
      }
    } catch (e) {
      await ctx.adapter.sendMessage(
        chatId,
        `plan failed: ${(e as Error).message}`,
      );
    }
    return;
  }
}

/**
 * Idea-question button-pick handler. Fired when the operator taps an
 * option button on a brainstorm suggestion that came back with a
 * structured `<ask-user>` clarification. We fetch the suggestion to
 * get the original brief + question, combine them with the picked
 * label, and re-fire `runProjectAction` with `kind="brainstorm"` so
 * the disambiguated brief produces grounded options in the next turn.
 *
 * Mirrors `handleProjectPick`'s shape: adapters decode the callback
 * id (`iq:<suggestionId>:<optionIdx>`), pass chatId from the surrounding
 * message context, and let `postBack` emit a transient ack on the
 * platform's widget.
 */
export async function handleIdeaQuestionPick(
  ctx: BotContext,
  chatId: string,
  suggestionId: string,
  optionIdx: number,
  postBack: (text: string) => Promise<void>,
): Promise<void> {
  let suggestion;
  try {
    const r = await ctx.client.getSuggestion(suggestionId);
    suggestion = r.suggestion;
  } catch (e) {
    await postBack(`(suggestion gone: ${(e as Error).message})`);
    return;
  }
  if (!suggestion.question) {
    await postBack("(no question on this suggestion)");
    return;
  }
  if (
    !Number.isInteger(optionIdx) ||
    optionIdx < 0 ||
    optionIdx >= suggestion.question.options.length
  ) {
    await postBack("(invalid option)");
    return;
  }
  const opt = suggestion.question.options[optionIdx]!;
  const projectId = suggestion.projectId;
  if (!projectId) {
    await postBack("(suggestion has no project)");
    return;
  }
  // Original brief + clarification, same shape as the web's answer
  // path. Keeps the agent grounded in the operator's intent across
  // both turns rather than just brainstorming on the answer alone.
  const combined = `${suggestion.prompt}\n\nClarification (${suggestion.question.header}): ${opt.label}`;
  await postBack(`→ ${opt.label}`);
  // Drop the question's reply pointer so a stray free-form reply to
  // the old bubble doesn't double-fire. lastSuggestionByChat will be
  // refreshed when the new brainstorm posts its result.
  ctx.state.lastSuggestionByChat.delete(chatId);
  await runProjectAction(ctx, chatId, "brainstorm", combined, projectId);
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
  ctx.state.pending.delete(pickerId);
  await postBack("…");
  await runProjectAction(ctx, p.chatId, p.kind, p.prompt, projectId);
}

// ── Task workflow commands ──────────────────────────────────────────

export async function cmdCommit(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    let message = arg.trim();
    if (!message) {
      const gen = await ctx.client.generateCommitMessage(id, {});
      if (gen.error) {
        await msg.reply(`could not auto-generate message: ${gen.error}`);
        return;
      }
      message = gen.message;
    }
    const r = await ctx.client.commitTask(id, message);
    if (!r.committed) {
      await msg.reply("nothing to commit.");
      return;
    }
    const fmt = ctx.adapter.fmt;
    await msg.reply(
      `committed ${fmt.code((r.sha ?? "").slice(0, 7))}\n${r.message ?? message}`,
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdPush(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const r = await ctx.client.pushTask(id);
    const fmt = ctx.adapter.fmt;
    await msg.reply(
      r.pushed
        ? `pushed ${fmt.code(r.branch)} → ${fmt.code(r.remote)}`
        : `nothing to push (${r.branch})`,
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

/**
 * /pr <title> | <body?> — open a PR. The "|" splits title from body
 * to allow multi-line bodies via the same single-line command. Use
 * the dashboard's streamed generator for richer output.
 */
export async function cmdPr(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  const trimmed = arg.trim();
  if (!trimmed) {
    await msg.reply("usage: /pr <title> [| <body>]");
    return;
  }
  const pipe = trimmed.indexOf("|");
  const title = (pipe >= 0 ? trimmed.slice(0, pipe) : trimmed).trim();
  const body = pipe >= 0 ? trimmed.slice(pipe + 1).trim() : undefined;
  try {
    const r = await ctx.client.openPrForTask(id, { title, body });
    await msg.reply(`PR opened: ${r.url}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdRevert(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  const sha = arg.trim();
  if (!sha) {
    await msg.reply("usage: /revert <sha>");
    return;
  }
  try {
    await ctx.client.revert(id, sha);
    await msg.reply(`reverted ${sha.slice(0, 7)}.`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdClose(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    await ctx.client.closeTask(id, arg.trim() || undefined);
    await msg.reply(`closed ${id.slice(-8)}.`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdReopen(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    await ctx.client.reopenTask(id);
    await msg.reply(`reopened ${id.slice(-8)}.`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdRm(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    await ctx.client.removeTask(id);
    ctx.state.focus.delete(msg.chatId);
    await msg.reply(`removed ${id.slice(-8)}.`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdFiles(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const r = await ctx.client.listFiles(id);
    if (r.files.length === 0) {
      await msg.reply("(no changed files)");
      return;
    }
    const body = r.files.slice(0, 100).join("\n");
    await msg.reply(body + (r.files.length > 100 ? "\n…" : ""));
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdSt(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const r = await ctx.client.gitStatus(id);
    if (r.entries.length === 0) {
      await msg.reply(`(clean) on ${r.base}`);
      return;
    }
    const body = r.entries
      .slice(0, 60)
      .map(
        (e) =>
          `${e.status.padEnd(10)} +${e.additions} -${e.deletions}  ${e.path}`,
      )
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

// ── Task metadata commands ──────────────────────────────────────────

export async function cmdModel(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  const trimmed = arg.trim();
  if (!trimmed) {
    try {
      const { task } = await ctx.client.getTask(id);
      const fmt = ctx.adapter.fmt;
      await msg.reply(
        `model: ${fmt.code(task.model || "(default)")}\n/model <id> to override, /model clear to reset`,
      );
    } catch (e) {
      await msg.reply((e as Error).message);
    }
    return;
  }
  const value = trimmed.toLowerCase() === "clear" ? "" : trimmed;
  try {
    await ctx.client.setTaskModel(id, value);
    await msg.reply(value ? `model → ${value}` : "model cleared.");
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

const VALID_THINK = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export async function cmdThink(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  const level = arg.trim().toLowerCase();
  if (!level) {
    try {
      const { task } = await ctx.client.getTask(id);
      await msg.reply(
        `thinking: ${task.thinkingLevel ?? "(default)"}\nlevels: minimal low medium high xhigh max`,
      );
    } catch (e) {
      await msg.reply((e as Error).message);
    }
    return;
  }
  if (!VALID_THINK.has(level)) {
    await msg.reply("level must be one of: minimal low medium high xhigh max");
    return;
  }
  try {
    await ctx.client.setTaskThinkingLevel(
      id,
      level as "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    );
    await msg.reply(`thinking → ${level}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

function parseBool(arg: string): boolean | null {
  const s = arg.trim().toLowerCase();
  if (s === "on" || s === "true" || s === "1" || s === "yes") return true;
  if (s === "off" || s === "false" || s === "0" || s === "no") return false;
  return null;
}

export async function cmdAutoCommit(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  const v = parseBool(arg);
  if (v == null) {
    try {
      const { task } = await ctx.client.getTask(id);
      await msg.reply(`autoCommit: ${task.autoCommit ?? true ? "on" : "off"}`);
    } catch (e) {
      await msg.reply((e as Error).message);
    }
    return;
  }
  try {
    await ctx.client.setTaskAutoFlags(id, { autoCommit: v });
    await msg.reply(`autoCommit → ${v ? "on" : "off"}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdAutoPush(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  const v = parseBool(arg);
  if (v == null) {
    try {
      const { task } = await ctx.client.getTask(id);
      await msg.reply(`autoPush: ${task.autoPush ? "on" : "off"}`);
    } catch (e) {
      await msg.reply((e as Error).message);
    }
    return;
  }
  try {
    await ctx.client.setTaskAutoFlags(id, { autoPush: v });
    await msg.reply(`autoPush → ${v ? "on" : "off"}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdSkills(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const { task } = await ctx.client.getTask(id);
    const skills = task.skills ?? [];
    if (skills.length === 0) {
      await msg.reply("(no skills active on this task)");
      return;
    }
    await msg.reply(`active skills:\n${skills.map((s) => `• ${s}`).join("\n")}`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

// ── Steer / ask / compact / context ─────────────────────────────────

export async function cmdSteer(
  ctx: BotContext,
  msg: IncomingMessage,
  text: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  if (!text.trim()) {
    await msg.reply("usage: /steer <text>");
    return;
  }
  try {
    const r = await ctx.client.steerTask(id, text, "interrupt");
    await msg.reply(`→ ${r.mode} for ${id.slice(-8)} (depth ${r.queued})`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdAsk(
  ctx: BotContext,
  msg: IncomingMessage,
  text: string,
): Promise<void> {
  // No dedicated /ask endpoint — same wire as /in, just queued. We
  // keep a separate verb so the operator's mental model matches the
  // dashboard's "Ask" button.
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  if (!text.trim()) {
    await msg.reply("usage: /ask <question>");
    return;
  }
  try {
    await ctx.client.sendInput(id, text);
    await msg.reply("asked.");
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdCompact(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const r = await ctx.client.compactTask(id, arg.trim() || undefined);
    await msg.reply(r.ok ? `compacting (${r.agent}).` : "compact failed.");
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdCtx(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const id = focused(ctx, msg.chatId);
  if (!id) {
    await msg.reply("no focused task.");
    return;
  }
  try {
    const c = await ctx.client.getTaskContext(id);
    const fmt = ctx.adapter.fmt;
    const conv = c.conversation;
    const skills = c.skills.map((s) => `• ${s.displayName}`).join("\n") || "(none)";
    const used = conv.used.toLocaleString();
    const window = conv.window.toLocaleString();
    const cumulative = conv.cumulative != null ? ` (${conv.cumulative.toLocaleString()} cumulative)` : "";
    await msg.reply(
      [
        `${fmt.bold("context")} ${used} / ${window} tokens${cumulative}`,
        `suffix budget: ${c.suffix.used.toLocaleString()} / ${c.suffix.budget.toLocaleString()}`,
        ``,
        `${fmt.bold("active skills")}`,
        skills,
      ].join("\n"),
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

// ── Saved ideas ─────────────────────────────────────────────────────

export async function cmdIdeas(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const projectId = focusedProject(ctx, msg.chatId);
  if (!projectId) {
    await msg.reply("no focused project. /project <name> first.");
    return;
  }
  try {
    const { ideas } = await ctx.client.listSavedIdeas(projectId);
    if (ideas.length === 0) {
      await msg.reply("(no saved ideas)");
      return;
    }
    const fmt = ctx.adapter.fmt;
    const body = ideas
      .slice(0, 20)
      .map(
        (i) =>
          `${fmt.code(i.id.slice(-8))}  ${i.text.slice(0, 80)}`,
      )
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdIdea(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = arg.trim();
  if (!id) {
    await msg.reply("usage: /idea <id-or-suffix>");
    return;
  }
  try {
    let resolvedId = id;
    const projectId = focusedProject(ctx, msg.chatId);
    if (projectId && id.length < 16) {
      // Suffix lookup within focused project — friendlier than full uuids.
      const { ideas } = await ctx.client.listSavedIdeas(projectId);
      const match = ideas.find((i) => i.id === id || i.id.endsWith(id));
      if (match) resolvedId = match.id;
    }
    const { idea } = await ctx.client.getIdea(resolvedId);
    const fmt = ctx.adapter.fmt;
    const lines: string[] = [
      `${fmt.bold(idea.text)} ${fmt.code(idea.id.slice(-8))}`,
    ];
    if (idea.description) lines.push(idea.description.slice(0, 400));
    if (idea.planDraft) {
      lines.push("", fmt.bold("plan"), idea.planDraft.slice(0, 600));
    }
    if (idea.planSlices && idea.planSlices.length > 0) {
      lines.push(
        "",
        fmt.bold("slices"),
        idea.planSlices.map((s, i) => `${i + 1}. ${s.title}`).join("\n"),
      );
    }
    await msg.reply(lines.join("\n"));
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

// ── GitHub ──────────────────────────────────────────────────────────

export async function cmdIssues(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const projectId = focusedProject(ctx, msg.chatId);
  if (!projectId) {
    await msg.reply("no focused project. /project <name> first.");
    return;
  }
  try {
    const r = await ctx.client.listGithubIssues(projectId, { state: "open" });
    if (r.issues.length === 0) {
      await msg.reply("(no open issues)");
      return;
    }
    const fmt = ctx.adapter.fmt;
    const body = r.issues
      .slice(0, 20)
      .map((i) => `#${i.number}  ${fmt.italic(i.state)}  ${i.title.slice(0, 80)}`)
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdPrs(
  ctx: BotContext,
  msg: IncomingMessage,
): Promise<void> {
  const projectId = focusedProject(ctx, msg.chatId);
  if (!projectId) {
    await msg.reply("no focused project. /project <name> first.");
    return;
  }
  try {
    const r = await ctx.client.listGithubPrs(projectId, { state: "open" });
    if (r.prs.length === 0) {
      await msg.reply("(no open PRs)");
      return;
    }
    const fmt = ctx.adapter.fmt;
    const body = r.prs
      .slice(0, 20)
      .map(
        (p) =>
          `#${p.number}  ${fmt.italic(p.state)}  ${p.title.slice(0, 80)}`,
      )
      .join("\n");
    await msg.reply(body);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdIssue(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const projectId = focusedProject(ctx, msg.chatId);
  if (!projectId) {
    await msg.reply("no focused project. /project <name> first.");
    return;
  }
  const num = Number(arg.trim());
  if (!Number.isFinite(num) || num <= 0) {
    await msg.reply("usage: /issue <number>");
    return;
  }
  try {
    const r = await ctx.client.viewGithubIssue(projectId, num);
    if (!r.ok || !r.issue) {
      await msg.reply(r.error ?? "issue not found");
      return;
    }
    const fmt = ctx.adapter.fmt;
    await msg.reply(
      [
        `${fmt.bold(`#${r.issue.number} ${r.issue.title}`)}`,
        `${fmt.italic(r.issue.state)}`,
        "",
        r.issue.body?.slice(0, 1000) || "(no body)",
      ].join("\n"),
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdPrView(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const projectId = focusedProject(ctx, msg.chatId);
  if (!projectId) {
    await msg.reply("no focused project. /project <name> first.");
    return;
  }
  const num = Number(arg.trim());
  if (!Number.isFinite(num) || num <= 0) {
    await msg.reply("usage: /prview <number>");
    return;
  }
  try {
    const r = await ctx.client.viewGithubPr(projectId, num);
    if (!r.ok || !r.pr) {
      await msg.reply(r.error ?? "pr not found");
      return;
    }
    const fmt = ctx.adapter.fmt;
    await msg.reply(
      [
        `${fmt.bold(`#${r.pr.number} ${r.pr.title}`)}`,
        `${fmt.italic(r.pr.state)}`,
        "",
        r.pr.body?.slice(0, 1000) || "(no body)",
      ].join("\n"),
    );
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

// ── Schedule on/off ─────────────────────────────────────────────────

export async function cmdSchedOn(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = arg.trim();
  if (!id) {
    await msg.reply("usage: /schedon <id-or-suffix>");
    return;
  }
  try {
    const { schedules } = await ctx.client.listSchedules();
    const match = schedules.find((s) => s.id === id || s.id.endsWith(id));
    if (!match) {
      await msg.reply("no match");
      return;
    }
    await ctx.client.enableSchedule(match.id);
    await msg.reply(`enabled ${match.name}.`);
  } catch (e) {
    await msg.reply((e as Error).message);
  }
}

export async function cmdSchedOff(
  ctx: BotContext,
  msg: IncomingMessage,
  arg: string,
): Promise<void> {
  const id = arg.trim();
  if (!id) {
    await msg.reply("usage: /schedoff <id-or-suffix>");
    return;
  }
  try {
    const { schedules } = await ctx.client.listSchedules();
    const match = schedules.find((s) => s.id === id || s.id.endsWith(id));
    if (!match) {
      await msg.reply("no match");
      return;
    }
    await ctx.client.disableSchedule(match.id);
    await msg.reply(`disabled ${match.name}.`);
  } catch (e) {
    await msg.reply((e as Error).message);
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

    // project session
    case "projects":
      await cmdProjects(ctx, msg);
      return true;
    case "project":
      await cmdProject(ctx, msg, args);
      return true;
    case "pclear":
      await cmdPClear(ctx, msg);
      return true;

    // tasks (existing)
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

    // task workflow
    case "commit":
      await cmdCommit(ctx, msg, args);
      return true;
    case "push":
      await cmdPush(ctx, msg);
      return true;
    case "pr":
      await cmdPr(ctx, msg, args);
      return true;
    case "revert":
      await cmdRevert(ctx, msg, args);
      return true;
    case "close":
      await cmdClose(ctx, msg, args);
      return true;
    case "reopen":
      await cmdReopen(ctx, msg);
      return true;
    case "rm":
      await cmdRm(ctx, msg);
      return true;
    case "files":
      await cmdFiles(ctx, msg);
      return true;
    case "st":
      await cmdSt(ctx, msg);
      return true;

    // task metadata
    case "model":
      await cmdModel(ctx, msg, args);
      return true;
    case "think":
      await cmdThink(ctx, msg, args);
      return true;
    case "autocommit":
      await cmdAutoCommit(ctx, msg, args);
      return true;
    case "autopush":
      await cmdAutoPush(ctx, msg, args);
      return true;
    case "skills":
      await cmdSkills(ctx, msg);
      return true;

    // steer / ask / context
    case "steer":
      await cmdSteer(ctx, msg, args);
      return true;
    case "ask":
      await cmdAsk(ctx, msg, args);
      return true;
    case "compact":
      await cmdCompact(ctx, msg, args);
      return true;
    case "ctx":
      await cmdCtx(ctx, msg);
      return true;

    // ideas
    case "ideas":
      await cmdIdeas(ctx, msg);
      return true;
    case "idea":
      await cmdIdea(ctx, msg, args);
      return true;

    // github
    case "issues":
      await cmdIssues(ctx, msg);
      return true;
    case "prs":
      await cmdPrs(ctx, msg);
      return true;
    case "issue":
      await cmdIssue(ctx, msg, args);
      return true;
    case "prview":
      await cmdPrView(ctx, msg, args);
      return true;

    // templates / schedules
    case "tpl":
      await cmdTpl(ctx, msg);
      return true;
    case "run":
      await cmdRun(ctx, msg, args);
      return true;
    case "sched":
      await cmdSched(ctx, msg);
      return true;
    case "schedon":
      await cmdSchedOn(ctx, msg, args);
      return true;
    case "schedoff":
      await cmdSchedOff(ctx, msg, args);
      return true;

    case "mirror":
      await cmdMirror(ctx, msg, args.trim());
      return true;
    default:
      return false;
  }
}
