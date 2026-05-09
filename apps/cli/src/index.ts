#!/usr/bin/env bun
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentdClient } from "@agentd/client";
import { loadCliConfig, saveCliConfig } from "./config.ts";

const HELP = `agentd — remote coding-agent orchestrator

Tasks:
  agentd pair --server <url> --token <pairing-token>
  agentd ls
  agentd new --repo <path> [--agent claude|codex] [--base <branch>] [--title <s>] [--push] [--pr] <prompt...>
  agentd show <task-id>
  agentd input <task-id> <text...>
  agentd attach <task-id>
  agentd stop <task-id>
  agentd rm <task-id>
  agentd config

Templates (reusable named prompts; substitute {placeholders}):
  agentd template ls
  agentd template add <name> --repo <path> [--agent claude] [--base main] [--push] [--pr] <prompt...>
  agentd template show <name>
  agentd template run <name> [--arg key=value ...]
  agentd template rm <name>

Schedules (cron-driven template runs):
  agentd schedule ls
  agentd schedule add <name> --cron "<5-field-cron>" --template <name> [--arg k=v]
  agentd schedule enable <name|id>
  agentd schedule disable <name|id>
  agentd schedule rm <name|id>

Triggers (condition-driven template runs — fire when an external predicate flips true):
  agentd triggers ls
  agentd triggers add <name> --kind datetime --fire-at "<iso-or-+Nm>" --template <name> [--repeat] [--arg k=v]
  agentd triggers add <name> --kind webhook --template <name> [--secret <hex>] [--repeat]
  agentd triggers add <name> --kind github_pr_merged --owner <o> --repo <r> --number <n> --template <name>
  agentd triggers add <name> --kind github_issue_closed --owner <o> --repo <r> --number <n> --template <name>
  agentd triggers enable <id|name>
  agentd triggers disable <id|name>
  agentd triggers rm <id|name>

Settings (daemon-side, edit the system prompt + AI helper guidance):
  agentd settings show
  agentd settings set <agentInstructions|commitInstructions|prInstructions> <value>

Progress (called by the agent automatically; useful from a host shell too):
  agentd progress "<summary>" [--done] [--task <id>]

Plugins:
  agentd plugin status
  agentd plugin enable telegram --token <bot-token> [--allow-user 1,2] [--allow-chat 3,4] [--default-repo <path>]
  agentd plugin enable discord  --token <bot-token> [--allow-user a,b] [--allow-channel c,d] [--default-repo <path>]
  agentd plugin disable <telegram|discord>

Skills (markdown skills the agent can invoke; sources: global / local / claude / codex):
  agentd skills ls [--repo <path>]
  agentd skills show <scope:slug> [--repo <path>]
  agentd skills new <slug> [--scope global|local] [--repo <path>] [--display "PR review"] [--desc "..."]
  agentd skills edit <scope:slug> [--repo <path>]                       # opens $EDITOR on the SKILL.md
  agentd skills rm <scope:slug> [--repo <path>]

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
      push: { type: "boolean" },
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
    ...(values.push ? { autoPush: true } : {}),
  };
  const { task } = await client().createTask(req);
  console.log(`created task ${task.id}`);
  console.log(`branch:   ${task.branch}`);
  console.log(`worktree: ${task.worktreePath}`);
  console.log(`status:   ${task.status}`);
  if (req.autoPush) {
    console.log(`hooks:    auto-push`);
  }
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

// ───────────── templates ─────────────

function parseArgPairs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq < 0) continue;
    out[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return out;
}

async function cmdTemplate(argv: string[]) {
  const sub = argv[0];
  const c = client();
  if (!sub || sub === "ls" || sub === "list") {
    const { templates } = await c.listTemplates();
    if (templates.length === 0) return console.log("(no templates)");
    for (const t of templates) {
      const flags = t.autoPush ? "push" : "";
      console.log(`${t.name.padEnd(20)} ${t.agent.padEnd(7)} ${t.repoPath} ${flags ? "[" + flags + "]" : ""}`);
      console.log(`                     base=${t.baseBranch}  prompt: ${t.promptTemplate.slice(0, 80)}${t.promptTemplate.length > 80 ? "…" : ""}`);
    }
    return;
  }
  if (sub === "show") {
    const name = argv[1];
    if (!name) { console.error("usage: agentd template show <name>"); process.exit(2); }
    const { template: t } = await c.getTemplate(name);
    console.log(JSON.stringify(t, null, 2));
    return;
  }
  if (sub === "rm" || sub === "delete") {
    const name = argv[1];
    if (!name) { console.error("usage: agentd template rm <name>"); process.exit(2); }
    await c.deleteTemplate(name);
    console.log(`removed ${name}`);
    return;
  }
  if (sub === "add" || sub === "create") {
    const name = argv[1];
    if (!name) { console.error("usage: agentd template add <name> --repo <path> ... <prompt>"); process.exit(2); }
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      options: {
        repo: { type: "string" },
        agent: { type: "string" },
        base: { type: "string" },
        push: { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (!values.repo) { console.error("--repo is required"); process.exit(2); }
    if (positionals.length === 0) { console.error("prompt is required"); process.exit(2); }
    const req = {
      name,
      agent: (values.agent === "codex" ? "codex" : "claude") as "claude" | "codex",
      repoPath: resolve(String(values.repo)),
      baseBranch: values.base ? String(values.base) : "main",
      promptTemplate: positionals.join(" "),
      autoPush: !!values.push,
    };
    const { template } = await c.createTemplate(req);
    console.log(`created template '${template.name}' (${template.id})`);
    return;
  }
  if (sub === "run" || sub === "fire") {
    const name = argv[1];
    if (!name) { console.error("usage: agentd template run <name> [--arg k=v ...]"); process.exit(2); }
    const argFlags: string[] = [];
    const rest = argv.slice(2);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--arg" && rest[i + 1]) {
        argFlags.push(rest[i + 1]!);
        i++;
      }
    }
    const args = parseArgPairs(argFlags);
    const result = await c.runTemplate(name, { args });
    if ("task" in result) {
      console.log(`fired template '${name}' → task ${result.task.id}`);
      console.log(`attach: agentd attach ${result.task.id}`);
    } else {
      // Ideation template — no task spawned. Just print the brainstorm
      // brief and tell the operator where the options landed.
      const sug = result.suggestion;
      console.log(
        `brainstormed '${name}' → ${sug.options.length} option${sug.options.length === 1 ? "" : "s"} (suggestion ${sug.id})`,
      );
      console.log(`pick: open the web ui's brainstorm window for this project`);
    }
    return;
  }
  console.error(`unknown template subcommand: ${sub}`);
  process.exit(2);
}

