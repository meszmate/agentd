import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ServerWebSocket } from "bun";
import {
  ApprovePermissionRequest,
  CreateTaskRequest,
  PairExchangeRequest,
  SendInputRequest,
  type WsServerEvent,
} from "@agentd/contracts";
import {
  EventBus,
  exchangePairingToken,
  issuePairingToken,
  listMessages,
  resolveSession,
  type AgentdPaths,
  type Db,
} from "@agentd/core";
import { requireSession, bearerOrHeader } from "./auth.ts";
import type { TaskManager } from "./taskManager.ts";

interface WsData {
  sessionId: string;
  taskId: string | null;
  unsubscribe: (() => void) | null;
}

export interface BuildServerOptions {
  db: Db;
  bus: EventBus;
  paths: AgentdPaths;
  tasks: TaskManager;
  version: string;
}

export function buildServer(opts: BuildServerOptions) {
  const { db, bus, tasks, version } = opts;
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
      const task = await tasks.create(parsed.data);
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

  api.post("/tasks/:id/approve", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ApprovePermissionRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    return c.json({ ok: false, error: "permission flow not wired yet" }, 501);
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

  api.post("/admin/pair", (c) => {
    // Issue an additional pairing token from an authenticated session.
    const issued = issuePairingToken(db);
    return c.json(issued);
  });

  app.route("/api", api);

  const wsHandler = {
    open(ws: ServerWebSocket<WsData>) {
      const taskId = ws.data.taskId;
      const send = (event: WsServerEvent) => {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          // socket closed
        }
      };
      send({ type: "hello", serverVersion: version });
      const sub = taskId
        ? bus.subscribeTask(taskId, (env) =>
            send({ type: "event", taskId: env.taskId, event: env.event, ts: env.ts }),
          )
        : bus.subscribeAll((env) =>
            send({ type: "event", taskId: env.taskId, event: env.event, ts: env.ts }),
          );
      ws.data.unsubscribe = sub;
    },
    message(_ws: ServerWebSocket<WsData>, _msg: string | Buffer) {
      // No client→server messages over WS in MVP. All inputs go via HTTP.
    },
    close(ws: ServerWebSocket<WsData>) {
      ws.data.unsubscribe?.();
      ws.data.unsubscribe = null;
    },
    drain(_ws: ServerWebSocket<WsData>) {},
  };

  function upgradeRequest(req: Request, server: Bun.Server<WsData>): Response | undefined {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return undefined;
    const token = url.searchParams.get("session") ?? "";
    const session = resolveSession(db, token);
    if (!session) return new Response("unauthorized", { status: 401 });
    const taskId = url.searchParams.get("task");
    const data: WsData = {
      sessionId: session.sessionId,
      taskId,
      unsubscribe: null,
    };
    if (server.upgrade(req, { data })) return undefined;
    return new Response("upgrade failed", { status: 500 });
  }

  return { app, wsHandler, upgradeRequest, bearerOrHeader };
}
