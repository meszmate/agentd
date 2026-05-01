import type { AgentEvent } from "@agentd/contracts";
import type {
  AgentRunner,
  PermissionMode,
  RunnerEventListener,
  RunnerStartOptions,
} from "./types.ts";
import { readLines } from "./lineStream.ts";

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

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
    usage?: ClaudeUsage;
  };
  result?: string;
  is_error?: boolean;
  tool_use_id?: string;
  content?: unknown;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  cost_usd?: number;
  // Wrapped SSE streaming events when --include-partial-messages is on.
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string; partial_json?: string };
    content_block?: { type?: string; index?: number };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ClaudeRunnerOptions {
  binary?: string;
  defaultPermissionMode?: PermissionMode;
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
    const mode =
      opts.permissionMode ??
      this.opts.defaultPermissionMode ??
      "bypassPermissions";
    args.push("--permission-mode", mode);
    if (mode === "bypassPermissions") {
      args.push("--allow-dangerously-skip-permissions");
    }
    // Reasoning effort. Claude's CLI takes --effort directly; we just clamp
    // to its accepted set. Default to `high` so casual single-line prompts
    // still get real thinking time.
    const effort = opts.thinkingLevel ?? "high";
    args.push("--effort", effort);
    if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    // Grant Claude access to extra dirs (active skill bundles) so it can
    // Read their SKILL.md / scripts on demand. Each dir is a separate
    // --add-dir occurrence; Claude dedupes against cwd internally.
    if (opts.additionalReadDirs?.length) {
      for (const d of opts.additionalReadDirs) {
        args.push("--add-dir", d);
      }
    }
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

  /**
   * Streaming text accumulators, keyed by content-block index. We re-emit
   * deltas to the daemon's event bus so the web can render them live; the
   * `kind:"message"` event still fires on block_stop and carries the final
   * text (which goes into the messages table).
   */
  private streamBuf = new Map<number, string>();
  private streamId(index: number): string {
    return `cb-${index}`;
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

    // ── Partial-message events (--include-partial-messages) ──
    if (type === "stream_event" && parsed.event) {
      const ev = parsed.event;
      if (ev.type === "content_block_start") {
        const idx = Number(ev.index ?? 0);
        if (ev.content_block?.type === "text") {
          this.streamBuf.set(idx, "");
        }
      } else if (ev.type === "content_block_delta") {
        const idx = Number(ev.index ?? 0);
        if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          const prev = this.streamBuf.get(idx) ?? "";
          this.streamBuf.set(idx, prev + ev.delta.text);
          this.emit({
            kind: "message_delta",
            streamId: this.streamId(idx),
            delta: ev.delta.text,
          });
        }
      } else if (ev.type === "content_block_stop") {
        const idx = Number(ev.index ?? 0);
        if (this.streamBuf.has(idx)) {
          this.emit({ kind: "message_end", streamId: this.streamId(idx) });
          this.streamBuf.delete(idx);
        }
      } else if (ev.type === "message_stop") {
        // Backstop — flush any leftover streams that didn't get a stop.
        for (const idx of this.streamBuf.keys()) {
          this.emit({ kind: "message_end", streamId: this.streamId(idx) });
        }
        this.streamBuf.clear();
      }
      return;
    }

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
      const usage = parsed.message.usage;
      if (usage) {
        this.emit({
          kind: "usage",
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
        });
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
      // Note: parsed.result is a duplicate of the assistant turn's text — Claude
      // Code emits both `assistant` blocks (which we already surface as
      // kind=message,role=agent) and a final `result` echo. Re-emitting it
      // would render the reply twice in the timeline. Keep usage/cost only.
      const cost =
        typeof parsed.total_cost_usd === "number"
          ? parsed.total_cost_usd
          : typeof parsed.cost_usd === "number"
            ? parsed.cost_usd
            : undefined;
      if (parsed.usage || cost != null) {
        const usage = parsed.usage ?? {};
        this.emit({
          kind: "usage",
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
          ...(cost != null ? { costUsd: cost } : {}),
        });
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
