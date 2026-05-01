import type { AgentEvent, AgentKind } from "@agentd/contracts";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export interface RunnerStartOptions {
  prompt: string;
  cwd: string;
  resume?: boolean;
  permissionMode?: PermissionMode;
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
