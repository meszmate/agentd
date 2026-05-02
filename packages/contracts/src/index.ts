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

/**
 * Where the agent's filesystem changes land.
 *
 *   worktree — agentd creates a fresh git worktree at
 *     <root>/worktrees/<task-id>/ on a new branch off baseBranch. Default,
 *     parallel-safe, doesn't touch the operator's checkout.
 *   in_place — the agent works directly inside the project's repo. No
 *     extra worktree. Useful for "just run a quick refactor on my actual
 *     branch" but unsafe if the worktree has uncommitted changes.
 */
export const WorkspaceMode = z.enum(["worktree", "in_place"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

/**
 *   new      — create a fresh branch (auto-named or via `branchName`).
 *   existing — switch the worktree onto an existing branch and work there.
 */
export const BranchMode = z.enum(["new", "existing"]);
export type BranchMode = z.infer<typeof BranchMode>;

/**
 * Reasoning / thinking effort. Mirrors Claude CLI's `--effort` enum so
 * Claude tasks can pass it through verbatim. Codex maps these to its
 * `model_reasoning_effort` config (`max` → `xhigh`, the rest are 1:1).
 *
 *   low     — minimal reasoning; fastest and cheapest.
 *   medium  — balanced.
 *   high    — default. Solid for multi-step engineering work.
 *   max     — extended thinking budget; slower, deeper.
 *   xhigh   — Claude's deepest tier (alias of `max` on Codex).
 */
export const ThinkingLevel = z.enum(["low", "medium", "high", "max", "xhigh"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/**
 * One candidate agent in a council. Each member runs the same prompt in
 * its own worktree; the judge picks a winner after all members exit.
 */
export const CouncilMember = z.object({
  agent: z.enum(["claude", "codex"]),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevel.optional(),
  /** Short label for UI ("opus xhigh", "sonnet high", "gpt-5-codex"). */
  label: z.string().optional(),
});
export type CouncilMember = z.infer<typeof CouncilMember>;

export const CouncilStatus = z.enum([
  "running",
  "judging",
  "done",
  "failed",
]);
export type CouncilStatus = z.infer<typeof CouncilStatus>;

export const Council = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  repoPath: z.string(),
  baseBranch: z.string(),
  prompt: z.string(),
  status: CouncilStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Task ids that belong to this council, in spawn order. */
  taskIds: z.array(z.string()),
  /** Set once the judge picks (or the operator does manually). */
  winnerTaskId: z.string().nullable(),
  /** One-line rationale from the judge. Empty for manual picks. */
  judgeExplanation: z.string().nullable(),
});
export type Council = z.infer<typeof Council>;

export const CreateCouncilRequest = z.object({
  projectId: z.string().optional(),
  repoPath: z.string().min(1),
  baseBranch: z.string().default("main"),
  prompt: z.string().min(1),
  /** 2–5 members. Each spawns its own task + worktree on a unique branch. */
  members: z.array(CouncilMember).min(2).max(5),
  /** Optional task title — defaults to the prompt's first line. */
  title: z.string().optional(),
});
export type CreateCouncilRequest = z.infer<typeof CreateCouncilRequest>;

/**
 * Where a running task mirrors its events. When set, every agent message,
 * tool call, permission request, progress note, and exit gets forwarded
 * to the named chat. Replies in that chat get fed back as steered input.
 *
 * `chatId` is platform-specific (a Telegram chat id, a Discord channel id),
 * stored as a string so we don't lose precision on Telegram's int64 ids.
 */
export const MirrorTarget = z.object({
  platform: z.enum(["telegram", "discord"]),
  chatId: z.string().min(1),
});
export type MirrorTarget = z.infer<typeof MirrorTarget>;

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
  workspaceMode: WorkspaceMode.optional(),
  thinkingLevel: ThinkingLevel.optional(),
  /**
   * Per-task model override. Empty = inherit the configured agent default.
   * Set per task in the spawn UI or changed mid-task from the header chip.
   */
  model: z.string().optional(),
  /**
   * When set, the task mirrors events to a chat (Telegram or Discord) and
   * accepts replies as steered input. Toggle from the task header chip.
   */
  mirrorTo: MirrorTarget.nullable().optional(),
  /**
   * Council membership — set when the task was spawned as one of N
   * parallel candidates against the same prompt. The council page
   * groups its members and runs the judge when all of them exit.
   */
  councilId: z.string().nullable().optional(),
  /**
   * When set, the task is "closed" — typically because its PR merged or
   * the operator decided it's no longer relevant. Closed tasks default
   * to filtered out of list views. Closed tasks can be reopened.
   */
  closedAt: z.number().nullable().optional(),
  /** Why the task was closed: "merged" | "abandoned" | "manual" | etc. */
  closedReason: z.string().nullable().optional(),
});
export type Task = z.infer<typeof Task>;

