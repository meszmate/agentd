import type { AgentEvent, AgentKind } from "@agentd/contracts";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type ThinkingLevel = "low" | "medium" | "high" | "max" | "xhigh";

export interface RunnerStartOptions {
  prompt: string;
  cwd: string;
  resume?: boolean;
  permissionMode?: PermissionMode;
  /**
   * Reasoning effort — `high` by default. Each runner translates it to its
   * native flag (Claude `--effort`, Codex `model_reasoning_effort`).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Per-run model override. Empty string / undefined inherits the runner's
   * constructor-time `model` (or the CLI's own default if neither is set).
   */
  model?: string;
  /** Appended to the agent's system prompt for this run. */
  appendSystemPrompt?: string;
  /**
   * Codex-only — when set, spawn `codex exec resume <id>` instead of
   * a fresh `codex exec`, so AGENTS.md/MCP init carries over and the
   * conversation keeps its prior context. Captured by the runner on
   * the first turn (`thread.started` stream event) and persisted on
   * the task; the daemon passes it back on every subsequent steer.
   * Other runners ignore this field.
   */
  resumeThreadId?: string;
  /**
   * Extra directories the agent is allowed to Read outside its cwd. Used
   * to grant access to active skill directories so the agent can load
   * the catalog entries it cares about mid-conversation.
   */
  additionalReadDirs?: string[];
  /**
   * Per-run env additions, merged into the runner's own env at spawn.
   * Used by the daemon to expose AGENTD_TASK_ID / AGENTD_DAEMON_URL /
   * AGENTD_TOKEN so the agent's `agentd progress` Bash calls work.
   */
  env?: Record<string, string>;
}

export type RunnerEventListener = (event: AgentEvent) => void;

export interface AgentRunner {
  readonly kind: AgentKind;
  readonly running: boolean;
  /**
   * True if `sendInput` works on a live runner (long-lived stream-json
   * model). False means each input requires a fresh `start()` call (the
   * task manager's spawn-per-turn fallback).
   *
   * Claude runs in long-lived stream-json mode so `sendInput` injects
   * user messages between tool calls — true mid-turn steering. Codex's
   * `exec` subcommand is single-shot and doesn't accept stdin streaming,
   * so the manager keeps spawning fresh codex processes per turn.
   */
  readonly supportsLiveInput: boolean;
  start(opts: RunnerStartOptions): Promise<void>;
  sendInput(text: string): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
  on(listener: RunnerEventListener): () => void;
  /**
   * Codex captures a session/thread id from its stream so the daemon
   * can persist it and pass it back as `resumeThreadId` on the next
   * spawn. Other runners return null.
   */
  getThreadId?(): string | null;
}