// ───────────── schedules ─────────────

async function cmdSchedule(argv: string[]) {
  const sub = argv[0];
  const c = client();
  if (!sub || sub === "ls" || sub === "list") {
    const { schedules } = await c.listSchedules();
    if (schedules.length === 0) return console.log("(no schedules)");
    for (const s of schedules) {
      const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—";
      const last = s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—";
      const state = s.enabled ? "enabled" : "disabled";
      console.log(`${s.name.padEnd(20)} ${state.padEnd(9)} cron='${s.cron}' template=${s.templateId}`);
      console.log(`                     next=${next}  last=${last}`);
    }
    return;
  }
  if (sub === "add" || sub === "create") {
    const name = argv[1];
    if (!name) { console.error("usage: agentd schedule add <name> --cron \"...\" --template <name> [--arg k=v ...]"); process.exit(2); }
    const argFlags: string[] = [];
    const passed = argv.slice(2);
    const filtered: string[] = [];
    for (let i = 0; i < passed.length; i++) {
      if (passed[i] === "--arg" && passed[i + 1]) {
        argFlags.push(passed[i + 1]!);
        i++;
      } else {
        filtered.push(passed[i]!);
      }
    }
    const { values } = parseArgs({
      args: filtered,
      options: {
        cron: { type: "string" },
        template: { type: "string" },
      },
      allowPositionals: false,
    });
    if (!values.cron || !values.template) { console.error("--cron and --template are required"); process.exit(2); }
    const args = parseArgPairs(argFlags);
    const { schedule } = await c.createSchedule({
      name,
      cron: String(values.cron),
      templateId: String(values.template),
      templateArgs: args,
      enabled: true,
    });
    console.log(`created schedule '${schedule.name}' (${schedule.id}) — next run ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "never"}`);
    return;
  }
  if (sub === "enable") {
    const id = argv[1];
    if (!id) { console.error("usage: agentd schedule enable <id>"); process.exit(2); }
    const { schedule } = await c.enableSchedule(id);
    console.log(`enabled ${schedule.name}`);
    return;
  }
  if (sub === "disable") {
    const id = argv[1];
    if (!id) { console.error("usage: agentd schedule disable <id>"); process.exit(2); }
    const { schedule } = await c.disableSchedule(id);
    console.log(`disabled ${schedule.name}`);
    return;
  }
  if (sub === "rm" || sub === "delete") {
    const id = argv[1];
    if (!id) { console.error("usage: agentd schedule rm <id>"); process.exit(2); }
    await c.deleteSchedule(id);
    console.log(`removed ${id}`);
    return;
  }
  console.error(`unknown schedule subcommand: ${sub}`);
  process.exit(2);
}

