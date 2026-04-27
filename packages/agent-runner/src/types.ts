import type { AgentEvent, AgentKind } from "@agentd/contracts";

export interface RunnerStartOptions {
  prompt: string;
  cwd: string;
  resume?: boolean;
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
