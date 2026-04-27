#!/usr/bin/env bun
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentdClient } from "@agentd/client";
import { loadCliConfig, saveCliConfig } from "./config.ts";

const HELP = `agentd — remote coding-agent orchestrator

Usage:
  agentd pair --server <url> --token <pairing-token>
  agentd ls
  agentd new --repo <path> [--agent claude|codex] [--base <branch>] [--title <s>] <prompt...>
  agentd show <task-id>
  agentd input <task-id> <text...>
  agentd attach <task-id>
  agentd stop <task-id>
  agentd rm <task-id>
  agentd config
  agentd plugin status
  agentd plugin enable telegram --token <bot-token> [--allow-user 1,2] [--allow-chat 3,4] [--default-repo <path>]
  agentd plugin enable discord  --token <bot-token> [--allow-user a,b] [--allow-channel c,d] [--default-repo <path>]
  agentd plugin disable <telegram|discord>

Env:
  AGENTD_SERVER   default server URL (overrides saved config)
  AGENTD_TOKEN    default session token (overrides saved config)
`;

async function cmdPair(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      token: { type: "string" },
      label: { type: "string" },
    },
    allowPositionals: false,
  });
  if (!values.server || !values.token) {
    console.error("pair: --server and --token are required");
    process.exit(2);
  }
  const label = values.label ?? `${process.env.USER ?? "user"}@${hostname()}`;
  const client = new AgentdClient(String(values.server), null);
  const res = await client.pair({
    pairingToken: String(values.token),
    deviceLabel: label,
  });
  saveCliConfig({ server: String(values.server), sessionToken: res.sessionToken });
  console.log(`paired as "${label}"`);
  console.log(`server: ${values.server}`);
  console.log(`session saved to ~/.agentd/cli.json`);
}

function client(): AgentdClient {
  const cfg = loadCliConfig();
  return new AgentdClient(cfg.server, cfg.sessionToken);
}

async function cmdLs() {
  const { tasks } = await client().listTasks();
  if (tasks.length === 0) {
    console.log("(no tasks)");
    return;
  }
  for (const t of tasks) {
    console.log(
      `${t.id}  ${t.status.padEnd(13)}  ${t.agent.padEnd(6)}  ${t.title}`,
    );
  }
}

async function cmdNew(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      agent: { type: "string" },
      base: { type: "string" },
      title: { type: "string" },
    },
    allowPositionals: true,
  });
  if (!values.repo) {
    console.error("new: --repo is required");
    process.exit(2);
  }
  if (positionals.length === 0) {
    console.error("new: prompt is required");
    process.exit(2);
  }
  const prompt = positionals.join(" ");
  const agent =
    values.agent === "codex" ? ("codex" as const) : ("claude" as const);
  const req = {
    agent,
    repoPath: resolve(String(values.repo)),
    baseBranch: values.base ? String(values.base) : "main",
    prompt,
    ...(values.title ? { title: String(values.title) } : {}),
  };
  const { task } = await client().createTask(req);
  console.log(`created task ${task.id}`);
  console.log(`branch:   ${task.branch}`);
  console.log(`worktree: ${task.worktreePath}`);
  console.log(`status:   ${task.status}`);
  console.log("");
  console.log(`attach: agentd attach ${task.id}`);
}

async function cmdShow(argv: string[]) {
  const id = argv[0];
  if (!id) {
    console.error("show: task id required");
    process.exit(2);
  }
  const { task, messages } = await client().getTask(id);
  console.log(`${task.id}  [${task.status}]  ${task.title}`);
  console.log(`branch:   ${task.branch}`);
  console.log(`worktree: ${task.worktreePath}`);
  console.log("");
  for (const m of messages) {
    const ts = new Date(m.ts).toISOString();
    console.log(`[${ts}] ${m.role}: ${m.content}`);
  }
}

async function cmdInput(argv: string[]) {
  const [id, ...rest] = argv;
  if (!id || rest.length === 0) {
    console.error("input: task-id and text required");
    process.exit(2);
  }
  await client().sendInput(id, rest.join(" "));
  console.log("input sent");
}

async function cmdStop(argv: string[]) {
  const id = argv[0];
  if (!id) {
    console.error("stop: task id required");
    process.exit(2);
  }
  await client().stopTask(id);
  console.log("stopped");
}

async function cmdRm(argv: string[]) {
  const id = argv[0];
  if (!id) {
    console.error("rm: task id required");
    process.exit(2);
  }
  await client().removeTask(id);
  console.log("removed");
}

