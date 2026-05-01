import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ServerWebSocket } from "bun";
import {
  CreateProjectRequest,
  CreateScheduleRequest,
  CreateSkillRequest,
  CreateTaskRequest,
  CreateTemplateRequest,
  type DeviceSession,
  PairExchangeRequest,
  RunTemplateRequest,
  SendInputRequest,
  UpdateProjectRequest,
  UpdateSkillRequest,
  CreateTerminalSessionRequest,
  CreateTerminalWindowRequest,
  RenameTerminalSessionRequest,
  RenameTerminalWindowRequest,
  SendTerminalKeysRequest,
  type WsServerEvent,
} from "@agentd/contracts";
import { join, normalize, relative, resolve } from "node:path";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  startPty,
  handlePtyClientMessage,
  closePty,
  type PtyAttachData,
} from "./pty.ts";
import {
  EventBus,
  exchangePairingToken,
  issuePairingToken,
  listSessions,
  revokeSession,
  listMessages,
  listFiles,
  diffAgainst,
  listLog,
  revertCommit,
  autoCommit,
  pushBranch,
  createPr,
  gitStatus,
  setTaskPrUrl,
  resolveSession,
  loadConfig,
  saveConfig,
  TelegramPluginConfig,
  DiscordPluginConfig,
  createTemplate,
  deleteTemplate,
  getTemplate,
  getTemplateByName,
  listTemplates,
  renderTemplate,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  setScheduleEnabled,
  type AgentdPaths,
  type Db,
  type PluginName,
  listAllSkills,
  findSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  deleteSkillFile,
  skillDirPath,
  renderSkillsBudgeted,
  renderSkillsCatalog,
  renderRepoContext,
  listProjects,
  getProjectById,
  getProjectBySlug,
  createProject,
  updateProject,
  deleteProject,
  listTmuxSessions,
  createTmuxSession,
  killTmuxSession,
  tmuxSessionExists,
  renameTmuxSession,
  listTmuxWindows,
  newTmuxWindow,
  killTmuxWindow,
  selectTmuxWindow,
  renameTmuxWindow,
  sendTmuxKeys,
} from "@agentd/core";
import type { PluginManager } from "./pluginManager.ts";
import { requireSession, bearerOrHeader } from "./auth.ts";
import type { TaskManager } from "./taskManager.ts";
import { WindowWatcher } from "./windowWatcher.ts";

interface EventsWsData {
  kind: "events";
  sessionId: string;
  taskId: string | null;
  unsubscribe: (() => void) | null;
  unsubscribeSystem: (() => void) | null;
}

type PtyWsData = { kind: "pty" } & PtyAttachData;

type WsData = EventsWsData | PtyWsData;

export interface BuildServerOptions {
  db: Db;
  bus: EventBus;
  paths: AgentdPaths;
  tasks: TaskManager;
  plugins: PluginManager;
  version: string;
}

