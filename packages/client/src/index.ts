import type {
  CreateProjectRequest,
  CreateScheduleRequest,
  CreateSkillRequest,
  CreateTaskRequest,
  CreateTemplateRequest,
  CreateTerminalSessionRequest,
  CreateTerminalWindowRequest,
  DeviceSession,
  PairExchangeRequest,
  PairExchangeResponse,
  Project,
  RenameTerminalSessionRequest,
  RenameTerminalWindowRequest,
  RunTemplateRequest,
  Schedule,
  SendTerminalKeysRequest,
  Skill,
  Task,
  Template,
  TerminalSession,
  TerminalWindow,
  Message,
  UpdateProjectRequest,
  UpdateSkillRequest,
  WsServerEvent,
} from "@agentd/contracts";

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
  allowedChatIds?: number[];
  defaultRepo?: string | null;
}

export interface DiscordPluginPatch {
  enabled?: boolean;
  botToken?: string;
  allowedUserIds?: string[];
  allowedChannelIds?: string[];
  defaultRepo?: string | null;
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

  async stopTask(id: string): Promise<void> {
    await this.req(`/api/tasks/${id}/stop`, { method: "POST" });
  }

  async removeTask(id: string): Promise<void> {
    await this.req(`/api/tasks/${id}`, { method: "DELETE" });
  }

  async listFiles(id: string): Promise<{ files: string[] }> {
    return this.req(`/api/tasks/${id}/files`);
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
  async runTemplate(
    idOrName: string,
    req: RunTemplateRequest = { args: {} },
  ): Promise<{ task: Task }> {
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

  // ── settings ──
  async getSettings(): Promise<{
    agentInstructions: string;
    commitPrefix: string;
    prTitlePrefix: string;
    prBodyTemplate: string;
    maxContextTokens: number;
  }> {
    return this.req("/api/admin/settings");
  }

  async patchSettings(
    patch: Partial<{
      agentInstructions: string;
      commitPrefix: string;
      prTitlePrefix: string;
      prBodyTemplate: string;
      maxContextTokens: number;
    }>,
  ): Promise<{ ok: boolean; settings: Record<string, unknown> }> {
    return this.req("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
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

  async getTaskContext(id: string): Promise<{
    agentInstructions: string;
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
    conversation: { used: number; window: number };
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
