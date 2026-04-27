import { Bot, GrammyError, HttpError } from "grammy";
import { AgentdClient } from "@agentd/client";
import type { Task, WsServerEvent } from "@agentd/contracts";

interface BotConfig {
  token: string;
  server: string;
  session: string;
  allowedChatIds: Set<number>;
  defaultRepo: string | null;
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
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "";
  const allowed = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s)),
  );
  if (allowed.size === 0) {
    console.error(
      "TELEGRAM_ALLOWED_CHAT_IDS must list at least one chat id (comma-separated). Use /whoami in a chat to get yours after launch.",
    );
  }
  return {
    token,
    server,
    session,
    allowedChatIds: allowed,
    defaultRepo: process.env.AGENTD_DEFAULT_REPO ?? null,
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

  function isAllowed(chatId: number | undefined): boolean {
    if (!chatId) return false;
    if (cfg.allowedChatIds.size === 0) return false;
    return cfg.allowedChatIds.has(chatId);
  }

  bot.command("whoami", async (ctx) => {
    const id = ctx.chat?.id;
    await ctx.reply(`chat id: \`${id}\`\nallowed: ${isAllowed(id) ? "yes" : "no"}`, {
      parse_mode: "MarkdownV2",
    });
  });

  bot.use(async (ctx, next) => {
    if (ctx.message?.text?.startsWith("/whoami")) return next();
    if (!isAllowed(ctx.chat?.id)) {
      await ctx.reply("not allowed. add this chat id to TELEGRAM_ALLOWED_CHAT_IDS.");
      return;
    }
    return next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "agentd telegram bridge",
        "",
        "/new <repo?> <prompt> — spawn a task (uses default repo if omitted)",
        "/ls — list tasks",
        "/show <id?> — show task (or focused)",
        "/in <text> — send input to focused task",
        "/use <id> — set focused task",
        "/stop — stop focused task",
        "/diff — show diff for focused task",
        "/log — show commits for focused task",
        cfg.defaultRepo ? `default repo: ${cfg.defaultRepo}` : "(no default repo set)",
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

  bot.command("new", async (ctx) => {
    const text = (ctx.match || "").toString().trim();
    if (!text) return ctx.reply("usage: /new [repo] <prompt>");
    let repo = cfg.defaultRepo;
    let prompt = text;
    if (text.startsWith("/") || text.startsWith("~")) {
      const parts = text.split(/\s+/);
      repo = parts[0] ?? null;
      prompt = parts.slice(1).join(" ");
    }
    if (!repo) return ctx.reply("no repo. set AGENTD_DEFAULT_REPO or pass an absolute path as first arg.");
    if (!prompt) return ctx.reply("usage: /new [repo] <prompt>");
    try {
      const { task } = await client.createTask({
        agent: "claude",
        repoPath: repo,
        baseBranch: "main",
        prompt,
      });
      focus.set(ctx.chat!.id, task.id);
      await ctx.reply(`spawned ${task.id}\nbranch: ${task.branch}\nfocused.`);
    } catch (e) {
      await ctx.reply(`new failed: ${(e as Error).message}`);
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

  // Anything not a command, in a chat with a focused task, becomes input.
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const id = focused(ctx);
    if (!id) return;
    try {
      await client.sendInput(id, ctx.message.text);
      await ctx.reply("→ sent to " + id.slice(-8));
    } catch (e) {
      await ctx.reply((e as Error).message);
    }
  });

  bot.catch((err) => {
    if (err.error instanceof GrammyError) console.error("grammy:", err.error.description);
    else if (err.error instanceof HttpError) console.error("http:", err.error.message);
    else console.error(err);
  });

  // Push notifications to chats that focus a task.
  const ws = client.watch(null, (event: WsServerEvent) => {
    if (event.type !== "event") return;
    if (event.event.kind !== "message" || event.event.role !== "agent") return;
    const text = event.event.text.trim();
    if (!text) return;
    for (const [chatId, taskId] of focus.entries()) {
      if (taskId !== event.taskId) continue;
      void bot.api
        .sendMessage(chatId, `[${taskId.slice(-8)}] ${text}`.slice(0, 4000))
        .catch((e) => console.error("notify failed:", e));
    }
  });
  ws.addEventListener("close", () => console.error("ws closed"));
  ws.addEventListener("error", () => console.error("ws error"));

  console.log(`telegram bot ready · server=${cfg.server} · ${cfg.allowedChatIds.size} allowed chat(s)`);
  await bot.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
