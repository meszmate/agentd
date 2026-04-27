import type { AgentEvent } from "@agentd/contracts";
import type {
  AgentRunner,
  RunnerEventListener,
  RunnerStartOptions,
} from "./types.ts";
import { readLines } from "./lineStream.ts";

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  result?: string;
  is_error?: boolean;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ClaudeRunnerOptions {
  binary?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
}

export class ClaudeRunner implements AgentRunner {
  readonly kind = "claude" as const;
  private listeners = new Set<RunnerEventListener>();
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private streamTask: Promise<void> | null = null;
  private exitTask: Promise<void> | null = null;

  constructor(private readonly opts: ClaudeRunnerOptions = {}) {}

  get running(): boolean {
    return this.proc != null && this.proc.exitCode == null;
  }

  on(listener: RunnerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // listener errors are swallowed
      }
    }
  }

  async start(opts: RunnerStartOptions): Promise<void> {
    if (this.running) {
      throw new Error("claude runner already running");
    }
    const binary = this.opts.binary ?? "claude";
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (opts.resume) args.push("--continue");
    if (this.opts.permissionMode)
      args.push("--permission-mode", this.opts.permissionMode);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const proc = Bun.spawn({
      cmd: [binary, ...args],
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.opts.env } as Record<string, string>,
    });
    this.proc = proc;
    this.emit({ kind: "status", status: "running" });

    this.streamTask = (async () => {
      try {
        for await (const line of readLines(proc.stdout)) {
          this.handleStdoutLine(line);
        }
      } catch (e) {
        this.emit({
          kind: "raw",
          stream: "stderr",
          text: `[stream read error] ${(e as Error).message}`,
        });
      }
    })();

    const stderrTask = (async () => {
      try {
        for await (const line of readLines(proc.stderr)) {
          this.emit({ kind: "raw", stream: "stderr", text: line });
        }
      } catch {
        // ignore
      }
    })();

    this.exitTask = (async () => {
      const code = await proc.exited;
      // Status must be emitted before exit — listeners may unsubscribe on exit.
      this.emit({
        kind: "status",
        status: code === 0 ? "done" : "failed",
      });
      this.emit({ kind: "exit", code: code ?? null });
      if (this.proc === proc) this.proc = null;
      void Promise.allSettled([this.streamTask, stderrTask]);
    })();
  }

  private handleStdoutLine(line: string): void {
    let parsed: ClaudeStreamMessage | null = null;
    try {
      parsed = JSON.parse(line) as ClaudeStreamMessage;
    } catch {
      this.emit({ kind: "raw", stream: "stdout", text: line });
      return;
    }
    if (!parsed) return;

    const type = parsed.type;
    if (type === "assistant" && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          this.emit({ kind: "message", role: "agent", text: block.text });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          this.emit({
            kind: "tool_call",
            tool: block.name,
            args: block.input ?? {},
          });
        }
      }
      return;
    }
    if (type === "user" && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === "tool_result") {
          const content = block as { content?: unknown; is_error?: boolean };
          const text =
            typeof content.content === "string"
              ? content.content
              : JSON.stringify(content.content ?? null);
          this.emit({
            kind: "tool_result",
            tool: "(result)",
            ok: !content.is_error,
            output: text,
          });
        }
      }
      return;
    }
    if (type === "result") {
      if (typeof parsed.result === "string") {
        this.emit({ kind: "message", role: "system", text: parsed.result });
      }
      return;
    }
    if (type === "system") {
      // Surface system events as raw for debugging; not noisy in normal use.
      this.emit({
        kind: "raw",
        stream: "stdout",
        text: `[system] ${parsed.subtype ?? ""}`,
      });
      return;
    }
    // Unknown event type — surface as raw for visibility.
    this.emit({ kind: "raw", stream: "stdout", text: line });
  }

  async sendInput(_text: string): Promise<void> {
    // MVP: each user input is a fresh `claude --continue` invocation by the
    // task manager. Live stdin streaming requires --input-format stream-json
    // with a different process model and lands in a follow-up.
    throw new Error(
      "sendInput requires the task manager to spawn a new --continue invocation",
    );
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.kill(signal);
    try {
      await proc.exited;
    } catch {
      // ignore
    }
  }
}