export function buildServer(opts: BuildServerOptions) {
  const { db, bus, paths, tasks, plugins, version } = opts;
  const windowWatcher = new WindowWatcher(bus);
  const app = new Hono();

  app.use("*", cors());

  app.get("/health", (c) =>
    c.json({ ok: true, version, time: Date.now() }),
  );

  app.post("/pair", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PairExchangeRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    try {
      const { sessionToken, expiresAt } = exchangePairingToken(
        db,
        parsed.data.pairingToken,
        parsed.data.deviceLabel,
      );
      return c.json({ sessionToken, expiresAt });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  const api = new Hono();
  api.use("*", requireSession(db));

  api.get("/tasks", (c) => c.json({ tasks: tasks.list() }));

  api.post("/tasks", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTaskRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    try {
      const task = await tasks.create({
        agent: parsed.data.agent,
        repoPath: parsed.data.repoPath,
        baseBranch: parsed.data.baseBranch,
        prompt: parsed.data.prompt,
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.autoPush != null ? { autoPush: parsed.data.autoPush } : {}),
        ...(parsed.data.autoPr != null ? { autoPr: parsed.data.autoPr } : {}),
        ...(parsed.data.skills?.length ? { skills: parsed.data.skills } : {}),
        ...(parsed.data.permissionMode
          ? { permissionMode: parsed.data.permissionMode }
          : {}),
      });
      return c.json({ task });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.get("/tasks/:id", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json({ task, messages: listMessages(db, id) });
  });

  api.post("/tasks/:id/input", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = SendInputRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    try {
      await tasks.sendInput(id, parsed.data.text);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.post("/tasks/:id/stop", async (c) => {
    const id = c.req.param("id");
    await tasks.stop(id);
    return c.json({ ok: true });
  });

  api.delete("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    await tasks.remove(id);
    return c.json({ ok: true });
  });

  api.get("/tasks/:id/files", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const files = await listFiles(task.worktreePath);
    return c.json({ files, worktreePath: task.worktreePath });
  });

  // Git status with per-file +/- counts. Drives the workspace file tree's
  // git-style overlay. Compared against the task's base branch so the
  // tree shows the agent's work even after auto-commit.
  api.get("/tasks/:id/git-status", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const base = c.req.query("base") ?? task.baseBranch;
    try {
      const entries = await gitStatus(task.worktreePath, base);
      return c.json({ worktreePath: task.worktreePath, entries, base });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Generate a commit message from the current diff using Claude (one-shot,
   * non-interactive). Returns a conventional-commit subject. Optional
   * shape flags let the caller ask for a body / scope / wip prefix.
   * Falls back to a deterministic title-derived message if Claude isn't
   * on PATH or errors out.
   */
  api.post("/tasks/:id/commit-message", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      includeBody?: boolean;
      includeScope?: boolean;
      wip?: boolean;
      hint?: string;
    };
    // Pull the staged + working diff so the model sees what's actually
    // about to be committed. Cap to ~12k chars so the prompt stays small.
    const stagedProc = Bun.spawn(["git", "diff", "--staged", "--no-color"], {
      cwd: task.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const wtProc = Bun.spawn(["git", "diff", "--no-color"], {
      cwd: task.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [staged, working] = await Promise.all([
      new Response(stagedProc.stdout).text(),
      new Response(wtProc.stdout).text(),
    ]);
    await Promise.all([stagedProc.exited, wtProc.exited]);
    const combined = (staged + "\n" + working).slice(0, 12000);
    if (combined.trim().length === 0) {
      return c.json({
        message: `chore: ${task.title.slice(0, 60)}`,
        source: "fallback-no-changes",
      });
    }

    const wantBody = !!body.includeBody;
    const wantScope = !!body.includeScope;
    const isWip = !!body.wip;
    const hint = (body.hint ?? "").trim();

    const rules = [
      "Output ONLY the commit message, no preamble, no fences, no quotes.",
      isWip
        ? "Use prefix `wip` (e.g. `wip: small description`)."
        : "Use a Conventional Commit type: feat, fix, refactor, docs, chore, style, test, perf, ci, build.",
      wantScope
        ? "Optionally include a short scope in parentheses if obvious from the diff: `feat(api): ...`."
        : "Do NOT include a scope.",
      "Subject line must be lowercase, in imperative mood, under 70 characters total.",
      wantBody
        ? "After the subject add a blank line, then 1–3 short bullet points explaining what changed (no test plan, no AI attribution)."
        : "Subject line only — no body.",
      hint ? `Operator hint: ${hint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const prompt =
      `Generate a single git commit message for this diff.\n\n${rules}\n\n--- DIFF ---\n${combined}\n--- END DIFF ---`;

    const claudeBin = process.env.AGENTD_CLAUDE_BIN || "claude";
    try {
      const proc = Bun.spawn([
        claudeBin,
        "-p",
        prompt,
        "--permission-mode",
        "bypassPermissions",
        "--allow-dangerously-skip-permissions",
      ], {
        cwd: task.worktreePath,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const cleaned = out
        .trim()
        .replace(/^`+|`+$/g, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (!cleaned) {
        return c.json({
          message: `chore: ${task.title.slice(0, 60)}`,
          source: "fallback-empty-output",
        });
      }
      return c.json({ message: cleaned, source: "claude" });
    } catch (e) {
      return c.json({
        message: `chore: ${task.title.slice(0, 60)}`,
        source: "fallback-claude-error",
        error: (e as Error).message,
      });
    }
  });

  // Manual commit — operator hits "Ship" in the UI when they want a
  // discrete commit instead of waiting for the agent to finish.
  api.post("/tasks/:id/commit", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
    };
    const cfg = loadConfig(paths.root);
    const subject =
      body.message?.trim() ||
      `${cfg.commitPrefix}${task.title}`.slice(0, 72);
    try {
      const r = await autoCommit({
        cwd: task.worktreePath,
        title: subject,
      });
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Push the task's branch to its origin remote.
  api.post("/tasks/:id/push", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    try {
      const r = await pushBranch(task.worktreePath);
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Open a PR for the current branch via gh. Title + body come from the
  // operator (we don't auto-generate to keep the user's voice / style).
  api.post("/tasks/:id/pr", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      body?: string;
      draft?: boolean;
    };
    if (!body.title?.trim()) {
      return c.json({ error: "title required" }, 400);
    }
    try {
      const r = await createPr({
        cwd: task.worktreePath,
        title: body.title.trim(),
        body: body.body ?? "",
        baseBranch: task.baseBranch,
        draft: !!body.draft,
      });
      if (r.url) {
        setTaskPrUrl(db, task.id, r.url);
      }
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.get("/tasks/:id/file", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path query required" }, 400);
    const safe = resolveSafePath(task.worktreePath, path);
    if (!safe) return c.json({ error: "path escapes worktree" }, 400);
    if (!existsSync(safe)) return c.json({ error: "not found" }, 404);
    const stat = statSync(safe);
    if (stat.isDirectory()) return c.json({ error: "is directory" }, 400);
    if (stat.size > 1_000_000)
      return c.json({ error: "file too large", size: stat.size }, 413);
    let text: string;
    try {
      text = readFileSync(safe, "utf8");
    } catch {
      return c.json({ error: "binary or unreadable" }, 415);
    }
    return c.json({ path, size: stat.size, content: text });
  });

  api.get("/tasks/:id/diff", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const baseRef = c.req.query("base") ?? task.baseBranch;
    const result = await diffAgainst(task.worktreePath, baseRef);
    return c.json(result);
  });

  api.get("/tasks/:id/log", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const log = await listLog(task.worktreePath, limit);
    return c.json({ log });
  });

  api.post("/tasks/:id/revert", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { sha?: string };
    if (!body.sha) return c.json({ error: "sha required" }, 400);
    try {
      await revertCommit(task.worktreePath, body.sha);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Inspect everything that gets injected into the agent's system prompt for
   * this task: server agentInstructions, resolved skill bodies, and a
   * repo-canonical doc (CLAUDE.md / AGENTS.md / .agents/INSTRUCTIONS.md if
   * present). The web UI renders these as collapsible blocks so the operator
   * can see what the agent is actually working with.
   */
  api.get("/tasks/:id/context", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const cfg = loadConfig(paths.root);

    const skills: { id: string; displayName: string; body: string }[] = [];
    for (const sid of task.skills ?? []) {
      const s = findSkill(sid, {
        agentdRoot: paths.root,
        repoPath: task.repoPath,
      });
      if (!s) continue;
      skills.push({
        id: `${s.scope}:${s.slug}`,
        displayName: s.displayName ?? s.name,
        body: s.body,
      });
    }

    // Compute the trim that *would* apply if we re-rendered now.
    const renderInfo = renderSkillsBudgeted(task.skills ?? [], {
      agentdRoot: paths.root,
      repoPath: task.repoPath,
      maxTokens: cfg.maxContextTokens,
    });

    // Read a repo-canonical instructions file if present.
    const candidateDocs = [
      ".agents/INSTRUCTIONS.md",
      "CLAUDE.md",
      "AGENTS.md",
    ];
    let repoCanonical: { path: string; content: string } | null = null;
    for (const rel of candidateDocs) {
      const p = join(task.repoPath, rel);
      if (!existsSync(p)) continue;
      try {
        const content = readFileSync(p, "utf8");
        if (content.length > 0) {
          repoCanonical = { path: rel, content };
          break;
        }
      } catch {
        // ignore unreadable
      }
    }

    // Conversation usage estimate — totalInput + totalOutput tokens reported
    // by the agent stream. Window: assume 200k Sonnet/Codex unless we know
    // better. Used by the UI to render a usage bar / warn at 80%.
    const conversationTokens =
      (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);
    const conversationWindow = 200_000;

    // The catalog actually injected at spawn time (names + paths, no bodies).
    const skillsCatalog = renderSkillsCatalog(task.skills ?? [], {
      agentdRoot: paths.root,
      repoPath: task.repoPath,
    });

    // Repo-context catalog — what we tell the agent about the worktree.
    const repoCtx = renderRepoContext({ worktreePath: task.worktreePath });

    return c.json({
      agentInstructions: cfg.agentInstructions ?? "",
      skills,
      repoCanonical,
      // Suffix-prompt budget (skills + agentInstructions), trim metadata.
      suffix: {
        budget: cfg.maxContextTokens,
        used: renderInfo.tokens,
        kept: renderInfo.kept,
        trimmed: renderInfo.trimmed,
      },
      // Progressive-disclosure catalogs — what the agent actually sees.
      catalogs: {
        skills: skillsCatalog,
        repo: repoCtx,
      },
      conversation: {
        used: conversationTokens,
        window: conversationWindow,
      },
    });
  });

  /**
   * Tell the running agent to compact its working memory. For Claude Code
   * we send the native `/compact` slash command (with optional focus
   * suffix). For Codex we send a structured "summarize and continue"
   * directive — Codex doesn't have a built-in compact command but it'll
   * happily summarize on demand.
   */
  api.post("/tasks/:id/compact", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { focus?: string };
    const focus = (body.focus ?? "").trim();
    let directive: string;
    if (task.agent === "claude") {
      directive = focus ? `/compact ${focus}` : "/compact";
    } else {
      directive = focus
        ? `Please summarize what you've done so far in 200 words, focusing on "${focus}". Discard intermediate scratch work, then continue with the smaller context.`
        : "Please summarize what you've done so far in 200 words and discard any intermediate scratch work; continue from this compact summary.";
    }
    try {
      await tasks.sendInput(id, directive);
      return c.json({ ok: true, agent: task.agent, directive });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ──────────────────────── templates ────────────────────────
  api.get("/templates", (c) => c.json({ templates: listTemplates(db) }));

  api.post("/templates", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTemplateRequest.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    if (getTemplateByName(db, parsed.data.name)) {
      return c.json({ error: "template name already exists" }, 409);
    }
    const tpl = createTemplate(db, parsed.data);
    return c.json({ template: tpl });
  });

  api.get("/templates/:id", (c) => {
    const tpl = getTemplate(db, c.req.param("id")) ?? getTemplateByName(db, c.req.param("id"));
    if (!tpl) return c.json({ error: "not found" }, 404);
    return c.json({ template: tpl });
  });

  api.delete("/templates/:id", (c) => {
    const tpl = getTemplate(db, c.req.param("id")) ?? getTemplateByName(db, c.req.param("id"));
    if (!tpl) return c.json({ error: "not found" }, 404);
    deleteTemplate(db, tpl.id);
    return c.json({ ok: true });
  });

  api.post("/templates/:id/run", async (c) => {
    const tpl = getTemplate(db, c.req.param("id")) ?? getTemplateByName(db, c.req.param("id"));
    if (!tpl) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = RunTemplateRequest.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const prompt = renderTemplate(tpl.promptTemplate, parsed.data.args);
    try {
      const task = await tasks.create({
        agent: tpl.agent,
        repoPath: tpl.repoPath,
        baseBranch: tpl.baseBranch,
        prompt,
        title: parsed.data.titleOverride ?? tpl.name,
        autoPush: tpl.autoPush,
        autoPr: tpl.autoPr,
        templateId: tpl.id,
      });
      return c.json({ task });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ──────────────────────── schedules ────────────────────────
  api.get("/schedules", (c) => c.json({ schedules: listSchedules(db) }));

  api.post("/schedules", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateScheduleRequest.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    // template must exist
    const tpl = getTemplate(db, parsed.data.templateId) ?? getTemplateByName(db, parsed.data.templateId);
    if (!tpl) return c.json({ error: `unknown template: ${parsed.data.templateId}` }, 400);
    try {
      const sched = createSchedule(db, {
        ...parsed.data,
        templateId: tpl.id,
      });
      return c.json({ schedule: sched });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.get("/schedules/:id", (c) => {
    const sch = getSchedule(db, c.req.param("id"));
    if (!sch) return c.json({ error: "not found" }, 404);
    return c.json({ schedule: sch });
  });

  api.post("/schedules/:id/enable", (c) => {
    const sch = setScheduleEnabled(db, c.req.param("id"), true);
    if (!sch) return c.json({ error: "not found" }, 404);
    return c.json({ schedule: sch });
  });

  api.post("/schedules/:id/disable", (c) => {
    const sch = setScheduleEnabled(db, c.req.param("id"), false);
    if (!sch) return c.json({ error: "not found" }, 404);
    return c.json({ schedule: sch });
  });

  api.delete("/schedules/:id", (c) => {
    const sch = getSchedule(db, c.req.param("id"));
    if (!sch) return c.json({ error: "not found" }, 404);
    deleteSchedule(db, sch.id);
    return c.json({ ok: true });
  });

  api.post("/admin/pair", (c) => {
    // Issue an additional pairing token from an authenticated session.
    const issued = issuePairingToken(db);
    return c.json(issued);
  });

  // ── Device sessions ──
  // The current session is identified from the auth middleware's c.get("session").
  // We use it both to mark the row in the list as `current: true` and to
  // refuse self-deletion (would leave the operator immediately logged out).
  api.get("/admin/sessions", (c) => {
    const cur = (c as unknown as { get: (k: string) => { sessionId: string } | undefined }).get("session");
    const rows = listSessions(db);
    const sessions: DeviceSession[] = rows.map((r) => ({
      id: r.id,
      deviceLabel: r.deviceLabel,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt ?? r.createdAt,
      expiresAt: r.expiresAt ?? null,
      current: cur?.sessionId === r.id,
    }));
    sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return c.json({ sessions });
  });

  api.delete("/admin/sessions/:id", (c) => {
    const cur = (c as unknown as { get: (k: string) => { sessionId: string } | undefined }).get("session");
    const id = c.req.param("id");
    if (cur?.sessionId === id) {
      return c.json(
        { error: "refusing to revoke the current session — log out instead" },
        409,
      );
    }
    revokeSession(db, id);
    return c.json({ ok: true });
  });

  // ── Filesystem browsing — used by the web repo picker ───────────────
  // Returns the directories within the requested path, marking which ones
  // contain a .git folder. Hidden entries (.foo) are filtered out unless
  // ?showHidden=1 is passed.
  api.get("/fs/list", (c) => {
    const reqPath = c.req.query("path") ?? homedir();
    const showHidden = c.req.query("showHidden") === "1";
    let abs: string;
    try {
      abs = resolve(reqPath || "/");
    } catch {
      return c.json({ error: "invalid path" }, 400);
    }
    if (!existsSync(abs)) {
      return c.json({ error: "not found", path: abs }, 404);
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
    if (!stat.isDirectory()) {
      return c.json({ error: "not a directory", path: abs }, 400);
    }
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch (e) {
      return c.json({ error: (e as Error).message, path: abs }, 500);
    }
    const entries: { name: string; path: string; isDir: boolean; isGit: boolean }[] = [];
    for (const name of names) {
      if (!showHidden && name.startsWith(".")) continue;
      const childPath = join(abs, name);
      let childStat: ReturnType<typeof statSync>;
      try {
        childStat = statSync(childPath);
      } catch {
        continue; // unreadable, skip
      }
      if (!childStat.isDirectory()) continue;
      const isGit = existsSync(join(childPath, ".git"));
      entries.push({ name, path: childPath, isDir: true, isGit });
    }
    entries.sort((a, b) => {
      if (a.isGit !== b.isGit) return a.isGit ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const parent = abs === "/" ? null : resolve(abs, "..");
    const isGitSelf = existsSync(join(abs, ".git"));
    return c.json({
      path: abs,
      parent,
      isGit: isGitSelf,
      entries,
    });
  });

  api.get("/admin/plugins", (c) => {
    const cfg = loadConfig(paths.root);
    return c.json({ plugins: plugins.status(), config: cfg.plugins });
  });

  api.get("/admin/settings", (c) => {
    const cfg = loadConfig(paths.root);
    return c.json({
      agentInstructions: cfg.agentInstructions,
      commitPrefix: cfg.commitPrefix,
      prTitlePrefix: cfg.prTitlePrefix,
      prBodyTemplate: cfg.prBodyTemplate,
      maxContextTokens: cfg.maxContextTokens,
    });
  });

  api.post("/admin/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "json body required" }, 400);
    }
    const cfg = loadConfig(paths.root);
    const next = { ...cfg };
    const stringKeys = [
      "agentInstructions",
      "commitPrefix",
      "prTitlePrefix",
      "prBodyTemplate",
    ] as const;
    const numberKeys = ["maxContextTokens"] as const;
    let changed = false;
    for (const key of stringKeys) {
      if (key in body) {
        const v = body[key];
        if (typeof v !== "string") {
          return c.json({ error: `${key} must be a string` }, 400);
        }
        (next as Record<string, unknown>)[key] = v;
        changed = true;
      }
    }
    for (const key of numberKeys) {
      if (key in body) {
        const v = Number(body[key]);
        if (!Number.isFinite(v) || v <= 0) {
          return c.json({ error: `${key} must be a positive number` }, 400);
        }
        (next as Record<string, unknown>)[key] = Math.floor(v);
        changed = true;
      }
    }
    if (!changed) return c.json({ error: "no valid keys in patch" }, 400);
    saveConfig(paths.root, next);
    return c.json({
      ok: true,
      settings: {
        agentInstructions: next.agentInstructions,
        commitPrefix: next.commitPrefix,
        prTitlePrefix: next.prTitlePrefix,
        prBodyTemplate: next.prBodyTemplate,
        maxContextTokens: next.maxContextTokens,
      },
    });
  });

  const PluginPatchTelegram = TelegramPluginConfig.partial();
  const PluginPatchDiscord = DiscordPluginConfig.partial();

  api.post("/admin/plugins/:name", async (c) => {
    const name = c.req.param("name") as PluginName;
    if (name !== "telegram" && name !== "discord") {
      return c.json({ error: "unknown plugin" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const schema = name === "telegram" ? PluginPatchTelegram : PluginPatchDiscord;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid patch", issues: parsed.error.issues }, 400);
    }
    const cfg = loadConfig(paths.root);
    const merged = { ...cfg.plugins[name], ...parsed.data };
    const next = {
      ...cfg,
      plugins: { ...cfg.plugins, [name]: merged },
    };
    saveConfig(paths.root, next);
    await plugins.reload();
    return c.json({ ok: true, plugin: next.plugins[name], status: plugins.status() });
  });

  api.post("/admin/plugins/:name/restart", async (c) => {
    const name = c.req.param("name") as PluginName;
    if (name !== "telegram" && name !== "discord") {
      return c.json({ error: "unknown plugin" }, 404);
    }
    const r = await plugins.restart(name);
    return c.json({ ok: r.restarted, reason: r.reason ?? null, status: plugins.status() });
  });

  // ── Projects ────────────────────────────────────────────────────────
  api.get("/projects", (c) => {
    return c.json({ projects: listProjects(db) });
  });

  api.get("/projects/:idOrSlug", (c) => {
    const key = c.req.param("idOrSlug");
    const project = getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json({ project });
  });

  api.post("/projects", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateProjectRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const project = createProject(db, parsed.data);
      return c.json({ project });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.patch("/projects/:idOrSlug", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateProjectRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const next = updateProject(db, project.id, parsed.data);
    return c.json({ project: next });
  });

  api.delete("/projects/:idOrSlug", (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    deleteProject(db, project.id);
    return c.json({ ok: true });
  });

  // ── Skills ──────────────────────────────────────────────────────────
  api.get("/skills", (c) => {
    const repoPath = c.req.query("repoPath") || undefined;
    const skills = listAllSkills({ agentdRoot: paths.root, repoPath });
    return c.json({ skills });
  });

  api.get("/skills/:scope/:slug", (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const repoPath = c.req.query("repoPath") || undefined;
    const skill = findSkill(`${scope}:${slug}`, {
      agentdRoot: paths.root,
      repoPath,
    });
    if (!skill) return c.json({ error: "skill not found" }, 404);
    return c.json({ skill });
  });

  api.post("/skills", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSkillRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    }
    try {
      const skill = createSkill(
        {
          scope: parsed.data.scope,
          slug: parsed.data.name,
          displayName: parsed.data.displayName,
          description: parsed.data.description,
          body: parsed.data.body,
        },
        { agentdRoot: paths.root, repoPath: parsed.data.repoPath },
      );
      return c.json({ skill });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.patch("/skills/:scope/:slug", async (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const repoPath = c.req.query("repoPath") || undefined;
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSkillRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    }
    try {
      const skill = updateSkill(`${scope}:${slug}`, parsed.data, {
        agentdRoot: paths.root,
        repoPath,
      });
      return c.json({ skill });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.delete("/skills/:scope/:slug", (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const repoPath = c.req.query("repoPath") || undefined;
    try {
      deleteSkill(`${scope}:${slug}`, { agentdRoot: paths.root, repoPath });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Skill bundle file management — list / read / write / delete files
  // inside a skill's directory (scripts/, references/, anything else).
  // SKILL.md edits go through PATCH /skills/:scope/:slug because they
  // need frontmatter rendering.
  api.get("/skills/:scope/:slug/files", (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const repoPath = c.req.query("repoPath") || undefined;
    try {
      const id = `${scope}:${slug}`;
      const files = listSkillFiles(id, { agentdRoot: paths.root, repoPath });
      const dir = skillDirPath(id, { agentdRoot: paths.root, repoPath });
      return c.json({ files, dir });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.get("/skills/:scope/:slug/file", (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const path = c.req.query("path") ?? "";
    const repoPath = c.req.query("repoPath") || undefined;
    if (!path) return c.json({ error: "path query required" }, 400);
    try {
      const out = readSkillFile(`${scope}:${slug}`, path, {
        agentdRoot: paths.root,
        repoPath,
      });
      return c.json({ path, ...out });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.put("/skills/:scope/:slug/file", async (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const path = c.req.query("path") ?? "";
    const repoPath = c.req.query("repoPath") || undefined;
    if (!path) return c.json({ error: "path query required" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.content !== "string") {
      return c.json({ error: "json body { content: string } required" }, 400);
    }
    try {
      const node = writeSkillFile(`${scope}:${slug}`, path, body.content, {
        agentdRoot: paths.root,
        repoPath,
      });
      return c.json({ ok: true, file: node });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.delete("/skills/:scope/:slug/file", (c) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    const path = c.req.query("path") ?? "";
    const repoPath = c.req.query("repoPath") || undefined;
    if (!path) return c.json({ error: "path query required" }, 400);
    try {
      deleteSkillFile(`${scope}:${slug}`, path, {
        agentdRoot: paths.root,
        repoPath,
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ── tmux / terminal sessions ──
  //
  // Every mutating endpoint also publishes the fresh snapshot on the bus so
  // the WS subscribers update their caches without polling. broadcastSessions
  // / broadcastWindows are the single place we re-fetch from tmux.
  async function broadcastSessions(): Promise<void> {
    bus.publishSystem({
      kind: "terminal_sessions",
      sessions: await listTmuxSessions(),
    });
  }
  async function broadcastWindows(sessionName: string): Promise<void> {
    if (!(await tmuxSessionExists(sessionName))) return;
    bus.publishSystem({
      kind: "terminal_windows",
      sessionName,
      windows: await listTmuxWindows(sessionName),
    });
  }

  api.get("/terminal/sessions", async (c) => {
    const sessions = await listTmuxSessions();
    return c.json({ sessions });
  });

  api.post("/terminal/sessions", async (c) => {
    try {
      const body = CreateTerminalSessionRequest.parse(await c.req.json());
      const cwd = body.cwd && existsSync(body.cwd) ? body.cwd : undefined;
      const session = await createTmuxSession(body.name, cwd);
      if (!session) return c.json({ error: "tmux failed to create session" }, 500);
      void broadcastSessions();
      return c.json({ session });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.delete("/terminal/sessions/:name", async (c) => {
    const name = c.req.param("name");
    const ok = await killTmuxSession(name);
    if (!ok) return c.json({ error: "kill failed (not found?)" }, 404);
    void broadcastSessions();
    return c.json({ ok: true });
  });

  api.post("/terminal/sessions/:name/rename", async (c) => {
    const oldName = c.req.param("name");
    if (!(await tmuxSessionExists(oldName))) {
      return c.json({ error: "session not found" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = RenameTerminalSessionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    if (parsed.data.name === oldName) {
      const all = await listTmuxSessions();
      const cur = all.find((s) => s.name === oldName);
      return c.json({ session: cur });
    }
    if (await tmuxSessionExists(parsed.data.name)) {
      return c.json({ error: "a session with that name already exists" }, 409);
    }
    const ok = await renameTmuxSession(oldName, parsed.data.name);
    if (!ok) return c.json({ error: "rename failed" }, 500);
    const all = await listTmuxSessions();
    const session = all.find((s) => s.name === parsed.data.name);
    void broadcastSessions();
    return c.json({ session });
  });

  api.get("/terminal/sessions/:name/windows", async (c) => {
    const name = c.req.param("name");
    if (!(await tmuxSessionExists(name))) {
      return c.json({ error: "session not found" }, 404);
    }
    const windows = await listTmuxWindows(name);
    return c.json({ windows });
  });

  api.post("/terminal/sessions/:name/windows", async (c) => {
    const name = c.req.param("name");
    if (!(await tmuxSessionExists(name))) {
      return c.json({ error: "session not found" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTerminalWindowRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const cwd =
      parsed.data.cwd && existsSync(parsed.data.cwd) ? parsed.data.cwd : undefined;
    const opts: { name?: string; cwd?: string } = {};
    if (parsed.data.name) opts.name = parsed.data.name;
    if (cwd) opts.cwd = cwd;
    const window = await newTmuxWindow(name, opts);
    if (!window) return c.json({ error: "failed to create window" }, 500);
    const windows = await listTmuxWindows(name);
    void broadcastWindows(name);
    void broadcastSessions();
    return c.json({ window, windows });
  });

  api.post("/terminal/sessions/:name/windows/:index/select", async (c) => {
    const name = c.req.param("name");
    const idx = Number(c.req.param("index"));
    if (!Number.isFinite(idx)) return c.json({ error: "invalid index" }, 400);
    if (!(await tmuxSessionExists(name))) {
      return c.json({ error: "session not found" }, 404);
    }
    const ok = await selectTmuxWindow(name, idx);
    if (!ok) return c.json({ error: "select failed" }, 500);
    void broadcastWindows(name);
    return c.json({ windows: await listTmuxWindows(name) });
  });

  api.post("/terminal/sessions/:name/windows/:index/rename", async (c) => {
    const name = c.req.param("name");
    const idx = Number(c.req.param("index"));
    if (!Number.isFinite(idx)) return c.json({ error: "invalid index" }, 400);
    if (!(await tmuxSessionExists(name))) {
      return c.json({ error: "session not found" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = RenameTerminalWindowRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const ok = await renameTmuxWindow(name, idx, parsed.data.name);
    if (!ok) return c.json({ error: "rename failed" }, 500);
    void broadcastWindows(name);
    return c.json({ windows: await listTmuxWindows(name) });
  });

  api.delete("/terminal/sessions/:name/windows/:index", async (c) => {
    const name = c.req.param("name");
    const idx = Number(c.req.param("index"));
    if (!Number.isFinite(idx)) return c.json({ error: "invalid index" }, 400);
    if (!(await tmuxSessionExists(name))) {
      return c.json({ error: "session not found" }, 404);
    }
    const ok = await killTmuxWindow(name, idx);
    if (!ok) return c.json({ error: "kill failed" }, 500);
    // Session may have died if it was the last window — caller should refetch.
    const stillThere = await tmuxSessionExists(name);
    if (stillThere) void broadcastWindows(name);
    void broadcastSessions();
    return c.json({
      ok: true,
      sessionAlive: stillThere,
      windows: stillThere ? await listTmuxWindows(name) : [],
    });
  });

  api.post("/terminal/sessions/:name/send-keys", async (c) => {
    const name = c.req.param("name");
    if (!(await tmuxSessionExists(name))) {
      return c.json({ error: "session not found" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = SendTerminalKeysRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const opts: { enter?: boolean } = {};
    if (parsed.data.enter) opts.enter = true;
    const ok = await sendTmuxKeys(name, parsed.data.text, opts);
    if (!ok) return c.json({ error: "send-keys failed" }, 500);
    return c.json({ ok: true });
  });

  app.route("/api", api);

  const wsHandler = {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "pty") {
        const ptyWs = ws as ServerWebSocket<PtyAttachData>;
        // Attach the window watcher *before* starting the PTY so the first
        // snapshot lands while the user is still seeing tmux's first redraw.
        if (ptyWs.data.mode === "term" && ptyWs.data.sessionName) {
          windowWatcher.attach(ptyWs.data.sessionName);
        }
        startPty(ptyWs);
        return;
      }
      const evData = ws.data;
      const taskId = evData.taskId;
      const send = (event: WsServerEvent) => {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          // socket closed
        }
      };
      send({ type: "hello", serverVersion: version });
      // Forward agent events as-is, but on transitions that mutate the task
      // row in the DB (status / exit / usage), also push a `task_updated`
      // message with the fresh row so the web cache stays current without
      // having to re-GET /api/tasks. This is what makes the UI feel live
      // instead of "polling and flashing".
      const onEnv = (env: import("@agentd/core").TaskEventEnvelope) => {
        send({
          type: "event",
          taskId: env.taskId,
          event: env.event,
          ts: env.ts,
        });
        const k = env.event.kind;
        if (k === "status" || k === "exit" || k === "usage") {
          const fresh = tasks.get(env.taskId);
          if (fresh) {
            send({ type: "task_updated", task: fresh });
          }
        }
      };
      const sub = taskId
        ? bus.subscribeTask(taskId, onEnv)
        : bus.subscribeAll(onEnv);
      evData.unsubscribe = sub;

      // System events — terminal session/window snapshots. Only forwarded on
      // the global stream (no taskId filter); per-task subscribers don't care.
      if (!taskId) {
        const onSys = (env: import("@agentd/core").SystemEventEnvelope) => {
          if (env.event.kind === "terminal_sessions") {
            send({
              type: "terminal_sessions",
              sessions: env.event.sessions,
              ts: env.ts,
            });
          } else if (env.event.kind === "terminal_windows") {
            send({
              type: "terminal_windows",
              sessionName: env.event.sessionName,
              windows: env.event.windows,
              ts: env.ts,
            });
          }
        };
        evData.unsubscribeSystem = bus.subscribeSystem(onSys);
      }
    },
    message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
      if (ws.data.kind === "pty") {
        handlePtyClientMessage(
          ws as ServerWebSocket<PtyAttachData>,
          typeof msg === "string" ? msg : msg.toString(),
        );
      }
      // /ws (events) is server→client only.
    },
    close(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "pty") {
        const ptyWs = ws as ServerWebSocket<PtyAttachData>;
        if (ptyWs.data.mode === "term" && ptyWs.data.sessionName) {
          windowWatcher.detach(ptyWs.data.sessionName);
        }
        closePty(ptyWs);
        return;
      }
      ws.data.unsubscribe?.();
      ws.data.unsubscribe = null;
      ws.data.unsubscribeSystem?.();
      ws.data.unsubscribeSystem = null;
    },
    drain(_ws: ServerWebSocket<WsData>) {},
  };

  function upgradeRequest(req: Request, server: Bun.Server<WsData>): Response | undefined {
    const url = new URL(req.url);
    const token = url.searchParams.get("session") ?? "";
    const session = resolveSession(db, token);
    if (url.pathname === "/ws") {
      if (!session) return new Response("unauthorized", { status: 401 });
      const taskId = url.searchParams.get("task");
      const data: WsData = {
        kind: "events",
        sessionId: session.sessionId,
        taskId,
        unsubscribe: null,
        unsubscribeSystem: null,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }
    // Per-task shell: /pty/:taskId  (legacy form, still used by the task
    //                                  detail Terminal tab)
    // Term session:   /pty/term/:name (attaches to a named tmux session)
    const ptyTermMatch = url.pathname.match(/^\/pty\/term\/([^/]+)$/);
    const ptyTaskMatch = url.pathname.match(/^\/pty\/([^/]+)$/);

    if (ptyTermMatch) {
      if (!session) return new Response("unauthorized", { status: 401 });
      const name = decodeURIComponent(ptyTermMatch[1]!);
      if (!/^[a-zA-Z0-9_.\-: ]{1,64}$/.test(name)) {
        return new Response("invalid session name", { status: 400 });
      }
      const data: WsData = {
        kind: "pty",
        mode: "term",
        sessionName: name,
        proc: null,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }

    if (ptyTaskMatch) {
      if (!session) return new Response("unauthorized", { status: 401 });
      const taskId = ptyTaskMatch[1]!;
      const task = tasks.get(taskId);
      if (!task) return new Response("task not found", { status: 404 });
      const data: WsData = {
        kind: "pty",
        mode: "task",
        taskId,
        task,
        proc: null,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }
    return undefined;
  }

  return { app, wsHandler, upgradeRequest, bearerOrHeader };
}

function resolveSafePath(root: string, requested: string): string | null {
  const joined = normalize(join(root, requested));
  const rel = relative(root, joined);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) return null;
  return joined;
}
