import type { AgentEvent } from "@agentd/contracts";
import type {
  AgentRunner,
  PermissionMode,
  RunnerEventListener,
  RunnerStartOptions,
} from "./types.ts";
import { readLines } from "./lineStream.ts";

/**
 * Codex stream events. Source of truth lives at
 * `~/codex/codex-rs/exec/src/exec_events.rs` — the `ThreadEvent` enum
 * and `ThreadItemDetails` enum together describe everything codex
 * exec emits as JSONL. Keep this in sync by reading that file when
 * codex bumps its protocol.
 *
 * Top-level event types:
 *   thread.started   — { thread_id }
 *   turn.started     — {}
 *   turn.completed   — { usage }
 *   turn.failed      — { error }
 *   item.started     — { item }   (item is in_progress)
 *   item.updated     — { item }   (status / output growing)
 *   item.completed   — { item }   (final state)
 *   error            — { message } (fatal stream error)
 *
 * Item types (`item.type`, snake_case):
 *   agent_message      — { text }
 *   reasoning          — { text }
 *   command_execution  — { command, aggregated_output, exit_code, status }
 *   file_change        — { changes: [{ path, kind: add|update|delete }], status }
 *   mcp_tool_call      — { server, tool, arguments, result, error, status }
 *   collab_tool_call   — multi-agent collab (rare; treated as generic tool_call)
 *   web_search         — { query, action }
 *   todo_list          — { items: [{ text, completed }] }
 *   error              — { message }
 */
interface CodexCommandExecutionItem {
  type: "command_execution";
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: "in_progress" | "completed" | "failed" | "declined";
}
interface CodexFileChange {
  path: string;
  kind: "add" | "update" | "delete";
}
interface CodexFileChangeItem {
  type: "file_change";
  changes?: CodexFileChange[];
  status?: "in_progress" | "completed" | "failed";
}
interface CodexMcpToolCallItem {
  type: "mcp_tool_call";
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown[]; structured_content?: unknown } | null;
  error?: { message?: string } | null;
  status?: "in_progress" | "completed" | "failed";
}
interface CodexWebSearchItem {
  type: "web_search";
  query?: string;
  action?: unknown;
}
interface CodexTodoListItem {
  type: "todo_list";
  items?: { text: string; completed?: boolean }[];
}
interface CodexAgentMessageItem {
  type: "agent_message";
  text?: string;
}
interface CodexReasoningItem {
  type: "reasoning";
  text?: string;
}
interface CodexErrorItem {
  type: "error";
  message?: string;
}
type CodexItem = (
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexErrorItem
  | { type?: string; [k: string]: unknown }
) & { id?: string };

interface CodexStreamMessage {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
  [key: string]: unknown;
}

export interface CodexRunnerOptions {
  binary?: string;
  defaultPermissionMode?: PermissionMode;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
}

/**
 * Probe `codex exec --help` once per binary to learn which flags this
 * version actually supports. Codex versions ship different surfaces
 * for the approval/sandbox knobs; auto-detecting saves us from the
 * "unknown option --dangerously-bypass-approvals-and-sandbox" failure
 * mode on older builds.
 */
