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
  ThinkingLevel,
  MirrorTarget,
  CreateCouncilRequest,
  ResolveSuggestionRequest,
  CreateTodoRequest,
  UpdateTodoRequest,
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
  listBranches,
  generateBranchName,
  generateCommitMessage,
  streamCommitMessage,
  streamPrMessage,
  getPrState,
  setTaskDiscordThread,
  setTaskPrUrl,
  aggregateToolStats,
  closeTask,
  createTodo,
  deleteTodo,
  getCouncil,
  getSuggestion,
  listCouncils,
  listSuggestions,
  listTodos,
  reopenTask,
  setCouncilWinner,
  setTaskThinkingLevel,
  setTaskModel,
  setTaskMirrorTo,
  updateTodo,
  resolveSession,
  loadConfig,
  loadCodexModelsFromCache,
  saveConfig,
  AiHelperConfig,
  TelegramPluginConfig,
  DiscordPluginConfig,
  UserPrefs,
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
  getProjectById,
  listProjects,
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
  reorderTasks,
  markTaskCompacted,
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

  /**
   * Realtime broadcast helpers — every state change visible across
   * surfaces (web, telegram, discord, CLI) flows through these so
   * connected clients update without a polling round-trip. The
   * principle: if a button in one surface mutates a row, every
   * other connected surface sees the new row within a frame.
   */
  function pubTaskChanged(taskId: string): void {
    const t = tasks.get(taskId);
    if (t) bus.publishSystem({ kind: "task_changed", task: t });
  }
  function pubTaskRemoved(taskId: string): void {
    bus.publishSystem({ kind: "task_removed", taskId });
  }
  function pubProjectChanged(projectId: string): void {
    const p = getProjectById(db, projectId);
    if (p) bus.publishSystem({ kind: "project_changed", project: p });
  }
  function pubProjectCreated(project: import("@agentd/contracts").Project): void {
    bus.publishSystem({ kind: "project_created", project });
  }
  function pubProjectRemoved(projectId: string): void {
    bus.publishSystem({ kind: "project_removed", projectId });
  }

  /**
   * Chat-bridge admin state.
   *
   *  - `discordChannelCache` is the snapshot the discord subprocess
   *    posts up on Ready / guildCreate / channelUpdate. The Plugins +
   *    project Connect-chat UIs read from it.
   *  - `discordCommandReplies` resolves the test-send round-trip: web
   *    POSTs `/discord/test-send`, daemon broadcasts a `discord_command`
   *    on the bus (the discord subprocess is also a /ws subscriber and
   *    handles it), discord posts the result back to
   *    `/discord/command-result`, daemon resolves the pending promise.
   *  - `deliveryTimestamps` is per-{projectId|"global"}+platform and
   *    holds raw timestamps so the stats endpoint can compute
   *    "lastDeliveredAt" + "count24h" without any persistence.
   *  - `telegramBotIdentityCache` memoizes the result of `getMe` per
   *    token so the Plugins page bridge-summary doesn't hammer
   *    Telegram on every render.
   */
  interface DiscordChannelsSnapshot {
    guilds: import("@agentd/contracts").DiscordGuildLite[];
    updatedAt: number;
  }
  let discordChannelCache: DiscordChannelsSnapshot = {
    guilds: [],
    updatedAt: 0,
  };
  const discordCommandReplies = new Map<
    string,
    {
      resolve: (r: { ok: boolean; error?: string; threadId?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const deliveryTimestamps = new Map<string, number[]>();
  const telegramBotIdentityCache = new Map<
    string,
    { identity: import("@agentd/contracts").TelegramBotIdentity; ts: number }
  >();

  function deliveryKey(
    projectId: string | null,
    platform: "telegram" | "discord",
  ): string {
    return `${projectId ?? "_global"}::${platform}`;
  }
  function recordDelivery(
    projectId: string | null,
    platform: "telegram" | "discord",
  ): void {
    const k = deliveryKey(projectId, platform);
    const arr = deliveryTimestamps.get(k) ?? [];
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const trimmed = arr.filter((t) => t >= cutoff);
    trimmed.push(now);
    deliveryTimestamps.set(k, trimmed);
    bus.publishSystem({ kind: "plugin_delivery", projectId, platform });
  }
  function deliveryStatsFor(
    projectId: string | null,
    platform: "telegram" | "discord",
  ): import("@agentd/contracts").BridgeDeliveryStats {
    const k = deliveryKey(projectId, platform);
    const arr = deliveryTimestamps.get(k) ?? [];
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const fresh = arr.filter((t) => t >= cutoff);
    if (fresh.length !== arr.length) deliveryTimestamps.set(k, fresh);
    return {
      lastDeliveredAt: fresh.length ? fresh[fresh.length - 1]! : null,
      count24h: fresh.length,
    };
  }
  async function fetchTelegramBotIdentity(
    token: string,
  ): Promise<import("@agentd/contracts").TelegramBotIdentity | null> {
    const cached = telegramBotIdentityCache.get(token);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.identity;
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`,
      );
      const j = (await r.json()) as {
        ok: boolean;
        result?: {
          id: number;
          is_bot: boolean;
          first_name: string;
          username?: string;
          can_join_groups?: boolean;
          can_read_all_group_messages?: boolean;
          supports_inline_queries?: boolean;
        };
        description?: string;
      };
      if (!j.ok || !j.result) return null;
      const identity = {
        id: j.result.id,
        isBot: j.result.is_bot,
        firstName: j.result.first_name,
        username: j.result.username,
        canJoinGroups: j.result.can_join_groups,
        canReadAllGroupMessages: j.result.can_read_all_group_messages,
        supportsInlineQueries: j.result.supports_inline_queries,
      };
      telegramBotIdentityCache.set(token, { identity, ts: Date.now() });
      return identity;
    } catch {
      return null;
    }
  }
  async function fetchTelegramChat(
    token: string,
    chatId: string,
  ): Promise<import("@agentd/contracts").TelegramChatInfo | null> {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      );
      const j = (await r.json()) as {
        ok: boolean;
        result?: {
          id: number;
          type: string;
          title?: string;
          username?: string;
          first_name?: string;
          last_name?: string;
        };
      };
      if (!j.ok || !j.result) return null;
      return {
        id: j.result.id,
        type: j.result.type,
        title: j.result.title,
        username: j.result.username,
        firstName: j.result.first_name,
        lastName: j.result.last_name,
      };
    } catch {
      return null;
    }
  }
  async function sendTelegramMessage(
    token: string,
    chatId: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
      const j = (await r.json()) as { ok: boolean; description?: string };
      if (!j.ok) return { ok: false, error: j.description ?? "send failed" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  function awaitDiscordReply(
    requestId: string,
    timeoutMs = 8000,
  ): Promise<{ ok: boolean; error?: string; threadId?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (discordCommandReplies.delete(requestId)) {
          resolve({
            ok: false,
            error: `discord plugin did not respond in ${timeoutMs}ms`,
          });
        }
      }, timeoutMs);
      discordCommandReplies.set(requestId, { resolve, timer });
    });
  }
  function dispatchDiscordTestSend(
    channelId: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const requestId = Math.random().toString(36).slice(2, 12);
    const p = awaitDiscordReply(requestId);
    bus.publishSystem({
      kind: "discord_test_send",
      channelId,
      text,
      requestId,
    });
    return p;
  }
  function dispatchDiscordCreateThread(
    channelId: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string; threadId?: string }> {
    const requestId = Math.random().toString(36).slice(2, 12);
    const p = awaitDiscordReply(requestId);
    bus.publishSystem({
      kind: "discord_create_thread",
      channelId,
      name,
      requestId,
    });
    return p;
  }
  function dispatchDiscordArchiveThread(
    threadId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const requestId = Math.random().toString(36).slice(2, 12);
    const p = awaitDiscordReply(requestId);
    bus.publishSystem({
      kind: "discord_archive_thread",
      threadId,
      requestId,
    });
    return p;
  }

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

  /**
   * Model registry — single source of truth for which agent CLIs accept
   * which model ids. Override `models` in `~/.agentd/config.json` to
   * add new releases without touching agentd code; everything that
   * needs a model picker reads from here.
   */
  api.get("/models", (c) => {
    const cfg = loadConfig(paths.root);
    // Codex maintains its own up-to-date model list at
    // ~/.codex/models_cache.json. Use it when present so new
    // releases (gpt-5.4, gpt-5.5, etc.) appear in the dropdown
    // without an agentd update. The user's config.json still wins
    // if they explicitly customized cfg.models.codex.
    const cachedCodex = loadCodexModelsFromCache();
    const codex =
      cachedCodex.length > 0 ? cachedCodex : cfg.models.codex;
    return c.json({
      models: { ...cfg.models, codex },
      // Surface the configured defaults so the web's model chip can
      // resolve "(default)" to the actual model id the runner will
      // pass — claude-code / codex both show this in their UIs.
      defaults: cfg.defaultModel,
    });
  });

  /* ── Councils ─────────────────────────────────────────────────────── */

  api.get("/councils", (c) => c.json({ councils: listCouncils(db) }));

  api.get("/councils/:id", (c) => {
    const id = c.req.param("id");
    const council = getCouncil(db, id);
    if (!council) return c.json({ error: "not found" }, 404);
    return c.json({ council });
  });

  api.post("/councils", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateCouncilRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const council = await tasks.createCouncil({
        repoPath: parsed.data.repoPath,
        baseBranch: parsed.data.baseBranch,
        prompt: parsed.data.prompt,
        members: parsed.data.members,
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
      });
      return c.json({ council });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Manual override — operator picks a winner instead of (or after) the judge. */
  api.post("/councils/:id/pick", async (c) => {
    const id = c.req.param("id");
    const council = getCouncil(db, id);
    if (!council) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      taskId?: string;
      explanation?: string;
    } | null;
    const winnerTaskId = (body?.taskId ?? "").trim();
    if (!council.taskIds.includes(winnerTaskId)) {
      return c.json({ error: "taskId is not a member of this council" }, 400);
    }
    setCouncilWinner(
      db,
      id,
      winnerTaskId,
      (body?.explanation ?? "manual pick").slice(0, 240),
    );
    return c.json({ council: getCouncil(db, id) });
  });

  /**
   * Tool usage stats. Reads `role='tool'` messages and aggregates by tool
   * name (parsed from the `[call <toolName>] ...` prefix the task manager
   * writes for every `tool_call` event the runner emits).
   *   ?recent=<n>  newest entries to include in the activity feed (1-500)
   */
  api.get("/tools/stats", (c) => {
    const recentParam = c.req.query("recent");
    const recentLimit = recentParam ? Number(recentParam) : 50;
    const stats = aggregateToolStats(db, {
      recentLimit:
        Number.isFinite(recentLimit) && recentLimit > 0 ? recentLimit : 50,
    });
    return c.json(stats);
  });

  /**
   * Bulk-reorder open tasks. Body: { taskIds: string[] }. Each id
   * gets an incrementing sortOrder (0, 1, 2, ...) so the sidebar's
   * drag-drop persists across reloads.
   */
  api.post("/tasks/reorder", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      taskIds?: unknown;
    } | null;
    const ids = Array.isArray(body?.taskIds)
      ? body.taskIds.filter((v): v is string => typeof v === "string")
      : null;
    if (!ids || ids.length === 0) {
      return c.json({ error: "taskIds[] required" }, 400);
    }
    reorderTasks(db, ids);
    for (const id of ids) pubTaskChanged(id);
    return c.json({ ok: true, count: ids.length });
  });

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
        ...(parsed.data.workspaceMode
          ? { workspaceMode: parsed.data.workspaceMode }
          : {}),
        ...(parsed.data.branchMode
          ? { branchMode: parsed.data.branchMode }
          : {}),
        ...(parsed.data.branchName
          ? { branchName: parsed.data.branchName }
          : {}),
        ...(parsed.data.pullLatest != null
          ? { pullLatest: parsed.data.pullLatest }
          : {}),
        ...(parsed.data.thinkingLevel
          ? { thinkingLevel: parsed.data.thinkingLevel }
          : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
      });
      pubTaskChanged(task.id);
      void maybeSpawnTaskThread(task.id);
      return c.json({ task });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * If the task's project has `autoTaskThread` + `discordChannelId`
   * set, ask the discord subprocess to spawn a thread named after
   * the task and persist its id. Errors are logged but don't fail
   * task creation — the operator can recover by toggling the
   * project flag off and back on.
   */
  async function maybeSpawnTaskThread(taskId: string): Promise<void> {
    const task = tasks.get(taskId);
    if (!task || !task.projectId || task.discordThreadId) return;
    const project = getProjectById(db, task.projectId);
    if (!project?.autoTaskThread || !project.discordChannelId) return;
    const cleanTitle = task.title.replace(/[\r\n]+/g, " ").slice(0, 90);
    const name = `${task.id.slice(-6)}-${cleanTitle}`.slice(0, 100);
    try {
      const r = await dispatchDiscordCreateThread(
        project.discordChannelId,
        name,
      );
      if (r.ok && r.threadId) {
        setTaskDiscordThread(db, task.id, r.threadId);
        pubTaskChanged(task.id);
      } else if (!r.ok) {
        console.warn(
          `[discord] thread spawn failed for task ${task.id}: ${r.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      console.warn(`[discord] thread spawn error: ${(e as Error).message}`);
    }
  }
  async function maybeArchiveTaskThread(taskId: string): Promise<void> {
    const task = tasks.get(taskId);
    if (!task || !task.discordThreadId) return;
    const threadId = task.discordThreadId;
    setTaskDiscordThread(db, task.id, null);
    pubTaskChanged(task.id);
    void dispatchDiscordArchiveThread(threadId).catch(() => {});
  }

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

  /**
   * Steer: queue or interrupt-and-fire a message while the agent is mid-turn.
   *   { text, mode: "queue" | "interrupt" }
   * If the task is idle this behaves like /input.
   */
  api.post("/tasks/:id/steer", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      mode?: string;
    } | null;
    const text = (body?.text ?? "").trim();
    if (!text) return c.json({ error: "text is required" }, 400);
    const mode = body?.mode === "interrupt" ? "interrupt" : "queue";
    try {
      await tasks.steer(id, text, mode);
      return c.json({
        ok: true,
        mode,
        queued: tasks.queuedInput(id).length,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.get("/tasks/:id/steer", (c) => {
    const id = c.req.param("id");
    return c.json({
      running: tasks.isRunning(id),
      queue: tasks.queuedInput(id),
    });
  });

  /** Drop a single queued line before it drains. Body: { index }. */
  api.post("/tasks/:id/steer/remove", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      index?: number;
    } | null;
    const index = Number(body?.index);
    if (!Number.isFinite(index)) {
      return c.json({ error: "index required" }, 400);
    }
    const queue = tasks.removeQueuedInput(id, index);
    return c.json({ queue });
  });

  /**
   * Fire a queued line — the per-row "Steer" action. Pulls the item
   * from the queue, persists it as a user message, and feeds it to
   * the runner (stdin for claude, SIGINT-respawn for codex). Body:
   * { index }.
   */
  api.post("/tasks/:id/steer/fire", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      index?: number;
    } | null;
    const index = Number(body?.index);
    if (!Number.isFinite(index)) {
      return c.json({ error: "index required" }, 400);
    }
    try {
      const queue = await tasks.fireQueued(id, index);
      return c.json({ queue });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.delete("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    await tasks.remove(id);
    pubTaskRemoved(id);
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
  /**
   * Push-sync state — used by the ShipMenu to grey out "Push" when
   * there's nothing to push, and surface "N ahead" when there is.
   * Returns counts of commits ahead / behind origin/<branch>.
   */
  api.get("/tasks/:id/push-state", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    try {
      const proc = Bun.spawn({
        cmd: [
          "git",
          "rev-list",
          "--left-right",
          "--count",
          `origin/${task.branch}...HEAD`,
        ],
        cwd: task.worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      // git outputs `<behind> <ahead>` separated by whitespace. If
      // the upstream doesn't exist (never pushed) git exits non-zero
      // and we treat the whole branch as ahead.
      const m = out.match(/^(\d+)\s+(\d+)/);
      if (proc.exitCode !== 0 || !m) {
        const headOnly = Bun.spawn({
          cmd: ["git", "rev-list", "--count", "HEAD"],
          cwd: task.worktreePath,
          stdout: "pipe",
        });
        const headCount = (await new Response(headOnly.stdout).text()).trim();
        await headOnly.exited;
        return c.json({
          ahead: parseInt(headCount, 10) || 0,
          behind: 0,
          hasUpstream: false,
        });
      }
      return c.json({
        behind: parseInt(m[1]!, 10),
        ahead: parseInt(m[2]!, 10),
        hasUpstream: true,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

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
   * Generate a commit message from the current diff using Claude. Two
   * shapes:
   *   - POST .../commit-message       → one-shot JSON: { message, source }
   *   - POST .../commit-message/stream → streamed text/plain chunks as
   *     Claude prints them, then a `\x1e` sentinel followed by JSON
   *     `{ source }` so the caller knows where claude ended.
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
    const cfg = loadConfig(paths.root);
    const r = await generateCommitMessage(task.worktreePath, {
      includeBody: !!body.includeBody,
      includeScope: !!body.includeScope,
      wip: !!body.wip,
      ...(body.hint ? { hint: body.hint } : {}),
      fallbackHint: task.title,
      baseRef: task.baseBranch,
      helper: cfg.aiHelpers,
      ...(cfg.commitInstructions
        ? { extraInstructions: cfg.commitInstructions }
        : {}),
    });
    return c.json(r);
  });

  api.post("/tasks/:id/commit-message/stream", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      includeBody?: boolean;
      includeScope?: boolean;
      wip?: boolean;
      hint?: string;
    };
    const cfg = loadConfig(paths.root);
    const opts = {
      includeBody: !!body.includeBody,
      includeScope: !!body.includeScope,
      wip: !!body.wip,
      ...(body.hint ? { hint: body.hint } : {}),
      fallbackHint: task.title,
      baseRef: task.baseBranch,
      helper: cfg.aiHelpers,
      ...(cfg.commitInstructions
        ? { extraInstructions: cfg.commitInstructions }
        : {}),
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamCommitMessage(task.worktreePath, opts);
          type Final = { message: string; source: string; error?: string };
          let result: Final | null = null;
          while (true) {
            const next = await it.next();
            if (next.done) {
              result = next.value as Final;
              break;
            }
            controller.enqueue(enc.encode(next.value));
          }
          // Sentinel + final metadata so the client can settle on a clean message.
          controller.enqueue(enc.encode("\x1e"));
          controller.enqueue(
            enc.encode(
              JSON.stringify({
                source: result?.source ?? "fallback-empty-output",
                message: result?.message ?? "",
              }),
            ),
          );
        } catch (e) {
          controller.enqueue(
            new TextEncoder().encode(
              `\x1e${JSON.stringify({
                source: "fallback-claude-error",
                error: (e as Error).message,
              })}`,
            ),
          );
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  /**
   * Streamed PR title + body generator. Response stream is the model's raw
   * output, terminated by the U+001E sentinel + JSON metadata
   *   { source, title, body, error? }
   * so the client can settle on a parsed result without losing tokens.
   */
  api.post("/tasks/:id/pr-message/stream", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      hint?: string;
      includeBullets?: boolean;
    };
    const cfg = loadConfig(paths.root);
    const messages = listMessages(db, task.id, 1);
    const taskPrompt = messages[0]?.role === "user" ? messages[0].content : "";
    const opts = {
      ...(body.hint ? { hint: body.hint } : {}),
      includeBullets: body.includeBullets !== false,
      baseRef: task.baseBranch,
      taskPrompt,
      taskTitle: task.title,
      helper: cfg.aiHelpers,
      ...(cfg.prInstructions
        ? { extraInstructions: cfg.prInstructions }
        : {}),
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamPrMessage(task.worktreePath, opts);
          type Final = {
            title: string;
            body: string;
            source: string;
            error?: string;
          };
          let result: Final | null = null;
          while (true) {
            const next = await it.next();
            if (next.done) {
              result = next.value as Final;
              break;
            }
            controller.enqueue(enc.encode(next.value));
          }
          controller.enqueue(enc.encode("\x1e"));
          controller.enqueue(
            enc.encode(
              JSON.stringify({
                source: result?.source ?? "fallback-empty-output",
                title: result?.title ?? "",
                body: result?.body ?? "",
              }),
            ),
          );
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                source: "fallback-claude-error",
                error: (e as Error).message,
              })}`,
            ),
          );
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  /**
   * Suggest a branch slug for a not-yet-created task. Used by the spawn
   * UI to fill in a clean `feature/<slug>` when the user hasn't typed
   * a branch name themselves.
   */
  api.post("/branch-name", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      prompt?: string;
    } | null;
    const prompt = (body?.prompt ?? "").trim();
    if (!prompt) return c.json({ error: "prompt required" }, 400);
    const cfg = loadConfig(paths.root);
    const r = await generateBranchName(prompt, { helper: cfg.aiHelpers });
    return c.json(r);
  });

  // Manual commit. If `message` is missing we generate one from the diff
  // (same path the auto-commit-on-exit uses), so callers never end up
  // committing the task title verbatim by accident.
  api.post("/tasks/:id/commit", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
    };
    let subject = body.message?.trim();
    if (!subject) {
      const cfg = loadConfig(paths.root);
      const ai = await generateCommitMessage(task.worktreePath, {
        fallbackHint: task.title,
        baseRef: task.baseBranch,
        helper: cfg.aiHelpers,
        ...(cfg.commitInstructions
          ? { extraInstructions: cfg.commitInstructions }
          : {}),
      });
      subject = ai.message;
    }
    try {
      const lines = subject.split("\n");
      const title = lines[0]!.slice(0, 72);
      const bodyText = lines.slice(1).join("\n").trim() || undefined;
      const r = await autoCommit({
        cwd: task.worktreePath,
        title,
        body: bodyText,
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
        pubTaskChanged(task.id);
      }
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Mark a task as closed. Doesn't stop a running task — use /stop for
   * that — but a running task usually shouldn't be closed.
   */
  api.post("/tasks/:id/close", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      reason?: string;
    };
    const updated = closeTask(db, id, body.reason ?? "manual");
    if (updated) {
      bus.publish({
        taskId: id,
        event: { kind: "status", status: updated.status },
        ts: Date.now(),
      });
      pubTaskChanged(id);
      void maybeArchiveTaskThread(id);
    }
    return c.json({ task: updated });
  });

  api.post("/tasks/:id/reopen", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const updated = reopenTask(db, id);
    if (updated) pubTaskChanged(id);
    return c.json({ task: updated });
  });

  /**
   * Update the task's reasoning effort. The currently running turn keeps
   * its level; the change takes effect on the next runner spawn (i.e. the
   * next user message or steer drain).
   */
  api.patch("/tasks/:id/thinking", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      thinkingLevel?: string;
    } | null;
    const parsed = ThinkingLevel.safeParse(body?.thinkingLevel);
    if (!parsed.success) {
      return c.json(
        { error: "invalid thinkingLevel", expected: ThinkingLevel.options },
        400,
      );
    }
    const updated = setTaskThinkingLevel(db, id, parsed.data);
    if (updated) pubTaskChanged(id);
    return c.json({ task: updated });
  });

  /**
   * Set or clear the chat mirror target. Pass `{ mirrorTo: null }` to
   * unmirror. The change takes effect on the next event the bus
   * publishes — no runner restart needed.
   */
  api.patch("/tasks/:id/mirror", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      mirrorTo?: MirrorTarget | null;
    } | null;
    if (!body || !("mirrorTo" in body)) {
      return c.json({ error: "mirrorTo field required" }, 400);
    }
    let target: MirrorTarget | null;
    if (body.mirrorTo == null) {
      target = null;
    } else {
      const parsed = MirrorTarget.safeParse(body.mirrorTo);
      if (!parsed.success) {
        return c.json(
          { error: "invalid mirrorTo", issues: parsed.error.issues },
          400,
        );
      }
      target = parsed.data;
    }
    const updated = setTaskMirrorTo(db, id, target);
    if (updated) pubTaskChanged(id);
    return c.json({ task: updated });
  });

  /**
   * Progress note from the running agent. The agent calls this after every
   * meaningful step via `agentd progress "<text>" [--done]`. Writes a
   * message + publishes a `progress` AgentEvent the bus fans out to the
   * web timeline and any mirrored chat.
   */
  api.post("/tasks/:id/progress", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      done?: boolean;
    } | null;
    const text = (body?.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const done = !!body?.done;
    tasks.recordProgress(id, text, done);
    return c.json({ ok: true });
  });

  /**
   * Non-blocking thought share — the agent broadcasts what it's
   * considering doing next, no answer required.
   */
  api.post("/tasks/:id/share", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
    } | null;
    const text = (body?.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    tasks.recordShare(id, text);
    return c.json({ ok: true });
  });

  /**
   * Blocking decision request. Holds the response open until the
   * operator answers (via chat reply, web steer, or `/api/tasks/:id/answer`).
   * Body: { prompt, options }. Returns: { answer }.
   */
  api.post("/tasks/:id/ask", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      prompt?: string;
      options?: string[];
    } | null;
    const prompt = (body?.prompt ?? "").trim();
    if (!prompt) return c.json({ error: "prompt required" }, 400);
    const options =
      Array.isArray(body?.options) && body!.options.length > 0
        ? body!.options.map((s) => String(s)).slice(0, 9)
        : [];
    const askId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const answer = await tasks.awaitAsk(id, askId, prompt, options);
    return c.json({ answer, askId });
  });

  /**
   * Resolve the oldest pending ask for a task. Used by the web "answer"
   * UI; chat plugins go through `steerTask` which also routes here.
   */
  api.post("/tasks/:id/answer", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      answer?: string;
    } | null;
    const answer = (body?.answer ?? "").trim();
    if (!answer) return c.json({ error: "answer required" }, 400);
    const matched = tasks.answerAsk(id, answer);
    return c.json({ ok: true, matched });
  });

  /**
   * Update the task's model override. Empty string clears it (next runner
   * spawn falls back to the configured default for the agent kind).
   */
  api.patch("/tasks/:id/model", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      model?: string;
    } | null;
    if (typeof body?.model !== "string") {
      return c.json({ error: "model must be a string" }, 400);
    }
    const updated = setTaskModel(db, id, body.model.trim());
    if (updated) pubTaskChanged(id);
    return c.json({ task: updated });
  });

  /**
   * Check whether the task's stored PR is merged. If so, return the merge
   * info and (when ?autoClose=1) flip the task to closed with reason="merged".
   */
  api.get("/tasks/:id/pr-state", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    if (!task.prUrl) {
      return c.json({ prUrl: null, merged: false, state: null });
    }
    const state = await getPrState(task.prUrl);
    if (state?.merged && c.req.query("autoClose") === "1") {
      const updated = closeTask(db, id, "merged");
      pubTaskChanged(id);
      void maybeArchiveTaskThread(id);
      return c.json({
        prUrl: task.prUrl,
        ...state,
        autoClosed: true,
        task: updated,
      });
    }
    return c.json({ prUrl: task.prUrl, ...state });
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
    // Slash commands like `/compact` only work in claude-code's
    // interactive mode. We're driving claude in stream-json input
    // mode where everything is treated as a literal user message,
    // so a textual directive is the only thing that actually
    // compresses context. Same instruction works for codex too.
    const directive = focus
      ? `Please summarize what you've done so far in this conversation in ~200 words, focusing on "${focus}". Drop intermediate scratch work and continue from the compact summary.`
      : "Please summarize what you've done so far in this conversation in ~200 words. Drop intermediate scratch work and continue from the compact summary.";
    try {
      await tasks.sendInput(id, directive);
      // Watermark — the web draws a "context compacted" divider in
      // the timeline at this ts so the operator can tell which
      // earlier messages are still in working memory.
      markTaskCompacted(db, id);
      pubTaskChanged(id);
      return c.json({ ok: true, agent: task.agent, directive });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ──────────────────────── todos ────────────────────────

  /**
   * List todos in a scope. Pass `projectId` for project-level todos,
   * `taskId` for task-scoped, or both. Without filters returns nothing
   * (we don't expose a global todo list).
   */
  api.get("/todos", (c) => {
    const projectId = c.req.query("projectId");
    const taskId = c.req.query("taskId");
    if (!projectId && !taskId) return c.json({ todos: [] });
    const list = listTodos(db, {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    });
    return c.json({ todos: list });
  });

  api.post("/todos", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTodoRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const t = createTodo(db, parsed.data);
    return c.json({ todo: t });
  });

  api.patch("/todos/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateTodoRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const t = updateTodo(db, id, parsed.data);
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json({ todo: t });
  });

  api.delete("/todos/:id", (c) => {
    const id = c.req.param("id");
    deleteTodo(db, id);
    return c.json({ ok: true });
  });

  // ──────────────────────── suggestions ────────────────────────

  api.get("/suggestions", (c) => {
    const status = c.req.query("status");
    const valid = status === "pending" || status === "resolved" || status === "dismissed";
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.max(1, Math.min(200, Number(limitStr))) : 50;
    const list = listSuggestions(db, {
      ...(valid ? { status } : {}),
      limit,
    });
    return c.json({ suggestions: list });
  });

  api.get("/suggestions/:id", (c) => {
    const sug = getSuggestion(db, c.req.param("id"));
    if (!sug) return c.json({ error: "not found" }, 404);
    return c.json({ suggestion: sug });
  });

  api.post("/suggestions/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = ResolveSuggestionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const r = await tasks.resolveSuggestionToTask(id, parsed.data);
      if (!r) return c.json({ error: "could not resolve" }, 400);
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.post("/suggestions/:id/dismiss", (c) => {
    const id = c.req.param("id");
    const sug = tasks.dismissSuggestion(id);
    if (!sug) return c.json({ error: "not found" }, 404);
    return c.json({ suggestion: sug });
  });

  /**
   * Conversational reply — operator types whatever they want, the
   * router (heuristic + AI) decides what to do. Used by the Telegram
   * bot, the web inbox, and anywhere else that lets the operator
   * answer a suggestion in free-form text.
   */
  api.post("/suggestions/:id/reply", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
    } | null;
    const text = (body?.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    try {
      const r = await tasks.replyToSuggestion(id, text);
      return c.json(r);
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
    // Resolve repoPath from project if a projectId was given. We still
    // store the resolved path so older callers (and exports) keep
    // working; the projectId reference makes future relocations cheap.
    let repoPath = parsed.data.repoPath ?? "";
    let projectId: string | null = parsed.data.projectId ?? null;
    if (projectId) {
      const project = getProjectById(db, projectId);
      if (!project) {
        return c.json({ error: `unknown project: ${projectId}` }, 400);
      }
      repoPath = project.path;
      projectId = project.id;
    }
    if (!repoPath.trim()) {
      return c.json(
        { error: "either projectId or repoPath is required" },
        400,
      );
    }
    const tpl = createTemplate(db, {
      name: parsed.data.name,
      agent: parsed.data.agent,
      ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
      projectId,
      repoPath,
      baseBranch: parsed.data.baseBranch,
      promptTemplate: parsed.data.promptTemplate,
      autoPush: parsed.data.autoPush,
      autoPr: parsed.data.autoPr,
      ...(parsed.data.permissionMode
        ? { permissionMode: parsed.data.permissionMode }
        : {}),
      ...(parsed.data.thinkingLevel
        ? { thinkingLevel: parsed.data.thinkingLevel }
        : {}),
      ...(parsed.data.model != null ? { model: parsed.data.model } : {}),
      ...(parsed.data.workspaceMode
        ? { workspaceMode: parsed.data.workspaceMode }
        : {}),
      ...(parsed.data.branchMode ? { branchMode: parsed.data.branchMode } : {}),
      ...(parsed.data.pullLatest != null
        ? { pullLatest: parsed.data.pullLatest }
        : {}),
      ...(parsed.data.skills?.length ? { skills: parsed.data.skills } : {}),
    });
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
    // If the template references a project, resolve fresh — its path may
    // have moved since the template was created.
    let repoPath = tpl.repoPath;
    if (tpl.projectId) {
      const project = getProjectById(db, tpl.projectId);
      if (project) repoPath = project.path;
    }
    try {
      const task = await tasks.create({
        agent: tpl.agent,
        repoPath,
        baseBranch: tpl.baseBranch,
        prompt,
        title: parsed.data.titleOverride ?? tpl.name,
        autoPush: parsed.data.autoPush ?? tpl.autoPush,
        autoPr: parsed.data.autoPr ?? tpl.autoPr,
        templateId: tpl.id,
        permissionMode: parsed.data.permissionMode ?? tpl.permissionMode,
        thinkingLevel: parsed.data.thinkingLevel ?? tpl.thinkingLevel,
        model: parsed.data.model ?? tpl.model,
        workspaceMode: parsed.data.workspaceMode ?? tpl.workspaceMode,
        branchMode: parsed.data.branchMode ?? tpl.branchMode,
        ...(parsed.data.branchName?.trim()
          ? { branchName: parsed.data.branchName.trim() }
          : {}),
        pullLatest: parsed.data.pullLatest ?? tpl.pullLatest,
        ...(tpl.skills.length ? { skills: tpl.skills } : {}),
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

  /**
   * Spawn-flow user preferences. Replaces the old agentd.last*
   * localStorage keys so prefs follow the user across devices.
   */
  api.get("/prefs", (c) => {
    const cfg = loadConfig(paths.root);
    return c.json({ prefs: cfg.prefs });
  });

  api.patch("/prefs", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "json body required" }, 400);
    }
    const cfg = loadConfig(paths.root);
    const merged = { ...cfg.prefs, ...(body as Record<string, unknown>) };
    const parsed = UserPrefs.safeParse(merged);
    if (!parsed.success) {
      return c.json(
        { error: "invalid prefs patch", issues: parsed.error.issues },
        400,
      );
    }
    const next = { ...cfg, prefs: parsed.data };
    saveConfig(paths.root, next);
    return c.json({ ok: true, prefs: parsed.data });
  });

  api.get("/admin/settings", (c) => {
    const cfg = loadConfig(paths.root);
    return c.json({
      agentInstructions: cfg.agentInstructions,
      commitInstructions: cfg.commitInstructions,
      prInstructions: cfg.prInstructions,
      maxContextTokens: cfg.maxContextTokens,
      aiHelpers: cfg.aiHelpers,
      defaultThinking: cfg.defaultThinking,
      defaultModel: cfg.defaultModel,
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
      "commitInstructions",
      "prInstructions",
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
    if ("aiHelpers" in body) {
      const parsed = AiHelperConfig.safeParse(body.aiHelpers);
      if (!parsed.success) {
        return c.json(
          { error: "invalid aiHelpers", issues: parsed.error.issues },
          400,
        );
      }
      next.aiHelpers = parsed.data;
      changed = true;
    }
    if ("defaultThinking" in body) {
      const dt = body.defaultThinking as
        | { claude?: string; codex?: string }
        | undefined;
      if (!dt || typeof dt !== "object") {
        return c.json({ error: "defaultThinking must be an object" }, 400);
      }
      const allowed = ["low", "medium", "high", "max", "xhigh"] as const;
      const cur = { ...cfg.defaultThinking };
      for (const k of ["claude", "codex"] as const) {
        const v = dt[k];
        if (v == null) continue;
        if (!allowed.includes(v as (typeof allowed)[number])) {
          return c.json({ error: `defaultThinking.${k} must be one of ${allowed.join("|")}` }, 400);
        }
        cur[k] = v as (typeof allowed)[number];
      }
      next.defaultThinking = cur;
      changed = true;
    }
    if ("defaultModel" in body) {
      const dm = body.defaultModel as
        | { claude?: string; codex?: string }
        | undefined;
      if (!dm || typeof dm !== "object") {
        return c.json({ error: "defaultModel must be an object" }, 400);
      }
      const cur = { ...cfg.defaultModel };
      for (const k of ["claude", "codex"] as const) {
        const v = dm[k];
        if (v == null) continue;
        if (typeof v !== "string") {
          return c.json({ error: `defaultModel.${k} must be a string` }, 400);
        }
        cur[k] = v.trim();
      }
      next.defaultModel = cur;
      changed = true;
    }
    if (!changed) return c.json({ error: "no valid keys in patch" }, 400);
    saveConfig(paths.root, next);
    return c.json({
      ok: true,
      settings: {
        agentInstructions: next.agentInstructions,
        commitInstructions: next.commitInstructions,
        prInstructions: next.prInstructions,
        maxContextTokens: next.maxContextTokens,
        aiHelpers: next.aiHelpers,
        defaultThinking: next.defaultThinking,
        defaultModel: next.defaultModel,
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

  // ── Chat-bridge admin (used by the Connect-chat wizard) ─────────────
  //
  // These power the polished chat-target UX. Telegram endpoints proxy
  // straight to the public Bot API; Discord endpoints round-trip
  // through the supervised discord subprocess via the system bus.

  api.post("/plugins/telegram/validate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      token?: string;
    } | null;
    const token = (body?.token ?? "").trim();
    if (!token) return c.json({ ok: false, error: "token required" }, 400);
    const identity = await fetchTelegramBotIdentity(token);
    if (!identity) {
      return c.json(
        { ok: false, error: "telegram rejected the token" },
        200,
      );
    }
    return c.json({ ok: true, bot: identity });
  });

  api.post("/plugins/telegram/get-chat", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      token?: string;
      chatId?: string;
    } | null;
    const token = (body?.token ?? "").trim();
    const chatId = (body?.chatId ?? "").trim();
    if (!token || !chatId) {
      return c.json({ ok: false, error: "token + chatId required" }, 400);
    }
    const chat = await fetchTelegramChat(token, chatId);
    if (!chat) {
      return c.json(
        { ok: false, error: "couldn't fetch chat (id wrong, or bot has never been messaged there)" },
        200,
      );
    }
    return c.json({ ok: true, chat });
  });

  api.post("/plugins/telegram/test-send", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      token?: string;
      chatId?: string;
      text?: string;
    } | null;
    const token = (body?.token ?? "").trim();
    const chatId = (body?.chatId ?? "").trim();
    if (!token || !chatId) {
      return c.json({ ok: false, error: "token + chatId required" }, 400);
    }
    const text =
      (body?.text ?? "").trim() ||
      "agentd test message — chat connected.";
    const r = await sendTelegramMessage(token, chatId, text);
    return c.json(r, 200);
  });

  api.get("/plugins/discord/channels", (c) => {
    return c.json({
      guilds: discordChannelCache.guilds,
      updatedAt: discordChannelCache.updatedAt,
    });
  });

  /** Internal — discord subprocess reports its current channel snapshot. */
  api.post("/plugins/discord/channels", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      guilds?: import("@agentd/contracts").DiscordGuildLite[];
    } | null;
    if (!body || !Array.isArray(body.guilds)) {
      return c.json({ ok: false, error: "guilds[] required" }, 400);
    }
    discordChannelCache = {
      guilds: body.guilds,
      updatedAt: Date.now(),
    };
    bus.publishSystem({ kind: "discord_channels_updated" });
    return c.json({ ok: true });
  });

  api.post("/plugins/discord/test-send", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      channelId?: string;
      text?: string;
    } | null;
    const channelId = (body?.channelId ?? "").trim();
    if (!channelId) {
      return c.json({ ok: false, error: "channelId required" }, 400);
    }
    const text =
      (body?.text ?? "").trim() ||
      "agentd test message — channel connected.";
    const r = await dispatchDiscordTestSend(channelId, text);
    return c.json(r, 200);
  });

  /** Internal — discord subprocess returns the result of any IPC command. */
  api.post("/plugins/discord/command-result", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      requestId?: string;
      ok?: boolean;
      error?: string;
      threadId?: string;
    } | null;
    if (!body?.requestId) {
      return c.json({ error: "requestId required" }, 400);
    }
    const pending = discordCommandReplies.get(body.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      discordCommandReplies.delete(body.requestId);
      pending.resolve({
        ok: !!body.ok,
        error: body.error,
        threadId: body.threadId,
      });
    }
    return c.json({ ok: true });
  });

  /** Internal — subprocesses report each successful delivery. */
  api.post("/plugins/delivery", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      projectId?: string | null;
      platform?: "telegram" | "discord";
    } | null;
    if (!body || (body.platform !== "telegram" && body.platform !== "discord")) {
      return c.json({ error: "platform required" }, 400);
    }
    recordDelivery(body.projectId ?? null, body.platform);
    return c.json({ ok: true });
  });

  /**
   * Bridge summary for the Plugins page "Project routing" section
   * and the project Connect-chat panel. Bundles per-project bot/
   * channel identity + delivery stats so the UI doesn't make N
   * round-trips per row.
   */
  api.get("/plugins/bridge-summary", async (c) => {
    const projectsList = listProjects(db);
    const channelByid = new Map<
      string,
      { name: string; guildId: string; guildName: string }
    >();
    for (const g of discordChannelCache.guilds) {
      for (const ch of g.channels) {
        channelByid.set(ch.id, {
          name: ch.name,
          guildId: g.id,
          guildName: g.name,
        });
      }
    }

    const out: import("@agentd/contracts").ProjectBridgeSummary[] = [];
    for (const p of projectsList) {
      const hasTg = !!p.telegramBotToken && !!p.telegramChatId;
      const hasDc = !!p.discordChannelId;
      if (!hasTg && !hasDc) continue;

      let telegram:
        | import("@agentd/contracts").ProjectBridgeSummary["telegram"]
        | null = null;
      if (hasTg && p.telegramBotToken && p.telegramChatId) {
        const identity = await fetchTelegramBotIdentity(p.telegramBotToken);
        const chat = await fetchTelegramChat(
          p.telegramBotToken,
          p.telegramChatId,
        );
        const chatLabel = chat
          ? chat.title ||
            chat.username ||
            [chat.firstName, chat.lastName].filter(Boolean).join(" ") ||
            null
          : null;
        telegram = {
          botUsername: identity?.username ?? null,
          botFirstName: identity?.firstName ?? null,
          chatId: p.telegramChatId,
          chatLabel,
          stats: deliveryStatsFor(p.id, "telegram"),
        };
      }

      let discord:
        | import("@agentd/contracts").ProjectBridgeSummary["discord"]
        | null = null;
      if (hasDc && p.discordChannelId) {
        const ch = channelByid.get(p.discordChannelId);
        discord = {
          channelId: p.discordChannelId,
          channelName: ch?.name ?? null,
          guildId: ch?.guildId ?? null,
          guildName: ch?.guildName ?? null,
          stats: deliveryStatsFor(p.id, "discord"),
        };
      }

      out.push({
        projectId: p.id,
        slug: p.slug,
        name: p.name,
        color: p.color ?? null,
        telegram,
        discord,
      });
    }

    return c.json({
      projects: out,
      totals: {
        telegram: deliveryStatsFor(null, "telegram"),
        discord: deliveryStatsFor(null, "discord"),
      },
      discordChannelsKnown: discordChannelCache.updatedAt > 0,
    });
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
      pubProjectCreated(project);
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
    if (next) pubProjectChanged(next.id);
    return c.json({ project: next });
  });

  /**
   * Project instructions — read/write the free-text guidance the
   * project carries. Resolved via the task's projectId so agents
   * (and helpers like `agentd-instructions`) only need their own
   * task id, not the project id.
   */
  api.get("/tasks/:taskId/project-instructions", (c) => {
    const taskId = c.req.param("taskId");
    const task = tasks.get(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (!task.projectId) return c.json({ instructions: "" });
    const project = getProjectById(db, task.projectId);
    return c.json({ instructions: project?.instructions ?? "" });
  });

  api.put("/tasks/:taskId/project-instructions", async (c) => {
    const taskId = c.req.param("taskId");
    const task = tasks.get(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (!task.projectId) {
      return c.json({ error: "task has no project" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      instructions?: string;
    } | null;
    const text = (body?.instructions ?? "").trim();
    const next = updateProject(db, task.projectId, {
      instructions: text || null,
    });
    if (next) pubProjectChanged(next.id);
    return c.json({
      ok: true,
      instructions: next?.instructions ?? "",
    });
  });

  api.delete("/projects/:idOrSlug", (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    deleteProject(db, project.id);
    pubProjectRemoved(project.id);
    return c.json({ ok: true });
  });

  // Branch list for the spawn picker. Local branches plus remote tracking
  // refs grouped by remote.
  api.get("/projects/:idOrSlug/branches", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      const branches = await listBranches(project.path);
      return c.json(branches);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
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
          } else if (env.event.kind === "suggestion_created") {
            send({
              type: "suggestion_created",
              suggestion: env.event.suggestion,
              ts: env.ts,
            });
          } else if (env.event.kind === "suggestion_updated") {
            send({
              type: "suggestion_updated",
              suggestion: env.event.suggestion,
              ts: env.ts,
            });
          } else if (env.event.kind === "task_changed") {
            send({ type: "task_updated", task: env.event.task });
          } else if (env.event.kind === "task_removed") {
            send({
              type: "task_removed",
              taskId: env.event.taskId,
              ts: env.ts,
            });
          } else if (env.event.kind === "project_changed") {
            send({
              type: "project_updated",
              project: env.event.project,
              ts: env.ts,
            });
          } else if (env.event.kind === "project_created") {
            send({
              type: "project_created",
              project: env.event.project,
              ts: env.ts,
            });
          } else if (env.event.kind === "project_removed") {
            send({
              type: "project_removed",
              projectId: env.event.projectId,
              ts: env.ts,
            });
          } else if (env.event.kind === "discord_test_send") {
            send({
              type: "discord_test_send",
              channelId: env.event.channelId,
              text: env.event.text,
              requestId: env.event.requestId,
              ts: env.ts,
            });
          } else if (env.event.kind === "discord_create_thread") {
            send({
              type: "discord_create_thread",
              channelId: env.event.channelId,
              name: env.event.name,
              requestId: env.event.requestId,
              ts: env.ts,
            });
          } else if (env.event.kind === "discord_archive_thread") {
            send({
              type: "discord_archive_thread",
              threadId: env.event.threadId,
              requestId: env.event.requestId,
              ts: env.ts,
            });
          } else if (env.event.kind === "plugin_delivery") {
            send({
              type: "plugin_delivery",
              projectId: env.event.projectId,
              platform: env.event.platform,
              ts: env.ts,
            });
          } else if (env.event.kind === "discord_channels_updated") {
            send({
              type: "discord_channels_updated",
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
