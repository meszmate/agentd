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
   * Extra directories the agent is allowed to Read outside its cwd. Used
   * to grant access to active skill directories so the agent can load
   * the catalog entries it cares about mid-conversation.
   */
  additionalReadDirs?: string[];
}

export type RunnerEventListener = (event: AgentEvent) => void;

export interface AgentRunner {
  readonly kind: AgentKind;
  readonly running: boolean;
  start(opts: RunnerStartOptions): Promise<void>;
  sendInput(text: string): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
  on(listener: RunnerEventListener): () => void;
}