interface CodexRunnerCaps {
  supportsBypass: boolean;
  supportsSandboxFlag: boolean;
  supportsSkipGitRepoCheck: boolean;
  supportsFullAuto: boolean;
}
const RUNNER_CAPS_CACHE = new Map<string, CodexRunnerCaps>();
function detectCodexRunnerCaps(binary: string): CodexRunnerCaps {
  const hit = RUNNER_CAPS_CACHE.get(binary);
  if (hit) return hit;
  let caps: CodexRunnerCaps = {
    supportsBypass: false,
    supportsSandboxFlag: false,
    supportsSkipGitRepoCheck: false,
    supportsFullAuto: false,
  };
  try {
    const out = Bun.spawnSync({
      cmd: [binary, "exec", "--help"],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const text =
      new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    caps = {
      supportsBypass: text.includes("--dangerously-bypass-approvals-and-sandbox"),
      supportsSandboxFlag: /-s,\s*--sandbox\b/.test(text) || /\s--sandbox\b/.test(text),
      supportsSkipGitRepoCheck: text.includes("--skip-git-repo-check"),
      supportsFullAuto: text.includes("--full-auto"),
    };
  } catch {
    // probe failed — keep conservative defaults
  }
  RUNNER_CAPS_CACHE.set(binary, caps);
  return caps;
}

export class CodexRunner implements AgentRunner {
  readonly kind = "codex" as const;
  // Codex's `exec` subcommand is single-shot: each user input is a
  // fresh process. Mid-turn steering falls back to the queue path.
  readonly supportsLiveInput = false;
  private listeners = new Set<RunnerEventListener>();
  private proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private streamTask: Promise<void> | null = null;
  private exitTask: Promise<void> | null = null;
  private threadId: string | null = null;
  private suppressRouterErrorContinuation = false;

  constructor(private readonly opts: CodexRunnerOptions = {}) {}

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
    if (this.running) throw new Error("codex runner already running");
    const binary = this.opts.binary ?? "codex";
    const mode =
      opts.permissionMode ??
      this.opts.defaultPermissionMode ??
      "bypassPermissions";

    // Build args. Two subcommand shapes:
    //   - first turn:  `codex exec [flags] <prompt>`
    //   - subsequent:  `codex exec resume <thread_id> [flags] <prompt>`
    // Resume reuses the original session's cwd/AGENTS.md/MCP init —
    // we just pass the same flag set + the new prompt and codex picks
    // up where the prior turn left off. (`--cd` is not accepted on
    // resume; the original cwd is remembered.)
    const caps = detectCodexRunnerCaps(binary);
    const resumeId = opts.resumeThreadId?.trim() || null;
    const args: string[] = resumeId
      ? ["exec", "resume", resumeId, "--json"]
      : ["exec", "--json"];
    if (caps.supportsSkipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    if (mode === "bypassPermissions" || mode === "acceptEdits") {
      const forced = process.env.AGENTD_CODEX_APPROVAL_MODE;
      if (forced !== "off") {
        const wantConfig = forced === "config" || !caps.supportsBypass;
        if (forced === "bypass" || (!wantConfig && caps.supportsBypass)) {
          args.push("--dangerously-bypass-approvals-and-sandbox");
        } else {
          if (caps.supportsSandboxFlag) {
            args.push("--sandbox", "danger-full-access");
          } else {
            args.push("--config", 'sandbox_mode="danger-full-access"');
          }
          args.push("--config", 'approval_policy="never"');
        }
      }
    } else if (caps.supportsFullAuto && !resumeId) {
      // `--full-auto` is only valid on the bare `exec` subcommand;
      // resume already inherits the prior turn's mode.
      args.push("--full-auto");
    }
    const model = (opts.model && opts.model.trim()) || this.opts.model;
    if (model) args.push("--model", model);
    // Reasoning effort. Codex takes the level via -c model_reasoning_effort.
    // It accepts: minimal | low | medium | high | xhigh. Our `max` is Claude's
    // top tier, which corresponds to `xhigh` on Codex.
    const effort = opts.thinkingLevel ?? "high";
    const codexEffort = effort === "max" ? "xhigh" : effort;
    args.push("--config", `model_reasoning_effort="${codexEffort}"`);
    if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
      // codex doesn't have a dedicated --append-system-prompt flag; the next
      // best thing is prepending the instructions to the user prompt with a
      // clear separator. On resume turns the agent has already seen the
      // catalog/instructions, so just pass the raw prompt to avoid re-stuffing
      // tokens on every steer.
      if (!resumeId) {
        opts = {
          ...opts,
          prompt: `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}`,
        };
      }
    }
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    // No `--cd` flag — Bun.spawn's `cwd` below sets the process working
    // directory, and resume reuses the original session's cwd anyway.
    args.push(opts.prompt);

    // Critical: stdin must be `"ignore"` (i.e. /dev/null) here — NOT
    // `"pipe"`. Codex's `exec` subcommand checks whether stdin is a
    // tty; when stdin is piped it prints "Reading additional input
    // from stdin..." and blocks waiting for EOF before processing the
    // prompt. Bun never writes to or closes the pipe, so the process
    // hangs forever and the UI shows "Agent is thinking…" with no
    // events. Pointing stdin at /dev/null makes codex skip the stdin
    // read and proceed straight to the argv prompt. (Claude uses
    // stdin: "pipe" because its stream-json mode legitimately drives
    // the conversation through stdin — codex `exec` does not.)
    const proc = Bun.spawn({
      cmd: [binary, ...args],
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...this.opts.env,
        ...(opts.env ?? {}),
      } as Record<string, string>,
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
          this.handleStderrLine(line);
        }
      } catch {
        // ignore
      }
    })();

    this.exitTask = (async () => {
      const code = await proc.exited;
      // Status before exit so listeners that unsubscribe on exit see it.
      this.emit({
        kind: "status",
        status: code === 0 ? "done" : "failed",
      });
      this.emit({ kind: "exit", code: code ?? null });
      if (this.proc === proc) this.proc = null;
      void Promise.allSettled([this.streamTask, stderrTask]);
    })();
  }

  private handleStderrLine(line: string): void {
    if (line.includes("Reading additional input from stdin")) return;

    const startsLogRecord = /^\d{4}-\d{2}-\d{2}T\S+\s+(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(
      line,
    );
    if (this.suppressRouterErrorContinuation && !startsLogRecord) {
      return;
    }
    if (startsLogRecord) {
      this.suppressRouterErrorContinuation = false;
    }

    const routerError = /\bERROR\s+codex_core::tools::router:\s+error=(.*)$/s.exec(
      line,
    );
    if (routerError) {
      const detail = (routerError[1] ?? "tool failed").trim();
      const filePath = / in ([^:\n]+):/.exec(detail)?.[1];
      this.emit({
        kind: "tool_call",
        tool: "Edit",
        args: filePath ? { file_path: filePath } : { source: "tool-router" },
      });
      this.emit({
        kind: "tool_result",
        tool: "Edit",
        ok: false,
        output: detail.slice(0, 4000),
      });
      this.suppressRouterErrorContinuation = true;
      return;
    }

    this.emit({ kind: "raw", stream: "stderr", text: line });
  }

  /**
   * Per-item emission gate. Codex emits item.started + (optional)
   * item.updated + item.completed for the same id; we emit a
   * `tool_call` exactly once (on the first time we see the id) and a
   * `tool_result` exactly once (on completion). Without this gate we
   * either miss the call (when item.started is absent for fast items)
   * or duplicate it (when both started and completed fire).
   */
  private emittedCall = new Set<string>();

  private handleStdoutLine(line: string): void {
    let parsed: CodexStreamMessage | null = null;
    try {
      parsed = JSON.parse(line) as CodexStreamMessage;
    } catch {
      // Non-JSON line — codex occasionally writes a non-JSONL banner
      // or progress hint. Forward as raw stdout for diagnostics.
      this.emit({ kind: "raw", stream: "stdout", text: line });
      return;
    }
    if (!parsed) return;

    const t = parsed.type;

    // ── Top-level lifecycle events ─────────────────────────────────
    if (t === "thread.started" && typeof parsed.thread_id === "string") {
      this.threadId = parsed.thread_id;
      this.emit({
        kind: "raw",
        stream: "stdout",
        text: `[codex thread] ${this.threadId}`,
      });
      return;
    }
    if (t === "turn.started") return;
    if (t === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      this.emit({
        kind: "usage",
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cached_input_tokens,
      });
      return;
    }
    if (t === "turn.failed") {
      // The model errored out mid-turn (rate limit, network, etc.).
      // Surface as stderr so the task page shows a red banner; the
      // process will exit afterward and the runner emits status.
      const msg =
        parsed.error?.message ??
        (typeof parsed.message === "string" ? parsed.message : "turn failed");
      this.emit({ kind: "raw", stream: "stderr", text: `[codex] ${msg}` });
      return;
    }
    if (t === "error") {
      // Fatal stream error before/around the agent.
      const msg =
        (typeof parsed.message === "string" ? parsed.message : null) ??
        parsed.error?.message ??
        "stream error";
      this.emit({ kind: "raw", stream: "stderr", text: `[codex] ${msg}` });
      return;
    }

    // ── Item events ────────────────────────────────────────────────
    if (
      (t === "item.started" || t === "item.updated" || t === "item.completed") &&
      parsed.item
    ) {
      this.handleItemEvent(t, parsed.item);
      return;
    }

    // Anything else — drop silently. Codex evolves; the web renders
    // `raw` events as system rows in the chat, so unknown shapes
    // would leak as noise.
  }

  private handleItemEvent(
    eventType: string,
    item: CodexItem,
  ): void {
    const isCompleted = eventType === "item.completed";
    const itemId = item.id ?? "";

    // ── agent_message — final reply on completion ──────────────────
    if (item.type === "agent_message") {
      if (isCompleted) {
        const text = (item as CodexAgentMessageItem).text;
        if (typeof text === "string" && text.length > 0) {
          this.emit({ kind: "message", role: "agent", text });
        }
      }
      return;
    }

    // ── reasoning — internal chain of thought, drop silently ───────
    if (item.type === "reasoning") return;

    // ── command_execution — tool_call on first sight, result on done
    if (item.type === "command_execution") {
      const ci = item as CodexCommandExecutionItem;
      if (typeof ci.command === "string" && itemId && !this.emittedCall.has(itemId)) {
        this.emittedCall.add(itemId);
        this.emit({
          kind: "tool_call",
          tool: "Bash",
          args: { command: ci.command },
        });
      }
      if (isCompleted) {
        const out = typeof ci.aggregated_output === "string" ? ci.aggregated_output : "";
        const exit = typeof ci.exit_code === "number" ? ci.exit_code : null;
        const ok = exit === 0 || (exit == null && ci.status === "completed");
        const display =
          out ||
          (ci.status === "failed"
            ? `(failed${exit != null ? `, exit ${exit}` : ""})`
            : ci.status === "declined"
              ? "(declined by sandbox)"
              : `(no output${exit != null ? `, exit ${exit}` : ""})`);
        this.emit({
          kind: "tool_result",
          tool: "Bash",
          ok,
          output: display,
        });
      }
      return;
    }

    // ── file_change — emitted only on completion. Map each change to
    //    the closest claude-style tool name so the existing tool-line
    //    renderer (which keys off Read/Write/Edit) gives the right
    //    icon and per-file row.
    if (item.type === "file_change") {
      if (!isCompleted) return;
      const fci = item as CodexFileChangeItem;
      const changes = fci.changes ?? [];
      if (changes.length === 0) {
        this.emit({
          kind: "tool_result",
          tool: "Edit",
          ok: fci.status !== "failed",
          output: fci.status === "failed" ? "(patch failed)" : "(no changes)",
        });
        return;
      }
      // For one change, emit a single Write/Edit pair so it renders
      // as a normal file-edit row. For multiple, emit one MultiEdit
      // pair with a synthesized summary so the operator sees the full
      // set of paths. Either way the matching tool_result reflects
      // success/failure of the whole patch.
      if (changes.length === 1) {
        const c = changes[0]!;
        const tool = c.kind === "add" ? "Write" : c.kind === "delete" ? "Edit" : "Edit";
        this.emit({
          kind: "tool_call",
          tool,
          args: { file_path: c.path, codex_change_kind: c.kind },
        });
        this.emit({
          kind: "tool_result",
          tool,
          ok: fci.status !== "failed",
          output: fci.status === "failed" ? "(patch failed)" : `${c.kind} ${c.path}`,
        });
      } else {
        const summary = changes
          .map((c) => `${c.kind} ${c.path}`)
          .join("\n");
        this.emit({
          kind: "tool_call",
          tool: "MultiEdit",
          args: {
            file_paths: changes.map((c) => c.path),
            codex_changes: changes,
          },
        });
        this.emit({
          kind: "tool_result",
          tool: "MultiEdit",
          ok: fci.status !== "failed",
          output: fci.status === "failed" ? `(patch failed)\n${summary}` : summary,
        });
      }
      return;
    }

    // ── web_search — show as a WebSearch tool row. Codex emits
    //    started + completed; we pair them on the same id.
    if (item.type === "web_search") {
      const ws = item as CodexWebSearchItem;
      if (itemId && !this.emittedCall.has(itemId)) {
        this.emittedCall.add(itemId);
        this.emit({
          kind: "tool_call",
          tool: "WebSearch",
          args: { query: ws.query ?? "", action: ws.action ?? null },
        });
      }
      if (isCompleted) {
        this.emit({
          kind: "tool_result",
          tool: "WebSearch",
          ok: true,
          output: ws.query ? `searched: ${ws.query}` : "(searched)",
        });
      }
      return;
    }

    // ── todo_list — claude calls this TodoWrite; codex calls it
    //    todo_list. Both flow through `parseAgentPlan` in the daemon
    //    which only checks the tool name + args shape, so emitting it
    //    as TodoWrite-with-todos lets the existing plan/todos panel
    //    pick it up unchanged. We emit on every state (started /
    //    updated / completed) since the operator wants the live plan.
    if (item.type === "todo_list") {
      const tl = item as CodexTodoListItem;
      const items = tl.items ?? [];
      // Same shape claude's TodoWrite uses: { todos: [{ content, status }] }
      const todos = items.map((i) => ({
        content: i.text,
        status: i.completed ? "completed" : "pending",
      }));
      this.emit({
        kind: "tool_call",
        tool: "TodoWrite",
        args: { todos },
      });
      if (isCompleted) {
        this.emit({
          kind: "tool_result",
          tool: "TodoWrite",
          ok: true,
          output: `${todos.length} todo${todos.length === 1 ? "" : "s"}`,
        });
      }
      return;
    }

    // ── mcp_tool_call — generic MCP tool. Tool name is
    //    `<server>:<tool>` so the operator can see which server it
    //    came from at a glance.
    if (item.type === "mcp_tool_call") {
      const mc = item as CodexMcpToolCallItem;
      const toolName = mc.server && mc.tool ? `${mc.server}:${mc.tool}` : (mc.tool ?? "mcp");
      if (itemId && !this.emittedCall.has(itemId)) {
        this.emittedCall.add(itemId);
        this.emit({
          kind: "tool_call",
          tool: toolName,
          args: mc.arguments ?? {},
        });
      }
      if (isCompleted) {
        if (mc.error?.message) {
          this.emit({
            kind: "tool_result",
            tool: toolName,
            ok: false,
            output: mc.error.message,
          });
        } else {
          // Best-effort string render of the result content.
          let out = "";
          if (mc.result?.structured_content != null) {
            out = JSON.stringify(mc.result.structured_content, null, 2);
          } else if (Array.isArray(mc.result?.content)) {
            out = mc.result!.content
              .map((c) =>
                typeof c === "string" ? c : JSON.stringify(c, null, 2),
              )
              .join("\n\n");
          } else {
            out = mc.status === "failed" ? "(failed)" : "(ok)";
          }
          this.emit({
            kind: "tool_result",
            tool: toolName,
            ok: mc.status !== "failed",
            output: out,
          });
        }
      }
      return;
    }

    // ── error item — surface as stderr. Differs from a top-level
    //    `error` event; this one is a non-fatal item describing
    //    something codex couldn't do.
    if (item.type === "error") {
      if (isCompleted) {
        const ie = item as CodexErrorItem;
        if (itemId && !this.emittedCall.has(itemId)) {
          this.emittedCall.add(itemId);
          this.emit({
            kind: "tool_call",
            tool: "Error",
            args: {},
          });
        }
        this.emit({
          kind: "tool_result",
          tool: "Error",
          ok: false,
          output: ie.message ?? "error",
        });
      }
      return;
    }

    // ── collab_tool_call (multi-agent) and any future item type —
    //    render generically so the operator at least sees something
    //    happened. Tool name is the snake_case item.type so it
    //    classifies as `other` (wrench icon) in the timeline.
    const generic = item as { type?: string; [k: string]: unknown };
    if (generic.type) {
      if (itemId && !this.emittedCall.has(itemId)) {
        this.emittedCall.add(itemId);
        this.emit({
          kind: "tool_call",
          tool: generic.type,
          args: generic,
        });
      }
      if (isCompleted) {
        this.emit({
          kind: "tool_result",
          tool: generic.type,
          ok: true,
          output: "(completed)",
        });
      }
    }
  }

  async sendInput(_text: string): Promise<void> {
    throw new Error(
      "codex sendInput is handled by spawning a fresh `codex exec` from the task manager",
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

  /**
   * The session id captured from codex's `thread.started` stream
   * event on the most recent run. Stable across `exec resume` calls
   * (codex re-emits the same id on resume).
   */
  getThreadId(): string | null {
    return this.threadId;
  }
}
