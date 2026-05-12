import type {
  ActiveIdeaTurn,
  Council,
  CreateCouncilRequest,
  CreateTodoRequest,
  Idea,
  IdeaMessage,
  IdeaQuestion,
  IdeaStatus,
  PlanSlice,
  SavedIdea,
  Suggestion,
  Todo,
  UpdateIdeaRequest,
  UpdateTodoRequest,
  CreateProjectRequest,
  CreateScheduleRequest,
  CreateSkillRequest,
  CreateTaskRequest,
  CreateTemplateRequest,
  CreateTriggerRequest,
  Trigger,
  UpdateTriggerRequest,
  CreateTerminalSessionRequest,
  CreateTerminalWindowRequest,
  DeviceSession,
  DiscordGuildLite,
  PairExchangeRequest,
  PairExchangeResponse,
  Project,
  ProjectBridgeSummary,
  ProviderRateLimit,
  UpdateInfo,
  BridgeDeliveryStats,
  RenameTerminalSessionRequest,
  RenameTerminalWindowRequest,
  RunTemplateRequest,
  Schedule,
  SendTerminalKeysRequest,
  GithubIssue,
  GithubListQuery,
  GithubPr,
  GithubStatus,
  GithubSpawnRequest,
  Skill,
  Task,
  TelegramBotIdentity,
  TelegramChatInfo,
  Template,
  TerminalSession,
  TerminalWindow,
  ThinkingLevel,
  Message,
  UpdateProjectRequest,
  UpdateSkillRequest,
  WsServerEvent,
  AgentKind,
} from "@agentd/contracts";

/**
 * Model registry served at `/api/models`. The daemon's config.json
 * is authoritative; this is a flat snapshot for the web/CLI to render
 * pickers against. Adding a new model = edit config.json, restart.
 */
export interface AgentdModelEntry {
  id: string;
  label: string;
  aliases: string[];
  tier?: "fast" | "balanced" | "deep" | "deepest";
  contextWindow?: number;
}

export interface AgentdModelRegistry {
  claude: AgentdModelEntry[];
  codex: AgentdModelEntry[];
}

/**
 * Server-stored "last picked" defaults for the spawn flow. Mirrors
 * `UserPrefs` from `@agentd/core/config` — kept inline so the web client
 * doesn't need to depend on the daemon package.
 */
export interface AgentdUserPrefs {
  lastAgent: "claude" | "codex";
  lastBase: string;
  lastRepo: string;
  lastProjectId: string;
  lastAutoCommit: boolean;
  lastAutoPush: boolean;
  lastPermissionMode: "bypassPermissions" | "acceptEdits" | "plan";
  lastThinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  lastModelClaude: string;
  lastModelCodex: string;
  workspaceMode: "worktree" | "in_place";
  branchMode: "new" | "existing" | "shared";
  pullLatest: boolean;
  sidebarExpandedProjects: string[];
  taskWorkspaceOpen: boolean;
  repoPickerPins: string[];
}

export interface AgentdLogEntry {
  sha: string;
  ts: number;
  author: string;
  subject: string;
}

export interface AgentdDiff {
  diff: string;
  stat: string;
  baseRef: string;
  headRef: string;
}

/**
 * One event from the helper's stream. `text` is a streaming token
 * delta; `tool_use` / `tool_result` mirror the agent's tool calls
 * during the turn (Read / Glob / Grep / Bash / etc.) so the UI can
 * render activity live instead of just a spinner.
 */
export type IdeaChatEvent =
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; preview?: string }
  | { kind: "text"; delta: string }
  /**
   * Plan content the agent decided to write — extracted out of a
   * `<plan-update>…</plan-update>` block in the streaming reply by
   * the daemon. The web app accumulates these deltas into the live
   * plan panel; the daemon also persists the final content to
   * `idea.planDraft` once the turn completes.
   */
  | { kind: "plan_delta"; delta: string }
  /**
   * Structured `<ask-user>` question the agent emitted in the live
   * stream. Surfaces render this as buttons (web), inline keyboards
   * (telegram), or message components (discord). Tapping an option
   * (or typing a free-form reply) sends the next operator turn.
   */
  | { kind: "question"; question: IdeaQuestion }
  | { kind: "raw"; text: string };

/**
 * Stream event for the project-instructions workshop chat. Same
 * shape as IdeaChatEvent except plan_delta is swapped for
 * instructions_delta — content the agent emitted inside an
 * `<instructions>…</instructions>` block, routed to the right-side
 * preview pane in the workshop modal.
 */
export type InstructionsChatEvent =
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; preview?: string }
  | { kind: "text"; delta: string }
  | { kind: "instructions_delta"; delta: string }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }
  | { kind: "raw"; text: string };

/**
 * Brainstorm streaming event. `option` arrives once per extracted
 * idea line; `tool_use` / `tool_result` mirror the agent's repo
 * exploration so the UI can render activity rows beside the options.
 */
export type IdeationEvent =
  | { kind: "option"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; preview?: string }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }
  /**
   * Structured `<ask-user>` question the brainstorm helper raised
   * instead of (or before) generating options. Surfaces render the
   * card with option buttons; the operator's pick re-fires
   * brainstorm with the disambiguated brief.
   */
  | { kind: "question"; question: IdeaQuestion };

export type PluginName = "telegram" | "discord";

export interface PluginStatus {
  name: PluginName;
  enabled: boolean;
  running: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
}

export interface TelegramPluginPatch {
  enabled?: boolean;
  botToken?: string;
  allowedUserIds?: number[];
  defaultRepo?: string | null;
}

export interface DiscordPluginPatch {
  enabled?: boolean;
  botToken?: string;
  allowedUserIds?: string[];
  defaultRepo?: string | null;
}

/**
 * Encode `GithubListQuery` as a URL query string. Repeats `?label=`
 * once per label so the daemon's `parseGithubListQuery` reconstructs
 * the array correctly.
 */
