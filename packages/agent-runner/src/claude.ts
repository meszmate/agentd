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
  /**
   * Set on assistant + user events that came from a sub-agent (Task
   * tool spawn). Claude-code wraps the sub-session's messages in the
   * parent process's stream-json with this field pointing at the
   * dispatching tool_use id, so we can reconstruct the swarm tree.
   */
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      id?: string;
      tool_use_id?: string;
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
    content_block?: {
      type?: string;
      index?: number;
      id?: string;
      name?: string;
    };
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
  readonly supportsLiveInput = true;
  private listeners = new Set<RunnerEventListener>();
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private streamTask: Promise<void> | null = null;
  private exitTask: Promise<void> | null = null;
  /**
   * True between writing a user message to stdin and seeing the
   * matching `result` event. We use it to gate status events: turn
   * boundaries get `running` / `done`, the proc-exit lifecycle is
   * separate (`kind:"exit"`).
   */
  private inTurn = false;
  /**
   * Map of tool_use_id → tool name, populated from `assistant` events
   * with `tool_use` blocks. When the matching `tool_result` shows up
   * on the next `user` event, we look up the name here so the
   * timeline can render `[result Bash ok …]` instead of an opaque
   * `[result (result) ok …]` that the web's parser used to drop into
   * the chat as a system row.
   */
  private toolUseNames = new Map<string, string>();

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
    // Long-lived stream-json mode: stdin drives the conversation. The
    // initial prompt is the first user message we write to stdin after
    // spawn — we don't pass `-p` here. Subsequent `sendInput` calls
    // inject between tool calls, so mid-turn steering works natively.
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    // Resume the prior session when respawning after a daemon restart
    // so the agent doesn't lose context. claude-code keeps session
    // history in `~/.claude/projects/<cwd-slug>/...` and `--continue`
    // pulls the most recent one for this cwd. The first turn of a
    // fresh task passes resume=false (no prior session to resume).
    if (opts.resume) {
      args.push("--continue");
    }
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
    // still get real thinking time. Codex's `minimal` tier doesn't exist on
    // claude — we map it to `low`, the closest equivalent. The other levels
    // are 1:1 with claude's flag values.
    const requested = opts.thinkingLevel ?? "high";
    const claudeEffort = requested === "minimal" ? "low" : requested;
    args.push("--effort", claudeEffort);
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
    // Per-run model override wins; otherwise fall back to the runner's
    // constructor-time default; if neither is set, let `claude` pick.
    const model = (opts.model && opts.model.trim()) || this.opts.model;
    if (model) args.push("--model", model);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const proc = Bun.spawn({
      cmd: [binary, ...args],
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...this.opts.env,
        ...(opts.env ?? {}),
      } as Record<string, string>,
    });
    this.proc = proc;
    // Don't emit `status:running` on spawn — the agent isn't doing work
    // yet. We emit it the moment we write the first user message to
    // stdin (`sendInput` below) so the meter only counts thinking time,
    // not boot time.
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
          // Suppress the CLI's "no stdin data received in 3s" warning —
          // it's harmless (we always feed stdin within milliseconds via
          // sendInput) but pollutes the timeline. Real errors still flow.
          if (line.includes("no stdin data received")) continue;
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
      this.inTurn = false;
      void Promise.allSettled([this.streamTask, stderrTask]);
    })();

    // Kick off the conversation by writing the user's first prompt.
    // From here the runner is fully driven by stdin: the task manager
    // calls `sendInput` for every subsequent turn (and for steering
    // mid-turn).
    await this.sendInput(opts.prompt);
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
  /**
   * Per-content-block tool_use metadata captured at `content_block_start`,
   * so the matching `input_json_delta` events can carry `toolUseId` +
   * `toolName` to the web before the final assistant `tool_use` block
   * arrives at block_stop. Cleared on block_stop. Without this map the
   * deltas would be unattributable — the web couldn't tell which in-flight
   * tool a partial-JSON chunk belongs to.
   */
  private toolBlocks = new Map<
    number,
    { id: string; name: string; parentToolUseId?: string }
  >();

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
      // Sub-agent (Task tool) partials carry parent_tool_use_id at the
      // top level so swarm-nested live previews can hang off the right
      // parent row in the timeline.
      const parentToolUseId =
        typeof parsed.parent_tool_use_id === "string"
          ? parsed.parent_tool_use_id
          : undefined;
      if (ev.type === "content_block_start") {
        const idx = Number(ev.index ?? 0);
        if (ev.content_block?.type === "text") {
          this.streamBuf.set(idx, "");
        } else if (
          ev.content_block?.type === "tool_use" &&
          typeof ev.content_block.id === "string" &&
          typeof ev.content_block.name === "string"
        ) {
          this.toolBlocks.set(idx, {
            id: ev.content_block.id,
            name: ev.content_block.name,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
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
        } else if (
          ev.delta?.type === "input_json_delta" &&
          typeof ev.delta.partial_json === "string"
        ) {
          const meta = this.toolBlocks.get(idx);
          if (meta) {
            this.emit({
              kind: "tool_input_delta",
              toolUseId: meta.id,
              toolName: meta.name,
              delta: ev.delta.partial_json,
              ...(meta.parentToolUseId
                ? { parentToolUseId: meta.parentToolUseId }
                : {}),
            });
          }
        }
      } else if (ev.type === "content_block_stop") {
        const idx = Number(ev.index ?? 0);
        if (this.streamBuf.has(idx)) {
          this.emit({ kind: "message_end", streamId: this.streamId(idx) });
          this.streamBuf.delete(idx);
        }
        this.toolBlocks.delete(idx);
      } else if (ev.type === "message_stop") {
        // Backstop — flush any leftover streams that didn't get a stop.
        for (const idx of this.streamBuf.keys()) {
          this.emit({ kind: "message_end", streamId: this.streamId(idx) });
        }
        this.streamBuf.clear();
        this.toolBlocks.clear();
      }
      return;
    }

    if (type === "assistant" && parsed.message?.content) {
      // `parent_tool_use_id` is the SDK's nesting key — claude-code
      // sets it on every assistant/user message that originated from a
      // sub-agent (Task tool spawn). Carry it onto each child event so
      // the daemon + web can render the swarm as a tree under the
      // dispatching Task row instead of flattening it.
      const parentToolUseId =
        typeof parsed.parent_tool_use_id === "string"
          ? parsed.parent_tool_use_id
          : undefined;
      for (const block of parsed.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          this.emit({
            kind: "message",
            role: "agent",
            text: block.text,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const toolUseId =
            typeof (block as { id?: unknown }).id === "string"
              ? ((block as { id?: string }).id as string)
              : undefined;
          // Remember the name keyed by id so the matching
          // `tool_result` event can emit a real tool name instead of
          // a generic placeholder. Without this lookup the result
          // header reads `[result (result) ok …]` and the web's
          // parser dumps it into the chat as a raw system row.
          if (toolUseId) this.toolUseNames.set(toolUseId, block.name);
          this.emit({
            kind: "tool_call",
            tool: block.name,
            args: block.input ?? {},
            ...(toolUseId ? { toolUseId } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
      const usage = parsed.message.usage;
      if (usage && !parentToolUseId) {
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
      const parentToolUseId =
        typeof parsed.parent_tool_use_id === "string"
          ? parsed.parent_tool_use_id
          : undefined;
      for (const block of parsed.message.content) {
        if (block.type === "tool_result") {
          const content = block as {
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          const text =
            typeof content.content === "string"
              ? content.content
              : JSON.stringify(content.content ?? null);
          // Look up the tool name from the call we saw earlier in
          // this turn. Without this the timeline shows `[result
          // (result) ok …]` for orphan rows.
          const toolName =
            (content.tool_use_id &&
              this.toolUseNames.get(content.tool_use_id)) ||
            "tool";
          this.emit({
            kind: "tool_result",
            tool: toolName,
            ok: !content.is_error,
            output: text,
            ...(content.tool_use_id ? { toolUseId: content.tool_use_id } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
      return;
    }
    if (type === "result") {
      const parentToolUseId =
        typeof parsed.parent_tool_use_id === "string"
          ? parsed.parent_tool_use_id
          : undefined;
      if (parentToolUseId) return;
      // Note: parsed.result is a duplicate of the assistant turn's text — Claude
      // Code emits both `assistant` blocks (which we already surface as
      // kind=message,role=agent) and a final `result` echo. Re-emitting it
      // would render the reply twice in the timeline. Keep cost only:
      // token usage here is aggregate run spend, not the current live
      // context. Assistant message usage above carries the live turn.
      const cost =
        typeof parsed.total_cost_usd === "number"
          ? parsed.total_cost_usd
          : typeof parsed.cost_usd === "number"
            ? parsed.cost_usd
            : undefined;
      if (cost != null) {
        this.emit({
          kind: "usage",
          costUsd: cost,
        });
      }
      // Turn boundary — agent is now idle waiting for the next stdin
      // message. Emit `idle` (not `done`) so the sidebar doesn't show
      // a still-active task as finished. `done` is reserved for the
      // proc actually exiting (kind:"exit").
      if (this.inTurn) {
        this.inTurn = false;
        this.emit({ kind: "status", status: "idle" });
      }
      return;
    }
    if (type === "system") {
      // CLI bookkeeping (init, status pings, hook lifecycle, etc.) — the
      // operator can't act on any of it, so it stays off the timeline.
      return;
    }
    if (type === "rate_limit_event") {
      // Pure rate-limit telemetry from the CLI — no info the operator
      // can act on. Suppress.
      return;
    }
    // Unknown event type — surface as raw for visibility.
    this.emit({ kind: "raw", stream: "stdout", text: line });
  }

  /**
   * Write a user message to claude's stdin in the stream-json input
   * format. Claude reads stdin between tool calls so this doubles as
   * "send next turn" (when idle) and "steer mid-turn" (when running).
   * The CLI buffers messages itself — we don't need to wait for a turn
   * boundary before writing.
   */
  async sendInput(text: string): Promise<void> {
    const proc = this.proc;
    if (!proc) throw new Error("claude runner not started");
    if (!this.inTurn) {
      this.inTurn = true;
      this.emit({ kind: "status", status: "running" });
    }
    const userMsg = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
    const line = JSON.stringify(userMsg) + "\n";
    try {
      const stdin = proc.stdin as { write: (s: string) => unknown; flush?: () => unknown };
      stdin.write(line);
      stdin.flush?.();
    } catch (e) {
      this.emit({
        kind: "raw",
        stream: "stderr",
        text: `[stdin write failed] ${(e as Error).message}`,
      });
      throw e;
    }
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    // Graceful shutdown: close stdin so claude reads EOF and exits
    // with code 0 the moment its current turn settles. Don't send a
    // signal alongside — that would force a non-zero exit and the
    // task would be marked "failed" even when the agent finished
    // cleanly via `agentd-progress --done`.
    try {
      const stdin = proc.stdin as { end?: () => unknown };
      stdin.end?.();
    } catch {
      // ignore
    }
    // Race the graceful exit against a generous timeout. If claude
    // hasn't exited within ~10s (e.g. it's stuck mid-tool-call), THEN
    // we escalate to a signal.
    const graceful = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      void proc.exited.then(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (await graceful) return;
    try {
      proc.kill(signal);
    } catch {
      // already dead
    }
    try {
      await proc.exited;
    } catch {
      // ignore
    }
  }
}
