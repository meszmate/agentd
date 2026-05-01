import { z } from "zod";

export const AgentKind = z.enum(["claude", "codex"]);
export type AgentKind = z.infer<typeof AgentKind>;

/**
 * How the agent should handle tool-permission decisions.
 *
 *   bypassPermissions — auto-allow everything. Default for unattended runs.
 *   acceptEdits       — auto-allow Read/Write/Edit, reject other tools.
 *   plan              — read-only planning; no writes, no commands.
 *
 * Note: the daemon currently invokes the agent CLIs in one-shot mode, so
 * interactive `default`-style approvals can't round-trip back through the
 * CLI's stdin. That mode is intentionally excluded.
 */
export const PermissionMode = z.enum([
  "bypassPermissions",
  "acceptEdits",
  "plan",
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const TaskStatus = z.enum([
  "pending",
  "running",
  "waiting_input",
  "waiting_perm",
  "done",
  "failed",
  "stopped",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  agent: AgentKind,
  repoPath: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  status: TaskStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  templateId: z.string().nullable().optional(),
  scheduleId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  autoPush: z.boolean().optional(),
  autoPr: z.boolean().optional(),
  prUrl: z.string().nullable().optional(),
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCacheReadTokens: z.number().optional(),
  totalCacheWriteTokens: z.number().optional(),
  totalCostUsd: z.number().nullable().optional(),
  // Skill identifiers (`scope:slug`) that were activated when this task spawned.
  skills: z.array(z.string()).optional(),
  permissionMode: PermissionMode.optional(),
});
export type Task = z.infer<typeof Task>;

export const Template = z.object({
  id: z.string(),
  name: z.string(),
  agent: AgentKind,
  repoPath: z.string(),
  baseBranch: z.string(),
  promptTemplate: z.string(),
  autoPush: z.boolean(),
  autoPr: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Template = z.infer<typeof Template>;

export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  templateId: z.string(),
  templateArgs: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  lastTaskId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Schedule = z.infer<typeof Schedule>;

export const Message = z.object({
  id: z.string(),
  taskId: z.string(),
  role: z.enum(["user", "agent", "tool", "system"]),
  content: z.string(),
  ts: z.number(),
});
export type Message = z.infer<typeof Message>;

export const AgentEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    role: z.enum(["agent", "system"]),
    text: z.string(),
  }),
  /**
   * Incremental text delta for the agent's current message. The web
   * accumulates these into a single growing message keyed by `streamId`
   * (one stream per content block), then finalizes when the matching
   * `kind:"message"` event lands.
   */
  z.object({
    kind: z.literal("message_delta"),
    streamId: z.string(),
    delta: z.string(),
  }),
  /** Marks the end of a stream — web removes the partial bubble. */
  z.object({
    kind: z.literal("message_end"),
    streamId: z.string(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    tool: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
  z.object({
    kind: z.literal("permission_request"),
    id: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal("status"),
    status: TaskStatus,
  }),
  z.object({
    kind: z.literal("raw"),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("exit"),
    code: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("usage"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    costUsd: z.number().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const CreateTaskRequest = z.object({
  agent: AgentKind,
  repoPath: z.string().min(1),
  baseBranch: z.string().default("main"),
  prompt: z.string().min(1),
  title: z.string().optional(),
  autoPush: z.boolean().optional(),
  autoPr: z.boolean().optional(),
  // Skill ids of the form `scope:slug` to activate on spawn.
  skills: z.array(z.string()).optional(),
  permissionMode: PermissionMode.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CreateTemplateRequest = z.object({
  name: z.string().min(1),
  agent: AgentKind,
  repoPath: z.string().min(1),
  baseBranch: z.string().default("main"),
  promptTemplate: z.string().min(1),
  autoPush: z.boolean().default(false),
  autoPr: z.boolean().default(false),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>;

export const RunTemplateRequest = z.object({
  args: z.record(z.string(), z.string()).default({}),
  titleOverride: z.string().optional(),
});
export type RunTemplateRequest = z.infer<typeof RunTemplateRequest>;

export const CreateScheduleRequest = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  templateId: z.string().min(1),
  templateArgs: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const SendInputRequest = z.object({
  text: z.string(),
});
export type SendInputRequest = z.infer<typeof SendInputRequest>;

export const PairExchangeRequest = z.object({
  pairingToken: z.string(),
  deviceLabel: z.string(),
});
export type PairExchangeRequest = z.infer<typeof PairExchangeRequest>;

export const PairExchangeResponse = z.object({
  sessionToken: z.string(),
  expiresAt: z.number(),
});
export type PairExchangeResponse = z.infer<typeof PairExchangeResponse>;

// ── Device sessions ─────────────────────────────────────────────────
//
// A "session" is a long-lived bearer token issued to a paired device. The
// daemon stores them hashed in `agentd.db`. The Devices view lets the
// operator audit and revoke them.

export const DeviceSession = z.object({
  id: z.string(),
  deviceLabel: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  expiresAt: z.number().nullable(),
  /** True when the request that listed sessions used this exact session. */
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

// ── Projects ────────────────────────────────────────────────────────
//
// A project is a stable handle for a working directory. One project can
// host many tasks (each on its own worktree branch). Auto-created when a
// task spawns at a path that doesn't have one yet.

export const Project = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  path: z.string(),
  color: z.string().nullable().optional(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  // Aggregates (populated on list endpoint).
  taskCount: z.number().optional(),
  activeCount: z.number().optional(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectRequest = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  color: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// ── Skills ──────────────────────────────────────────────────────────
//
// A skill is a directory containing a SKILL.md file with YAML frontmatter
// + a markdown body. Skills get appended to the agent's system prompt
// when activated for a task. Sources, in priority order:
//   - "local"  : <repoPath>/.agents/skills/<name>/SKILL.md  (per-project)
//   - "global" : <agentdRoot>/skills/<name>/SKILL.md         (per-server)
//   - "claude" : ~/.claude/skills/<name>/SKILL.md            (read-only)
//   - "codex"  : ~/.codex/skills/<name>/SKILL.md             (read-only)

export const SkillScope = z.enum(["global", "local", "claude", "codex"]);
export type SkillScope = z.infer<typeof SkillScope>;

export const Skill = z.object({
  name: z.string().min(1),
  scope: SkillScope,
  path: z.string(), // absolute filesystem path to the SKILL.md
  displayName: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean(),
  body: z.string(),
  // Untyped frontmatter for forward-compatibility with provider-specific keys.
  metadata: z.record(z.string(), z.unknown()),
  // Where this skill lives relative to its scope root (e.g. "review-pr").
  slug: z.string(),
  // Optional: writable scopes get this. Read-only ones (claude/codex) are
  // false; the web UI hides edit/delete affordances.
  writable: z.boolean(),
});
export type Skill = z.infer<typeof Skill>;

export const CreateSkillRequest = z.object({
  scope: z.enum(["global", "local"]),
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-_]*$/, {
    message: "name must be a slug (a-z, 0-9, -, _)",
  }),
  displayName: z.string().optional(),
  description: z.string().optional(),
  body: z.string().default(""),
  // For "local" scope, callers must supply the repo path so the daemon
  // knows where the .agents/skills/ directory lives.
  repoPath: z.string().optional(),
});
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;

export const UpdateSkillRequest = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
});
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequest>;

// ── tmux / terminal sessions ──
//
// Persistent shells the daemon hosts via tmux. The browser's xterm pane
// attaches to one of these via /pty/term/:name; the tmux server keeps it
// alive across disconnects and across browser tabs.

export const TerminalSession = z.object({
  name: z.string(),
  windows: z.number().int().nonnegative(),
  attached: z.boolean(),
  createdAt: z.number().int(),
  activity: z.number().int().nullable(),
});
export type TerminalSession = z.infer<typeof TerminalSession>;

export const CreateTerminalSessionRequest = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.\-: ]+$/, {
      message: "name may only contain letters, digits, _ . - : space",
    }),
  cwd: z.string().optional(),
});
export type CreateTerminalSessionRequest = z.infer<
  typeof CreateTerminalSessionRequest
>;

export const RenameTerminalSessionRequest = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.\-: ]+$/, {
      message: "name may only contain letters, digits, _ . - : space",
    }),
});
export type RenameTerminalSessionRequest = z.infer<
  typeof RenameTerminalSessionRequest
>;

export const TerminalWindow = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  active: z.boolean(),
  panes: z.number().int().nonnegative(),
  activity: z.number().int().nullable(),
});
export type TerminalWindow = z.infer<typeof TerminalWindow>;

export const CreateTerminalWindowRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  cwd: z.string().optional(),
});
export type CreateTerminalWindowRequest = z.infer<
  typeof CreateTerminalWindowRequest
>;

export const RenameTerminalWindowRequest = z.object({
  name: z.string().min(1).max(64),
});
export type RenameTerminalWindowRequest = z.infer<
  typeof RenameTerminalWindowRequest
>;

export const SendTerminalKeysRequest = z.object({
  text: z.string(),
  enter: z.boolean().optional(),
});
export type SendTerminalKeysRequest = z.infer<typeof SendTerminalKeysRequest>;

export const WsServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    taskId: z.string(),
    event: AgentEvent,
    ts: z.number(),
  }),
  z.object({
    type: z.literal("task_updated"),
    task: Task,
  }),
  z.object({
    type: z.literal("hello"),
    serverVersion: z.string(),
  }),
  // Pushed when tmux sessions are created / killed / renamed. Carries the
  // fresh snapshot so the web doesn't have to refetch.
  z.object({
    type: z.literal("terminal_sessions"),
    sessions: z.array(TerminalSession),
    ts: z.number(),
  }),
  // Pushed when windows within a specific session change.
  z.object({
    type: z.literal("terminal_windows"),
    sessionName: z.string(),
    windows: z.array(TerminalWindow),
    ts: z.number(),
  }),
]);
export type WsServerEvent = z.infer<typeof WsServerEvent>;
