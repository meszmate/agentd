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
  IdeaChatRequest,
  IdeateRequest,
  PlanSuggestionRequest,
  ResolveSuggestionRequest,
  SaveIdeaRequest,
  SpawnMultiRequest,
  SpawnSiblingRequest,
  SpawnTasksMultiRequest,
  UpdateIdeaRequest,
  CreateTodoRequest,
  UpdateTodoRequest,
  GithubSpawnRequest,
  GithubPrActionRequest,
  GithubListQuery,
  type Task,
  type WsServerEvent,
} from "@agentd/contracts";
import { join, normalize, relative, resolve } from "node:path";
import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  watch,
} from "node:fs";
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
  streamSuggestionPlan,
  streamPrMessage,
  streamProjectInstructionsDraft,
  streamInstructionsConversation,
  streamValidateIdea,
  getPrState,
  setTaskDiscordThread,
  setTaskPrUrl,
  closeTask,
  createTodo,
  deleteTodo,
  getCouncil,
  appendIdeaMessage,
  createSavedIdea,
  createSuggestion,
  deleteProjectSuggestions,
  deleteSavedIdea,
  getSavedIdea,
  getSuggestion,
  addSuggestionValidation,
  listCouncils,
  listIdeaMessages,
  listSavedIdeas,
  listSuggestions,
  markSavedIdeaSpawned,
  runIdeation,
  streamIdeaConversation,
  streamIdeation,
  streamValidateIdeas,
  updateSavedIdea,
  updateSavedIdeaPlan,
  updateSavedIdeaSlices,
  listTodos,
  reopenTask,
  setCouncilWinner,
  setTaskThinkingLevel,
  setTaskAutoFlags,
  setTaskModel,
  setTaskMirrorTo,
  updateTodo,
  resolveSession,
  loadConfig,
  loadCodexCache,
  mergeModelLists,
  DEFAULT_MODEL_REGISTRY,
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
  type AiHelperOptions,
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
  ghStatus,
  ghRepo,
  listIssues as ghListIssues,
  listPrs as ghListPrs,
  viewPr as ghViewPr,
  viewIssue as ghViewIssue,
  prComment as ghPrComment,
  prReview as ghPrReview,
  prMerge as ghPrMerge,
  countOpenIssues as ghCountOpenIssues,
  countOpenPrs as ghCountOpenPrs,
  formatIssueConversation,
  formatPrConversation,
  renderConfigTemplate,
  setTaskGithubMeta,
  listTasks,
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
  function helperForTask(task: Task): AiHelperOptions {
    const cfg = loadConfig(paths.root);
    const helper: AiHelperOptions = {
      agent: task.agent,
      effort: task.thinkingLevel ?? cfg.aiHelpers.effort,
    };
    const selectedModel =
      task.model?.trim() || cfg.defaultModel?.[task.agent] || "";
    if (selectedModel) helper.model = selectedModel;
    return helper;
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
   * Cross-device sync for the saved-idea library + active draft
   * conversations. Fires on create, update (status / messages /
   * plan-draft / etc.), and delete. The web invalidates its
   * `["saved-ideas", slug]` + per-idea queries; other surfaces
   * (telegram / discord) ignore for now but can subscribe later.
   */
  function pubSavedIdeaChanged(ideaId: string): void {
    const idea = getSavedIdea(db, ideaId);
    if (!idea) return;
    bus.publishSystem({
      kind: "saved_idea_changed",
      ideaId,
      projectId: idea.projectId ?? null,
    });
  }
  function pubSavedIdeaRemoved(
    ideaId: string,
    projectId: string | null,
  ): void {
    bus.publishSystem({
      kind: "saved_idea_removed",
      ideaId,
      projectId,
    });
  }
  /**
   * GitHub state for a project shifted — issue/PR list refresh, spawn,
   * PR action completed, status probe re-ran. Web invalidates the
   * project's `github-issues` / `github-prs` queries on this so every
   * connected client sees the new state without polling.
   */
  function pubGithubRefreshed(projectId: string): void {
    bus.publishSystem({ kind: "github_refreshed", projectId });
  }

  /**
   * File-watching for the model registry. Two sources can change
   * the visible model list:
   *
   *   1. `~/.codex/models_cache.json` — codex itself rewrites this
   *      whenever it talks to the API and gets a fresh roster (new
   *      release, pricing change, etc).
   *   2. `~/.agentd/config.json` — operator edits cfg.models.* by
   *      hand to add a private fine-tune, early-access pin, etc.
   *
   * When either changes we publish `models_changed`, the WS bus
   * fans it out, and the web invalidates its `["models"]` cache so
   * the next picker open shows the fresh list. No polling on either
   * side.
   *
   * Watchers are cheap (one inotify handle each) and can be torn
   * down safely on process exit — `Bun.serve()` doesn't pin them.
   */
  function watchModelSources(): () => void {
    const codexCachePath = join(homedir(), ".codex", "models_cache.json");
    const agentdConfigPath = join(paths.root, "config.json");
    const closers: Array<() => void> = [];
    let lastFire = 0;
    function fire() {
      // Coalesce — fs writes often land as multiple events (rename
      // + create + write). 200ms is enough to dedupe without making
      // the operator wait noticeably.
      const now = Date.now();
      if (now - lastFire < 200) return;
      lastFire = now;
      bus.publishSystem({ kind: "models_changed" });
    }
    for (const p of [codexCachePath, agentdConfigPath]) {
      try {
        // `persistent: false` keeps the watcher from holding the
        // process open after the daemon shuts down.
        const w = watch(p, { persistent: false }, fire);
        closers.push(() => {
          try {
            w.close();
          } catch {
            // already closed
          }
        });
      } catch {
        // File doesn't exist yet — that's fine. Codex creates the
        // cache on first run, and the operator may not have a
        // config.json. The watcher just doesn't fire until it does.
      }
    }
    return () => {
      for (const c of closers) c();
    };
  }
  const stopModelWatchers = watchModelSources();

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
    // ~/.codex/models_cache.json. Read it fresh on every request
    // (no in-memory caching) so newly released models appear without
    // an agentd restart. Operator entries from cfg.models.codex are
    // unioned in front so they keep their custom label/tier.
    const codexCache = loadCodexCache();
    const codex = mergeModelLists(cfg.models.codex, codexCache.models);
    // Same union for claude — operator overrides for early-access
    // version pins, then the family aliases (opus/sonnet/haiku).
    const claude = mergeModelLists(
      cfg.models.claude,
      DEFAULT_MODEL_REGISTRY.claude,
    );
    return c.json({
      models: { claude, codex },
      defaults: cfg.defaultModel,
      // Operator's preferred thinking level per agent, surfaced here so
      // the spawn UI can pre-fill the dot/picker without an extra
      // round-trip. Editable via PATCH /api/config; falls back to
      // claude=xhigh / codex=high if the operator never set it.
      defaultThinking: cfg.defaultThinking,
      // Source-of-truth metadata so the UI can show a freshness hint
      // and a one-click refresh affordance ("Codex list updated 3
      // min ago — Refresh"). Helps when a brand-new model lands and
      // the operator wants to confirm agentd sees it.
      sources: {
        codex: {
          available: codexCache.models.length > 0,
          fetchedAt: codexCache.fetchedAt,
          path: "~/.codex/models_cache.json",
        },
      },
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
    // Best-effort: kill the per-task tmux session so it doesn't pile
    // up. Same name pattern the PTY layer attaches to.
    void killTmuxSession(`agentd-task-${id.slice(-8)}`).catch(() => {});
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
      helper: helperForTask(task),
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
      helper: helperForTask(task),
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
      helper: helperForTask(task),
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
      agent?: string;
      model?: string;
      thinkingLevel?: import("@agentd/contracts").ThinkingLevel;
    } | null;
    const prompt = (body?.prompt ?? "").trim();
    if (!prompt) return c.json({ error: "prompt required" }, 400);
    const cfg = loadConfig(paths.root);
    const agent =
      body?.agent === "claude" || body?.agent === "codex"
        ? body.agent
        : null;
    const helper: AiHelperOptions = agent
      ? {
          agent,
          effort: body?.thinkingLevel ?? cfg.aiHelpers.effort,
        }
      : { ...cfg.aiHelpers };
    if (agent) {
      const selectedModel =
        body?.model?.trim() || cfg.defaultModel?.[agent] || "";
      if (selectedModel) helper.model = selectedModel;
    } else if (body?.model?.trim()) {
      helper.model = body.model.trim();
    }
    const r = await generateBranchName(prompt, { helper });
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
        helper: helperForTask(task),
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
   * Toggle the task's auto-push / auto-PR flags mid-flight. The
   * post-turn hook reads these on every agent exit so flipping them
   * changes the behavior of the NEXT completed turn (not the one
   * already in flight). Either flag is optional — pass only the
   * one you're toggling.
   */
  api.patch("/tasks/:id/auto-flags", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      autoCommit?: boolean;
      autoPush?: boolean;
    } | null;
    if (
      !body ||
      (body.autoCommit === undefined && body.autoPush === undefined)
    ) {
      return c.json(
        { error: "at least one of autoCommit / autoPush required" },
        400,
      );
    }
    const updated = setTaskAutoFlags(db, id, {
      ...(body.autoCommit !== undefined ? { autoCommit: body.autoCommit } : {}),
      ...(body.autoPush !== undefined ? { autoPush: body.autoPush } : {}),
    });
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

    // Conversation usage — the LIVE context size (most recent turn's
    // input + output reported by the runner), NOT the cumulative
    // billing total. Cumulative sums every turn forever, so a
    // task with 4 turns of 50K context each shows 200K used when
    // the agent's actual context is just 50K. Falls back to the
    // cumulative for old rows that never recorded a per-turn value.
    //
    // Keeping the same formula the timeline's compact-banner uses
    // (`apps/web/src/views/TaskDetail.tsx` → `contextTokens`) so the
    // header donut, the chat banner, and this Context tab all agree.
    const liveTurnTokens =
      task.latestTurnInputTokens != null || task.latestTurnOutputTokens != null
        ? (task.latestTurnInputTokens ?? 0) + (task.latestTurnOutputTokens ?? 0)
        : null;
    const cumulativeTokens =
      (task.totalInputTokens ?? 0) +
      (task.totalOutputTokens ?? 0) +
      (task.totalCacheReadTokens ?? 0) +
      (task.totalCacheWriteTokens ?? 0);
    const conversationTokens = liveTurnTokens ?? 0;
    // Per-agent context window. Claude Sonnet/Opus 4: 200K. Codex
    // (GPT-5 family) defaults to 200K too, though specific models
    // can run higher. Keep a single number for now; future work can
    // resolve from cfg.models metadata if operators want to express
    // a non-standard window.
    const conversationWindow = task.agent === "codex" ? 200_000 : 200_000;

    // The catalog actually injected at spawn time (names + paths, no bodies).
    const skillsCatalog = renderSkillsCatalog(task.skills ?? [], {
      agentdRoot: paths.root,
      repoPath: task.repoPath,
    });

    // Repo-context catalog — what we tell the agent about the worktree.
    const repoCtx = renderRepoContext({ worktreePath: task.worktreePath });
    const project = task.projectId ? getProjectById(db, task.projectId) : null;
    const projectInstructions =
      project?.instructionsEnabled !== false
        ? project?.instructions?.trim() || ""
        : "";
    const injectedParts = [
      cfg.agentInstructions?.trim() || "",
      projectInstructions
        ? `# Project instructions\n\n${projectInstructions}`
        : "",
      skillsCatalog.text,
      repoCtx.text,
    ].filter((part) => part.trim().length > 0);
    const injectedText = injectedParts.join("\n\n---\n\n");
    const injectedTokens = Math.ceil(injectedText.length / 4);

    return c.json({
      agentInstructions: cfg.agentInstructions ?? "",
      projectInstructions,
      skills,
      repoCanonical,
      // Suffix-prompt budget (skills + agentInstructions), trim metadata.
      suffix: {
        budget: cfg.maxContextTokens,
        used: injectedTokens,
        kept: skillsCatalog.entries.map((e) => e.id),
        trimmed: [],
      },
      // Progressive-disclosure catalogs — what the agent actually sees.
      catalogs: {
        skills: skillsCatalog,
        repo: repoCtx,
      },
      conversation: {
        used: conversationTokens,
        window: conversationWindow,
        // True when the current context gauge came from runner usage.
        // False means there is no live reading yet, not that lifetime
        // spend should be treated as context.
        liveTurn: liveTurnTokens != null,
        // Separate billing-style total — never decreases. Lets the
        // tab surface "current context" + "lifetime spend" without
        // conflating them.
        cumulative: cumulativeTokens,
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
    try {
      const directive = await tasks.compact(id, body.focus);
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
    // Resolve `projectId` either by id or by slug — the project page
    // and CLI both want to filter by what they have on hand.
    const projectKey = c.req.query("projectId") ?? c.req.query("project");
    let projectId: string | null = null;
    if (projectKey) {
      const p = getProjectById(db, projectKey) ?? getProjectBySlug(db, projectKey);
      if (!p) return c.json({ suggestions: [] });
      projectId = p.id;
    }
    const list = listSuggestions(db, {
      ...(valid ? { status } : {}),
      ...(projectId ? { projectId } : {}),
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
   * Re-score every option on a suggestion with a different agent /
   * model. Used by the brainstorm view's "Validate with…" dropdown
   * so the operator can triangulate across raters before saving an
   * idea. Adds (or replaces) one validation entry on the suggestion
   * and broadcasts `suggestion_updated` so every connected surface
   * shows the new badges.
   */
  api.post("/suggestions/:id/validate", async (c) => {
    const id = c.req.param("id");
    const sug = getSuggestion(db, id);
    if (!sug) return c.json({ error: "not found" }, 404);
    if (sug.options.length === 0) {
      return c.json({ error: "nothing to validate" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      agent?: import("@agentd/contracts").AgentKind;
      model?: string;
      effort?: import("@agentd/contracts").ThinkingLevel;
    } | null;
    const cfg = loadConfig(paths.root);
    const helper = {
      ...cfg.aiHelpers,
      ...(body?.agent ? { agent: body.agent } : {}),
      ...(body?.model ? { model: body.model } : {}),
      ...(body?.effort ? { effort: body.effort } : {}),
    };
    let cwd = process.cwd();
    if (sug.projectId) {
      const project = getProjectById(db, sug.projectId);
      if (project) cwd = project.path;
    }
    // Streamed: each tool_use / tool_result lands as `\x1f<json>\n`
    // so the brainstorm UI can show "claude opus is reading the
    // README…" live. Final result is `\x1e<JSON envelope>` with
    // `{ok, suggestion}` or `{ok:false, error}`.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamValidateIdeas({
            cwd,
            brief: sug.prompt,
            ideas: sug.options,
            helper,
          });
          while (true) {
            const next = await it.next();
            if (next.done) {
              const r = next.value;
              if (r.scores.length === 0) {
                controller.enqueue(
                  enc.encode(
                    `\x1e${JSON.stringify({
                      ok: false,
                      error: r.error ?? "the rater returned no scores",
                    })}`,
                  ),
                );
                break;
              }
              const updated = addSuggestionValidation(db, id, {
                agent: helper.agent ?? "claude",
                model: helper.model ?? "",
                scores: r.scores,
                validatedAt: Date.now(),
              });
              if (updated) {
                bus.publishSystem({
                  kind: "suggestion_updated",
                  suggestion: updated,
                });
              }
              controller.enqueue(
                enc.encode(
                  `\x1e${JSON.stringify({
                    ok: true,
                    suggestion: updated ?? sug,
                  })}`,
                ),
              );
              break;
            }
            controller.enqueue(
              enc.encode(`\x1f${JSON.stringify(next.value)}\n`),
            );
          }
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: false,
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
        "cache-control": "no-cache",
      },
    });
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

  /**
   * Plan a picked option — runs the planner helper against the
   * project's repo and streams a markdown spec back. The operator
   * edits it in the web UI then hands it to whichever executor agent
   * + model they choose. Same streaming shape as commit/PR helpers:
   * raw text chunks, then an `\x1e` separator + final JSON metadata.
   */
  api.post("/suggestions/:id/plan", async (c) => {
    const id = c.req.param("id");
    const sug = getSuggestion(db, id);
    if (!sug) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PlanSuggestionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    let brief: string;
    if (typeof parsed.data.index === "number") {
      const opt = sug.options[parsed.data.index];
      if (!opt) return c.json({ error: "index out of range" }, 400);
      brief = opt;
    } else if (parsed.data.text && parsed.data.text.trim()) {
      brief = parsed.data.text.trim();
    } else {
      return c.json({ error: "provide index or text" }, 400);
    }
    const project = sug.projectId
      ? getProjectById(db, sug.projectId)
      : null;
    const repoPath = project?.path;
    if (!repoPath) {
      return c.json({ error: "suggestion has no project repo" }, 400);
    }
    const cfg = loadConfig(paths.root);
    const helper = {
      ...cfg.aiHelpers,
      ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamSuggestionPlan(repoPath, brief, {
            helper,
            ...(cfg.agentInstructions
              ? { extraInstructions: cfg.agentInstructions }
              : {}),
          });
          type Final = {
            plan: string;
            source: string;
            error?: string;
            slices?: import("@agentd/contracts").PlanSlice[];
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
                source: result?.source ?? "fallback-empty",
                plan: result?.plan ?? "",
                ...(result?.slices && result.slices.length > 0
                  ? { slices: result.slices }
                  : {}),
              }),
            ),
          );
        } catch (e) {
          controller.enqueue(
            new TextEncoder().encode(
              `\x1e${JSON.stringify({
                source: "fallback-error",
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
        "cache-control": "no-cache",
      },
    });
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
      // Per-agent allowed sets — claude rejects `minimal`, codex rejects `max`.
      const allowedClaude = ["low", "medium", "high", "xhigh", "max"] as const;
      const allowedCodex = ["minimal", "low", "medium", "high", "xhigh"] as const;
      const cur = { ...cfg.defaultThinking };
      if (dt.claude != null) {
        if (!allowedClaude.includes(dt.claude as (typeof allowedClaude)[number])) {
          return c.json(
            { error: `defaultThinking.claude must be one of ${allowedClaude.join("|")}` },
            400,
          );
        }
        cur.claude = dt.claude as (typeof allowedClaude)[number];
      }
      if (dt.codex != null) {
        if (!allowedCodex.includes(dt.codex as (typeof allowedCodex)[number])) {
          return c.json(
            { error: `defaultThinking.codex must be one of ${allowedCodex.join("|")}` },
            400,
          );
        }
        cur.codex = dt.codex as (typeof allowedCodex)[number];
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
    const list = listProjects(db);
    // Lazy first-time fill of sidebar GitHub badges. Any project that
    // has a known `githubRepo` but no cached counts yet kicks off a
    // background refresh; the bus event flips badges on without a
    // poll. Bounded fan-out via Promise.all but capped at the existing
    // gh process limit (gh handles its own concurrency).
    for (const p of list) {
      if (p.githubRepo && p.openIssueCount == null && p.openPrCount == null) {
        void refreshGithubCounts(p).catch(() => {});
      }
    }
    return c.json({ projects: list });
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

  /**
   * Stream an AI-drafted set of project instructions. Body:
   *   { description: string; existing?: string }
   * Yields raw text chunks, then a `\x1e` separator + JSON envelope
   * with the cleaned final text (same wire format as the PR-message
   * stream, so the web client can reuse its parser).
   */
  api.post("/projects/:idOrSlug/draft-instructions/stream", async (c) => {
    const key = c.req.param("idOrSlug");
    const project = getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      description?: string;
      existing?: string;
    };
    const cfg = loadConfig(paths.root);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamProjectInstructionsDraft(project.path, {
            description: body.description ?? "",
            ...(body.existing ? { existing: body.existing } : {}),
            helper: cfg.aiHelpers,
          });
          let result: { text: string; source: string } | null = null;
          while (true) {
            const next = await it.next();
            if (next.done) {
              result = next.value as { text: string; source: string };
              break;
            }
            controller.enqueue(enc.encode(next.value));
          }
          controller.enqueue(enc.encode("\x1e"));
          controller.enqueue(
            enc.encode(
              JSON.stringify({
                text: result?.text ?? "",
                source: result?.source ?? "fallback-empty-output",
              }),
            ),
          );
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                text: "",
                source: "fallback-error",
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
   * Agentic conversational editor for project instructions. The agent
   * gets full codebase access (Read/Glob/Grep/Bash via the helper)
   * so it can actually look at the project before suggesting rules.
   * Wire format mirrors the saved-idea chat stream:
   *   - per-event:  `\x1f<HelperStreamEvent json>\n`   (text/tool/instructions deltas)
   *   - terminator: `\x1e<{ ok, reply, instructions, source } json>`
   * The web client consumes events live to render tool activity on
   * the left and a live preview on the right, then reads the
   * envelope to capture the final reply text + revised draft.
   */
  api.post("/projects/:idOrSlug/instructions-chat/stream", async (c) => {
    const key = c.req.param("idOrSlug");
    const project = getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      currentDraft?: string;
      history?: Array<{ role?: string; content?: string }>;
    };
    const message = (body.message ?? "").trim();
    if (!message) return c.json({ error: "message required" }, 400);
    const cfg = loadConfig(paths.root);
    const history = (body.history ?? [])
      .map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("agent" as const),
        content: String(m.content ?? "").slice(0, 4000),
      }))
      .filter((m) => m.content.trim().length > 0)
      .slice(-12);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamInstructionsConversation(project.path, {
            projectName: project.name,
            currentDraft: body.currentDraft ?? project.instructions ?? "",
            history,
            userMessage: message,
            helper: cfg.aiHelpers,
          });
          let final: {
            reply: string;
            source: string;
            instructions?: string | null;
            error?: string;
          } | null = null;
          while (true) {
            const next = await it.next();
            if (next.done) {
              final = next.value;
              break;
            }
            controller.enqueue(enc.encode(`\x1f${JSON.stringify(next.value)}\n`));
          }
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: true,
                reply: final?.reply ?? "",
                source: final?.source ?? "fallback-empty",
                ...(final?.instructions ? { instructions: final.instructions } : {}),
                ...(final?.error ? { error: final.error } : {}),
              })}`,
            ),
          );
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: false,
                source: "fallback-error",
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
        "cache-control": "no-cache",
      },
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

  /**
   * Idea Factory — on-demand brainstorm. Runs the Claude ideation
   * helper synchronously against the project's repo path, persists a
   * project-scoped Suggestion, and broadcasts `suggestion_created`
   * so every connected surface (web, telegram, discord) lights up.
   *
   * Long-running by nature (~10–30s for the helper to come back). The
   * caller shows a spinner; the daemon's `idleTimeout` is generous
   * enough that this fits comfortably.
   */
  api.post("/projects/:idOrSlug/ideate", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = IdeateRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const cfg = loadConfig(paths.root);
    const helper = {
      ...cfg.aiHelpers,
      ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
    };
    const result = await runIdeation(project.path, parsed.data.prompt, {
      helper,
      max: parsed.data.max,
    });
    if (result.options.length === 0) {
      return c.json(
        {
          ok: false,
          source: result.source,
          error:
            result.error ??
            "the helper returned no options — try a sharper brief",
        },
        200,
      );
    }
    const title =
      parsed.data.title?.trim() ||
      parsed.data.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
    const sug = createSuggestion(db, {
      templateId: null,
      projectId: project.id,
      title,
      prompt: parsed.data.prompt,
      options: result.options,
    });
    bus.publishSystem({ kind: "suggestion_created", suggestion: sug });
    return c.json({ ok: true, suggestion: sug });
  });

  /**
   * Streaming brainstorm — same helper as `/ideate` but yields each
   * option line as it lands so the UI ticks them in one-by-one with
   * a fade-in. Drives the agentic look on the project page.
   *
   * Wire shape: each option arrives as `\x1f<text>\n`, then a final
   * `\x1e<JSON>` envelope contains the persisted suggestion.
   */
  /**
   * Reset the brainstorm thread — purges every suggestion (and its
   * options) tied to this project. Saved ideas survive because the
   * `saved_ideas` table is decoupled. Operator's escape hatch when
   * the conversation has piled up and they want a clean canvas.
   */
  api.delete("/projects/:idOrSlug/suggestions", (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const removed = deleteProjectSuggestions(db, project.id);
    return c.json({ ok: true, removed });
  });

  api.post("/projects/:idOrSlug/ideate/stream", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = IdeateRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const cfg = loadConfig(paths.root);
    const helper = {
      ...cfg.aiHelpers,
      ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
    };
    // Gather project context so the agent can dedup against work
    // the operator already saved, brainstormed, or shipped. Most-
    // recent first; helper caps each list internally.
    const savedIdeas = listSavedIdeas(db, {
      projectId: project.id,
      includeSpawned: false,
    }).map((i) => i.text);
    const pastSuggestions = listSuggestions(db, {
      projectId: project.id,
      limit: 8,
    });
    const pastOptions = pastSuggestions.flatMap((s) => s.options);
    const recentTasks = tasks
      .list()
      .filter((t) => t.projectId === project.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((t) => t.title);
    const ctx = {
      savedIdeas,
      pastOptions,
      recentTasks,
      // Honor the operator's "use these instructions" toggle so the
      // brainstorm helper agrees with the spawn prompt.
      instructions:
        project.instructionsEnabled !== false
          ? project.instructions ?? null
          : null,
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const collected: string[] = [];
        const startedAt = Date.now();
        let lastUsage: {
          inputTokens?: number;
          outputTokens?: number;
        } | null = null;
        // Tool-call events accumulated so they can be persisted on
        // the suggestion. The brainstorm thread renders these as
        // `<ToolLine>` rows so the operator sees what the agent
        // actually read / ran during the draft, even after reload.
        const accumulatedEvents: Array<{
          kind: "tool_use" | "tool_result";
          [k: string]: unknown;
        }> = [];
        try {
          const it = streamIdeation(project.path, parsed.data.prompt, {
            helper,
            context: ctx,
            ...(parsed.data.max != null ? { max: parsed.data.max } : {}),
          });
          while (true) {
            const next = await it.next();
            if (next.done) {
              const result = next.value;
              if (collected.length === 0 && result.options.length === 0) {
                controller.enqueue(
                  enc.encode(
                    `\x1e${JSON.stringify({
                      ok: false,
                      source: result.source,
                      error: result.error ?? "the helper returned no options — try a sharper brief",
                    })}`,
                  ),
                );
              } else {
                const title =
                  parsed.data.title?.trim() ||
                  parsed.data.prompt
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 60);
                const sug = createSuggestion(db, {
                  templateId: null,
                  projectId: project.id,
                  title,
                  prompt: parsed.data.prompt,
                  options: collected,
                  durationMs: Date.now() - startedAt,
                  ...(lastUsage?.inputTokens != null
                    ? { inputTokens: lastUsage.inputTokens }
                    : {}),
                  ...(lastUsage?.outputTokens != null
                    ? { outputTokens: lastUsage.outputTokens }
                    : {}),
                  ...(accumulatedEvents.length > 0
                    ? {
                        events: accumulatedEvents as Array<
                          import("@agentd/contracts").IdeaMessageEvent
                        >,
                      }
                    : {}),
                });
                bus.publishSystem({
                  kind: "suggestion_created",
                  suggestion: sug,
                });
                controller.enqueue(
                  enc.encode(
                    `\x1e${JSON.stringify({
                      ok: true,
                      suggestion: sug,
                      source: result.source,
                    })}`,
                  ),
                );
              }
              break;
            }
            const ev = next.value;
            if (ev.kind === "option") {
              collected.push(ev.text);
            } else if (ev.kind === "tool_use" || ev.kind === "tool_result") {
              accumulatedEvents.push(
                ev as { kind: "tool_use" | "tool_result"; [k: string]: unknown },
              );
            } else if (ev.kind === "usage") {
              lastUsage = {
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              };
            }
            // Each event lands as `\x1f<json>\n` so the web can render
            // tool_use / tool_result / usage rows live.
            controller.enqueue(enc.encode(`\x1f${JSON.stringify(ev)}\n`));
          }
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: false,
                source: "fallback-error",
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
        "cache-control": "no-cache",
      },
    });
  });

  /**
   * Saved ideas — the per-project shortlist the operator curates from
   * brainstorm options. Independent of suggestion lifecycle.
   */
  api.get("/projects/:idOrSlug/saved-ideas", (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const includeSpawned = c.req.query("includeSpawned") === "1";
    const statusParam = c.req.query("status");
    const statuses = statusParam
      ? statusParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) =>
            ["draft", "refining", "validated", "spawned", "archived"].includes(s),
          )
      : undefined;
    const ideas = listSavedIdeas(db, {
      projectId: project.id,
      includeSpawned,
      ...(statuses && statuses.length > 0
        ? { statuses: statuses as import("@agentd/contracts").IdeaStatus[] }
        : {}),
    });
    return c.json({ ideas });
  });

  api.post("/projects/:idOrSlug/saved-ideas", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = SaveIdeaRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const idea = createSavedIdea(db, {
      projectId: project.id,
      text: parsed.data.text.trim(),
      ...(parsed.data.description != null
        ? { description: parsed.data.description }
        : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
      ...(parsed.data.suggestionId
        ? { suggestionId: parsed.data.suggestionId }
        : {}),
      ...(parsed.data.optionIndex != null
        ? { optionIndex: parsed.data.optionIndex }
        : {}),
      ...(parsed.data.planDraft != null
        ? { planDraft: parsed.data.planDraft }
        : {}),
    });
    pubSavedIdeaChanged(idea.id);
    return c.json({ idea });
  });

  /**
   * "I have an idea" — agentic validation flow. Streams the agent's
   * critique + sketch + suggested title back as it reads the repo.
   * The web's brainstorm view renders this turn just like a brain-
   * storm session: live tool activity above, prose body, action row
   * (save / discard) when finished. NOTHING is persisted by this
   * endpoint — the operator clicks Save explicitly, which hits the
   * existing saved-ideas POST.
   *
   * Wire format mirrors the saved-idea chat stream:
   *   - per-event:  `\x1f<HelperStreamEvent json>\n`
   *   - terminator: `\x1e<{ ok, critique, suggestedTitle, source } json>`
   */
  api.post("/projects/:idOrSlug/validate-idea/stream", async (c) => {
    const key = c.req.param("idOrSlug");
    const project = getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      history?: Array<{ role?: string; content?: string }>;
    } | null;
    const text = (body?.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const history = (body?.history ?? [])
      .map((m) => ({
        role: m.role === "agent" ? ("agent" as const) : ("user" as const),
        content: String(m.content ?? "").slice(0, 4000),
      }))
      .filter((m) => m.content.trim().length > 0)
      .slice(-12);
    const cfg = loadConfig(paths.root);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          const it = streamValidateIdea(project.path, {
            text,
            history,
            helper: cfg.aiHelpers,
          });
          let result: {
            ok: boolean;
            critique: string;
            suggestedTitle: string;
            source: string;
            error?: string;
          } | null = null;
          while (true) {
            const next = await it.next();
            if (next.done) {
              result = next.value;
              break;
            }
            controller.enqueue(enc.encode(`\x1f${JSON.stringify(next.value)}\n`));
          }
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: result?.ok ?? false,
                critique: result?.critique ?? "",
                suggestedTitle: result?.suggestedTitle ?? "",
                source: result?.source ?? "fallback-empty",
                ...(result?.error ? { error: result.error } : {}),
              })}`,
            ),
          );
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: false,
                source: "fallback-error",
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
        "cache-control": "no-cache",
      },
    });
  });

  /**
   * "I have an idea, help me plan it" — synchronous wrapper around
   * the plan-mode helper. Creates a SavedIdea from the prompt,
   * drains streamIdeaConversation in plan mode against the project's
   * worktree (the agent reads the repo before producing the spec),
   * persists the resulting plan onto the saved idea, and returns
   * both. Plugins (telegram /plan, discord /plan) and the project
   * page's "Plan an idea" entry both call this.
   */
  api.post("/projects/:idOrSlug/plan-idea", async (c) => {
    const key = c.req.param("idOrSlug");
    const project = getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      title?: string;
    } | null;
    const text = (body?.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const titleSeed = (body?.title?.trim() || text)
      .replace(/\s+/g, " ")
      .slice(0, 80);

    const cfg = loadConfig(paths.root);
    // Stash the idea immediately so the operator can see it in the
    // library even if the plan generator times out.
    const idea = createSavedIdea(db, {
      projectId: project.id,
      text: titleSeed,
      description: text,
      status: "refining",
    });

    try {
      const it = streamIdeaConversation(project.path, {
        title: titleSeed,
        description: text,
        history: [],
        userMessage: text,
        mode: "plan",
        helper: cfg.aiHelpers,
      });
      let plan = "";
      while (true) {
        const next = await it.next();
        if (next.done) {
          plan = (next.value.reply || "").trim();
          break;
        }
        // Drop streaming events here — this endpoint is synchronous;
        // the web's streaming variant handles live UI separately.
      }
      if (!plan) {
        return c.json(
          {
            ok: false,
            idea,
            error:
              "the helper returned an empty plan — try a sharper brief or the workshop's chat",
          },
          200,
        );
      }
      const updated = updateSavedIdeaPlan(db, idea.id, plan) ?? idea;
      return c.json({ ok: true, idea: updated, plan });
    } catch (e) {
      return c.json(
        { ok: false, idea, error: (e as Error).message },
        200,
      );
    }
  });

  /**
   * One idea + its full conversation thread. Used by the workshop
   * panel when the operator opens an idea card.
   */
  api.get("/saved-ideas/:id", (c) => {
    const id = c.req.param("id");
    const idea = getSavedIdea(db, id);
    if (!idea) return c.json({ error: "not found" }, 404);
    const messages = listIdeaMessages(db, id);
    return c.json({ idea, messages });
  });

  api.patch("/saved-ideas/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateIdeaRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const updated = updateSavedIdea(db, id, parsed.data);
    if (!updated) return c.json({ error: "not found" }, 404);
    pubSavedIdeaChanged(id);
    return c.json({ idea: updated });
  });

  api.get("/saved-ideas/:id/messages", (c) => {
    const id = c.req.param("id");
    const idea = getSavedIdea(db, id);
    if (!idea) return c.json({ error: "not found" }, 404);
    return c.json({ messages: listIdeaMessages(db, id) });
  });

  /**
   * Workshop chat — operator asks a question (or taps "challenge"
   * for the agent to self-critique), the helper streams a reply
   * that lands as an `agent` message at the end of the thread. The
   * idea's status auto-advances from `draft` → `refining` on first
   * message.
   *
   * Wire shape: raw text chunks, then `\x1e<JSON>` envelope with
   * `{ ok, message, ideaStatus }`.
   */
  api.post("/saved-ideas/:id/chat/stream", async (c) => {
    const id = c.req.param("id");
    const idea = getSavedIdea(db, id);
    if (!idea) return c.json({ error: "not found" }, 404);
    const project = getProjectById(db, idea.projectId);
    if (!project) return c.json({ error: "project gone" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = IdeaChatRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const mode = parsed.data.mode ?? "chat";
    const userMessage = (parsed.data.text ?? "").trim();
    if (mode === "chat" && !userMessage) {
      return c.json({ error: "text required for chat mode" }, 400);
    }
    // Persist the operator's turn before spawning the helper so the
    // thread always reflects truth even if the helper never responds.
    if ((mode === "chat" || mode === "validate") && userMessage) {
      appendIdeaMessage(db, {
        ideaId: id,
        role: "user",
        content: userMessage,
      });
      pubSavedIdeaChanged(id);
    } else if (mode === "challenge") {
      appendIdeaMessage(db, {
        ideaId: id,
        role: "system",
        content: "Operator asked the agent to challenge the idea.",
      });
      pubSavedIdeaChanged(id);
    } else if (mode === "plan") {
      appendIdeaMessage(db, {
        ideaId: id,
        role: "system",
        content: userMessage
          ? `Operator asked the agent to draft a plan: ${userMessage}`
          : idea.planDraft
            ? "Operator asked the agent to refine the plan."
            : "Operator asked the agent to draft a plan.",
      });
      pubSavedIdeaChanged(id);
    }
    const cfg = loadConfig(paths.root);
    const helper = {
      ...cfg.aiHelpers,
      ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
    };
    const history = listIdeaMessages(db, id).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        // We accumulate the agent's tool-call events so they can
        // be persisted on the agent message — the workshop replays
        // the activity timeline from this on reload, like task pages.
        const accumulatedEvents: Array<{
          kind: string;
          [k: string]: unknown;
        }> = [];
        try {
          const it = streamIdeaConversation(project.path, {
            title: idea.text,
            description: idea.description,
            planDraft: idea.planDraft,
            history,
            ...(userMessage ? { userMessage } : {}),
            mode,
            helper,
          });
          while (true) {
            const next = await it.next();
            if (next.done) {
              const result = next.value;
              if (!result.reply) {
                controller.enqueue(
                  enc.encode(
                    `\x1e${JSON.stringify({
                      ok: false,
                      source: result.source,
                      error: result.error ?? "the helper returned nothing",
                    })}`,
                  ),
                );
              } else {
                // First conversation turn promotes draft → refining,
                // EXCEPT in validate mode — those drafts stay as
                // "draft" until the operator explicitly hits Save in
                // the brainstorm view (which sets status to refining
                // via PATCH). Keeps the brainstorm idea-mode pile
                // distinct from the workshop's library.
                let nextStatus = idea.status;
                if (idea.status === "draft" && mode !== "validate") {
                  const promoted = updateSavedIdea(db, id, {
                    status: "refining",
                  });
                  if (promoted) nextStatus = promoted.status;
                }
                let persisted;
                let nextPlanDraft = idea.planDraft;
                let nextPlanSlices = idea.planSlices ?? null;
                if (mode === "plan") {
                  // Plan mode: the agent's reply IS the new plan. Stash
                  // it on the idea (the right-side plan panel shows
                  // this) and write a short system marker in the
                  // thread instead of bloating the chat with the full
                  // plan body. Tool-call events go on the marker so
                  // the activity history still survives reload.
                  const planned = updateSavedIdeaPlan(db, id, result.reply);
                  if (planned) nextPlanDraft = planned.planDraft;
                  if (result.planSlices && result.planSlices.length > 0) {
                    const sliced = updateSavedIdeaSlices(
                      db,
                      id,
                      result.planSlices,
                    );
                    if (sliced) nextPlanSlices = sliced.planSlices ?? null;
                  }
                  persisted = appendIdeaMessage(db, {
                    ideaId: id,
                    role: "system",
                    content: idea.planDraft
                      ? "Plan refined — see the right panel."
                      : "Plan drafted — see the right panel.",
                    ...(accumulatedEvents.length > 0
                      ? {
                          events: accumulatedEvents as Array<{
                            kind: "tool_use" | "tool_result" | "text" | "raw";
                            [k: string]: unknown;
                          }>,
                        }
                      : {}),
                  });
                } else {
                  persisted = appendIdeaMessage(db, {
                    ideaId: id,
                    role: "agent",
                    content: result.reply,
                    ...(accumulatedEvents.length > 0
                      ? {
                          events: accumulatedEvents as Array<{
                            kind: "tool_use" | "tool_result" | "text" | "raw";
                            [k: string]: unknown;
                          }>,
                        }
                      : {}),
                  });
                  // Chat / challenge mode: if the agent decided to
                  // update the plan in this turn (via a <plan-update>
                  // block), persist the new plan and drop a system
                  // marker into the thread so the timeline reflects
                  // the change.
                  if (result.planContent) {
                    const planned = updateSavedIdeaPlan(
                      db,
                      id,
                      result.planContent,
                    );
                    if (planned) nextPlanDraft = planned.planDraft;
                    if (result.planSlices && result.planSlices.length > 0) {
                      const sliced = updateSavedIdeaSlices(
                        db,
                        id,
                        result.planSlices,
                      );
                      if (sliced) nextPlanSlices = sliced.planSlices ?? null;
                    }
                    appendIdeaMessage(db, {
                      ideaId: id,
                      role: "system",
                      content: idea.planDraft
                        ? "Plan updated — see the right panel."
                        : "Plan drafted — see the right panel.",
                    });
                  }
                }
                controller.enqueue(
                  enc.encode(
                    `\x1e${JSON.stringify({
                      ok: true,
                      message: persisted,
                      ideaStatus: nextStatus,
                      planDraft: nextPlanDraft,
                      ...(nextPlanSlices && nextPlanSlices.length > 0
                        ? { planSlices: nextPlanSlices }
                        : {}),
                      ...(result.suggestedTitle
                        ? { suggestedTitle: result.suggestedTitle }
                        : {}),
                    })}`,
                  ),
                );
                // Cross-device sync — every other connected client
                // refreshes the idea + its messages list.
                pubSavedIdeaChanged(id);
              }
              break;
            }
            // streamIdeaConversation now yields HelperStreamEvent —
            // we forward each as `\x1f<json>\n` so the web can render
            // tool_use / tool_result rows live + persist them on the
            // agent message at the end so history survives reload.
            const ev = next.value;
            if (ev.kind === "tool_use" || ev.kind === "tool_result") {
              accumulatedEvents.push(ev);
            }
            controller.enqueue(enc.encode(`\x1f${JSON.stringify(ev)}\n`));
          }
        } catch (e) {
          controller.enqueue(
            enc.encode(
              `\x1e${JSON.stringify({
                ok: false,
                source: "fallback-error",
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
        "cache-control": "no-cache",
      },
    });
  });

  api.delete("/saved-ideas/:id", (c) => {
    const id = c.req.param("id");
    const idea = getSavedIdea(db, id);
    if (!idea) return c.json({ error: "not found" }, 404);
    deleteSavedIdea(db, id);
    pubSavedIdeaRemoved(id, idea.projectId ?? null);
    return c.json({ ok: true });
  });

  api.put("/saved-ideas/:id/plan", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      planDraft?: string | null;
    } | null;
    const updated = updateSavedIdeaPlan(db, id, body?.planDraft ?? null);
    if (!updated) return c.json({ error: "not found" }, 404);
    pubSavedIdeaChanged(id);
    return c.json({ idea: updated });
  });

  /**
   * Persist the operator-edited slice list. Empty array (or null) clears
   * the slices and reverts the spawn sheet to single-task mode.
   */
  api.put("/saved-ideas/:id/slices", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      slices?: import("@agentd/contracts").PlanSlice[] | null;
    } | null;
    const slices = body?.slices ?? null;
    const updated = updateSavedIdeaSlices(db, id, slices);
    if (!updated) return c.json({ error: "not found" }, 404);
    pubSavedIdeaChanged(id);
    return c.json({ idea: updated });
  });

  /**
   * Spawn a real task from a saved idea. Same machinery as the
   * suggestion resolve path — accepts the full executor knob set.
   */
  api.post("/saved-ideas/:id/spawn", async (c) => {
    const id = c.req.param("id");
    const idea = getSavedIdea(db, id);
    if (!idea) return c.json({ error: "not found" }, 404);
    const project = getProjectById(db, idea.projectId);
    if (!project) return c.json({ error: "project gone" }, 400);
    const body = (await c.req.json().catch(() => null)) as {
      prompt?: string;
      agent?: import("@agentd/contracts").AgentKind;
      model?: string;
      thinkingLevel?: import("@agentd/contracts").ThinkingLevel;
      permissionMode?: import("@agentd/contracts").PermissionMode;
      title?: string;
    } | null;
    const promptText = (body?.prompt?.trim() || idea.planDraft?.trim() || idea.text);
    try {
      const task = await tasks.create({
        agent: body?.agent ?? "claude",
        repoPath: project.path,
        prompt: promptText,
        title:
          body?.title?.trim() || idea.text.split("\n")[0]!.slice(0, 80),
        ...(body?.model ? { model: body.model } : {}),
        ...(body?.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
        ...(body?.permissionMode
          ? { permissionMode: body.permissionMode }
          : {}),
      });
      const updated = markSavedIdeaSpawned(db, id, task.id) ?? idea;
      pubTaskChanged(task.id);
      return c.json({ idea: updated, task });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Fan a saved idea's plan slices out into N sibling tasks. Slices
   * share one worktree on one branch by default and run sequentially
   * via dependsOnTaskId chains so they can land independent commits
   * without racing on the same checkout. Returns the created tasks
   * in slice order; the first one starts immediately.
   */
  api.post("/saved-ideas/:id/spawn-multi", async (c) => {
    const id = c.req.param("id");
    const idea = getSavedIdea(db, id);
    if (!idea) return c.json({ error: "not found" }, 404);
    const project = getProjectById(db, idea.projectId);
    if (!project) return c.json({ error: "project gone" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = SpawnMultiRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const created = await tasks.createBatch({
        repoPath: project.path,
        slices: parsed.data.slices,
        ...(parsed.data.shareWorktree != null
          ? { shareWorktree: parsed.data.shareWorktree }
          : {}),
        ...(parsed.data.branchName ? { branchName: parsed.data.branchName } : {}),
        ...(parsed.data.baseBranch ? { baseBranch: parsed.data.baseBranch } : {}),
        ...(parsed.data.title ? { titlePrefix: parsed.data.title } : {}),
      });
      const firstTask = created[0]!;
      const updated = markSavedIdeaSpawned(db, id, firstTask.id) ?? idea;
      for (const t of created) pubTaskChanged(t.id);
      return c.json({ idea: updated, tasks: created });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Saved-idea-free fan-out. Same `createBatch` mechanics as
   * `/saved-ideas/:id/spawn-multi` but takes a `repoPath` directly so
   * the spawn sheet's "phase this" toggle can split a plan across
   * agents without first stashing it as an idea.
   */
  api.post("/tasks/spawn-multi", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SpawnTasksMultiRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const created = await tasks.createBatch({
        repoPath: parsed.data.repoPath,
        slices: parsed.data.slices,
        ...(parsed.data.shareWorktree != null
          ? { shareWorktree: parsed.data.shareWorktree }
          : {}),
        ...(parsed.data.branchName ? { branchName: parsed.data.branchName } : {}),
        ...(parsed.data.baseBranch ? { baseBranch: parsed.data.baseBranch } : {}),
        ...(parsed.data.title ? { titlePrefix: parsed.data.title } : {}),
        ...(parsed.data.autoPush != null ? { autoPush: parsed.data.autoPush } : {}),
      });
      for (const t of created) pubTaskChanged(t.id);
      return c.json({ tasks: created });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Spawn a sibling task on an existing task's worktree + branch. The
   * new task chains via `dependsOnTaskId` so it runs after the parent
   * finishes its current turn. Used by the task page's "Spawn related
   * task" action — lets the operator drop a second agent (different
   * model, different scope) onto the same checkout. Both end up in
   * the same `planGroupId`, so the sidebar shows them as one cluster.
   */
  api.post("/tasks/:id/spawn-sibling", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = SpawnSiblingRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const sibling = await tasks.addSiblingTask(id, {
        agent: parsed.data.agent,
        prompt: parsed.data.prompt,
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(parsed.data.thinkingLevel
          ? { thinkingLevel: parsed.data.thinkingLevel }
          : {}),
        ...(parsed.data.permissionMode
          ? { permissionMode: parsed.data.permissionMode }
          : {}),
        ...(parsed.data.autoCommit != null
          ? { autoCommit: parsed.data.autoCommit }
          : {}),
        ...(parsed.data.autoPush != null
          ? { autoPush: parsed.data.autoPush }
          : {}),
      });
      pubTaskChanged(sibling.id);
      pubTaskChanged(id);
      return c.json({ task: sibling });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
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

  /**
   * Project-level git state — current branch + commits ahead/behind
   * `origin/<branch>`. Drives the "N commits behind, click to pull"
   * pill on the project brainstorm topbar so the operator never
   * brainstorms against stale code. `?fetch=1` runs `git fetch
   * --prune` first so the counts reflect the real remote state;
   * default is cheap (just rev-list of what's already fetched).
   */
  api.get("/projects/:idOrSlug/git-state", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const wantFetch = c.req.query("fetch") === "1";
    try {
      const branchProc = Bun.spawn({
        cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd: project.path,
        stdout: "pipe",
        stderr: "pipe",
      });
      const branch = (await new Response(branchProc.stdout).text()).trim();
      await branchProc.exited;
      let fetched = false;
      let fetchError: string | null = null;
      if (wantFetch) {
        const fp = Bun.spawn({
          cmd: ["git", "fetch", "--prune", "origin"],
          cwd: project.path,
          stdout: "pipe",
          stderr: "pipe",
        });
        await fp.exited;
        if (fp.exitCode === 0) fetched = true;
        else
          fetchError = (await new Response(fp.stderr).text()).trim() || null;
      }
      const proc = Bun.spawn({
        cmd: [
          "git",
          "rev-list",
          "--left-right",
          "--count",
          `origin/${branch}...HEAD`,
        ],
        cwd: project.path,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      // Count uncommitted entries in `git status --porcelain` so the UI
      // can show a "dirty" badge alongside ahead/behind.
      const statusProc = Bun.spawn({
        cmd: ["git", "status", "--porcelain"],
        cwd: project.path,
        stdout: "pipe",
        stderr: "pipe",
      });
      const statusOut = (await new Response(statusProc.stdout).text()).trim();
      await statusProc.exited;
      const dirty = statusOut.length === 0
        ? 0
        : statusOut.split("\n").filter((l) => l.length > 0).length;
      const m = out.match(/^(\d+)\s+(\d+)/);
      if (proc.exitCode !== 0 || !m) {
        return c.json({
          branch,
          ahead: 0,
          behind: 0,
          hasUpstream: false,
          dirty,
          fetched,
          ...(fetchError ? { fetchError } : {}),
        });
      }
      return c.json({
        branch,
        behind: parseInt(m[1]!, 10),
        ahead: parseInt(m[2]!, 10),
        hasUpstream: true,
        dirty,
        fetched,
        ...(fetchError ? { fetchError } : {}),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Pull origin into the project's working tree. Fast-forward only —
   * if the operator has local commits the pull is rejected and the
   * UI surfaces the error instead of silently merging. Returns the
   * new git-state so the UI can update the "N behind" pill in one
   * round-trip.
   */
  api.post("/projects/:idOrSlug/pull", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      const branchProc = Bun.spawn({
        cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd: project.path,
        stdout: "pipe",
      });
      const branch = (await new Response(branchProc.stdout).text()).trim();
      await branchProc.exited;
      const pull = Bun.spawn({
        cmd: ["git", "pull", "--ff-only", "origin", branch],
        cwd: project.path,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = (await new Response(pull.stdout).text()).trim();
      const stderr = (await new Response(pull.stderr).text()).trim();
      await pull.exited;
      if (pull.exitCode !== 0) {
        return c.json(
          {
            ok: false,
            error: stderr || stdout || "git pull failed",
            branch,
          },
          400,
        );
      }
      const after = Bun.spawn({
        cmd: [
          "git",
          "rev-list",
          "--left-right",
          "--count",
          `origin/${branch}...HEAD`,
        ],
        cwd: project.path,
        stdout: "pipe",
      });
      const out = (await new Response(after.stdout).text()).trim();
      await after.exited;
      const m = out.match(/^(\d+)\s+(\d+)/);
      const behind = m ? parseInt(m[1]!, 10) : 0;
      const ahead = m ? parseInt(m[2]!, 10) : 0;
      // Project's underlying tree changed — bump the project row so
      // any view that derives from the worktree (file tree, etc.)
      // can refresh on the next render.
      pubProjectChanged(project.id);
      return c.json({
        ok: true,
        branch,
        ahead,
        behind,
        hasUpstream: true,
        message: stdout || "fast-forward complete",
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // ── GitHub ──────────────────────────────────────────────────────────
  //
  // Thin shell-out layer over the operator's `gh` CLI. Auth is `gh`'s
  // problem; we just reuse the operator's existing identity (no PATs,
  // no Octokit). Every project-scoped call runs in the project's repo
  // path so `gh` picks up the right remote from `.git/config`.

  /**
   * Global preflight — `gh --version` + `gh auth status`. Web's GitHub
   * tab gates on this. Cheap (~150ms) so we don't cache.
   */
  api.get("/github/status", async (c) => {
    const status = await ghStatus();
    return c.json(status);
  });

  /**
   * Resolve `owner/repo` for a project lazily and cache it on the
   * project row. The web reads this to decide whether the GitHub tab
   * makes sense (no GitHub remote → tab hidden). Re-runs `gh repo
   * view` when the project doesn't have it cached yet, so the first
   * visit pays a small cost and every visit after is free.
   */
  async function resolveProjectGithubRepo(project: {
    id: string;
    path: string;
    githubRepo?: string | null;
  }): Promise<string | null> {
    if (project.githubRepo) return project.githubRepo;
    const slug = await ghRepo(project.path);
    if (slug) {
      const next = updateProject(db, project.id, { githubRepo: slug });
      if (next) pubProjectChanged(next.id);
    }
    return slug;
  }

  /**
   * Refresh the cached open-issue/PR counts for a project. Runs both
   * `gh` calls in parallel and writes the results back to the project
   * row. Best-effort — a `gh` failure leaves the prior cached count in
   * place (we only overwrite when the call succeeded). Publishes
   * `project_changed` so every connected sidebar updates without
   * polling. Safe to fire-and-forget; callers that need the result
   * await it.
   */
  async function refreshGithubCounts(project: {
    id: string;
    path: string;
    githubRepo?: string | null;
  }): Promise<void> {
    const slug = await resolveProjectGithubRepo(project);
    if (!slug) return;
    const [issues, prs] = await Promise.all([
      ghCountOpenIssues(project.path),
      ghCountOpenPrs(project.path),
    ]);
    const patch: {
      openIssueCount?: number | null;
      openPrCount?: number | null;
      githubCountsAt?: number | null;
    } = { githubCountsAt: Date.now() };
    if (issues != null) patch.openIssueCount = issues;
    if (prs != null) patch.openPrCount = prs;
    const next = updateProject(db, project.id, patch);
    if (next) pubProjectChanged(next.id);
  }

  /**
   * Re-pull the live state (`OPEN` / `MERGED` / `CLOSED`, plus draft for
   * PRs) for a single task from `gh` and persist it. Best-effort: a `gh`
   * failure is swallowed so the prior cached state stays put. Publishes
   * `task_changed` so the lifecycle icon updates everywhere without a
   * poll. Used after PR actions and during project github refreshes.
   */
  async function refreshTaskGithubMeta(
    taskId: string,
    cwd: string,
  ): Promise<void> {
    const task = tasks.get(taskId);
    if (!task) return;
    if (task.githubPr) {
      const r = await ghViewPr(cwd, task.githubPr);
      if (!r.ok || !r.data) return;
      const next = setTaskGithubMeta(db, taskId, {
        githubPrState: r.data.state || null,
        githubPrIsDraft: r.data.isDraft === true,
      });
      if (next) pubTaskChanged(taskId);
    } else if (task.githubIssue) {
      const r = await ghViewIssue(cwd, task.githubIssue);
      if (!r.ok || !r.data) return;
      const next = setTaskGithubMeta(db, taskId, {
        githubIssueState: r.data.state || null,
      });
      if (next) pubTaskChanged(taskId);
    }
  }

  /**
   * Fan-out refresh: every task in this project that's tied to a
   * GitHub issue or PR re-pulls its lifecycle state. Runs serially to
   * stay friendly to `gh`'s implicit rate limiter (HTTP-cached, so
   * cheap on the second hit). Fire-and-forget — callers don't wait.
   */
  async function refreshProjectTaskGithubMeta(project: {
    id: string;
    path: string;
  }): Promise<void> {
    const all = listTasks(db);
    for (const t of all) {
      if (t.projectId !== project.id) continue;
      if (!t.githubPr && !t.githubIssue) continue;
      await refreshTaskGithubMeta(t.id, project.path).catch(() => {});
    }
  }

  api.get("/projects/:idOrSlug/github/repo", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const slug = await resolveProjectGithubRepo(project);
    return c.json({ repo: slug });
  });

  /**
   * Parse the GitHub list/search query string. Mirrors github.com's
   * own filter UI: `state, q, label (repeatable), author, assignee,
   * milestone, draft, base, limit`. The `q` param accepts the full
   * github.com search syntax (`is:open author:foo label:bug
   * in:title,body`) and is handed to `gh --search` verbatim.
   */
  function parseGithubListQuery(c: import("hono").Context): GithubListQuery {
    const q = c.req.queries();
    const out: GithubListQuery = {};
    const state = c.req.query("state");
    if (state === "open" || state === "closed" || state === "merged" || state === "all") {
      out.state = state;
    }
    const search = c.req.query("q") ?? c.req.query("search");
    if (search?.trim()) out.search = search.trim();
    const labels = q.label ?? q.labels ?? [];
    if (labels.length > 0) {
      // Allow `?label=a&label=b` (repeated) or `?labels=a,b` (csv).
      const flat: string[] = [];
      for (const l of labels) {
        for (const part of l.split(",")) {
          if (part.trim()) flat.push(part.trim());
        }
      }
      if (flat.length > 0) out.labels = flat;
    }
    const author = c.req.query("author");
    if (author?.trim()) out.author = author.trim();
    const assignee = c.req.query("assignee");
    if (assignee?.trim()) out.assignee = assignee.trim();
    const milestone = c.req.query("milestone");
    if (milestone?.trim()) out.milestone = milestone.trim();
    const base = c.req.query("base");
    if (base?.trim()) out.base = base.trim();
    if (c.req.query("draft") === "true") out.draft = true;
    const limit = c.req.query("limit");
    if (limit) {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) out.limit = Math.min(500, Math.floor(n));
    }
    return out;
  }

  /**
   * True when a `GithubListQuery` is the unfiltered "open" default —
   * `state=open` (or unset) and no search/label/author/etc filters.
   * The list endpoints use this to opportunistically update the
   * cached open-count cache (and therefore the sidebar badges) from
   * the response length without an extra `gh` round-trip. Filtered
   * lists would give a misleading count, so we skip them.
   */
  function isNaturalOpenView(opts: GithubListQuery): boolean {
    if (opts.state && opts.state !== "open") return false;
    if (opts.search?.trim()) return false;
    if (opts.labels && opts.labels.length > 0) return false;
    if (opts.author?.trim()) return false;
    if (opts.assignee?.trim()) return false;
    if (opts.milestone?.trim()) return false;
    if (opts.base?.trim()) return false;
    if (opts.draft) return false;
    return true;
  }

  api.get("/projects/:idOrSlug/github/issues", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const slug = await resolveProjectGithubRepo(project);
    if (!slug) return c.json({ ok: false, repo: null, issues: [], error: "no GitHub remote" });
    const opts = parseGithubListQuery(c);
    const r = await ghListIssues(project.path, opts);
    if (!r.ok) {
      return c.json({ ok: false, repo: slug, issues: [], error: r.error ?? "gh failed" });
    }
    // Operator opened the GitHub tab — kick a background count
    // refresh so the sidebar badges follow the same view.
    // Fire-and-forget; the bus event flips badges without polling.
    if (isNaturalOpenView(opts)) {
      void refreshGithubCounts(project).catch(() => {});
    }
    return c.json({ ok: true, repo: slug, issues: r.data ?? [], query: opts });
  });

  api.get("/projects/:idOrSlug/github/prs", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const slug = await resolveProjectGithubRepo(project);
    if (!slug) return c.json({ ok: false, repo: null, prs: [], error: "no GitHub remote" });
    const opts = parseGithubListQuery(c);
    const r = await ghListPrs(project.path, opts);
    if (!r.ok) {
      return c.json({ ok: false, repo: slug, prs: [], error: r.error ?? "gh failed" });
    }
    if (isNaturalOpenView(opts)) {
      void refreshGithubCounts(project).catch(() => {});
    }
    return c.json({ ok: true, repo: slug, prs: r.data ?? [], query: opts });
  });

  /**
   * Per-issue / per-PR detail. Returns the full conversation (body +
   * comments + reviews + commits for PRs) so the web detail panel can
   * render everything that happened on the item without leaving the
   * tab. The spawn endpoint reuses the same fetch for prompt context.
   */
  api.get("/projects/:idOrSlug/github/issues/:number", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const num = Number(c.req.param("number"));
    if (!Number.isFinite(num) || num < 1) return c.json({ error: "bad number" }, 400);
    const slug = await resolveProjectGithubRepo(project);
    if (!slug) return c.json({ ok: false, error: "no GitHub remote" }, 400);
    const r = await ghViewIssue(project.path, num);
    if (!r.ok || !r.data) {
      return c.json({ ok: false, error: r.error ?? "gh issue view failed" }, 400);
    }
    return c.json({ ok: true, repo: slug, issue: r.data });
  });

  api.get("/projects/:idOrSlug/github/prs/:number", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const num = Number(c.req.param("number"));
    if (!Number.isFinite(num) || num < 1) return c.json({ error: "bad number" }, 400);
    const slug = await resolveProjectGithubRepo(project);
    if (!slug) return c.json({ ok: false, error: "no GitHub remote" }, 400);
    const r = await ghViewPr(project.path, num);
    if (!r.ok || !r.data) {
      return c.json({ ok: false, error: r.error ?? "gh pr view failed" }, 400);
    }
    return c.json({ ok: true, repo: slug, pr: r.data });
  });

  /**
   * Manual refresh — kicks the WS bus so every connected client
   * re-fetches without polling. The lists themselves come from the
   * GET endpoints above; this is just the broadcast.
   */
  api.post("/projects/:idOrSlug/github/refresh", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    await refreshGithubCounts(project).catch(() => {});
    void refreshProjectTaskGithubMeta(project).catch(() => {});
    pubGithubRefreshed(project.id);
    return c.json({ ok: true });
  });

  /**
   * Spawn a task from a GitHub issue or PR. Prompt is assembled from
   * the configured preset + the issue/PR body; for PR tasks the
   * worktree is checked out onto the PR's branch via `gh pr checkout`
   * (handled in TaskManager.create when `githubPr` is set).
   */
  api.post("/projects/:idOrSlug/github/spawn", async (c) => {
    const key = c.req.param("idOrSlug");
    const project =
      getProjectById(db, key) ?? getProjectBySlug(db, key);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = GithubSpawnRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const slug = await resolveProjectGithubRepo(project);
    if (!slug) return c.json({ error: "project has no GitHub remote" }, 400);

    const cfg = loadConfig(paths.root);
    const presets = cfg.presets.github;

    // Pull the full conversation so the agent's prompt includes every
    // comment + review (PR) the operator could have read on github.com
    // before kicking off the task. We render it into a structured
    // markdown blob and substitute it as `{body}` in the preset
    // template (the existing template uses `{body}` for "context to
    // hand the agent"; replacing the bare body with the conversation
    // is a strict superset of what was there before).
    let prompt = parsed.data.prompt?.trim() ?? "";
    let title = parsed.data.title?.trim() ?? "";
    let conversation = "";
    const spawnMeta: {
      githubPrState?: string | null;
      githubPrIsDraft?: boolean | null;
      githubIssueState?: string | null;
    } = {};
    if (parsed.data.kind === "issue") {
      const r = await ghViewIssue(project.path, parsed.data.number);
      if (!r.ok || !r.data) {
        return c.json(
          { error: r.error ?? `gh issue view #${parsed.data.number} failed` },
          400,
        );
      }
      const issue = r.data;
      conversation = formatIssueConversation(issue);
      spawnMeta.githubIssueState = issue.state || "OPEN";
      if (!title) title = `#${issue.number} ${issue.title}`.slice(0, 100);
      if (parsed.data.preset === "fix-issue" || (!prompt && parsed.data.preset !== "freeform")) {
        prompt = renderConfigTemplate(presets.fixIssue, {
          number: String(issue.number),
          title: issue.title,
          body: conversation,
          url: issue.url,
          branch: "",
        });
      } else if (parsed.data.preset === "freeform" && prompt) {
        // Freeform with operator-supplied prompt: append the full
        // conversation as context so the agent still sees what
        // happened on the issue without the operator pasting it.
        prompt = `${prompt}\n\n---\n\n${conversation}`;
      }
      if (!prompt) prompt = conversation;
    } else {
      const r = await ghViewPr(project.path, parsed.data.number);
      if (!r.ok || !r.data) {
        return c.json(
          { error: r.error ?? `gh pr view #${parsed.data.number} failed` },
          400,
        );
      }
      const pr = r.data;
      conversation = formatPrConversation(pr);
      spawnMeta.githubPrState = pr.state || "OPEN";
      spawnMeta.githubPrIsDraft = pr.isDraft === true;
      if (!title) title = `PR #${pr.number} ${pr.title}`.slice(0, 100);
      if (parsed.data.preset === "review-pr" || (!prompt && parsed.data.preset !== "freeform")) {
        prompt = renderConfigTemplate(presets.reviewPr, {
          number: String(pr.number),
          title: pr.title,
          body: conversation,
          url: pr.url,
          branch: pr.headRefName,
        });
      } else if (parsed.data.preset === "freeform" && prompt) {
        prompt = `${prompt}\n\n---\n\n${conversation}`;
      }
      if (!prompt) prompt = conversation;
    }

    try {
      const task = await tasks.create({
        agent: parsed.data.agent ?? "claude",
        repoPath: project.path,
        prompt,
        title,
        ...(parsed.data.permissionMode
          ? { permissionMode: parsed.data.permissionMode }
          : {}),
        ...(parsed.data.thinkingLevel
          ? { thinkingLevel: parsed.data.thinkingLevel }
          : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(parsed.data.kind === "issue"
          ? { githubIssue: parsed.data.number }
          : { githubPr: parsed.data.number }),
        // PR tasks: skip the AI branch helper — the worktree gets
        // switched onto the PR branch by `gh pr checkout`. Pass a
        // placeholder branch name here; taskManager will overwrite it
        // with the actual PR head once the checkout lands.
        ...(parsed.data.kind === "pr"
          ? { branchName: `gh-pr-${parsed.data.number}` }
          : {}),
      });
      // Stamp the live PR/issue state from the gh view we already
      // performed above so the lifecycle icon shows up immediately,
      // without a second `gh` round-trip.
      setTaskGithubMeta(db, task.id, spawnMeta);
      pubTaskChanged(task.id);
      void refreshGithubCounts(project).catch(() => {});
      pubGithubRefreshed(project.id);
      return c.json({ task });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * PR action bar — comment / review / merge. Reads `task.githubPr`
   * (set at spawn time) so the operator can act on the PR from the
   * task detail view without leaving agentd. `cwd` is the project
   * path so `gh` resolves the right repo.
   */
  function loadPrTask(c: import("hono").Context): {
    task: Task;
    project: { id: string; path: string };
    number: number;
  } | { error: string; status: 400 | 404 } {
    const id = c.req.param("id") ?? "";
    const task = tasks.get(id);
    if (!task) return { error: "task not found", status: 404 };
    if (!task.githubPr) return { error: "task is not a PR task", status: 400 };
    if (!task.projectId) return { error: "task has no project", status: 400 };
    const project = getProjectById(db, task.projectId);
    if (!project) return { error: "project missing", status: 404 };
    return { task, project, number: task.githubPr };
  }

  api.post("/tasks/:id/github/comment", async (c) => {
    const ctx = loadPrTask(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
    const body = await c.req.json().catch(() => null);
    const parsed = GithubPrActionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const commentBody = parsed.data.body?.trim();
    if (!commentBody) {
      return c.json({ error: "body is required" }, 400);
    }
    const r = await ghPrComment(ctx.project.path, ctx.number, commentBody);
    if (!r.ok) return c.json({ error: r.error ?? "gh pr comment failed" }, 400);
    void refreshGithubCounts(ctx.project).catch(() => {});
    void refreshTaskGithubMeta(ctx.task.id, ctx.project.path).catch(() => {});
    pubGithubRefreshed(ctx.project.id);
    return c.json({ ok: true });
  });

  api.post("/tasks/:id/github/review", async (c) => {
    const ctx = loadPrTask(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
    const body = await c.req.json().catch(() => null);
    const parsed = GithubPrActionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const event = parsed.data.event ?? "COMMENT";
    const r = await ghPrReview(
      ctx.project.path,
      ctx.number,
      event,
      parsed.data.body,
    );
    if (!r.ok) return c.json({ error: r.error ?? "gh pr review failed" }, 400);
    void refreshGithubCounts(ctx.project).catch(() => {});
    void refreshTaskGithubMeta(ctx.task.id, ctx.project.path).catch(() => {});
    pubGithubRefreshed(ctx.project.id);
    return c.json({ ok: true });
  });

  api.post("/tasks/:id/github/merge", async (c) => {
    const ctx = loadPrTask(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
    const body = await c.req.json().catch(() => null);
    const parsed = GithubPrActionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const method = parsed.data.method ?? "squash";
    const r = await ghPrMerge(ctx.project.path, ctx.number, method);
    if (!r.ok) return c.json({ error: r.error ?? "gh pr merge failed" }, 400);
    void refreshGithubCounts(ctx.project).catch(() => {});
    void refreshTaskGithubMeta(ctx.task.id, ctx.project.path).catch(() => {});
    pubGithubRefreshed(ctx.project.id);
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
          } else if (env.event.kind === "models_changed") {
            send({
              type: "models_changed",
              ts: env.ts,
            });
          } else if (env.event.kind === "saved_idea_changed") {
            send({
              type: "saved_idea_changed",
              ideaId: env.event.ideaId,
              projectId: env.event.projectId,
              ts: env.ts,
            });
          } else if (env.event.kind === "saved_idea_removed") {
            send({
              type: "saved_idea_removed",
              ideaId: env.event.ideaId,
              projectId: env.event.projectId,
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

  return {
    app,
    wsHandler,
    upgradeRequest,
    bearerOrHeader,
    /** Tear down file watchers when the daemon shuts down. */
    stop: () => {
      stopModelWatchers();
    },
  };
}

function resolveSafePath(root: string, requested: string): string | null {
  const joined = normalize(join(root, requested));
  const rel = relative(root, joined);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) return null;
  return joined;
}