// ───────────── triggers ─────────────

async function cmdTriggers(argv: string[]) {
  const sub = argv[0];
  const c = client();
  if (!sub || sub === "ls" || sub === "list") {
    const { triggers } = await c.listTriggers();
    if (triggers.length === 0) return console.log("(no triggers)");
    for (const t of triggers) {
      const last = t.lastFiredAt ? new Date(t.lastFiredAt).toLocaleString() : "—";
      const state = t.enabled ? "enabled" : "disabled";
      const cfg = JSON.stringify(t.predicateConfig);
      console.log(`${t.name.padEnd(20)} ${state.padEnd(9)} ${t.predicateKind.padEnd(20)} ${cfg}`);
      console.log(`                     last=${last}  template=${t.templateId}${t.lastError ? "  err=" + t.lastError : ""}`);
    }
    return;
  }
  if (sub === "add" || sub === "create") {
    const name = argv[1];
    if (!name) { console.error("usage: agentd triggers add <name> --kind <k> --template <name> [...]"); process.exit(2); }
    const argFlags: string[] = [];
    const passed = argv.slice(2);
    const filtered: string[] = [];
    for (let i = 0; i < passed.length; i++) {
      if (passed[i] === "--arg" && passed[i + 1]) {
        argFlags.push(passed[i + 1]!);
        i++;
      } else {
        filtered.push(passed[i]!);
      }
    }
    const { values } = parseArgs({
      args: filtered,
      options: {
        kind: { type: "string" },
        template: { type: "string" },
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "string" },
        "fire-at": { type: "string" },
        secret: { type: "string" },
        repeat: { type: "boolean" },
      },
      allowPositionals: false,
    });
    if (!values.kind || !values.template) {
      console.error("--kind and --template are required");
      process.exit(2);
    }
    const kind = String(values.kind);
    let predicateConfig: Record<string, unknown>;
    if (kind === "github_pr_merged" || kind === "github_issue_closed") {
      if (!values.owner || !values.repo || !values.number) {
        console.error(`--owner, --repo, --number are required for ${kind}`);
        process.exit(2);
      }
      predicateConfig = {
        kind,
        owner: String(values.owner),
        repo: String(values.repo),
        number: Number(values.number),
      };
    } else if (kind === "datetime") {
      if (!values["fire-at"]) {
        console.error("--fire-at is required for datetime (ISO timestamp or +Nm/+Ns)");
        process.exit(2);
      }
      const fireAt = parseFireAt(String(values["fire-at"]));
      predicateConfig = { kind, fireAt };
    } else if (kind === "webhook") {
      const secret = values.secret ? String(values.secret) : randomHex(24);
      predicateConfig = { kind, secret };
    } else {
      console.error(`unknown kind: ${kind}`);
      process.exit(2);
    }
    const args = parseArgPairs(argFlags);
    const { trigger } = await c.createTrigger({
      name,
      predicateKind: kind as "datetime" | "webhook" | "github_pr_merged" | "github_issue_closed",
      predicateConfig: predicateConfig as never,
      templateId: String(values.template),
      templateArgs: args,
      enabled: true,
      repeat: !!values.repeat,
    });
    console.log(`created trigger '${trigger.name}' (${trigger.id})`);
    if (trigger.predicateConfig.kind === "webhook") {
      const cfg = loadCliConfig();
      console.log(`  webhook URL: ${cfg.server.replace(/\/$/, "")}/api/webhooks/${trigger.id}`);
      console.log(`  secret:      ${trigger.predicateConfig.secret}`);
    }
    return;
  }
  if (sub === "enable") {
    const id = argv[1];
    if (!id) { console.error("usage: agentd triggers enable <id>"); process.exit(2); }
    const { trigger } = await c.enableTrigger(id);
    console.log(`enabled ${trigger.name}`);
    return;
  }
  if (sub === "disable") {
    const id = argv[1];
    if (!id) { console.error("usage: agentd triggers disable <id>"); process.exit(2); }
    const { trigger } = await c.disableTrigger(id);
    console.log(`disabled ${trigger.name}`);
    return;
  }
  if (sub === "rm" || sub === "delete") {
    const id = argv[1];
    if (!id) { console.error("usage: agentd triggers rm <id>"); process.exit(2); }
    await c.deleteTrigger(id);
    console.log(`removed ${id}`);
    return;
  }
  console.error(`unknown triggers subcommand: ${sub}`);
  process.exit(2);
}

