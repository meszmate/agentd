import type { AgentRunner, RunnerEventListener, RunnerStartOptions } from "./types.ts";

export class CodexRunner implements AgentRunner {
  readonly kind = "codex" as const;
  readonly running = false;
  on(_listener: RunnerEventListener): () => void {
    return () => {};
  }
  async start(_opts: RunnerStartOptions): Promise<void> {
    throw new Error("codex runner not implemented yet");
  }
  async sendInput(_text: string): Promise<void> {
    throw new Error("codex runner not implemented yet");
  }
  async stop(): Promise<void> {
    /* no-op */
  }
}
