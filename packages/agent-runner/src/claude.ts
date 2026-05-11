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
    content_block?: { type?: string; index?: number };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Recognise the handful of stderr patterns claude-code emits when it
 * fails (auth, overload, rate limit, model permission). Returns a
 * `[claude] …` line with an actionable hint where applicable, or
 * `null` to pass the line through unchanged. The CLI doesn't ship a
 * machine-readable error stream so we pattern-match on the human
 * messages — keep this list short and ASCII-broad.
 */
function formatClaudeStderrLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const lc = trimmed.toLowerCase();

  // Anthropic API JSON error body: `{"type":"error","error":{"type":"...","message":"..."}}`.
  // The CLI sometimes dumps this verbatim before exiting.
  if (trimmed.startsWith("{") && lc.includes("\"type\":\"error\"")) {
    try {
      const obj = JSON.parse(trimmed) as {
        error?: { type?: string; message?: string };
      };
      const type = obj.error?.type;
      const message = obj.error?.message;
      if (typeof message === "string") {
        const head = type ? `${type}: ${message}` : message;
        const hint = claudeErrorHint(type ?? null, message);
        return hint ? `[claude] ${head}\nHint: ${hint}` : `[claude] ${head}`;
      }
    } catch {
      // not parseable — fall through to plain-text matching
    }
  }

  if (
    lc.includes("invalid api key") ||
    lc.includes("authentication_error") ||
    lc.includes("anthropic_api_key")
  ) {
    return `[claude] ${trimmed}\nHint: Run \`claude /login\` or set ANTHROPIC_API_KEY.`;
  }
  if (lc.includes("overloaded") || lc.includes("overloaded_error")) {
    return `[claude] ${trimmed}\nHint: Anthropic is overloaded. Wait a moment and steer to retry.`;
  }
  if (lc.includes("rate_limit") || lc.includes("rate limit")) {
    return `[claude] ${trimmed}\nHint: Rate limited. Wait, then steer to retry.`;
  }
  if (lc.includes("permission_error") || lc.includes("not authorized")) {
    return `[claude] ${trimmed}\nHint: Your account/org lacks access to this model. Pick a different model.`;
  }
  if (lc.includes("model") && lc.includes("not found")) {
    return `[claude] ${trimmed}\nHint: Unknown model. Check the model field in task settings.`;
  }
  return null;
}