/** Accept ISO timestamps, epoch ms, or relative offsets like "+90s" / "+5m" / "+2h". */
function parseFireAt(input: string): number {
  const trimmed = input.trim();
  const rel = trimmed.match(/^\+(\d+)\s*([smhd])?$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? "s") as "s" | "m" | "h" | "d";
    const mult: Record<typeof unit, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return Date.now() + n * mult[unit];
  }
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 1_000_000_000) return asNum;
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`could not parse --fire-at: ${input}`);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ───────────── settings ─────────────

const SETTINGS_KEYS = ["agentInstructions", "commitInstructions", "prInstructions"] as const;
type SettingKey = (typeof SETTINGS_KEYS)[number];

/**
 * Progress reporter the running agent calls after every meaningful step.
 * The daemon injects AGENTD_TASK_ID, AGENTD_DAEMON_URL, AGENTD_TOKEN at
 * spawn time so this works without a paired CLI session.
 *
 *   agentd progress "<one-line summary>" [--done]
 *
 * Outside the spawn env (no env vars set) we fall back to the saved CLI
 * config and require an explicit `--task <id>` so the host shell can
 * also use it for ad-hoc status posts.
 */
async function cmdProgress(argv: string[]) {
  let text = "";
  let done = false;
  let explicitTaskId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--done") done = true;
    else if (a === "--task" && argv[i + 1]) {
      explicitTaskId = argv[++i];
    } else {
      text = text ? `${text} ${a}` : a;
    }
  }
  if (!text.trim()) {
    console.error('progress: usage: agentd progress "<summary>" [--done] [--task <id>]');
    process.exit(2);
  }

  const envTaskId = process.env.AGENTD_TASK_ID;
  const envUrl = process.env.AGENTD_DAEMON_URL;
  const envToken = process.env.AGENTD_TOKEN;

  let server: string;
  let token: string;
  let taskId: string | undefined;
  if (envTaskId && envUrl && envToken) {
    server = envUrl;
    token = envToken;
    taskId = explicitTaskId ?? envTaskId;
  } else {
    const cfg = loadCliConfig();
    if (!cfg.sessionToken) {
      console.error("progress: no session — pair the CLI first or run inside a spawn");
      process.exit(2);
    }
    server = cfg.server;
    token = cfg.sessionToken;
    taskId = explicitTaskId;
    if (!taskId) {
      console.error(
        "progress: no task id (set AGENTD_TASK_ID or pass --task <id>)",
      );
      process.exit(2);
    }
  }

  const url = `${server.replace(/\/$/, "")}/api/tasks/${encodeURIComponent(taskId)}/progress`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text: text.trim(), done }),
  });
  if (!r.ok) {
    console.error(`progress: ${r.status} ${await r.text().catch(() => "")}`);
    process.exit(1);
  }
}

