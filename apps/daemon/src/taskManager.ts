import type {
  AgentEvent,
  AgentKind,
  BranchMode,
  Council,
  CouncilMember,
  PermissionMode,
  ResolveSuggestionRequest,
  Suggestion,
  Task,
  Template,
  ThinkingLevel,
  WorkspaceMode,
} from "@agentd/contracts";
import {
  addTaskUsage,
  appendMessage,
  autoCommit,
  createPr,
  createTask,
  detectDefaultBranch,
  EventBus,
  getTask,
  listTasks,
  listMessages,
  createCouncil as dbCreateCouncil,
  createSuggestion,
  dismissSuggestion as dbDismissSuggestion,
  generateBranchName,
  generateCommitMessage,
  getCouncil,
  getProjectById,
  getSuggestion,
  getTemplate,
  interpretSuggestionReply,
  resolveSuggestion as dbResolveSuggestion,
  runIdeation,
  runJudge,
  setCouncilStatus,
  setCouncilWinner,
  streamPrMessage,
  loadConfig,
  resolveModelInRegistry,
  newId,
  renderRepoContext,
  renderSkillsCatalog,
  ensureProjectForPath,
  touchProject,
  pushBranch,
  removeWorktree,
  setTaskPrUrl,
  syncAgentPlan,
  updateTaskStatus,
  createWorktree,
  type AgentdPaths,
  type Db,
} from "@agentd/core";
import {
  ClaudeRunner,
  CodexRunner,
  type AgentRunner,
} from "@agentd/agent-runner";

interface RunningSession {
  runner: AgentRunner;
  unsubscribe: () => void;
}

export interface CreateTaskParams {
  agent: AgentKind;
  repoPath: string;
  baseBranch?: string;
  prompt: string;
  title?: string;
  autoPush?: boolean;
  autoPr?: boolean;
  templateId?: string | null;
  scheduleId?: string | null;
  skills?: string[];
  permissionMode?: PermissionMode;
  /** Workspace setup — see contracts WorkspaceMode + BranchMode for shapes. */
  workspaceMode?: WorkspaceMode;
  branchMode?: BranchMode;
  branchName?: string;
  pullLatest?: boolean;
  thinkingLevel?: ThinkingLevel;
  model?: string;
}

