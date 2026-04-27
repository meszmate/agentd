import type { AgentKind } from "@agentd/contracts";
import type { AgentRunner } from "./types.ts";
import { ClaudeRunner } from "./claude.ts";
import { CodexRunner } from "./codex.ts";

export type { AgentRunner, RunnerStartOptions, RunnerEventListener } from "./types.ts";
export { ClaudeRunner } from "./claude.ts";
export { CodexRunner } from "./codex.ts";

export function createRunner(kind: AgentKind): AgentRunner {
  switch (kind) {
    case "claude":
      return new ClaudeRunner();
    case "codex":
      return new CodexRunner();
  }
}