async function cmdSettings(argv: string[]) {
  const sub = argv[0];
  const c = client();
  if (!sub || sub === "show" || sub === "ls") {
    const s = await c.getSettings();
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (sub === "set") {
    const key = argv[1] as SettingKey | undefined;
    const value = argv.slice(2).join(" ");
    if (!key || !SETTINGS_KEYS.includes(key)) {
      console.error(`usage: agentd settings set <${SETTINGS_KEYS.join("|")}> <value>`);
      process.exit(2);
    }
    if (value === "") {
      console.error("value required (use empty quotes if you really want '')");
      process.exit(2);
    }
    const r = await c.patchSettings({ [key]: value });
    console.log(`updated ${key}.`);
    console.log(JSON.stringify(r.settings, null, 2));
    return;
  }
  console.error(`unknown settings subcommand: ${sub}`);
  process.exit(2);
}

// ───────────── skills ─────────────
async function cmdSkills(argv: string[]) {
  const c = client();
  const sub = argv[0];

  function pickRepo(args: string[]): string | undefined {
    const i = args.indexOf("--repo");
    return i >= 0 ? args[i + 1] : undefined;
  }
  function pickFlag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  }

  if (!sub || sub === "ls" || sub === "list") {
    const repo = pickRepo(argv.slice(1));
    const { skills } = await c.listSkills(repo);
    if (skills.length === 0) {
      console.log("(no skills)");
      return;
    }
    for (const s of skills) {
      const ro = s.writable ? "" : " [ro]";
      const en = s.enabled ? "" : " [disabled]";
      const desc = s.description ? `  ${s.description}` : "";
      console.log(
        `${s.scope.padEnd(7)} ${s.slug.padEnd(24)} ${s.displayName ?? s.name}${ro}${en}${desc}`,
      );
    }
    return;
  }

  if (sub === "show") {
    const id = argv[1];
    if (!id || !id.includes(":")) {
      console.error("usage: agentd skills show <scope:slug> [--repo <path>]");
      process.exit(2);
    }
    const [scope, slug] = id.split(":") as [string, string];
    const repo = pickRepo(argv.slice(2));
    const { skill } = await c.getSkill(scope, slug, repo);
    console.log(`# ${skill.displayName ?? skill.name}\n`);
    if (skill.description) console.log(`${skill.description}\n`);
    console.log(`scope: ${skill.scope}    path: ${skill.path}`);
    console.log(`writable: ${skill.writable}    enabled: ${skill.enabled}\n`);
    console.log("--- body ---\n");
    console.log(skill.body || "(empty)");
    return;
  }

  if (sub === "new" || sub === "create") {
    const slug = argv[1];
    if (!slug) {
      console.error(
        "usage: agentd skills new <slug> [--scope global|local] [--repo <path>] [--display ...] [--desc ...]",
      );
      process.exit(2);
    }
    const scopeArg = pickFlag(argv.slice(2), "--scope") ?? "global";
    if (scopeArg !== "global" && scopeArg !== "local") {
      console.error("--scope must be 'global' or 'local'");
      process.exit(2);
    }
    const repo = pickRepo(argv.slice(2));
    const display = pickFlag(argv.slice(2), "--display");
    const desc = pickFlag(argv.slice(2), "--desc");
    if (scopeArg === "local" && !repo) {
      console.error("local skills need --repo");
      process.exit(2);
    }
    const { skill } = await c.createSkill({
      scope: scopeArg as "global" | "local",
      name: slug,
      ...(display ? { displayName: display } : {}),
      ...(desc ? { description: desc } : {}),
      body: "",
      ...(scopeArg === "local" && repo ? { repoPath: repo } : {}),
    });
    console.log(`created ${skill.scope}:${skill.slug} → ${skill.path}`);
    return;
  }

  if (sub === "edit") {
    const id = argv[1];
    if (!id || !id.includes(":")) {
      console.error("usage: agentd skills edit <scope:slug> [--repo <path>]");
      process.exit(2);
    }
    const [scope, slug] = id.split(":") as [string, string];
    const repo = pickRepo(argv.slice(2));
    const { skill } = await c.getSkill(scope, slug, repo);
    if (!skill.writable) {
      console.error(`skill is read-only: ${id}`);
      process.exit(2);
    }
    const editor = process.env.EDITOR || "vi";
    const { spawn } = await import("node:child_process");
    await new Promise<void>((res, rej) => {
      const p = spawn(editor, [skill.path], { stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`editor exited ${code}`))));
    });
    console.log(`saved ${skill.path}`);
    return;
  }

  if (sub === "rm" || sub === "delete") {
    const id = argv[1];
    if (!id || !id.includes(":")) {
      console.error("usage: agentd skills rm <scope:slug> [--repo <path>]");
      process.exit(2);
    }
    const [scope, slug] = id.split(":") as [string, string];
    const repo = pickRepo(argv.slice(2));
    await c.deleteSkill(scope, slug, repo);
    console.log(`removed ${id}`);
    return;
  }

  console.error(`unknown skills subcommand: ${sub ?? "(none)"}`);
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
    case "template":
    case "templates":
      return cmdTemplate(rest);
    case "schedule":
    case "schedules":
    case "cron":
      return cmdSchedule(rest);
    case "trigger":
    case "triggers":
      return cmdTriggers(rest);
    case "settings":
      return cmdSettings(rest);
    case "skills":
    case "skill":
      return cmdSkills(rest);
    case "progress":
      return cmdProgress(rest);
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