export class TaskManager {
  private running = new Map<string, RunningSession>();
  /**
   * Inputs typed while the agent was mid-turn. Drained on exit so the next
   * runner starts with the user's queued message. Multiple queued lines are
   * joined with blank lines so they read like one continuous note.
   */
  private inputQueue = new Map<string, string[]>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly paths: AgentdPaths,
    /**
     * Daemon URL the agent's `agentd progress` Bash calls hit. Exposed
     * to the runner subprocess as AGENTD_DAEMON_URL.
     */
    private readonly daemonUrl: string,
    /**
     * A pre-issued session token the agent can use to authenticate its
     * progress / steer / status calls back into the daemon. Reuses the
     * plugin session token so chat plugins and agent subprocesses share
     * the same identity from the daemon's perspective.
     */
    private readonly agentSessionToken: string,
  ) {}

  list(): Task[] {
    return listTasks(this.db);
  }

  get(id: string): Task | null {
    return getTask(this.db, id);
  }

  isRunning(id: string): boolean {
    const s = this.running.get(id);
    return !!s && s.runner.running;
  }

  /** Snapshot of queued steer messages — for the UI badge. */
  queuedInput(id: string): string[] {
    return this.inputQueue.get(id)?.slice() ?? [];
  }

  /**
   * Remove a single queued line by its current index. Used by the
   * timeline's queue strip — the operator can drop something they
   * decided against before the next turn drains it. Returns the
   * remaining queue snapshot so the caller can re-render.
   */
  removeQueuedInput(taskId: string, index: number): string[] {
    const cur = this.inputQueue.get(taskId);
    if (!cur || index < 0 || index >= cur.length) {
      return cur?.slice() ?? [];
    }
    cur.splice(index, 1);
    if (cur.length === 0) this.inputQueue.delete(taskId);
    else this.inputQueue.set(taskId, cur);
    return cur.slice();
  }

  /**
   * Persist a structured progress note from the running agent and fan it
   * out to the bus. The mirror plugin and web timeline both subscribe.
   */
  recordProgress(taskId: string, text: string, done: boolean): void {
    appendMessage(
      this.db,
      taskId,
      "system",
      done ? `[progress · done] ${text}` : `[progress] ${text}`,
    );
    this.bus.publish({
      taskId,
      event: { kind: "progress", text, done },
      ts: Date.now(),
    });
    // For long-lived runners (claude in stream-json mode), the agent
    // signaling "done" is our cue to close stdin → proc exits cleanly
    // → completion hooks fire (commit, push, PR). Without this the
    // runner would idle forever waiting for the next stdin line.
    if (done) {
      const session = this.running.get(taskId);
      if (session?.runner.supportsLiveInput && session.runner.running) {
        // Fire-and-forget — `stop` closes stdin then waits for exit.
        void session.runner.stop("SIGTERM").catch(() => {});
      }
    }
  }

  /**
   * Non-blocking thought share. The agent calls `agentd-share "..."` to
   * broadcast a forward-looking idea ("I'm thinking we should ...") so
   * the operator can intervene before action. The chat mirror surfaces
   * these distinctly from progress so they read as opinions, not facts.
   */
  recordShare(taskId: string, text: string): void {
    appendMessage(this.db, taskId, "system", `[share] ${text}`);
    this.bus.publish({
      taskId,
      event: { kind: "share", text },
      ts: Date.now(),
    });
  }

  /**
   * Pending decisions — the agent's `agentd-ask` blocks until one of
   * these resolves. We park a Promise per askId and resolve it when the
   * operator's reply (a steer / chat reply) lands.
   *
   * Auto-expires after a generous window so a forgotten dialog doesn't
   * pin the agent forever.
   */
  private pendingAsks = new Map<
    string,
    { taskId: string; resolve: (answer: string) => void; expiresAt: number }
  >();

  /**
   * Register a blocking decision request. Returns a promise that
   * resolves with the operator's chosen text. Caller's HTTP handler
   * holds the response open while the agent waits.
   */
  awaitAsk(
    taskId: string,
    askId: string,
    prompt: string,
    options: string[],
    timeoutMs = 60 * 60 * 1000,
  ): Promise<string> {
    appendMessage(
      this.db,
      taskId,
      "system",
      `[ask] ${prompt}\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`,
    );
    this.bus.publish({
      taskId,
      event: { kind: "ask", askId, prompt, options },
      ts: Date.now(),
    });
    return new Promise<string>((resolve) => {
      const expiresAt = Date.now() + timeoutMs;
      this.pendingAsks.set(askId, { taskId, resolve, expiresAt });
    });
  }

  /**
   * Resolve the *oldest* pending ask for a task with the given answer.
   * Called when the operator replies via chat or web. Returns true if
   * the answer was matched to an in-flight ask.
   *
   * The matcher is "oldest pending" rather than askId-keyed so the
   * operator can reply naturally without quoting an id — there's at
   * most one ask in flight per task by design (the agent blocks).
   */
  answerAsk(taskId: string, answer: string): boolean {
    let oldestAskId: string | null = null;
    let oldestExp = Infinity;
    for (const [id, entry] of this.pendingAsks) {
      if (entry.taskId !== taskId) continue;
      if (entry.expiresAt < oldestExp) {
        oldestExp = entry.expiresAt;
        oldestAskId = id;
      }
    }
    if (!oldestAskId) return false;
    const entry = this.pendingAsks.get(oldestAskId)!;
    this.pendingAsks.delete(oldestAskId);
    appendMessage(this.db, taskId, "user", `[answer · ${oldestAskId}] ${answer}`);
    this.bus.publish({
      taskId,
      event: { kind: "answer", askId: oldestAskId, answer },
      ts: Date.now(),
    });
    entry.resolve(answer);
    return true;
  }

  /** True when the task has a question waiting on the operator. */
  hasPendingAsk(taskId: string): boolean {
    for (const e of this.pendingAsks.values()) {
      if (e.taskId === taskId) return true;
    }
    return false;
  }

  async create(params: CreateTaskParams): Promise<Task> {
    const baseBranch =
      params.baseBranch ?? (await detectDefaultBranch(params.repoPath));
    const title = params.title ?? params.prompt.split("\n")[0]!.slice(0, 80);
    const taskId = newId("task");
    const workspaceMode = params.workspaceMode ?? "worktree";
    const branchMode = params.branchMode ?? "new";
    // Auto-name the branch when the caller didn't provide one. We try the
    // AI helper first because the prompt usually has a clear intent ("fix
    // X", "add Y") that maps to a much tighter slug than the title.
    // Falls back to a deterministic slug if Claude isn't available — and
    // we never include the task id, so names look like `feature/auth-rate-limit`
    // instead of the old `feature/<long-title>-7a5a4a`.
    let branch: string;
    if (branchMode === "existing") {
      branch = params.branchName?.trim() || baseBranch;
    } else if (params.branchName?.trim()) {
      branch = params.branchName.trim();
    } else {
      const cfg = loadConfig(this.paths.root);
      const ai = await generateBranchName(params.prompt, {
        helper: cfg.aiHelpers,
      });
      branch = `feature/${ai.slug}`;
    }
    // Auto-create or look up the project for this repo path. Tasks belong
    // to projects so the sidebar can group them and surface what's new.
    const project = ensureProjectForPath(this.db, params.repoPath);
    const { worktreePath } = await createWorktree({
      repoPath: params.repoPath,
      worktreeRoot: this.paths.worktrees,
      taskId,
      baseBranch,
      branchName: branch,
      workspaceMode,
      branchMode,
      pullLatest: params.pullLatest ?? false,
    });
    const task: Task = createTask(this.db, {
      id: taskId,
      title,
      agent: params.agent,
      repoPath: params.repoPath,
      worktreePath,
      branch,
      baseBranch,
      templateId: params.templateId ?? null,
      scheduleId: params.scheduleId ?? null,
      projectId: project.id,
      // Default ON: the agent commits + pushes when done; the post-hook
      // is a safety net. Auto-PR stays OFF — that's a deliberate manual
      // step from the Ship menu.
      autoPush: params.autoPush ?? true,
      autoPr: params.autoPr ?? false,
      skills: params.skills ?? [],
      permissionMode: params.permissionMode ?? "bypassPermissions",
      workspaceMode,
      thinkingLevel:
        params.thinkingLevel ??
        (() => {
          const cfg = loadConfig(this.paths.root);
          return cfg.defaultThinking[params.agent];
        })(),
      model: params.model ?? "",
    });
    touchProject(this.db, project.id);
    appendMessage(this.db, task.id, "user", params.prompt);
    await this.spawnRunner(task, params.prompt, false);
    return task;
  }

  async sendInput(taskId: string, text: string): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error("task not found");
    // 1. If the agent is blocked on an `agentd-ask`, this input is its
    //    answer. Resolve the pending Promise — the agent's curl call
    //    unblocks and the runner keeps going.
    if (this.answerAsk(taskId, text)) return;
    // 2. Live-input agents (claude in stream-json mode): the runner
    //    holds the conversation state across turns. Each input is just
    //    another stdin line — claude buffers between tool calls.
    const session = this.running.get(taskId);
    if (session?.runner.supportsLiveInput && session.runner.running) {
      appendMessage(this.db, taskId, "user", text);
      try {
        await session.runner.sendInput(text);
        // No queue chip on the regular send path — that's only for
        // mid-turn steers the operator may want to fire later.
      } catch (e) {
        // Stdin write failed — runner died unexpectedly. Fall through
        // to a fresh spawn so the operator's message isn't lost.
        this.bus.publish({
          taskId,
          event: {
            kind: "raw",
            stream: "stderr",
            text: `[stdin closed, respawning] ${(e as Error).message}`,
          },
          ts: Date.now(),
        });
        this.running.delete(taskId);
        await this.spawnRunner(task, text, true);
      }
      return;
    }
    // 3. Codex (or claude not yet started): mid-turn means queue;
    //    idle means spawn a fresh runner with --continue.
    if (this.isRunning(taskId)) {
      this.queueInput(taskId, text);
      return;
    }
    appendMessage(this.db, taskId, "user", text);
    await this.spawnRunner(task, text, true);
  }

  /**
   * Steer modes:
   *   queue     — for live-input runners (claude), inject as the next
   *               stdin message; the agent picks it up between tool
   *               calls. For spawn-per-turn runners (codex), append to
   *               the local queue and drain on next turn.
   *   interrupt — stop the current runner now, then fire as the next turn.
   *               The current turn's partial work is preserved in messages.
   */
  async steer(
    taskId: string,
    text: string,
    mode: "queue" | "interrupt" = "queue",
  ): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error("task not found");
    // Block-on-ask wins: if there's a pending decision, this becomes the
    // answer regardless of the requested steer mode. The agent unblocks
    // and continues, so neither queue nor interrupt is appropriate.
    if (this.answerAsk(taskId, text)) return;
    if (!this.isRunning(taskId)) {
      // Idle path — same as a normal sendInput so callers don't have to
      // branch on running state themselves.
      appendMessage(this.db, taskId, "user", text);
      await this.spawnRunner(task, text, true);
      return;
    }
    // For both live-input (claude) and spawn-per-turn (codex), submit
    // while mid-turn just queues. No appendMessage, no sendInput. The
    // operator confirms via the per-row Steer button (`fireQueued`)
    // when they're ready to send the item to the agent. This matches
    // claude-code / codex feel: type your thought now, fire it when
    // it's the right moment.
    this.queueInput(taskId, text);
    if (mode === "interrupt") {
      // Stop and let the exit handler drain.
      await this.stop(taskId).catch(() => {});
    }
  }

  /**
   * Fire a single queued item — the operator's "send this now" action.
   *   live-input runner (claude) running → pop + persist + write to
   *     stdin. Claude picks it up at the next tool-call boundary.
   *   no runner alive → pop + persist + spawn fresh with this text.
   *   spawn-per-turn runner (codex) running → promote the fired item
   *     to the front of the queue and SIGINT the runner so the
   *     existing exit-time drain joins the queue as the next prompt
   *     with the fired item leading.
   * Returns the new queue snapshot so the caller can re-render.
   */
  async fireQueued(taskId: string, index: number): Promise<string[]> {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error("task not found");
    const cur = this.inputQueue.get(taskId);
    if (!cur || index < 0 || index >= cur.length) {
      return cur?.slice() ?? [];
    }
    const text = cur[index]!;

    const session = this.running.get(taskId);

    if (session?.runner.supportsLiveInput && session.runner.running) {
      // Pop and stream to stdin.
      cur.splice(index, 1);
      if (cur.length === 0) this.inputQueue.delete(taskId);
      else this.inputQueue.set(taskId, cur);
      appendMessage(this.db, taskId, "user", text);
      try {
        await session.runner.sendInput(text);
      } catch (e) {
        this.bus.publish({
          taskId,
          event: {
            kind: "raw",
            stream: "stderr",
            text: `[fire failed, respawning] ${(e as Error).message}`,
          },
          ts: Date.now(),
        });
        this.running.delete(taskId);
        await this.spawnRunner(task, text, true);
      }
      return cur.slice();
    }

    if (!this.isRunning(taskId)) {
      // No runner alive — pop, persist, spawn fresh.
      cur.splice(index, 1);
      if (cur.length === 0) this.inputQueue.delete(taskId);
      else this.inputQueue.set(taskId, cur);
      appendMessage(this.db, taskId, "user", text);
      await this.spawnRunner(task, text, true);
      return this.inputQueue.get(taskId)?.slice() ?? [];
    }

    // Spawn-per-turn runner (codex) is running — promote fired item
    // to the front and SIGINT so the drain takes everything in
    // queue order with the fired one leading. The user message is
    // persisted now so the timeline reflects the operator's intent.
    cur.splice(index, 1);
    cur.unshift(text);
    this.inputQueue.set(taskId, cur);
    appendMessage(this.db, taskId, "user", text);
    await this.stop(taskId).catch(() => {});
    return cur.slice();
  }

  /**
   * Drain all queued items into a live-input runner — used at turn
   * boundaries so anything the operator queued during the agent's
   * thinking flushes automatically. Each item lands as a separate
   * user message and stdin write, in queue order.
   */
  private async autoDrainQueue(taskId: string): Promise<void> {
    const cur = this.inputQueue.get(taskId);
    if (!cur || cur.length === 0) return;
    const session = this.running.get(taskId);
    if (!session?.runner.supportsLiveInput || !session.runner.running) return;
    // Snapshot + clear up front so concurrent steers don't double-send.
    const items = cur.slice();
    this.inputQueue.delete(taskId);
    for (const text of items) {
      appendMessage(this.db, taskId, "user", text);
      try {
        await session.runner.sendInput(text);
      } catch (e) {
        this.bus.publish({
          taskId,
          event: {
            kind: "raw",
            stream: "stderr",
            text: `[auto-drain failed] ${(e as Error).message}`,
          },
          ts: Date.now(),
        });
        return;
      }
    }
  }

  /**
   * In-memory queue tracker — drives the chip strip in the web UI
   * (polled via `GET /api/tasks/:id/steer`). Pure state, no DB write
   * and no extra timeline text: the user's message itself is already
   * persisted by the caller via `appendMessage("user", text)`, and
   * the strip is the visual proof that it's pending.
   *
   * For codex (spawn-per-turn), the items get joined and fed as the
   * next turn's prompt via `drainQueue`. For claude (long-lived
   * stdin), the items have already been written to stdin — the chip
   * is purely a "we sent this, claude hasn't acknowledged yet" hint
   * cleared on `status:done`.
   */
  private queueInput(taskId: string, text: string): void {
    const cur = this.inputQueue.get(taskId) ?? [];
    cur.push(text);
    this.inputQueue.set(taskId, cur);
  }


  private drainQueue(taskId: string): string | null {
    const q = this.inputQueue.get(taskId);
    if (!q || q.length === 0) return null;
    this.inputQueue.delete(taskId);
    return q.join("\n\n");
  }

  async stop(taskId: string): Promise<void> {
    const session = this.running.get(taskId);
    if (!session) return;
    await session.runner.stop("SIGTERM");
    session.unsubscribe();
    this.running.delete(taskId);
    updateTaskStatus(this.db, taskId, "stopped");
    this.bus.publish({
      taskId,
      event: { kind: "status", status: "stopped" },
      ts: Date.now(),
    });
  }

  async remove(taskId: string, opts?: { keepWorktree?: boolean }): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) return;
    await this.stop(taskId).catch(() => {});
    if (!opts?.keepWorktree) {
      try {
        await removeWorktree(task.repoPath, task.worktreePath, { force: true });
      } catch {
        // best-effort
      }
    }
  }

  private async spawnRunner(
    task: Task,
    prompt: string,
    resume: boolean,
  ): Promise<void> {
    const runner: AgentRunner =
      task.agent === "claude" ? new ClaudeRunner() : new CodexRunner();
    const unsubscribe = runner.on((event) => this.handleEvent(task.id, event));
    this.running.set(task.id, { runner, unsubscribe });
    updateTaskStatus(this.db, task.id, "running");
    this.bus.publish({
      taskId: task.id,
      event: { kind: "status", status: "running" },
      ts: Date.now(),
    });
    const cfg = loadConfig(this.paths.root);
    // Two catalogs surface high-signal context to the agent without
    // pasting bodies into the prompt:
    //   1. Skills — agent reads SKILL.md when relevant.
    //   2. Repo context — pins, conventions, service stacks. All in cwd
    //      already, the catalog just tells the agent what's worth reading.
    const catalog = renderSkillsCatalog(task.skills ?? [], {
      agentdRoot: this.paths.root,
      repoPath: task.repoPath,
    });
    const repoCtx = renderRepoContext({ worktreePath: task.worktreePath });
    // Skills + repo-ctx used to publish diagnostic notes to the timeline
    // every spawn — pure noise for the operator. We log them once on
    // the daemon's stdout instead so they're available in the daemon
    // log without cluttering chat.
    if (catalog.entries.length > 0) {
      console.log(
        `[task ${task.id}] skills=${catalog.entries.map((e) => e.id).join(",")}`,
      );
    }
    if (repoCtx.sections.length > 0) {
      const summary = repoCtx.sections
        .map((s) => `${s.key}=${s.entries.length}`)
        .join(" ");
      console.log(`[task ${task.id}] repo-ctx ${summary}`);
    }
    const appendParts: string[] = [];
    if (cfg.agentInstructions) appendParts.push(cfg.agentInstructions);
    // Per-project instructions — like an AGENTS.md but stored in
    // the daemon DB (not the repo, so they don't get committed).
    // The agent can also self-modify these via `agentd-instructions`.
    if (task.projectId) {
      const project = getProjectById(this.db, task.projectId);
      const projectInstructions = project?.instructions?.trim();
      if (projectInstructions) {
        appendParts.push(
          `# Project instructions\n\n${projectInstructions}\n\nYou can update this guidance with \`agentd-instructions write "<text>"\` if you discover something important worth persisting for future runs.`,
        );
      }
    }
    if (catalog.text) appendParts.push(catalog.text);
    if (repoCtx.text) appendParts.push(repoCtx.text);
    // Tell the agent to land its own work. We always ask it to commit
    // because the agent has full context of what it changed and writes
    // a much more accurate message than a separate Claude pass over the
    // diff. The daemon-side post-hook still runs as a safety net (it
    // becomes a no-op when there's nothing left to commit / push).
    const finishParts: string[] = [
      "You have three small Bash tools for talking to the operator. They are the ONLY way they see what you're doing when away from the laptop.",
      "  - `agentd-progress \"<text>\"`  — past-tense status. Run it after every meaningful step (file edit, successful build, useful tool result). One short line each.",
      "  - `agentd-share \"<text>\"`     — forward-looking thought, non-blocking. Use it BEFORE big moves (\"thinking we should X first then Y\") so the operator can nudge before you commit. Don't wait for an answer.",
      "  - `agentd-ask \"<question>\" \"opt1\" \"opt2\" ...`  — blocking decision. Use this at real forks (architectural choice, library to pick, ambiguous naming, \"should I also do X?\"). Stops you until the operator picks. The chosen option text comes back on stdout — capture it: `answer=$(agentd-ask \"Which approach?\" \"rewrite\" \"refactor\" \"add a flag\")`. Don't fabricate a default when you genuinely don't know — ASK.",
      "  - `agentd-instructions read` / `agentd-instructions write \"<text>\"` — read or update the project's persistent guidance (like AGENTS.md but stored in the daemon, not the repo). Use it to persist hard-won knowledge that should survive into future runs of the same project: conventions, gotchas, where things live, what NOT to do. Read at the start when in doubt; write after you've discovered something a future agent should know.",
      "When you believe the entire task is finished, run `agentd-progress \"<final summary>\" --done` and then stop.",
      "When your work is complete, stage everything and commit it inside this worktree BEFORE the final `--done` progress call.",
      "Use a single conventional-commit subject line (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `style:`, `test:`, `perf:`, `ci:`, `build:`) under 70 characters, lowercase, imperative mood, with no scope unless one is obvious.",
      "Do NOT add `Co-Authored-By`, `Generated with`, or any AI attribution to commit messages.",
    ];
    if (cfg.commitInstructions?.trim()) {
      finishParts.push(`Commit style notes:\n${cfg.commitInstructions.trim()}`);
    }
    if (task.autoPush) {
      finishParts.push(
        "After committing, push the branch to origin with `git push -u origin HEAD`. Don't open a pull request — that step is manual.",
      );
    } else {
      finishParts.push(
        "Do NOT push the branch and do NOT open a pull request — those are manual steps.",
      );
    }
    appendParts.push(finishParts.join(" "));
    const appendSystemPrompt = appendParts.length
      ? appendParts.join("\n\n---\n\n")
      : undefined;
    const additionalReadDirs = catalog.entries.map((e) => e.skillDir);
    try {
      // Per-task model wins; otherwise fall back to the configured default
      // for this agent. Empty string means inherit the CLI's own default.
      const model =
        (task.model && task.model.trim()) ||
        cfg.defaultModel?.[task.agent] ||
        "";
      await runner.start({
        prompt,
        cwd: task.worktreePath,
        resume,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        permissionMode: task.permissionMode ?? "bypassPermissions",
        thinkingLevel: task.thinkingLevel ?? "high",
        ...(model ? { model } : {}),
        ...(additionalReadDirs.length ? { additionalReadDirs } : {}),
        env: {
          AGENTD_TASK_ID: task.id,
          AGENTD_DAEMON_URL: this.daemonUrl,
          AGENTD_TOKEN: this.agentSessionToken,
          // Prepend the daemon's bin dir so the agent always finds
          // `agentd-progress` on its PATH regardless of host install.
          PATH: `${this.paths.bin}:${process.env.PATH ?? ""}`,
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.bus.publish({
        taskId: task.id,
        event: {
          kind: "raw",
          stream: "stderr",
          text: `[runner failed to start] ${msg}`,
        },
        ts: Date.now(),
      });
      updateTaskStatus(this.db, task.id, "failed");
      this.running.delete(task.id);
      throw err;
    }
  }

  private handleEvent(taskId: string, event: AgentEvent): void {
    if (event.kind === "message" && event.role === "agent") {
      appendMessage(this.db, taskId, "agent", event.text);
    } else if (event.kind === "tool_call") {
      appendMessage(
        this.db,
        taskId,
        "tool",
        `[call ${event.tool}] ${JSON.stringify(event.args).slice(0, 500)}`,
      );
      // TodoWrite (claude) / update_plan (codex) carries the agent's
      // current plan. Mirror it into the todos table tagged source=agent
      // so the UI's right-side todos panel (and any other consumer)
      // sees the plan alongside user-added todos.
      const planItems = parseAgentPlan(event.tool, event.args);
      if (planItems) {
        const task = getTask(this.db, taskId);
        if (task) {
          try {
            syncAgentPlan(this.db, taskId, task.projectId ?? null, planItems);
            this.bus.publish({
              taskId,
              event: { kind: "todos_updated" },
              ts: Date.now(),
            });
          } catch {
            // Don't let a sync hiccup break the event loop — the raw
            // tool_call event still flows through to the timeline.
          }
        }
      }
    } else if (event.kind === "status") {
      updateTaskStatus(this.db, taskId, event.status);
      // Auto-fire any queued items at the turn boundary for
      // long-lived runners (claude). `idle` means the agent
      // finished its turn and is waiting for the next stdin
      // message — perfect moment to flush the queue. The per-row
      // Steer button is the manual mid-turn force; if the operator
      // just lets the queue sit, items drain themselves here.
      if (event.status === "idle") {
        const sess = this.running.get(taskId);
        if (sess?.runner.supportsLiveInput) {
          void this.autoDrainQueue(taskId);
        }
      }
    } else if (event.kind === "usage") {
      addTaskUsage(this.db, taskId, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        costUsd: event.costUsd,
      });
    } else if (event.kind === "exit") {
      const session = this.running.get(taskId);
      if (session) {
        session.unsubscribe();
        this.running.delete(taskId);
      }
      // Fire-and-forget; commit + push + PR all run after the agent exits.
      void this.runCompletionHooks(taskId);
    }
    this.bus.publish({ taskId, event, ts: Date.now() });
  }

  private async runCompletionHooks(taskId: string): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) return;
    const committed = await this.maybeAutoCommit(taskId, task);
    if (committed) {
      if (task.autoPush || task.autoPr) {
        await this.maybePush(taskId, task);
      }
      if (task.autoPr) {
        await this.maybeOpenPr(taskId, task);
      }
    }
    // Drain any messages the user queued mid-turn. Re-fetch the task so we
    // pick up any thinking-level change made while the previous turn ran.
    const queued = this.drainQueue(taskId);
    if (queued) {
      const fresh = getTask(this.db, taskId);
      if (fresh) {
        appendMessage(this.db, taskId, "user", queued);
        try {
          await this.spawnRunner(fresh, queued, true);
        } catch (err) {
          this.bus.publish({
            taskId,
            event: {
              kind: "raw",
              stream: "stderr",
              text: `[steer drain failed] ${(err as Error).message}`,
            },
            ts: Date.now(),
          });
        }
      }
    }
    // Council hook — if this task is part of a council, see whether all
    // siblings have settled and run the judge if so.
    if (task.councilId) {
      void this.maybeRunJudge(task.councilId);
    }
  }

  /* ── Ideation ───────────────────────────────────────────────────── */

  /**
   * Fire an ideation template — runs a one-off Claude helper that
   * proposes N options, persists them as a `Suggestion`, and emits a
   * bus event so chat mirrors + the web inbox light up. The schedule
   * caller logs whichever id we return.
   *
   * Returns null if the AI helper produced nothing useful (we just
   * skip a fire rather than create an empty suggestion).
   */
  async fireIdeation(
    tpl: Template,
    prompt: string,
    _scheduleId: string | null,
  ): Promise<Suggestion | null> {
    const cfg = loadConfig(this.paths.root);
    const repoPath = (() => {
      if (tpl.projectId) {
        const p = getProjectById(this.db, tpl.projectId);
        if (p?.path) return p.path;
      }
      return tpl.repoPath;
    })();
    const result = await runIdeation(repoPath, prompt, {
      helper: cfg.aiHelpers,
      max: 5,
    });
    if (result.options.length === 0) {
      return null;
    }
    const sug = createSuggestion(this.db, {
      templateId: tpl.id,
      projectId: tpl.projectId,
      title: tpl.name,
      prompt,
      options: result.options,
    });
    // Broadcast as a system event — first-class citizen, not a fake
    // per-task `ask`. Web clients + chat plugins subscribe via /ws
    // and render their own affordances.
    this.bus.publishSystem({
      kind: "suggestion_created",
      suggestion: sug,
    });
    return sug;
  }

  /**
   * Resolve a suggestion — either by index (operator picked one of the
   * proposed options) or by free-form text (operator wrote their own
   * direction). Spawns a real task using the chosen text as the prompt;
   * the spawned task lives in the same project as the suggestion.
   */
  async resolveSuggestionToTask(
    suggestionId: string,
    pick: ResolveSuggestionRequest,
  ): Promise<{ suggestion: Suggestion; task: Task } | null> {
    const sug = getSuggestion(this.db, suggestionId);
    if (!sug) throw new Error("suggestion not found");
    if (sug.status !== "pending") {
      throw new Error(`suggestion is ${sug.status}, not pending`);
    }
    let chosenText: string;
    let chosenIndex: number | null = null;
    if (typeof pick.index === "number") {
      if (pick.index < 0 || pick.index >= sug.options.length) {
        throw new Error("index out of range");
      }
      chosenIndex = pick.index;
      chosenText = sug.options[pick.index]!;
    } else if (pick.text && pick.text.trim()) {
      chosenText = pick.text.trim();
    } else {
      throw new Error("provide index or text");
    }
    // Resolve the project to a real repo path. If the template had no
    // project, fall back to the originating template's stored path.
    const repoPath = (() => {
      if (sug.projectId) {
        const project = getProjectById(this.db, sug.projectId);
        if (project) return project.path;
      }
      if (sug.templateId) {
        const tpl = getTemplate(this.db, sug.templateId);
        if (tpl) return tpl.repoPath;
      }
      throw new Error("no repo path resolvable for suggestion");
    })();
    const titleSeed =
      pick.title?.trim() || chosenText.split("\n")[0]!.slice(0, 80);
    const task = await this.create({
      agent: pick.agent ?? "claude",
      repoPath,
      prompt: chosenText,
      title: titleSeed,
      ...(pick.model ? { model: pick.model } : {}),
      ...(pick.thinkingLevel ? { thinkingLevel: pick.thinkingLevel } : {}),
      ...(pick.permissionMode ? { permissionMode: pick.permissionMode } : {}),
      ...(pick.workspaceMode ? { workspaceMode: pick.workspaceMode } : {}),
      ...(pick.branchMode ? { branchMode: pick.branchMode } : {}),
      ...(pick.branchName ? { branchName: pick.branchName } : {}),
      ...(pick.pullLatest != null ? { pullLatest: pick.pullLatest } : {}),
    });
    const updated = dbResolveSuggestion(
      this.db,
      sug.id,
      chosenIndex,
      chosenText,
      task.id,
    )!;
    return { suggestion: updated, task };
  }

  dismissSuggestion(id: string): Suggestion | null {
    const updated = dbDismissSuggestion(this.db, id);
    if (updated) {
      this.bus.publishSystem({ kind: "suggestion_updated", suggestion: updated });
    }
    return updated;
  }

  /**
   * Conversational reply path — routes a free-form chat reply through
   * the heuristic + AI router, then either spawns a task, dismisses
   * the suggestion, or returns a clarification question for the bot
   * to ask back.
   *
   * Returns one of:
   *   { kind: "spawned", suggestion, task, picked: "option N" | "custom" }
   *   { kind: "dismissed", suggestion }
   *   { kind: "clarify", question }
   *   { kind: "noop", reason }   — already resolved, nothing to do
   */
  async replyToSuggestion(
    id: string,
    text: string,
  ): Promise<
    | {
        kind: "spawned";
        suggestion: Suggestion;
        task: Task;
        picked: string;
        agent: AgentKind;
        model: string;
        thinkingLevel: ThinkingLevel;
      }
    | { kind: "dismissed"; suggestion: Suggestion }
    | { kind: "clarify"; question: string }
    | { kind: "noop"; reason: string }
  > {
    const sug = getSuggestion(this.db, id);
    if (!sug) throw new Error("suggestion not found");
    if (sug.status !== "pending") {
      return { kind: "noop", reason: `already ${sug.status}` };
    }
    const cfg = loadConfig(this.paths.root);
    const modelHints = (
      ["claude", "codex"] as const
    ).flatMap((agent) =>
      (cfg.models[agent] ?? []).map((m) => ({
        agent,
        aliases: [m.id, ...m.aliases],
      })),
    );
    const decision = await interpretSuggestionReply({
      options: sug.options,
      text,
      helper: cfg.aiHelpers,
      resolveModel: (raw, agent) =>
        resolveModelInRegistry(raw, agent, cfg.models),
      modelHints,
    });

    if (decision.action === "clarify") {
      return { kind: "clarify", question: decision.question };
    }
    if (decision.action === "dismiss") {
      const updated = dbDismissSuggestion(this.db, id)!;
      this.bus.publishSystem({
        kind: "suggestion_updated",
        suggestion: updated,
      });
      return { kind: "dismissed", suggestion: updated };
    }

    // pick or custom — both spawn a task. The difference is just where
    // the prompt comes from + how we record the resolution.
    const repoPath = (() => {
      if (sug.projectId) {
        const project = getProjectById(this.db, sug.projectId);
        if (project) return project.path;
      }
      if (sug.templateId) {
        const tpl = getTemplate(this.db, sug.templateId);
        if (tpl) return tpl.repoPath;
      }
      throw new Error("no repo path resolvable for suggestion");
    })();

    let chosenIndex: number | null = null;
    let prompt: string;
    let picked: string;
    if (decision.action === "pick") {
      chosenIndex = decision.index;
      prompt = sug.options[decision.index]!;
      picked = `option ${decision.index + 1}`;
    } else {
      // custom — text is the synthesized prompt.
      prompt = decision.prompt;
      picked = "custom";
    }

    const agent: AgentKind = decision.agent ?? "claude";
    const thinkingLevel: ThinkingLevel =
      decision.thinkingLevel ?? cfg.defaultThinking[agent];
    const model = decision.model ?? "";

    const task = await this.create({
      agent,
      repoPath,
      prompt,
      title: prompt.split("\n")[0]!.slice(0, 80),
      thinkingLevel,
      ...(model ? { model } : {}),
    });
    const updated = dbResolveSuggestion(
      this.db,
      sug.id,
      chosenIndex,
      prompt,
      task.id,
    )!;
    this.bus.publishSystem({
      kind: "suggestion_updated",
      suggestion: updated,
    });
    return {
      kind: "spawned",
      suggestion: updated,
      task,
      picked,
      agent,
      model,
      thinkingLevel,
    };
  }

  /* ── Councils ───────────────────────────────────────────────────── */

  /**
   * Spawn a council: N parallel tasks against the same prompt, each in
   * its own worktree on a unique branch. The judge runs after all of
   * them exit and picks a winner.
   */
  async createCouncil(params: {
    repoPath: string;
    baseBranch?: string;
    prompt: string;
    title?: string;
    members: CouncilMember[];
    projectId?: string | null;
  }): Promise<Council> {
    if (params.members.length < 2 || params.members.length > 5) {
      throw new Error("council needs 2-5 members");
    }
    const baseBranch =
      params.baseBranch ?? (await detectDefaultBranch(params.repoPath));
    const title = params.title ?? params.prompt.split("\n")[0]!.slice(0, 80);
    const project = params.projectId
      ? null
      : ensureProjectForPath(this.db, params.repoPath);
    const projectId = params.projectId ?? project?.id ?? null;

    const cfg = loadConfig(this.paths.root);
    const ai = await generateBranchName(params.prompt, {
      helper: cfg.aiHelpers,
    });
    const baseSlug = ai.slug || "council";

    const council = dbCreateCouncil(this.db, {
      projectId,
      repoPath: params.repoPath,
      baseBranch,
      prompt: params.prompt,
    });

    // Spawn each member sequentially so worktree creation doesn't race.
    // Runner starts kick off in parallel inside `spawnRunner` though.
    const memberLabels: string[] = [];
    for (const m of params.members) {
      const label =
        m.label ||
        [m.agent, m.model, m.thinkingLevel].filter(Boolean).join(" ") ||
        m.agent;
      const safeLabel = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
      memberLabels.push(label);
      const taskId = newId("task");
      const branch = `feature/${baseSlug}-${safeLabel}-${taskId.slice(-4)}`;
      const { worktreePath } = await createWorktree({
        repoPath: params.repoPath,
        worktreeRoot: this.paths.worktrees,
        taskId,
        baseBranch,
        branchName: branch,
        workspaceMode: "worktree",
        branchMode: "new",
        pullLatest: false,
      });
      const memberTask: Task = createTask(this.db, {
        id: taskId,
        title: `[${label}] ${title}`.slice(0, 120),
        agent: m.agent,
        repoPath: params.repoPath,
        worktreePath,
        branch,
        baseBranch,
        projectId,
        // Council members never auto-PR — we only PR the winner via the
        // operator's manual Ship action.
        autoPush: false,
        autoPr: false,
        permissionMode: "bypassPermissions",
        thinkingLevel:
          m.thinkingLevel ?? cfg.defaultThinking[m.agent],
        model: m.model ?? "",
        councilId: council.id,
      });
      void touchProject(this.db, projectId ?? "");
      appendMessage(this.db, memberTask.id, "user", params.prompt);
      // Fire and forget — each runner starts independently. Errors get
      // logged on the bus by spawnRunner itself.
      void this.spawnRunner(memberTask, params.prompt, false).catch(() => {});
    }
    void memberLabels;

    return getCouncil(this.db, council.id)!;
  }

  /**
   * Called whenever a council member exits. If every member has settled,
   * runs the judge and records a winner. Idempotent: only one judge run
   * per council, gated on status.
   */
  private async maybeRunJudge(councilId: string): Promise<void> {
    const council = getCouncil(this.db, councilId);
    if (!council) return;
    if (council.status !== "running") return; // already judged or judging
    // All members settled means none of them are currently running.
    const members = council.taskIds
      .map((id) => getTask(this.db, id))
      .filter((t): t is Task => t != null);
    if (members.length === 0) return;
    const stillRunning = members.some((t) => this.isRunning(t.id));
    if (stillRunning) return;
    setCouncilStatus(this.db, councilId, "judging");
    this.bus.publish({
      taskId: members[0]!.id,
      event: {
        kind: "raw",
        stream: "stdout",
        text: `[council ${councilId.slice(-6)}] all members settled — running judge`,
      },
      ts: Date.now(),
    });
    const cfg = loadConfig(this.paths.root);
    const verdict = await runJudge(
      council.prompt,
      members.map((t) => ({
        id: t.id,
        label: t.title.replace(/^\[([^\]]+)\].*/, "$1") || t.agent,
        cwd: t.worktreePath,
        baseRef: t.baseBranch,
      })),
      { helper: cfg.aiHelpers },
    );
    if (verdict.winnerId) {
      setCouncilWinner(
        this.db,
        councilId,
        verdict.winnerId,
        verdict.explanation,
      );
      this.bus.publish({
        taskId: verdict.winnerId,
        event: {
          kind: "raw",
          stream: "stdout",
          text: `[council ${councilId.slice(-6)}] winner: ${verdict.explanation}`,
        },
        ts: Date.now(),
      });
    } else {
      setCouncilStatus(this.db, councilId, "failed");
    }
  }

  private async maybeAutoCommit(taskId: string, task: Task): Promise<boolean> {
    const lastUserMsg = findLastUserMessage(this.db, taskId);
    const cfg = loadConfig(this.paths.root);
    // Generate the commit subject from the actual diff. The user's
    // commitInstructions (free-form guidance) get appended to the helper's
    // system rules so the message matches their style.
    const ai = await generateCommitMessage(task.worktreePath, {
      fallbackHint: task.title,
      baseRef: task.baseBranch,
      helper: cfg.aiHelpers,
      ...(cfg.commitInstructions
        ? { extraInstructions: cfg.commitInstructions }
        : {}),
    });
    const subject =
      ai.source === "claude"
        ? ai.message.split("\n")[0]!.slice(0, 72)
        : task.title.slice(0, 72);
    const body =
      ai.source === "claude" && ai.message.includes("\n")
        ? ai.message.split("\n").slice(1).join("\n").trim() || undefined
        : (lastUserMsg ?? undefined);
    try {
      const result = await autoCommit({
        cwd: task.worktreePath,
        title: subject,
        body,
      });
      if (result.committed) {
        appendMessage(
          this.db,
          taskId,
          "system",
          `auto-committed ${result.sha?.slice(0, 7)}: ${result.message}`,
        );
        this.bus.publish({
          taskId,
          event: {
            kind: "raw",
            stream: "stdout",
            text: `[auto-commit ${result.sha?.slice(0, 7)}] ${result.message}`,
          },
          ts: Date.now(),
        });
      }
      return result.committed;
    } catch (e) {
      appendMessage(
        this.db,
        taskId,
        "system",
        `auto-commit failed: ${(e as Error).message}`,
      );
      return false;
    }
  }

  private async maybePush(taskId: string, task: Task): Promise<void> {
    try {
      const r = await pushBranch(task.worktreePath);
      appendMessage(this.db, taskId, "system", `pushed ${r.branch} → ${r.remote}`);
    } catch (e) {
      appendMessage(this.db, taskId, "system", `auto-push failed: ${(e as Error).message}`);
    }
  }

  private async maybeOpenPr(taskId: string, task: Task): Promise<void> {
    try {
      const lastUserMsg = findLastUserMessage(this.db, taskId);
      const cfg = loadConfig(this.paths.root);
      // Try the AI helper first — it gets a clean title + body from the
      // diff with the user's prInstructions appended. Falls back to the
      // task title + last user message when the helper is unreachable.
      const it = streamPrMessage(task.worktreePath, {
        baseRef: task.baseBranch,
        helper: cfg.aiHelpers,
        taskPrompt: lastUserMsg ?? "",
        taskTitle: task.title,
        ...(cfg.prInstructions
          ? { extraInstructions: cfg.prInstructions }
          : {}),
      });
      let final: { title: string; body: string; source: string } | null = null;
      while (true) {
        const next = await it.next();
        if (next.done) {
          final = next.value as { title: string; body: string; source: string };
          break;
        }
      }
      const title = (final?.title || task.title).slice(0, 200);
      const body = final?.body || lastUserMsg || "";
      const r = await createPr({
        cwd: task.worktreePath,
        title,
        body,
        baseBranch: task.baseBranch,
      });
      if (r.url) {
        setTaskPrUrl(this.db, taskId, r.url);
        appendMessage(this.db, taskId, "system", `opened PR: ${r.url}`);
      } else {
        appendMessage(this.db, taskId, "system", `gh pr create succeeded but no URL parsed: ${r.output.slice(0, 200)}`);
      }
    } catch (e) {
      appendMessage(this.db, taskId, "system", `auto-PR failed: ${(e as Error).message}`);
    }
  }
}