function claudeErrorHint(
  type: string | null,
  message: string,
): string | null {
  const m = message.toLowerCase();
  if (type === "authentication_error" || m.includes("api key")) {
    return "Run `claude /login` or set ANTHROPIC_API_KEY.";
  }
  if (type === "overloaded_error" || m.includes("overloaded")) {
    return "Anthropic is overloaded. Wait a moment and steer to retry.";
  }
  if (type === "rate_limit_error" || m.includes("rate limit")) {
    return "Rate limited. Wait, then steer to retry.";
  }
  if (type === "permission_error") {
    return "Your account/org lacks access to this model. Pick a different model.";
  }
  if (type === "not_found_error") {
    return "Model not found. Check the model field in task settings.";
  }
  if (m.includes("context") && m.includes("length")) {
    return "Context window full. Run `/compact` or restart the task.";
  }
  return null;
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
  /**
   * Most recent friendly-formatted stderr error line. Used to dedupe
   * repeated emissions when the claude CLI flushes the same error
   * multiple times before exiting. Cleared on proc exit.
   */
  private lastFatalStderrLine: string | null = null;

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
    // Resume the prior session when respawning. We prefer
    // `--resume <session-id>` over `--continue` because `--continue`
    // resolves the most-recent session by cwd alone, and the cwd is
    // not unique to a task — a sibling plan slice in the same
    // worktree, or an AI helper (branch naming, commit drafting)
    // that happens to spawn `claude` in the same project dir, can
    // leave a more-recent session that `--continue` will pick up.
    // The resumed run then carries the wrong conversation history,
    // which surfaces as "the compacted summary belongs to a
    // different task". The session-id path pins resume to THIS
    // task's session. We capture the id from the first
    // `system/init` event below; until we have one, fall back to
    // `--continue` so legacy tasks that pre-date this column still
    // resume something.
    if (opts.resume) {
      if (opts.resumeSessionId) {
        args.push("--resume", opts.resumeSessionId);
      } else {
        args.push("--continue");
      }
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
          // Tag known API-error patterns with `[claude] …` and an
          // actionable hint where we recognise the shape. Everything
          // else passes through unchanged so debug lines / unknown
          // diagnostics aren't swallowed.
          const friendly = formatClaudeStderrLine(line);
          if (friendly && friendly === this.lastFatalStderrLine) continue;
          if (friendly) this.lastFatalStderrLine = friendly;
          this.emit({
            kind: "raw",
            stream: "stderr",
            text: friendly ?? line,
          });
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
      this.lastFatalStderrLine = null;
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
      // claude-code emits a synthetic `compact_boundary` system message
      // every time it auto-compacts (or the user runs /compact inside
      // claude). The boundary lands in the JSONL stream BEFORE the
      // post-compaction summary message, so by the time the daemon
      // sees it we still have the chance to mirror the prune in our
      // own history. Source: ~/claude-code/src/utils/messages.ts
      // (createCompactBoundaryMessage) + .../utils/messages/mappers.ts
      // (toSDKMessages — wraps it as { subtype: "compact_boundary",
      // compact_metadata: { trigger, pre_tokens, … } } on stdout).
      if (parsed.subtype === "compact_boundary") {
        const meta = parsed.compact_metadata as
          | { trigger?: "auto" | "manual"; pre_tokens?: number }
          | undefined;
        this.emit({
          kind: "auto_compacted",
          ...(meta?.trigger ? { trigger: meta.trigger } : {}),
          ...(typeof meta?.pre_tokens === "number"
            ? { preTokens: meta.pre_tokens }
            : {}),
        });
        return;
      }
      // The very first event each run is `{type:"system",subtype:"init",
      // session_id:"<uuid>", …}`. Capture the id and forward it as a
      // raw stdout marker — the daemon parses `[claude session] <uuid>`
      // and persists it on the task so subsequent spawns can use
      // `--resume <uuid>` instead of cwd-based `--continue`. The
      // session_id can come from a brand-new session OR a resumed one
      // (claude-code preserves the id across `--resume` unless the
      // operator passed `--fork-session`), so it's safe to emit on
      // every init — the daemon dedupes on its end.
      if (parsed.subtype === "init") {
        const sid = (parsed as { session_id?: unknown }).session_id;
        if (typeof sid === "string" && sid.length > 0) {
          this.emit({
            kind: "raw",
            stream: "stdout",
            text: `[claude session] ${sid}`,
          });
        }
        return;
      }
      // Other CLI bookkeeping (status pings, hook lifecycle, …) —
      // the operator can't act on any of it, so it stays off the timeline.
      return;
    }
    if (type === "rate_limit_event") {
      // Account-wide window snapshot — claude emits one per session at
      // start and an extra one when status flips (allowed → warn →
      // exceeded). Forward as a structured event so the daemon can
      // mirror it onto the singleton row keyed by provider and the
      // global header chip refreshes everywhere.
      const info = parsed.rate_limit_info as
        | {
            status?: unknown;
            rateLimitType?: unknown;
            resetsAt?: unknown;
            overageStatus?: unknown;
            overageDisabledReason?: unknown;
            isUsingOverage?: unknown;
          }
        | undefined;
      if (
        info &&
        typeof info.status === "string" &&
        typeof info.rateLimitType === "string" &&
        typeof info.resetsAt === "number"
      ) {
        this.emit({
          kind: "rate_limit",
          status: info.status,
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt,
          ...(typeof info.overageStatus === "string"
            ? { overageStatus: info.overageStatus }
            : {}),
          ...(typeof info.overageDisabledReason === "string"
            ? { overageDisabledReason: info.overageDisabledReason }
            : {}),
          ...(typeof info.isUsingOverage === "boolean"
            ? { isUsingOverage: info.isUsingOverage }
            : {}),
        });
      }
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
