import type { AgentEvent } from "@agentd/contracts";
import type {
  AgentRunner,
  PermissionMode,
  RunnerEventListener,
  RunnerStartOptions,
} from "./types.ts";
import { readLines } from "./lineStream.ts";

/**
 * Codex stream events (sampled from `codex exec --json`):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_N","type":"command_execution","command":"...","status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_N","type":"command_execution","command":"...","aggregated_output":"...","exit_code":N,"status":"completed"|"failed"}}
 *   {"type":"item.completed","item":{"id":"item_N","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_N","type":"function_call",...}}
 *   {"type":"item.completed","item":{"id":"item_N","type":"reasoning","summary":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}
 *
 * Anything not in this set is surfaced as a short `raw` annotation so
 * we never dump unparsed JSON into the operator's timeline.
 */
interface CodexStreamMessage {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    arguments?: unknown;
    output?: unknown;
    // Newer codex shells: command_execution items.
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    // Reasoning items expose a short summary string.
    summary?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
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
          // Codex prints this banner whenever stdin isn't a tty — it's
          // harmless (we point stdin at /dev/null on purpose) and just
          // pollutes the timeline. Real errors still flow through.
          if (line.includes("Reading additional input from stdin")) continue;
          this.emit({ kind: "raw", stream: "stderr", text: line });
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

  private handleStdoutLine(line: string): void {
    let parsed: CodexStreamMessage | null = null;
    try {
      parsed = JSON.parse(line) as CodexStreamMessage;
    } catch {
      // Non-JSON line — codex sometimes writes a banner or progress
      // hint that isn't JSON. Forward as raw stdout so it's preserved
      // for diagnostics, but don't dress it as an agent reply.
      this.emit({ kind: "raw", stream: "stdout", text: line });
      return;
    }
    if (!parsed) return;

    const t = parsed.type;
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

    // `item.started` fires when codex begins a long-running item
    // (typically a shell command). Surfacing it as a `tool_call` lets
    // the timeline show the command IS happening before the output
    // lands; the matching `item.completed` then emits the
    // `tool_result`. Pairing is positional — we never emit a
    // tool_call from item.completed for the same item, so the two
    // events stay in lockstep.
    if (t === "item.started" && parsed.item) {
      const item = parsed.item;
      if (
        (item.type === "command_execution" || item.type === "local_shell_call") &&
        typeof item.command === "string"
      ) {
        this.emit({
          kind: "tool_call",
          tool: "Bash",
          args: { command: item.command },
        });
      } else if (
        (item.type === "function_call" || item.type === "tool_call") &&
        typeof item.name === "string"
      ) {
        this.emit({
          kind: "tool_call",
          tool: item.name,
          args: item.arguments ?? {},
        });
      }
      // Other item.started types (agent_message, reasoning) carry no
      // useful "starting" info — wait for item.completed.
      return;
    }

    if (t === "item.completed" && parsed.item) {
      const item = parsed.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        this.emit({ kind: "message", role: "agent", text: item.text });
        return;
      }
      if (item.type === "command_execution" || item.type === "local_shell_call") {
        // Shell command finishing — emit only `tool_result`. The
        // matching `tool_call` was already emitted from item.started.
        // We mark `ok` from exit_code and prefer a non-empty output
        // so the timeline shows something even on silent successes.
        const out =
          typeof item.aggregated_output === "string" && item.aggregated_output
            ? item.aggregated_output
            : typeof item.output === "string"
              ? item.output
              : "";
        const exit = typeof item.exit_code === "number" ? item.exit_code : null;
        const ok = exit === 0 || (exit == null && item.status === "completed");
        const display =
          out ||
          (item.status === "failed"
            ? `(failed${exit != null ? `, exit ${exit}` : ""})`
            : `(no output${exit != null ? `, exit ${exit}` : ""})`);
        this.emit({
          kind: "tool_result",
          tool: "Bash",
          ok,
          output: display,
        });
        return;
      }
      if (item.type === "function_call" || item.type === "tool_call") {
        this.emit({
          kind: "tool_call",
          tool: item.name ?? item.type,
          args: item.arguments ?? {},
        });
        return;
      }
      if (
        item.type === "function_call_output" ||
        item.type === "tool_call_output"
      ) {
        const out =
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output ?? null);
        this.emit({
          kind: "tool_result",
          tool: item.name ?? item.type,
          ok: true,
          output: out,
        });
        return;
      }
      if (item.type === "reasoning") {
        // Codex's chain-of-thought summary. The timeline doesn't show
        // model reasoning by design — drop silently.
        return;
      }
      // Unknown item type — drop silently. Earlier versions emitted a
      // `raw` event so we'd see something in the timeline, but the
      // web's TaskDetail renders raw stdout as a system row, which
      // meant unparsed codex shapes leaked into the chat as noise.
      // Codex evolves its event vocabulary frequently; the safe
      // default is to silently swallow anything we don't model
      // explicitly here.
      return;
    }

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

    // Unknown event type — same reasoning as above: silently drop
    // instead of emitting a raw event that would land in the chat.
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
