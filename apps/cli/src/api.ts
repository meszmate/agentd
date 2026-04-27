import type {
  CreateTaskRequest,
  PairExchangeRequest,
  PairExchangeResponse,
  Task,
  Message,
  WsServerEvent,
} from "@agentd/contracts";

export class ApiClient {
  constructor(
    private readonly server: string,
    private readonly token: string | null,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {
      "content-type": "application/json",
      ...extra,
    };
    if (this.token) base["x-agentd-session"] = this.token;
    return base;
  }

  async pair(req: PairExchangeRequest): Promise<PairExchangeResponse> {
    const r = await fetch(`${this.server}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error(`pair failed (${r.status}): ${await r.text()}`);
    return (await r.json()) as PairExchangeResponse;
  }

  async listTasks(): Promise<{ tasks: Task[] }> {
    const r = await fetch(`${this.server}/api/tasks`, {
      headers: this.headers(),
    });
    if (!r.ok) throw new Error(`list failed (${r.status}): ${await r.text()}`);
    return (await r.json()) as { tasks: Task[] };
  }

  async createTask(req: CreateTaskRequest): Promise<{ task: Task }> {
    const r = await fetch(`${this.server}/api/tasks`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (!r.ok)
      throw new Error(`create failed (${r.status}): ${await r.text()}`);
    return (await r.json()) as { task: Task };
  }

  async getTask(id: string): Promise<{ task: Task; messages: Message[] }> {
    const r = await fetch(`${this.server}/api/tasks/${id}`, {
      headers: this.headers(),
    });
    if (!r.ok) throw new Error(`get failed (${r.status}): ${await r.text()}`);
    return (await r.json()) as { task: Task; messages: Message[] };
  }

  async sendInput(id: string, text: string): Promise<void> {
    const r = await fetch(`${this.server}/api/tasks/${id}/input`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`input failed (${r.status}): ${await r.text()}`);
  }

  async stopTask(id: string): Promise<void> {
    const r = await fetch(`${this.server}/api/tasks/${id}/stop`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!r.ok) throw new Error(`stop failed (${r.status}): ${await r.text()}`);
  }

  async removeTask(id: string): Promise<void> {
    const r = await fetch(`${this.server}/api/tasks/${id}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok)
      throw new Error(`remove failed (${r.status}): ${await r.text()}`);
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
        // ignore unparseable
      }
    });
    return ws;
  }
}