function findLastUserMessage(db: Db, taskId: string): string | null {
  const all = listMessages(db, taskId, 200);
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    if (m.role === "user") return m.content;
  }
  return null;
}

/**
 * Parse a TodoWrite (claude) / update_plan (codex) tool call's args
 * into syncAgentPlan-compatible items. Returns null when the tool
 * isn't a plan tool or the shape is unrecognized — caller falls
 * through to the generic tool_call render.
 */
function parseAgentPlan(
  tool: string,
  args: unknown,
): Array<{ text: string; status: "pending" | "in_progress" | "done" }> | null {
  if (
    tool !== "TodoWrite" &&
    tool !== "todo_write" &&
    tool !== "update_plan" &&
    tool !== "UpdatePlan" &&
    tool !== "Plan"
  ) {
    return null;
  }
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const list =
    (Array.isArray(a.todos) && (a.todos as unknown[])) ||
    (Array.isArray(a.plan) && (a.plan as unknown[])) ||
    (Array.isArray(a.items) && (a.items as unknown[])) ||
    null;
  if (!list) return null;
  const out: Array<{ text: string; status: "pending" | "in_progress" | "done" }> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const text = String(
      r.content ?? r.step ?? r.task ?? r.title ?? "",
    ).trim();
    if (!text) continue;
    const rawStatus = String(r.status ?? r.state ?? "pending").toLowerCase();
    const status: "pending" | "in_progress" | "done" =
      rawStatus === "completed" ||
      rawStatus === "done" ||
      rawStatus === "complete"
        ? "done"
        : rawStatus === "in_progress" ||
            rawStatus === "in-progress" ||
            rawStatus === "active" ||
            rawStatus === "running"
          ? "in_progress"
          : "pending";
    out.push({ text, status });
  }
  return out;
}