/**
 *   task     — fires on schedule, spawns a real agent task.
 *   ideation — fires on schedule, runs a small AI helper that suggests
 *              N options for the operator to pick from. Picking spawns
 *              a real task with the chosen option as its prompt. This
 *              is the "AGI is thinking about your project while you're
 *              away" loop — the agent proposes, you approve.
 */
export const TemplateKind = z.enum(["task", "ideation"]);
export type TemplateKind = z.infer<typeof TemplateKind>;

export const Template = z.object({
  id: z.string(),
  name: z.string(),
  agent: AgentKind,
  kind: TemplateKind.default("task"),
  /** Optional — when set, repoPath is resolved from the project at run time. */
  projectId: z.string().nullable(),
  repoPath: z.string(),
  baseBranch: z.string(),
  promptTemplate: z.string(),
  autoPush: z.boolean(),
  autoPr: z.boolean(),
  /** All these knobs propagate into the spawned task — overridable per-run. */
  permissionMode: PermissionMode.default("bypassPermissions"),
  thinkingLevel: ThinkingLevel.default("high"),
  model: z.string().default(""),
  workspaceMode: WorkspaceMode.default("worktree"),
  branchMode: BranchMode.default("new"),
  pullLatest: z.boolean().default(false),
  skills: z.array(z.string()).default([]),
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
  z.object({
    /**
     * Structured progress note the agent posts via `agentd progress` after
     * each meaningful step. The text is what the agent did; `done: true`
     * signals the work is complete and the runner is about to wrap up.
     * Mirrored chats render these as the primary status update — they're
     * meant to be the digest stream when you're not at the computer.
     */
    kind: z.literal("progress"),
    text: z.string(),
    done: z.boolean().optional(),
  }),
  z.object({
    /**
     * Non-blocking forward-looking thought. The agent broadcasts what it
     * is *considering* next so the operator can nudge before commitment.
     * No reply required — the agent keeps working. Posted via
     * `agentd-share "<thought>"`.
     */
    kind: z.literal("share"),
    text: z.string(),
  }),
  z.object({
    /**
     * Blocking decision request. The agent stops, lists 1-N options, and
     * waits for the operator to pick one (by index or free-form text).
     * The next steered input from the user becomes the answer.
     *
     *   askId   — short stable id, used to correlate the answer
     *   prompt  — one-line question
     *   options — ordered choices the operator can pick by index
     */
    kind: z.literal("ask"),
    askId: z.string(),
    prompt: z.string(),
    options: z.array(z.string()),
  }),
  z.object({
    /**
     * The operator's answer to a previous `ask`. Surfaced as its own
     * event so the timeline shows the full Q→A pair clearly.
     */
    kind: z.literal("answer"),
    askId: z.string(),
    answer: z.string(),
  }),
  z.object({
    /**
     * Fan-out signal that the task's todos table changed — emitted
     * after the runner's TodoWrite/update_plan plan is mirrored into
     * the todos table. The web invalidates its `todos` query on this
     * to refresh the sidebar without polling.
     */
    kind: z.literal("todos_updated"),
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
  // Workspace setup — how the agent's checkout is prepared.
  workspaceMode: WorkspaceMode.optional(),
  branchMode: BranchMode.optional(),
  branchName: z.string().optional(),
  pullLatest: z.boolean().optional(),
  thinkingLevel: ThinkingLevel.optional(),
  model: z.string().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CreateTemplateRequest = z.object({
  name: z.string().min(1),
  agent: AgentKind,
  kind: TemplateKind.optional(),
  /** Either projectId OR repoPath is required. projectId wins if both set. */
  projectId: z.string().optional(),
  repoPath: z.string().optional(),
  baseBranch: z.string().default("main"),
  promptTemplate: z.string().min(1),
  autoPush: z.boolean().default(false),
  autoPr: z.boolean().default(false),
  permissionMode: PermissionMode.optional(),
  thinkingLevel: ThinkingLevel.optional(),
  model: z.string().optional(),
  workspaceMode: WorkspaceMode.optional(),
  branchMode: BranchMode.optional(),
  pullLatest: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>;

/**
 * Output of an ideation template run. The AI helper proposed N options
 * the operator can pick from. Picking spawns a real task with the
 * chosen option as its prompt; dismissing closes it without action.
 */
export const SuggestionStatus = z.enum([
  "pending",
  "resolved",
  "dismissed",
]);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

export const Suggestion = z.object({
  id: z.string(),
  templateId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** Short title for UI listing, derived from the source template name. */
  title: z.string(),
  /** The ideation prompt that produced these options. */
  prompt: z.string(),
  /** Numbered options — pick by index (0..N-1) or write a free-form answer. */
  options: z.array(z.string()),
  status: SuggestionStatus,
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
  /** Index of the chosen option, or -1 if a free-form answer was used. */
  chosenIndex: z.number().nullable(),
  /** The resolved choice text — either an option or a free-form answer. */
  chosenText: z.string().nullable(),
  /** Task spawned from the resolved choice (null when dismissed). */
  spawnedTaskId: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/**
 * First-class todo. Either project-scoped (taskId == null) or pinned to
 * a specific task. The agent's `TodoWrite` / `update_plan` tool calls
 * sync into the same table so the operator's manual todos and the
 * agent's plan share one view.
 */
export const TodoStatus = z.enum(["pending", "in_progress", "done", "cancelled"]);
export type TodoStatus = z.infer<typeof TodoStatus>;

export const TodoSource = z.enum(["user", "agent"]);
export type TodoSource = z.infer<typeof TodoSource>;

export const Todo = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  text: z.string(),
  status: TodoStatus,
  source: TodoSource,
  /** Sort order within its scope (project or task). Lower = earlier. */
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoRequest = z.object({
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  text: z.string().min(1),
  status: TodoStatus.optional(),
  source: TodoSource.optional(),
});
export type CreateTodoRequest = z.infer<typeof CreateTodoRequest>;

export const UpdateTodoRequest = z.object({
  text: z.string().optional(),
  status: TodoStatus.optional(),
  sortOrder: z.number().optional(),
});
export type UpdateTodoRequest = z.infer<typeof UpdateTodoRequest>;

export const ResolveSuggestionRequest = z.object({
  /** Pick an option by index (0..N-1). Required unless `text` is set. */
  index: z.number().int().min(0).optional(),
  /** Free-form prompt that overrides the option list. */
  text: z.string().optional(),
});
export type ResolveSuggestionRequest = z.infer<typeof ResolveSuggestionRequest>;

export const RunTemplateRequest = z.object({
  args: z.record(z.string(), z.string()).default({}),
  titleOverride: z.string().optional(),
  /** Per-run overrides — anything set here wins over the template's own values. */
  permissionMode: PermissionMode.optional(),
  thinkingLevel: ThinkingLevel.optional(),
  model: z.string().optional(),
  workspaceMode: WorkspaceMode.optional(),
  branchMode: BranchMode.optional(),
  branchName: z.string().optional(),
  pullLatest: z.boolean().optional(),
  autoPush: z.boolean().optional(),
  autoPr: z.boolean().optional(),
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
  z.object({
    type: z.literal("suggestion_created"),
    suggestion: Suggestion,
    ts: z.number(),
  }),
  z.object({
    type: z.literal("suggestion_updated"),
    suggestion: Suggestion,
    ts: z.number(),
  }),
]);
export type WsServerEvent = z.infer<typeof WsServerEvent>;
