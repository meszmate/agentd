import type {
  CreateScheduleRequest,
  CreateTaskRequest,
  CreateTemplateRequest,
  PairExchangeRequest,
  PairExchangeResponse,
  RunTemplateRequest,
  Schedule,
  Task,
  Template,
  Message,
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
  }> {
    return this.req("/api/admin/settings");
  }

  async patchSettings(patch: Partial<{
    agentInstructions: string;
    commitPrefix: string;
    prTitlePrefix: string;
    prBodyTemplate: string;
  }>): Promise<{ ok: boolean; settings: Record<string, string> }> {
    return this.req("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
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