function githubListQs(opts?: GithubListQuery): string {
  if (!opts) return "";
  const sp = new URLSearchParams();
  if (opts.state) sp.set("state", opts.state);
  if (opts.search?.trim()) sp.set("q", opts.search.trim());
  if (opts.author?.trim()) sp.set("author", opts.author.trim());
  if (opts.assignee?.trim()) sp.set("assignee", opts.assignee.trim());
  if (opts.milestone?.trim()) sp.set("milestone", opts.milestone.trim());
  if (opts.base?.trim()) sp.set("base", opts.base.trim());
  if (opts.draft) sp.set("draft", "true");
  if (typeof opts.limit === "number") sp.set("limit", String(opts.limit));
  for (const l of opts.labels ?? []) {
    if (l.trim()) sp.append("label", l.trim());
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class AgentdClient {
  constructor(
    private readonly server: string,
    private readonly token: string | null,
  ) {}

  withToken(token: string): AgentdClient {
    return new AgentdClient(this.server, token);
  }

  get baseUrl(): string {
    return this.server;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      ...extra,
    };
    if (this.token) h["x-agentd-session"] = this.token;
    return h;
  }

  private async req<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const r = await fetch(this.server + path, {
      ...init,
      headers: { ...this.headers(), ...((init.headers as Record<string, string>) ?? {}) },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`${init.method ?? "GET"} ${path} → ${r.status}: ${text}`);
    }
    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await r.json()) as T;
    return (await r.text()) as unknown as T;
  }

  async pair(req: PairExchangeRequest): Promise<PairExchangeResponse> {
    return this.req("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
  }

  async health(): Promise<{ ok: boolean; version: string; time: number }> {
    return this.req("/health");
  }

  // ── todos ──
  async listTodos(opts: {
    projectId?: string;
    taskId?: string;
  }): Promise<{ todos: Todo[] }> {
    const qs: string[] = [];
    if (opts.projectId !== undefined)
      qs.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    if (opts.taskId !== undefined)
      qs.push(`taskId=${encodeURIComponent(opts.taskId)}`);
    return this.req(`/api/todos${qs.length ? "?" + qs.join("&") : ""}`);
  }
  async createTodo(req: CreateTodoRequest): Promise<{ todo: Todo }> {
    return this.req("/api/todos", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }
  async updateTodo(
    id: string,
    req: UpdateTodoRequest,
  ): Promise<{ todo: Todo }> {
    return this.req(`/api/todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(req),
    });
  }
  async deleteTodo(id: string): Promise<{ ok: true }> {
    return this.req(`/api/todos/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ── model registry ──
  async getModels(): Promise<{
    models: AgentdModelRegistry;
    defaults?: { claude?: string; codex?: string };
    /**
     * Operator's preferred thinking level per agent, set in
     * `cfg.defaultThinking`. Spawn UIs read this so the picker opens
     * pre-filled with the operator's preference instead of "auto".
     */
    defaultThinking?: { claude: ThinkingLevel; codex: ThinkingLevel };
    /**
     * Where each agent's model list was sourced from, so the UI can
     * surface "list pulled from codex 3 min ago" with a refresh
     * affordance. `fetchedAt` is the ISO date the cache file was
     * written, parsed to ms-since-epoch (or null when unavailable).
     */
    sources?: {
      codex?: {
        available: boolean;
        fetchedAt: number | null;
        path: string;
      };
    };
  }> {
    return this.req("/api/models");
  }

  // ── rate limits ──
  /**
   * Per-provider rate-limit snapshots — populated today by claude's
   * `rate_limit_event` stream JSON. Initial fetch only; the realtime
   * bus patches the cache off `provider_rate_limit_updated` after
   * mount, no polling needed.
   */
  async listRateLimits(): Promise<{ rateLimits: ProviderRateLimit[] }> {
    return this.req("/api/rate-limits");
  }

  // ── npm update info ──
  /**
   * Latest known npm update state. Initial fetch only; the `update_info`
   * WS event patches the cache after that so the banner stays live
   * across the 24h check interval.
   */
  async getUpdateInfo(): Promise<{ info: UpdateInfo }> {
    return this.req("/api/update-info");
  }

  /**
   * Force a re-check now (skip the 24h interval). Used by the "Check
   * again" button on the settings page.
   */
  async checkUpdateInfo(): Promise<{ info: UpdateInfo }> {
    return this.req("/api/update-info/check", { method: "POST" });
  }

  // ── suggestions ──
  async listSuggestions(opts?: {
    status?: "pending" | "resolved" | "dismissed";
    projectId?: string;
    limit?: number;
  }): Promise<{ suggestions: Suggestion[] }> {
    const qs: string[] = [];
    if (opts?.status) qs.push(`status=${opts.status}`);
    if (opts?.projectId)
      qs.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    if (opts?.limit) qs.push(`limit=${opts.limit}`);
    return this.req(`/api/suggestions${qs.length ? "?" + qs.join("&") : ""}`);
  }
  /**
   * Kicks off an on-demand "brainstorm" against a project. Runs the
   * Claude ideation helper synchronously (~10–30s) and returns the
   * persisted Suggestion, or `{ ok: false, error }` if the helper
   * returned nothing useful.
   */
  async clearProjectBrainstorm(
    idOrSlug: string,
  ): Promise<{ ok: true; removed: number }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/suggestions`,
      { method: "DELETE" },
    );
  }
  async ideateForProject(
    idOrSlug: string,
    body: {
      prompt: string;
      max?: number;
      title?: string;
      agent?: "claude" | "codex";
      model?: string;
      effort?: ThinkingLevel;
    },
  ): Promise<
    | { ok: true; suggestion: Suggestion }
    | { ok: false; source: string; error: string }
  > {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/ideate`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }
  /**
   * "I have an idea, help me plan it" — synchronous wrapper around
   * the plan-mode helper. Creates a SavedIdea, drains the plan
   * stream against the project, persists the result, and returns
   * the idea + plan markdown. Used by plugins (telegram /plan,
   * discord /plan) and the project page's quick plan entry.
   */
  async planIdea(
    idOrSlug: string,
    body: { text: string; title?: string },
  ): Promise<
    | { ok: true; idea: SavedIdea; plan: string }
    | { ok: false; idea?: SavedIdea; error: string }
  > {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/plan-idea`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }
  /**
   * Streams brainstorm events as they arrive — `option` lines and
   * the agent's `tool_use` / `tool_result` activity (so the UI can
   * show what the agent's actually doing in the repo while drafting,
   * same vibe as the workshop). Resolves with the persisted
   * suggestion once the helper finishes.
   *
   * Wire shape: each event arrives as `\x1f<json>\n`, then a final
   * `\x1e<JSON>` envelope.
   */
  async streamIdeateForProject(
    idOrSlug: string,
    body: {
      prompt: string;
      max?: number;
      title?: string;
      agent?: "claude" | "codex";
      model?: string;
      effort?: ThinkingLevel;
    },
    onEvent: (event: IdeationEvent) => void,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; suggestion: Suggestion; source: string }
    | { ok: false; source: string; error: string }
  > {
    const r = await fetch(
      `${this.server}/api/projects/${encodeURIComponent(idOrSlug)}/ideate/stream`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`ideate stream failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let envelope = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      while (!sawSentinel) {
        const sIdx = buffer.indexOf("\x1e");
        const oIdx = buffer.indexOf("\x1f");
        if (sIdx >= 0 && (oIdx < 0 || sIdx < oIdx)) {
          envelope += buffer.slice(sIdx + 1);
          buffer = "";
          sawSentinel = true;
          break;
        }
        if (oIdx < 0) break;
        const eol = buffer.indexOf("\n", oIdx + 1);
        if (eol < 0) break;
        const json = buffer.slice(oIdx + 1, eol);
        buffer = buffer.slice(eol + 1);
        try {
          onEvent(JSON.parse(json));
        } catch {
          // bad event — skip
        }
      }
      if (sawSentinel) envelope += buffer.length ? buffer : "";
      if (sawSentinel) buffer = "";
    }
    try {
      return JSON.parse(envelope || "{}");
    } catch {
      return {
        ok: false,
        source: "fallback-error",
        error: envelope || "empty stream",
      };
    }
  }
  /**
   * Streaming counterpart to `runTemplate` for ideation-kind templates.
   * Same wire shape as {@link streamIdeateForProject} but bound to a
   * template instead of an ad-hoc project brief — args fill the
   * template placeholders before the brainstorm helper runs.
   */
  async streamIdeateForTemplate(
    templateId: string,
    body: {
      args?: Record<string, string>;
      max?: number;
      title?: string;
      agent?: "claude" | "codex";
      model?: string;
      effort?: ThinkingLevel;
    },
    onEvent: (event: IdeationEvent) => void,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; suggestion: Suggestion; source: string }
    | { ok: false; source: string; error: string }
  > {
    const r = await fetch(
      `${this.server}/api/templates/${encodeURIComponent(templateId)}/ideate/stream`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`ideate stream failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let envelope = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      while (!sawSentinel) {
        const sIdx = buffer.indexOf("\x1e");
        const oIdx = buffer.indexOf("\x1f");
        if (sIdx >= 0 && (oIdx < 0 || sIdx < oIdx)) {
          envelope += buffer.slice(sIdx + 1);
          buffer = "";
          sawSentinel = true;
          break;
        }
        if (oIdx < 0) break;
        const eol = buffer.indexOf("\n", oIdx + 1);
        if (eol < 0) break;
        const json = buffer.slice(oIdx + 1, eol);
        buffer = buffer.slice(eol + 1);
        try {
          onEvent(JSON.parse(json));
        } catch {
          // bad event — skip
        }
      }
      if (sawSentinel) envelope += buffer.length ? buffer : "";
      if (sawSentinel) buffer = "";
    }
    try {
      return JSON.parse(envelope || "{}");
    } catch {
      return {
        ok: false,
        source: "fallback-error",
        error: envelope || "empty stream",
      };
    }
  }
  // ── ideas (per-project library) ──
  async listSavedIdeas(
    idOrSlug: string,
    opts?: { includeSpawned?: boolean; statuses?: IdeaStatus[] },
  ): Promise<{ ideas: Idea[] }> {
    const qs: string[] = [];
    if (opts?.includeSpawned) qs.push("includeSpawned=1");
    if (opts?.statuses && opts.statuses.length > 0) {
      qs.push(`status=${opts.statuses.join(",")}`);
    }
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/saved-ideas${qs.length ? "?" + qs.join("&") : ""}`,
    );
  }
  async getIdea(
    id: string,
  ): Promise<{ idea: Idea; messages: IdeaMessage[] }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}`);
  }
  async createSavedIdea(
    idOrSlug: string,
    body: {
      text: string;
      description?: string;
      status?: IdeaStatus;
      tags?: string[];
      suggestionId?: string;
      optionIndex?: number;
      planDraft?: string;
    },
  ): Promise<{ idea: Idea }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/saved-ideas`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }
  async updateIdea(
    id: string,
    patch: UpdateIdeaRequest,
  ): Promise<{ idea: Idea }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async listIdeaMessages(
    id: string,
  ): Promise<{ messages: IdeaMessage[] }> {
    return this.req(
      `/api/saved-ideas/${encodeURIComponent(id)}/messages`,
    );
  }
  /**
   * Stream a workshop chat reply. `mode: "challenge"` flips the
   * directive so the agent self-critiques the idea. Events arrive
   * as typed `IdeaChatEvent`s — text deltas, tool_use, tool_result —
   * so the UI can render the agent's tool calls live like the task
   * timeline does.
   */
  async streamIdeaChat(
    id: string,
    body: {
      text?: string;
      mode?: "chat" | "challenge" | "plan" | "validate";
      agent?: "claude" | "codex";
      model?: string;
      effort?: ThinkingLevel;
    },
    onEvent: (event: IdeaChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        message: IdeaMessage;
        ideaStatus: IdeaStatus;
        planDraft?: string | null;
        planSlices?: PlanSlice[];
        suggestedTitle?: string;
        question?: IdeaQuestion | null;
      }
    | { ok: false; source: string; error: string }
  > {
    const r = await fetch(
      `${this.server}/api/saved-ideas/${encodeURIComponent(id)}/chat/stream`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`idea chat failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let envelope = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (!sawSentinel) {
        const sIdx = buffer.indexOf("\x1e");
        const oIdx = buffer.indexOf("\x1f");
        if (sIdx >= 0 && (oIdx < 0 || sIdx < oIdx)) {
          envelope += buffer.slice(sIdx + 1);
          buffer = "";
          sawSentinel = true;
          break;
        }
        if (oIdx < 0) break;
        const eol = buffer.indexOf("\n", oIdx + 1);
        if (eol < 0) break;
        const json = buffer.slice(oIdx + 1, eol);
        buffer = buffer.slice(eol + 1);
        try {
          onEvent(JSON.parse(json));
        } catch {
          // bad event — skip
        }
      }
      if (sawSentinel && buffer) {
        envelope += buffer;
        buffer = "";
      }
    }
    try {
      return JSON.parse(envelope || "{}");
    } catch {
      return {
        ok: false,
        source: "fallback-error",
        error: envelope || "empty stream",
      };
    }
  }
  async deleteSavedIdea(id: string): Promise<{ ok: true }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /**
   * Snapshot of an idea's currently-running turn (if any). Used on
   * IdeaWorkshop mount to seed the live streaming state when the
   * operator opens the page mid-stream — agent could be drafting a
   * plan that was kicked off from another device or a prior session.
   */
  async getActiveIdeaTurn(
    id: string,
  ): Promise<{ turn: ActiveIdeaTurn | null }> {
    return this.req(
      `/api/saved-ideas/${encodeURIComponent(id)}/active-turn`,
    );
  }

  /**
   * Cancel an in-flight idea turn. Idempotent — returns `{ ok: true }`
   * even when nothing's running for that idea.
   */
  async cancelIdeaTurn(id: string): Promise<{ ok: true }> {
    return this.req(
      `/api/saved-ideas/${encodeURIComponent(id)}/cancel-turn`,
      { method: "POST" },
    );
  }

  /**
   * "I have an idea" agentic flow. Streams the agent reading the
   * repo + drafting a critique + sketch, ending with a suggested
   * title the UI uses for the Save button. Same wire format as
   * `streamIdeaChat` — `\x1f<event>\n` per event + `\x1e<envelope>`.
   * Nothing is persisted server-side; the operator clicks Save
   * explicitly to land it as a SavedIdea.
   */
  async streamValidateIdea(
    idOrSlug: string,
    body: {
      text: string;
      history?: Array<{ role: "user" | "agent"; content: string }>;
    },
    onEvent: (event: IdeaChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; critique: string; suggestedTitle: string; source: string }
    | { ok: false; source: string; error: string }
  > {
    const r = await fetch(
      `${this.server}/api/projects/${encodeURIComponent(idOrSlug)}/validate-idea/stream`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`validate-idea failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let envelope = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (!sawSentinel) {
        const sIdx = buffer.indexOf("\x1e");
        const oIdx = buffer.indexOf("\x1f");
        if (sIdx >= 0 && (oIdx < 0 || sIdx < oIdx)) {
          envelope += buffer.slice(sIdx + 1);
          buffer = "";
          sawSentinel = true;
          break;
        }
        if (oIdx < 0) break;
        const eol = buffer.indexOf("\n", oIdx + 1);
        if (eol < 0) break;
        const json = buffer.slice(oIdx + 1, eol);
        buffer = buffer.slice(eol + 1);
        try {
          onEvent(JSON.parse(json));
        } catch {
          // bad event — skip
        }
      }
      if (sawSentinel && buffer) {
        envelope += buffer;
        buffer = "";
      }
    }
    try {
      return JSON.parse(envelope || "{}");
    } catch {
      return {
        ok: false,
        source: "fallback-error",
        error: envelope || "empty stream",
      };
    }
  }

  /**
   * Conversational editor for project instructions. Uses the same
   * `\x1f<event>\n` + `\x1e<envelope>` wire format as `streamIdeaChat`.
   * The agent has codebase access; events arrive as `InstructionsChatEvent`s
   * (text deltas, tool calls, instructions deltas) for live UI rendering;
   * the envelope carries the final reply text + revised instructions
   * if the agent emitted any inside `<instructions>…</instructions>`.
   */
  async streamInstructionsChat(
    idOrSlug: string,
    body: {
      message: string;
      currentDraft?: string;
      history?: Array<{ role: "user" | "agent"; content: string }>;
    },
    onEvent: (event: InstructionsChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        reply: string;
        source: string;
        instructions?: string;
      }
    | { ok: false; source: string; error: string }
  > {
    const r = await fetch(
      `${this.server}/api/projects/${encodeURIComponent(idOrSlug)}/instructions-chat/stream`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`instructions chat failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let envelope = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (!sawSentinel) {
        const sIdx = buffer.indexOf("\x1e");
        const oIdx = buffer.indexOf("\x1f");
        if (sIdx >= 0 && (oIdx < 0 || sIdx < oIdx)) {
          envelope += buffer.slice(sIdx + 1);
          buffer = "";
          sawSentinel = true;
          break;
        }
        if (oIdx < 0) break;
        const eol = buffer.indexOf("\n", oIdx + 1);
        if (eol < 0) break;
        const json = buffer.slice(oIdx + 1, eol);
        buffer = buffer.slice(eol + 1);
        try {
          onEvent(JSON.parse(json));
        } catch {
          // bad event — skip
        }
      }
      if (sawSentinel && buffer) {
        envelope += buffer;
        buffer = "";
      }
    }
    try {
      return JSON.parse(envelope || "{}");
    } catch {
      return {
        ok: false,
        source: "fallback-error",
        error: envelope || "empty stream",
      };
    }
  }
  async updateSavedIdeaPlan(
    id: string,
    planDraft: string | null,
  ): Promise<{ idea: SavedIdea }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}/plan`, {
      method: "PUT",
      body: JSON.stringify({ planDraft }),
    });
  }
  async updateSavedIdeaSlices(
    id: string,
    slices: PlanSlice[] | null,
  ): Promise<{ idea: SavedIdea }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}/slices`, {
      method: "PUT",
      body: JSON.stringify({ slices }),
    });
  }
  async spawnFromSavedIdea(
    id: string,
    body: {
      prompt?: string;
      agent?: "claude" | "codex";
      model?: string;
      thinkingLevel?: ThinkingLevel;
      permissionMode?: "bypassPermissions" | "acceptEdits" | "plan";
      title?: string;
    },
  ): Promise<{ idea: SavedIdea; task: Task }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}/spawn`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /**
   * Fan a saved idea's slices out into N sibling tasks. Returns the
   * created tasks in slice order; the first one starts immediately,
   * the rest stay `pending` until their parent finishes.
   */
  async spawnMultiFromSavedIdea(
    id: string,
    body: {
      slices: PlanSlice[];
      shareWorktree?: boolean;
      branchName?: string;
      baseBranch?: string;
      title?: string;
    },
  ): Promise<{ idea: SavedIdea; tasks: Task[] }> {
    return this.req(`/api/saved-ideas/${encodeURIComponent(id)}/spawn-multi`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /**
   * Fan a freeform plan (no saved idea) into N sibling tasks. Same
   * mechanics as `spawnMultiFromSavedIdea` — shared worktree by default,
   * sequential `dependsOnTaskId` chain — but takes the repo path
   * directly so the spawn sheet can phase a plan without persisting it
   * as an idea first.
   */
  async spawnTasksMulti(body: {
    repoPath: string;
    slices: PlanSlice[];
    shareWorktree?: boolean;
    branchName?: string;
    baseBranch?: string;
    title?: string;
    autoPush?: boolean;
  }): Promise<{ tasks: Task[] }> {
    return this.req(`/api/tasks/spawn-multi`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Add a sibling task to an existing one — same worktree + branch,
   * chained sequentially via dependsOnTaskId. Used by the task page's
   * "Spawn related task" action so the operator can drop another
   * agent (different model / different concern) on the same checkout.
   */
  async spawnSiblingTask(
    parentId: string,
    body: {
      agent: "claude" | "codex";
      prompt: string;
      title?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      permissionMode?: "bypassPermissions" | "acceptEdits" | "plan";
      autoCommit?: boolean;
      autoPush?: boolean;
    },
  ): Promise<{ task: Task }> {
    return this.req(`/api/tasks/${encodeURIComponent(parentId)}/spawn-sibling`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  async getSuggestion(id: string): Promise<{ suggestion: Suggestion }> {
    return this.req(`/api/suggestions/${encodeURIComponent(id)}`);
  }
  async resolveSuggestion(
    id: string,
    pick: {
      index?: number;
      text?: string;
      agent?: "claude" | "codex";
      model?: string;
      thinkingLevel?: ThinkingLevel;
      permissionMode?: "bypassPermissions" | "acceptEdits" | "plan";
      workspaceMode?: "worktree" | "in_place";
      branchMode?: "new" | "existing" | "shared";
      branchName?: string;
      pullLatest?: boolean;
      title?: string;
    },
  ): Promise<{ suggestion: Suggestion; task: Task }> {
    return this.req(`/api/suggestions/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(pick),
    });
  }
  /**
   * Stream a planning helper for a picked option. Emits raw text
   * chunks until the final separator (`\x1e`), after which a single
   * JSON envelope arrives. The callback receives chunks; the
   * promise resolves with `{ plan, source }`.
   */
  async streamSuggestionPlan(
    id: string,
    pick: {
      index?: number;
      text?: string;
      agent?: "claude" | "codex";
      model?: string;
      effort?: ThinkingLevel;
    },
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    plan: string;
    source: string;
    error?: string;
    slices?: PlanSlice[];
  }> {
    const r = await fetch(
      `${this.server}/api/suggestions/${encodeURIComponent(id)}/plan`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(pick),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`plan stream failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const sentinelIdx = chunk.indexOf("\x1e");
      if (sentinelIdx >= 0 && !sawSentinel) {
        const before = chunk.slice(0, sentinelIdx);
        if (before) onChunk(before);
        buffer = chunk.slice(sentinelIdx + 1);
        sawSentinel = true;
      } else if (sawSentinel) {
        buffer += chunk;
      } else {
        onChunk(chunk);
      }
    }
    try {
      return JSON.parse(buffer || "{}");
    } catch {
      return { plan: "", source: "fallback-error", error: buffer };
    }
  }
  async dismissSuggestion(id: string): Promise<{ suggestion: Suggestion }> {
    return this.req(`/api/suggestions/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
    });
  }
  /**
   * Re-score every option on a suggestion with the given agent + model.
   * Streams the rater's tool calls (Read / Glob / Bash) so the UI can
   * show "claude opus is reading the README…" live, then resolves
   * with the updated suggestion (new score badges) or the error.
   * Realtime bus also fires `suggestion_updated` for other surfaces.
   */
  async streamValidateSuggestion(
    id: string,
    body: {
      agent: "claude" | "codex";
      model?: string;
      effort?: ThinkingLevel;
    },
    onEvent: (event: IdeaChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; suggestion: Suggestion }
    | { ok: false; error: string }
  > {
    const r = await fetch(
      `${this.server}/api/suggestions/${encodeURIComponent(id)}/validate`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`validate failed: ${r.status} ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let envelope = "";
    let sawSentinel = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (!sawSentinel) {
        const sIdx = buffer.indexOf("\x1e");
        const oIdx = buffer.indexOf("\x1f");
        if (sIdx >= 0 && (oIdx < 0 || sIdx < oIdx)) {
          envelope += buffer.slice(sIdx + 1);
          buffer = "";
          sawSentinel = true;
          break;
        }
        if (oIdx < 0) break;
        const eol = buffer.indexOf("\n", oIdx + 1);
        if (eol < 0) break;
        const json = buffer.slice(oIdx + 1, eol);
        buffer = buffer.slice(eol + 1);
        try {
          onEvent(JSON.parse(json));
        } catch {
          // bad event — skip
        }
      }
      if (sawSentinel) envelope += buffer.length ? buffer : "";
      if (sawSentinel) buffer = "";
    }
    try {
      return JSON.parse(envelope || "{}");
    } catch {
      return { ok: false, error: envelope || "empty stream" };
    }
  }
  /**
   * Conversational reply — heuristic + AI router. The text is whatever
   * the operator typed; server returns one of:
   *   { kind: "spawned", suggestion, task, picked, agent, model, thinkingLevel }
   *   { kind: "dismissed", suggestion }
   *   { kind: "clarify", question }
   *   { kind: "noop", reason }
   */
  async replyToSuggestion(
    id: string,
    text: string,
  ): Promise<
    | {
        kind: "spawned";
        suggestion: Suggestion;
        task: Task;
        picked: string;
        agent: "claude" | "codex";
        model: string;
        thinkingLevel: ThinkingLevel;
      }
    | { kind: "dismissed"; suggestion: Suggestion }
    | { kind: "clarify"; question: string }
    | { kind: "noop"; reason: string }
  > {
    return this.req(`/api/suggestions/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  // ── councils ──
  async listCouncils(): Promise<{ councils: Council[] }> {
    return this.req("/api/councils");
  }
  async getCouncil(id: string): Promise<{ council: Council }> {
    return this.req(`/api/councils/${encodeURIComponent(id)}`);
  }
  async createCouncil(
    req: CreateCouncilRequest,
  ): Promise<{ council: Council }> {
    return this.req("/api/councils", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }
  async pickCouncilWinner(
    id: string,
    taskId: string,
    explanation?: string,
  ): Promise<{ council: Council }> {
    return this.req(`/api/councils/${encodeURIComponent(id)}/pick`, {
      method: "POST",
      body: JSON.stringify({
        taskId,
        ...(explanation ? { explanation } : {}),
      }),
    });
  }

  async listTasks(): Promise<{ tasks: Task[] }> {
    return this.req("/api/tasks");
  }

  async getTask(id: string): Promise<{ task: Task; messages: Message[] }> {
    return this.req(`/api/tasks/${id}`);
  }

  async createTask(req: CreateTaskRequest): Promise<{ task: Task }> {
    return this.req("/api/tasks", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async sendInput(id: string, text: string): Promise<void> {
    await this.req(`/api/tasks/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  /**
   * Resolve the oldest pending `agentd-ask` for this task. The agent's
   * blocked HTTP call unblocks and gets the answer on stdout. `matched`
   * is false when no ask was pending — caller can then fall back to
   * a regular `sendInput`.
   */
  async answerTask(
    id: string,
    answer: string,
  ): Promise<{ ok: true; matched: boolean }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
  }

  /**
   * Skip a pending ask without answering it. Useful when the operator
   * wants to redirect the agent without their next chat message being
   * captured as the literal answer, or when the ask is stale (agent
   * already moved on / crashed). Unblocks the agent with "(dismissed)"
   * and writes the paired `[answer · askId] (dismissed)` row.
   */
  async dismissTaskAsk(id: string, askId: string): Promise<{ ok: true }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/dismiss-ask`, {
      method: "POST",
      body: JSON.stringify({ askId }),
    });
  }

  async stopTask(id: string): Promise<void> {
    await this.req(`/api/tasks/${id}/stop`, { method: "POST" });
  }

  async closeTask(id: string, reason?: string): Promise<{ task: Task | null }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/close`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }

  async reopenTask(id: string): Promise<{ task: Task | null }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/reopen`, {
      method: "POST",
    });
  }

  async setTaskThinkingLevel(
    id: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<{ task: Task | null }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/thinking`, {
      method: "PATCH",
      body: JSON.stringify({ thinkingLevel }),
    });
  }

  /**
   * Toggle the task's auto-push / auto-PR flags mid-flight. Either
   * field is optional — pass only the one you're flipping.
   */
  async setTaskAutoFlags(
    id: string,
    patch: { autoCommit?: boolean; autoPush?: boolean },
  ): Promise<{ task: Task | null }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/auto-flags`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * Queue a message while the agent is mid-turn, or interrupt-and-fire it
   * immediately. Idle tasks behave like `sendTaskInput`.
   */
  async steerTask(
    id: string,
    text: string,
    mode: "queue" | "interrupt" = "queue",
  ): Promise<{ ok: true; mode: string; queued: number }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/steer`, {
      method: "POST",
      body: JSON.stringify({ text, mode }),
    });
  }

  async getTaskSteerState(
    id: string,
  ): Promise<{ running: boolean; queue: string[] }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/steer`);
  }

  /**
   * Persist an explicit task ordering for the sidebar drag-drop.
   * Each id in `taskIds` receives an incrementing sortOrder (0, 1,
   * 2, ...). Tasks not in the array keep their existing value.
   */
  async reorderTasks(taskIds: string[]): Promise<{ ok: true; count: number }> {
    return this.req(`/api/tasks/reorder`, {
      method: "POST",
      body: JSON.stringify({ taskIds }),
    });
  }

  /** Drop a queued steer line by index before the next turn drains it. */
  async removeQueuedSteer(
    id: string,
    index: number,
  ): Promise<{ queue: string[] }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/steer/remove`, {
      method: "POST",
      body: JSON.stringify({ index }),
    });
  }

  /**
   * Fire a queued steer line — sends it to the agent now (stdin for
   * claude long-lived, SIGINT-respawn for codex). The item is also
   * persisted as a regular user message so it appears in the chat.
   */
  async fireQueuedSteer(
    id: string,
    index: number,
  ): Promise<{ queue: string[] }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/steer/fire`, {
      method: "POST",
      body: JSON.stringify({ index }),
    });
  }

  async checkPrState(
    id: string,
    autoClose = false,
  ): Promise<{
    prUrl: string | null;
    merged?: boolean;
    state?: string | null;
    mergedAt?: string | null;
    autoClosed?: boolean;
    task?: Task | null;
  }> {
    const qs = autoClose ? "?autoClose=1" : "";
    return this.req(`/api/tasks/${encodeURIComponent(id)}/pr-state${qs}`);
  }

  async removeTask(id: string): Promise<void> {
    await this.req(`/api/tasks/${id}`, { method: "DELETE" });
  }

  async listFiles(
    id: string,
  ): Promise<{ files: string[]; worktreePath: string }> {
    return this.req(`/api/tasks/${id}/files`);
  }

  async gitStatus(
    id: string,
  ): Promise<{
    worktreePath: string;
    base: string;
    entries: {
      path: string;
      status:
        | "added"
        | "modified"
        | "deleted"
        | "renamed"
        | "untracked"
        | "ignored";
      additions: number;
      deletions: number;
      changed: boolean;
    }[];
  }> {
    return this.req(`/api/tasks/${id}/git-status`);
  }

  async commitTask(
    id: string,
    message?: string,
  ): Promise<{ committed: boolean; sha?: string; message?: string }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/commit`, {
      method: "POST",
      body: JSON.stringify(message ? { message } : {}),
    });
  }

  async generateCommitMessage(
    id: string,
    opts: {
      includeBody?: boolean;
      includeScope?: boolean;
      wip?: boolean;
      hint?: string;
    } = {},
  ): Promise<{ message: string; source: string; error?: string }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/commit-message`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  /**
   * Streamed commit-message generation. Calls `onChunk(text)` as Claude
   * prints each chunk; resolves with the cleaned final message + source.
   * The response stream ends with a sentinel " " + JSON metadata that the
   * caller's last chunk will not include.
   */
  async streamCommitMessage(
    id: string,
    opts: {
      includeBody?: boolean;
      includeScope?: boolean;
      wip?: boolean;
      hint?: string;
    } = {},
    onChunk?: (chunk: string) => void,
    abort?: AbortSignal,
  ): Promise<{ message: string; source: string; error?: string }> {
    const url =
      this.server +
      `/api/tasks/${encodeURIComponent(id)}/commit-message/stream`;
    const r = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
      ...(abort ? { signal: abort } : {}),
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`stream commit-message ${r.status}: ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk;
      // U+001E separates the streamed message body from the trailing JSON
      // metadata. The control byte never appears in Claude's normal text
      // output, so the boundary is unambiguous and we never leak the JSON
      // envelope into the streamed body.
      const sentinel = buf.indexOf("\x1e");
      if (sentinel >= 0) {
        const visible = chunk.slice(
          0,
          chunk.length - (buf.length - sentinel),
        );
        if (visible.length > 0) onChunk?.(visible);
        // Drain remaining bytes into buf for parsing below, but stop
        // forwarding to onChunk.
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buf += decoder.decode(next.value, { stream: true });
        }
        break;
      }
      onChunk?.(chunk);
    }
    // Parse trailing metadata.
    const sentinelAt = buf.indexOf("\x1e");
    if (sentinelAt < 0) {
      // No sentinel arrived (e.g. claude died silently). Treat what we
      // got as the message.
      return { message: buf.trim(), source: "claude" };
    }
    const tail = buf.slice(sentinelAt + 1).trim();
    try {
      const meta = JSON.parse(tail) as {
        source: string;
        message?: string;
        error?: string;
      };
      return {
        message: meta.message ?? buf.slice(0, sentinelAt).trim(),
        source: meta.source,
        ...(meta.error ? { error: meta.error } : {}),
      };
    } catch {
      return { message: buf.slice(0, sentinelAt).trim(), source: "claude" };
    }
  }

  async pushTask(
    id: string,
  ): Promise<{ pushed: boolean; remote: string; branch: string; output: string }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/push`, {
      method: "POST",
    });
  }

  /** Branch sync state vs origin — used to grey out a "Push" button. */
  async getPushState(
    id: string,
  ): Promise<{ ahead: number; behind: number; hasUpstream: boolean }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/push-state`);
  }

  async openPrForTask(
    id: string,
    req: { title: string; body?: string; draft?: boolean },
  ): Promise<{ url: string; output: string }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/pr`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async getFile(id: string, path: string): Promise<{ path: string; size: number; content: string }> {
    return this.req(`/api/tasks/${id}/file?path=${encodeURIComponent(path)}`);
  }

  async getDiff(id: string, base?: string): Promise<AgentdDiff> {
    const q = base ? `?base=${encodeURIComponent(base)}` : "";
    return this.req(`/api/tasks/${id}/diff${q}`);
  }

  async getLog(id: string, limit = 50): Promise<{ log: AgentdLogEntry[] }> {
    return this.req(`/api/tasks/${id}/log?limit=${limit}`);
  }

  async revert(id: string, sha: string): Promise<void> {
    await this.req(`/api/tasks/${id}/revert`, {
      method: "POST",
      body: JSON.stringify({ sha }),
    });
  }

  async pluginStatus(): Promise<{ plugins: PluginStatus[]; config: Record<string, unknown> }> {
    return this.req("/api/admin/plugins");
  }

  async patchPlugin(
    name: "telegram",
    patch: TelegramPluginPatch,
  ): Promise<{ ok: boolean; plugin: unknown; status: PluginStatus[] }>;
  async patchPlugin(
    name: "discord",
    patch: DiscordPluginPatch,
  ): Promise<{ ok: boolean; plugin: unknown; status: PluginStatus[] }>;
  async patchPlugin(
    name: PluginName,
    patch: TelegramPluginPatch | DiscordPluginPatch,
  ): Promise<{ ok: boolean; plugin: unknown; status: PluginStatus[] }> {
    return this.req(`/api/admin/plugins/${name}`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  // ── templates ──
  async listTemplates(): Promise<{ templates: Template[] }> {
    return this.req("/api/templates");
  }
  async createTemplate(req: CreateTemplateRequest): Promise<{ template: Template }> {
    return this.req("/api/templates", { method: "POST", body: JSON.stringify(req) });
  }
  async getTemplate(idOrName: string): Promise<{ template: Template }> {
    return this.req(`/api/templates/${encodeURIComponent(idOrName)}`);
  }
  async deleteTemplate(idOrName: string): Promise<void> {
    await this.req(`/api/templates/${encodeURIComponent(idOrName)}`, { method: "DELETE" });
  }
  /**
   * Run a template. `kind: "task"` templates return `{ task }`;
   * `kind: "ideation"` templates run the brainstorm helper synchronously
   * and return `{ suggestion }`. Web prefers
   * {@link streamIdeateForTemplate} for ideation so the operator sees
   * options stream in live, but this blocking path stays available for
   * plugins / curl / scheduled "run now" use.
   */
  async runTemplate(
    idOrName: string,
    req: RunTemplateRequest = { args: {} },
  ): Promise<{ task: Task } | { suggestion: Suggestion }> {
    return this.req(`/api/templates/${encodeURIComponent(idOrName)}/run`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  // ── schedules ──
  async listSchedules(): Promise<{ schedules: Schedule[] }> {
    return this.req("/api/schedules");
  }
  async createSchedule(req: CreateScheduleRequest): Promise<{ schedule: Schedule }> {
    return this.req("/api/schedules", { method: "POST", body: JSON.stringify(req) });
  }
  async enableSchedule(id: string): Promise<{ schedule: Schedule }> {
    return this.req(`/api/schedules/${encodeURIComponent(id)}/enable`, { method: "POST" });
  }
  async disableSchedule(id: string): Promise<{ schedule: Schedule }> {
    return this.req(`/api/schedules/${encodeURIComponent(id)}/disable`, { method: "POST" });
  }
  async deleteSchedule(id: string): Promise<void> {
    await this.req(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ── triggers ──
  async listTriggers(): Promise<{ triggers: Trigger[] }> {
    return this.req("/api/triggers");
  }
  async createTrigger(req: CreateTriggerRequest): Promise<{ trigger: Trigger }> {
    return this.req("/api/triggers", { method: "POST", body: JSON.stringify(req) });
  }
  async getTrigger(id: string): Promise<{ trigger: Trigger }> {
    return this.req(`/api/triggers/${encodeURIComponent(id)}`);
  }
  async updateTrigger(
    id: string,
    patch: UpdateTriggerRequest,
  ): Promise<{ trigger: Trigger }> {
    return this.req(`/api/triggers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async enableTrigger(id: string): Promise<{ trigger: Trigger }> {
    return this.req(`/api/triggers/${encodeURIComponent(id)}/enable`, {
      method: "POST",
    });
  }
  async disableTrigger(id: string): Promise<{ trigger: Trigger }> {
    return this.req(`/api/triggers/${encodeURIComponent(id)}/disable`, {
      method: "POST",
    });
  }
  async deleteTrigger(id: string): Promise<void> {
    await this.req(`/api/triggers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  async testTrigger(
    id: string,
  ): Promise<{ trigger: Trigger; taskId: string }> {
    return this.req(`/api/triggers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
  }

  // ── settings ──
  async getSettings(): Promise<{
    agentInstructions: string;
    commitInstructions: string;
    prInstructions: string;
    maxContextTokens: number;
    aiHelpers: {
      binary: string;
      model: string;
      effort: ThinkingLevel;
    };
    defaultThinking: { claude: ThinkingLevel; codex: ThinkingLevel };
    defaultModel: { claude: string; codex: string };
  }> {
    return this.req("/api/admin/settings");
  }

  async patchSettings(
    patch: Partial<{
      agentInstructions: string;
      commitInstructions: string;
      prInstructions: string;
      maxContextTokens: number;
      aiHelpers: { binary: string; model: string; effort: ThinkingLevel };
      defaultThinking: Partial<{
        claude: ThinkingLevel;
        codex: ThinkingLevel;
      }>;
      defaultModel: Partial<{ claude: string; codex: string }>;
    }>,
  ): Promise<{ ok: boolean; settings: Record<string, unknown> }> {
    return this.req("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  // ── user prefs (spawn-flow defaults, server-stored, cross-device) ──
  async getPrefs(): Promise<{ prefs: AgentdUserPrefs }> {
    return this.req("/api/prefs");
  }

  async patchPrefs(
    patch: Partial<AgentdUserPrefs>,
  ): Promise<{ ok: boolean; prefs: AgentdUserPrefs }> {
    return this.req("/api/prefs", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Per-task model override. Empty string clears it. */
  async setTaskModel(
    id: string,
    model: string,
  ): Promise<{ task: Task | null }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/model`, {
      method: "PATCH",
      body: JSON.stringify({ model }),
    });
  }

  /**
   * Set / clear the chat mirror target for a task. Passing null
   * unmirrors. Triggers immediately — no runner restart.
   */
  async setTaskMirror(
    id: string,
    mirrorTo: { platform: "telegram" | "discord"; chatId: string } | null,
  ): Promise<{ task: Task | null }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/mirror`, {
      method: "PATCH",
      body: JSON.stringify({ mirrorTo }),
    });
  }

  /** Suggest a conventional `<prefix>/<slug>` branch name from the task prompt. */
  async suggestBranchName(
    prompt: string,
    opts: {
      agent?: AgentKind;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    } = {},
  ): Promise<{
    prefix: "feature" | "fix" | "refactor" | "chore";
    slug: string;
    source: string;
    error?: string;
  }> {
    return this.req("/api/branch-name", {
      method: "POST",
      body: JSON.stringify({ prompt, ...opts }),
    });
  }

  /**
   * Streamed PR title + body generator. Same wire format as
   * `streamCommitMessage`: chunks → U+001E sentinel → JSON metadata.
   */
  async streamPrMessage(
    id: string,
    opts: { hint?: string; includeBullets?: boolean } = {},
    onChunk?: (chunk: string) => void,
    abort?: AbortSignal,
  ): Promise<{
    title: string;
    body: string;
    source: string;
    error?: string;
  }> {
    const url =
      this.server +
      `/api/tasks/${encodeURIComponent(id)}/pr-message/stream`;
    const r = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
      ...(abort ? { signal: abort } : {}),
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`stream pr-message ${r.status}: ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk;
      const sentinel = buf.indexOf("\x1e");
      if (sentinel >= 0) {
        const visible = chunk.slice(
          0,
          chunk.length - (buf.length - sentinel),
        );
        if (visible.length > 0) onChunk?.(visible);
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buf += decoder.decode(next.value, { stream: true });
        }
        break;
      }
      onChunk?.(chunk);
    }
    const sentinelAt = buf.indexOf("\x1e");
    if (sentinelAt < 0) {
      // No sentinel; treat the whole buffer as title+body split on first
      // blank line.
      const cleaned = buf.trim();
      const idx = cleaned.indexOf("\n\n");
      return idx < 0
        ? { title: cleaned, body: "", source: "claude" }
        : {
            title: cleaned.slice(0, idx).trim(),
            body: cleaned.slice(idx + 2).trim(),
            source: "claude",
          };
    }
    const tail = buf.slice(sentinelAt + 1).trim();
    try {
      const meta = JSON.parse(tail) as {
        source: string;
        title?: string;
        body?: string;
        error?: string;
      };
      return {
        title: meta.title ?? "",
        body: meta.body ?? "",
        source: meta.source,
        ...(meta.error ? { error: meta.error } : {}),
      };
    } catch {
      const cleaned = buf.slice(0, sentinelAt).trim();
      const idx = cleaned.indexOf("\n\n");
      return idx < 0
        ? { title: cleaned, body: "", source: "claude" }
        : {
            title: cleaned.slice(0, idx).trim(),
            body: cleaned.slice(idx + 2).trim(),
            source: "claude",
          };
    }
  }

  /**
   * Stream an AI-drafted set of project instructions. The text comes
   * across as raw chunks (call `onChunk` for live preview), then a
   * `\x1e`-prefixed JSON envelope closes with the cleaned final text.
   */
  async streamProjectInstructionsDraft(
    idOrSlug: string,
    opts: { description: string; existing?: string },
    onChunk?: (chunk: string) => void,
    abort?: AbortSignal,
  ): Promise<{ text: string; source: string; error?: string }> {
    const url =
      this.server +
      `/api/projects/${encodeURIComponent(idOrSlug)}/draft-instructions/stream`;
    const r = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
      ...(abort ? { signal: abort } : {}),
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`stream draft-instructions ${r.status}: ${text}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk;
      const sentinel = buf.indexOf("\x1e");
      if (sentinel >= 0) {
        const visible = chunk.slice(
          0,
          chunk.length - (buf.length - sentinel),
        );
        if (visible.length > 0) onChunk?.(visible);
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buf += decoder.decode(next.value, { stream: true });
        }
        break;
      }
      onChunk?.(chunk);
    }
    const sentinelAt = buf.indexOf("\x1e");
    if (sentinelAt < 0) {
      return { text: buf.trim(), source: "claude" };
    }
    const tail = buf.slice(sentinelAt + 1).trim();
    try {
      const meta = JSON.parse(tail) as {
        text?: string;
        source: string;
        error?: string;
      };
      return {
        text: meta.text ?? buf.slice(0, sentinelAt).trim(),
        source: meta.source,
        ...(meta.error ? { error: meta.error } : {}),
      };
    } catch {
      return { text: buf.slice(0, sentinelAt).trim(), source: "claude" };
    }
  }

  // ── pairing tokens ──
  async issuePairToken(): Promise<{ token: string; expiresAt: number }> {
    return this.req("/api/admin/pair", { method: "POST" });
  }

  // ── device sessions ──
  async listDeviceSessions(): Promise<{ sessions: DeviceSession[] }> {
    return this.req("/api/admin/sessions");
  }

  async revokeDeviceSession(id: string): Promise<{ ok: true }> {
    return this.req(`/api/admin/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** Force-restart a plugin process. Resets its restart-history backoff. */
  async restartPlugin(
    name: PluginName,
  ): Promise<{ ok: boolean; reason: string | null; status: PluginStatus[] }> {
    return this.req(`/api/admin/plugins/${encodeURIComponent(name)}/restart`, {
      method: "POST",
    });
  }

  // ── chat bridges (Connect-chat wizard + plugins page) ──
  async validateTelegramToken(
    token: string,
  ): Promise<{ ok: true; bot: TelegramBotIdentity } | { ok: false; error: string }> {
    return this.req("/api/plugins/telegram/validate", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }
  async getTelegramChat(
    token: string,
    chatId: string,
  ): Promise<{ ok: true; chat: TelegramChatInfo } | { ok: false; error: string }> {
    return this.req("/api/plugins/telegram/get-chat", {
      method: "POST",
      body: JSON.stringify({ token, chatId }),
    });
  }
  async telegramTestSend(
    token: string,
    chatId: string,
    text?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.req("/api/plugins/telegram/test-send", {
      method: "POST",
      body: JSON.stringify({ token, chatId, text }),
    });
  }
  async listDiscordChannels(): Promise<{
    guilds: DiscordGuildLite[];
    updatedAt: number;
  }> {
    return this.req("/api/plugins/discord/channels");
  }
  async reportDiscordChannels(
    guilds: DiscordGuildLite[],
  ): Promise<{ ok: true }> {
    return this.req("/api/plugins/discord/channels", {
      method: "POST",
      body: JSON.stringify({ guilds }),
    });
  }
  async discordTestSend(
    channelId: string,
    text?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.req("/api/plugins/discord/test-send", {
      method: "POST",
      body: JSON.stringify({ channelId, text }),
    });
  }
  async reportDiscordCommandResult(
    requestId: string,
    ok: boolean,
    error?: string,
    threadId?: string,
  ): Promise<{ ok: true }> {
    return this.req("/api/plugins/discord/command-result", {
      method: "POST",
      body: JSON.stringify({ requestId, ok, error, threadId }),
    });
  }
  async reportDelivery(
    projectId: string | null,
    platform: "telegram" | "discord",
  ): Promise<{ ok: true }> {
    return this.req("/api/plugins/delivery", {
      method: "POST",
      body: JSON.stringify({ projectId, platform }),
    });
  }
  async getBridgeSummary(): Promise<{
    projects: ProjectBridgeSummary[];
    totals: { telegram: BridgeDeliveryStats; discord: BridgeDeliveryStats };
    discordChannelsKnown: boolean;
  }> {
    return this.req("/api/plugins/bridge-summary");
  }

  // ── projects ──
  async listProjects(): Promise<{ projects: Project[] }> {
    return this.req("/api/projects");
  }

  async getProject(idOrSlug: string): Promise<{ project: Project }> {
    return this.req(`/api/projects/${encodeURIComponent(idOrSlug)}`);
  }

  async createProject(req: CreateProjectRequest): Promise<{ project: Project }> {
    return this.req("/api/projects", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async updateProject(
    idOrSlug: string,
    patch: UpdateProjectRequest,
  ): Promise<{ project: Project }> {
    return this.req(`/api/projects/${encodeURIComponent(idOrSlug)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async deleteProject(idOrSlug: string): Promise<{ ok: true }> {
    return this.req(`/api/projects/${encodeURIComponent(idOrSlug)}`, {
      method: "DELETE",
    });
  }

  async listProjectBranches(
    idOrSlug: string,
  ): Promise<{
    current: string | null;
    local: string[];
    remote: { remote: string; ref: string }[];
    /**
     * The repo's default branch (`main`, `master`, `trunk`, …). The
     * spawn forms use this as the initial value of the "base" field
     * so a fresh task on a master-default repo doesn't try to base
     * off a non-existent `main`.
     */
    default: string;
  }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/branches`,
    );
  }

  async getProjectGitState(
    idOrSlug: string,
    opts: { fetch?: boolean } = {},
  ): Promise<{
    branch: string;
    ahead: number;
    behind: number;
    hasUpstream: boolean;
    dirty: number;
    fetched?: boolean;
    fetchError?: string;
  }> {
    const qs = opts.fetch ? "?fetch=1" : "";
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/git-state${qs}`,
    );
  }

  async pullProject(idOrSlug: string): Promise<{
    ok: boolean;
    branch: string;
    ahead?: number;
    behind?: number;
    hasUpstream?: boolean;
    message?: string;
    error?: string;
  }> {
    return this.req(`/api/projects/${encodeURIComponent(idOrSlug)}/pull`, {
      method: "POST",
    });
  }

  // ── GitHub ──
  async getGithubStatus(): Promise<GithubStatus> {
    return this.req("/api/github/status");
  }

  async getProjectGithubRepo(
    idOrSlug: string,
  ): Promise<{ repo: string | null }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/repo`,
    );
  }

  async listGithubIssues(
    idOrSlug: string,
    opts?: GithubListQuery,
  ): Promise<{
    ok: boolean;
    repo: string | null;
    issues: GithubIssue[];
    error?: string;
  }> {
    const qs = githubListQs(opts);
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/issues${qs}`,
    );
  }

  async listGithubPrs(
    idOrSlug: string,
    opts?: GithubListQuery,
  ): Promise<{
    ok: boolean;
    repo: string | null;
    prs: GithubPr[];
    error?: string;
  }> {
    const qs = githubListQs(opts);
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/prs${qs}`,
    );
  }

  async viewGithubIssue(
    idOrSlug: string,
    number: number,
  ): Promise<{
    ok: boolean;
    repo?: string | null;
    issue?: GithubIssue;
    error?: string;
  }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/issues/${number}`,
    );
  }

  async viewGithubPr(
    idOrSlug: string,
    number: number,
  ): Promise<{
    ok: boolean;
    repo?: string | null;
    pr?: GithubPr;
    error?: string;
  }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/prs/${number}`,
    );
  }

  async refreshGithub(idOrSlug: string): Promise<{ ok: true }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/refresh`,
      { method: "POST" },
    );
  }

  async spawnGithubTask(
    idOrSlug: string,
    req: GithubSpawnRequest,
  ): Promise<{ task: Task }> {
    return this.req(
      `/api/projects/${encodeURIComponent(idOrSlug)}/github/spawn`,
      { method: "POST", body: JSON.stringify(req) },
    );
  }

  async prComment(
    taskId: string,
    body: string,
  ): Promise<{ ok: true }> {
    return this.req(
      `/api/tasks/${encodeURIComponent(taskId)}/github/comment`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }

  async prReview(
    taskId: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string,
  ): Promise<{ ok: true }> {
    return this.req(
      `/api/tasks/${encodeURIComponent(taskId)}/github/review`,
      {
        method: "POST",
        body: JSON.stringify({ event, ...(body ? { body } : {}) }),
      },
    );
  }

  async prMerge(
    taskId: string,
    method: "merge" | "squash" | "rebase" = "squash",
  ): Promise<{ ok: true }> {
    return this.req(
      `/api/tasks/${encodeURIComponent(taskId)}/github/merge`,
      { method: "POST", body: JSON.stringify({ method }) },
    );
  }

  async getTaskContext(id: string): Promise<{
    agentInstructions: string;
    projectInstructions: string;
    skills: { id: string; displayName: string; body: string }[];
    repoCanonical: { path: string; content: string } | null;
    suffix: {
      budget: number;
      used: number;
      kept: string[];
      trimmed: string[];
    };
    catalogs: {
      skills: {
        text: string;
        entries: {
          id: string;
          name: string;
          displayName?: string;
          description?: string;
          skillFile: string;
          skillDir: string;
        }[];
      };
      repo: {
        text: string;
        sections: {
          key: "conventions" | "toolchain" | "services";
          title: string;
          intro: string;
          entries: { relPath: string; hint: string }[];
        }[];
      };
    };
    conversation: {
      /** Live context size (latest turn's input + output). */
      used: number;
      /** Model's context window. */
      window: number;
      /** True when `used` is sourced from the per-turn signal; false
       *  when we fell back to the lifetime cumulative because the
       *  task hasn't logged a usage event since this code shipped. */
      liveTurn?: boolean;
      /** Lifetime billing total (sum of every turn's input+output).
       *  Never decreases; shown alongside `used` so the operator can
       *  see both "current context" and "lifetime spend". */
      cumulative?: number;
    };
  }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/context`);
  }

  async compactTask(
    id: string,
    focus?: string,
  ): Promise<{ ok: boolean; agent: string; directive: string }> {
    return this.req(`/api/tasks/${encodeURIComponent(id)}/compact`, {
      method: "POST",
      body: JSON.stringify({ focus: focus ?? "" }),
    });
  }

  // ── skills ──
  async listSkills(repoPath?: string): Promise<{ skills: Skill[] }> {
    const qs = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : "";
    return this.req(`/api/skills${qs}`);
  }

  async getSkill(
    scope: string,
    slug: string,
    repoPath?: string,
  ): Promise<{ skill: Skill }> {
    const qs = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : "";
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${qs}`,
    );
  }

  async createSkill(req: CreateSkillRequest): Promise<{ skill: Skill }> {
    return this.req("/api/skills", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async updateSkill(
    scope: string,
    slug: string,
    patch: UpdateSkillRequest,
    repoPath?: string,
  ): Promise<{ skill: Skill }> {
    const qs = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : "";
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${qs}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async deleteSkill(scope: string, slug: string, repoPath?: string): Promise<{ ok: true }> {
    const qs = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : "";
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${qs}`,
      { method: "DELETE" },
    );
  }

  // ── skill bundle files ──
  async listSkillFiles(
    scope: string,
    slug: string,
    repoPath?: string,
  ): Promise<{
    dir: string;
    files: {
      path: string;
      name: string;
      isDir: boolean;
      size: number;
      mtime: number;
    }[];
  }> {
    const qs = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : "";
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/files${qs}`,
    );
  }

  async readSkillFile(
    scope: string,
    slug: string,
    path: string,
    repoPath?: string,
  ): Promise<{ path: string; content: string; size: number; binary: boolean }> {
    const params = new URLSearchParams({ path });
    if (repoPath) params.set("repoPath", repoPath);
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/file?${params}`,
    );
  }

  async writeSkillFile(
    scope: string,
    slug: string,
    path: string,
    content: string,
    repoPath?: string,
  ): Promise<{ ok: true; file: { path: string; size: number; mtime: number } }> {
    const params = new URLSearchParams({ path });
    if (repoPath) params.set("repoPath", repoPath);
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/file?${params}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    );
  }

  async deleteSkillFile(
    scope: string,
    slug: string,
    path: string,
    repoPath?: string,
  ): Promise<{ ok: true }> {
    const params = new URLSearchParams({ path });
    if (repoPath) params.set("repoPath", repoPath);
    return this.req(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/file?${params}`,
      { method: "DELETE" },
    );
  }

  // ── filesystem browsing (for the web repo picker) ──
  async listFs(
    path?: string,
    opts?: { showHidden?: boolean },
  ): Promise<{
    path: string;
    parent: string | null;
    isGit: boolean;
    entries: { name: string; path: string; isDir: boolean; isGit: boolean }[];
  }> {
    const qs = new URLSearchParams();
    if (path) qs.set("path", path);
    if (opts?.showHidden) qs.set("showHidden", "1");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.req(`/api/fs/list${suffix}`);
  }

  // ── tmux / terminal sessions ──
  async listTerminalSessions(): Promise<{ sessions: TerminalSession[] }> {
    return this.req("/api/terminal/sessions");
  }

  async createTerminalSession(
    req: CreateTerminalSessionRequest,
  ): Promise<{ session: TerminalSession }> {
    return this.req("/api/terminal/sessions", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async killTerminalSession(name: string): Promise<{ ok: true }> {
    return this.req(`/api/terminal/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async renameTerminalSession(
    oldName: string,
    req: RenameTerminalSessionRequest,
  ): Promise<{ session: TerminalSession }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(oldName)}/rename`,
      { method: "POST", body: JSON.stringify(req) },
    );
  }

  async listTerminalWindows(
    sessionName: string,
  ): Promise<{ windows: TerminalWindow[] }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(sessionName)}/windows`,
    );
  }

  async createTerminalWindow(
    sessionName: string,
    req: CreateTerminalWindowRequest = {},
  ): Promise<{ window: TerminalWindow; windows: TerminalWindow[] }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(sessionName)}/windows`,
      { method: "POST", body: JSON.stringify(req) },
    );
  }

  async selectTerminalWindow(
    sessionName: string,
    index: number,
  ): Promise<{ windows: TerminalWindow[] }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(sessionName)}/windows/${index}/select`,
      { method: "POST" },
    );
  }

  async renameTerminalWindow(
    sessionName: string,
    index: number,
    req: RenameTerminalWindowRequest,
  ): Promise<{ windows: TerminalWindow[] }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(sessionName)}/windows/${index}/rename`,
      { method: "POST", body: JSON.stringify(req) },
    );
  }

  async killTerminalWindow(
    sessionName: string,
    index: number,
  ): Promise<{ ok: true; sessionAlive: boolean; windows: TerminalWindow[] }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(sessionName)}/windows/${index}`,
      { method: "DELETE" },
    );
  }

  async sendTerminalKeys(
    sessionName: string,
    req: SendTerminalKeysRequest,
  ): Promise<{ ok: true }> {
    return this.req(
      `/api/terminal/sessions/${encodeURIComponent(sessionName)}/send-keys`,
      { method: "POST", body: JSON.stringify(req) },
    );
  }

  /**
   * Open a WebSocket attached to a tmux session (creating the session if it
   * doesn't exist on the daemon side). Caller wires it into xterm.js.
   */
  attachTerminal(sessionName: string): WebSocket {
    const url = new URL(this.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/pty/term/${encodeURIComponent(sessionName)}`;
    if (this.token) url.searchParams.set("session", this.token);
    return new WebSocket(url.toString());
  }

  /** Open a WebSocket attached to a task's worktree shell. */
  attachTask(taskId: string): WebSocket {
    const url = new URL(this.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/pty/${encodeURIComponent(taskId)}`;
    if (this.token) url.searchParams.set("session", this.token);
    return new WebSocket(url.toString());
  }

  watch(taskId: string | null, onEvent: (e: WsServerEvent) => void): WebSocket {
    const url = new URL(this.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    if (this.token) url.searchParams.set("session", this.token);
    if (taskId) url.searchParams.set("task", taskId);
    const ws = new WebSocket(url.toString());
    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as WsServerEvent;
        onEvent(data);
      } catch {
        // ignore
      }
    });
    return ws;
  }
}