async function cmdAttach(argv: string[]) {
  const id = argv[0];
  if (!id) {
    console.error("attach: task id required");
    process.exit(2);
  }
  const c = client();
  // print history first
  try {
    const { messages } = await c.getTask(id);
    for (const m of messages) {
      console.log(`[${m.role}] ${m.content}`);
    }
  } catch (e) {
    console.error(`failed to load task: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log("--- live ---");
  const ws = c.watch(id, (event) => {
    if (event.type === "hello") return;
    if (event.type !== "event") return;
    const e = event.event;
    if (e.kind === "message") {
      console.log(`[${e.role}] ${e.text}`);
    } else if (e.kind === "tool_call") {
      const args = JSON.stringify(e.args).slice(0, 200);
      console.log(`[tool→ ${e.tool}] ${args}`);
    } else if (e.kind === "tool_result") {
      console.log(`[tool← ${e.tool}] ${e.ok ? "ok" : "error"}: ${e.output.slice(0, 200)}`);
    } else if (e.kind === "raw") {
      console.log(`[${e.stream}] ${e.text}`);
    } else if (e.kind === "status") {
      console.log(`[status] ${e.status}`);
    } else if (e.kind === "exit") {
      console.log(`[exit] code=${e.code ?? "?"}`);
    }
  });
  ws.addEventListener("close", () => process.exit(0));
  ws.addEventListener("error", (e) => {
    console.error("ws error:", e);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    try {
      ws.close();
    } finally {
      process.exit(0);
    }
  });
}

function cmdConfig() {
  const c = loadCliConfig();
  console.log(JSON.stringify(c, null, 2));
}

function fmtAgo(ts: number | null): string {
  if (!ts) return "—";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

async function cmdPlugin(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "status") {
    const { plugins, config } = await client().pluginStatus();
    for (const p of plugins) {
      const cfg = (config as Record<string, Record<string, unknown>>)[p.name] ?? {};
      const allowedUsers = ((cfg.allowedUserIds as unknown[]) ?? []).length;
      const allowedScopes =
        p.name === "telegram"
          ? ((cfg.allowedChatIds as unknown[]) ?? []).length + " chat(s)"
          : ((cfg.allowedChannelIds as unknown[]) ?? []).length + " channel(s)";
      const state = p.enabled ? (p.running ? "running" : "stopped") : "disabled";
      console.log(
        `${p.name.padEnd(8)}  ${state.padEnd(9)}  pid=${p.pid ?? "—"}  restarts=${p.restarts}  users=${allowedUsers}  ${allowedScopes}  uptime=${fmtAgo(p.startedAt)}`,
      );
      if (p.lastError) console.log(`            last error: ${p.lastError}`);
    }
    return;
  }

  const name = argv[1];
  if (sub === "disable") {
    if (name !== "telegram" && name !== "discord") {
      console.error("usage: agentd plugin disable <telegram|discord>");
      process.exit(2);
    }
    await client().patchPlugin(name as "telegram", { enabled: false });
    console.log(`${name} disabled.`);
    return;
  }

  if (sub === "enable") {
    if (name !== "telegram" && name !== "discord") {
      console.error("usage: agentd plugin enable <telegram|discord> --token <bot-token> ...");
      process.exit(2);
    }
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        token: { type: "string" },
        "allow-user": { type: "string" },
        "allow-chat": { type: "string" },
        "allow-channel": { type: "string" },
        "default-repo": { type: "string" },
      },
      allowPositionals: false,
    });
    if (!values.token) {
      console.error("--token is required");
      process.exit(2);
    }
    if (name === "telegram") {
      const patch = {
        enabled: true,
        botToken: String(values.token),
        ...(values["allow-user"]
          ? {
              allowedUserIds: String(values["allow-user"])
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n)),
            }
          : {}),
        ...(values["allow-chat"]
          ? {
              allowedChatIds: String(values["allow-chat"])
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n)),
            }
          : {}),
        ...(values["default-repo"] ? { defaultRepo: String(values["default-repo"]) } : {}),
      };
      const r = await client().patchPlugin("telegram", patch);
      console.log("telegram enabled. status:");
      for (const p of r.status) console.log(`  ${p.name}: ${p.running ? "running pid=" + p.pid : (p.lastError ?? "stopped")}`);
    } else {
      const patch = {
        enabled: true,
        botToken: String(values.token),
        ...(values["allow-user"]
          ? { allowedUserIds: String(values["allow-user"]).split(",").map((s) => s.trim()).filter(Boolean) }
          : {}),
        ...(values["allow-channel"]
          ? { allowedChannelIds: String(values["allow-channel"]).split(",").map((s) => s.trim()).filter(Boolean) }
          : {}),
        ...(values["default-repo"] ? { defaultRepo: String(values["default-repo"]) } : {}),
      };
      const r = await client().patchPlugin("discord", patch);
      console.log("discord enabled. status:");
      for (const p of r.status) console.log(`  ${p.name}: ${p.running ? "running pid=" + p.pid : (p.lastError ?? "stopped")}`);
    }
    return;
  }

  console.error(`unknown plugin subcommand: ${sub}`);
  process.exit(2);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "pair":
      return cmdPair(rest);
    case "ls":
      return cmdLs();
    case "new":
      return cmdNew(rest);
    case "show":
      return cmdShow(rest);
    case "input":
      return cmdInput(rest);
    case "attach":
      return cmdAttach(rest);
    case "stop":
      return cmdStop(rest);
    case "rm":
      return cmdRm(rest);
    case "config":
      return cmdConfig();
    case "plugin":
    case "plugins":
      return cmdPlugin(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
