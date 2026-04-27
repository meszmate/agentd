import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ServerWebSocket } from "bun";
import {
  ApprovePermissionRequest,
  CreateScheduleRequest,
  CreateTaskRequest,
  CreateTemplateRequest,
  PairExchangeRequest,
  RunTemplateRequest,
  SendInputRequest,
  type WsServerEvent,
} from "@agentd/contracts";
import { join, normalize, relative } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
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
  listMessages,
  listFiles,
  diffAgainst,
  listLog,
  revertCommit,
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
} from "@agentd/core";
import type { PluginManager } from "./pluginManager.ts";
import { requireSession, bearerOrHeader } from "./auth.ts";
import type { TaskManager } from "./taskManager.ts";

interface EventsWsData {
  kind: "events";
  sessionId: string;
  taskId: string | null;
  unsubscribe: (() => void) | null;
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

  api.get("/tasks/:id/files", async (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const files = await listFiles(task.worktreePath);
    return c.json({ files });
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
    });
  });

  api.post("/admin/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "json body required" }, 400);
    }
    const cfg = loadConfig(paths.root);
    const next = { ...cfg };
    const allowed = ["agentInstructions", "commitPrefix", "prTitlePrefix", "prBodyTemplate"] as const;
    let changed = false;
    for (const key of allowed) {
      if (key in body) {
        const v = body[key];
        if (typeof v !== "string") {
          return c.json({ error: `${key} must be a string` }, 400);
        }
        (next as Record<string, unknown>)[key] = v;
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

  app.route("/api", api);

  const wsHandler = {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === "pty") {
        startPty(ws as ServerWebSocket<PtyAttachData>);
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
      const sub = taskId
        ? bus.subscribeTask(taskId, (env) =>
            send({ type: "event", taskId: env.taskId, event: env.event, ts: env.ts }),
          )
        : bus.subscribeAll((env) =>
            send({ type: "event", taskId: env.taskId, event: env.event, ts: env.ts }),
          );
      evData.unsubscribe = sub;
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
        closePty(ws as ServerWebSocket<PtyAttachData>);
        return;
      }
      ws.data.unsubscribe?.();
      ws.data.unsubscribe = null;
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
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }
    const ptyMatch = url.pathname.match(/^\/pty\/([^/]+)$/);
    if (ptyMatch) {
      if (!session) return new Response("unauthorized", { status: 401 });
      const taskId = ptyMatch[1]!;
      const task = tasks.get(taskId);
      if (!task) return new Response("task not found", { status: 404 });
      const data: WsData = { kind: "pty", taskId, task, proc: null };
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
