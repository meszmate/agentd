import type {
  AgentEvent,
  AgentKind,
  BranchMode,
  PermissionMode,
  Task,
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
  generateBranchName,
  generateCommitMessage,
  streamPrMessage,
  loadConfig,
  newId,
  renderRepoContext,
  renderSkillsCatalog,
  ensureProjectForPath,
  touchProject,
  pushBranch,
  removeWorktree,
  setTaskPrUrl,
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
    // If the task is mid-turn we queue the message and surface it in the
    // timeline as a "queued" user note. The exit handler drains the queue
    // and starts a fresh `--continue` invocation with the joined text.
    if (this.isRunning(taskId)) {
      this.queueInput(taskId, text);
      return;
    }
    appendMessage(this.db, taskId, "user", text);
    await this.spawnRunner(task, text, true);
  }

  /**
   * Steer modes:
   *   queue     — append to the queue, fires on the next turn.
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
    if (!this.isRunning(taskId)) {
      // Idle path — same as a normal sendInput so callers don't have to
      // branch on running state themselves.
      appendMessage(this.db, taskId, "user", text);
      await this.spawnRunner(task, text, true);
      return;
    }
    this.queueInput(taskId, text);
    if (mode === "interrupt") {
      // Stop and let the exit handler drain.
      await this.stop(taskId).catch(() => {});
    }
  }

  private queueInput(taskId: string, text: string): void {
    const cur = this.inputQueue.get(taskId) ?? [];
    cur.push(text);
    this.inputQueue.set(taskId, cur);
    // Surface the queued note in the timeline so the user can see it
    // landed even before the agent picks it up.
    appendMessage(this.db, taskId, "user", `[queued] ${text}`);
    this.bus.publish({
      taskId,
      event: {
        kind: "raw",
        stream: "stdout",
        text: `[queued] ${text}`,
      },
      ts: Date.now(),
    });
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
    if (catalog.entries.length > 0) {
      this.bus.publish({
        taskId: task.id,
        event: {
          kind: "raw",
          stream: "stdout",
          text: `[skills] catalog: ${catalog.entries.map((e) => e.id).join(", ")}`,
        },
        ts: Date.now(),
      });
    }
    const repoCtx = renderRepoContext({ worktreePath: task.worktreePath });
    if (repoCtx.sections.length > 0) {
      const summary = repoCtx.sections
        .map((s) => `${s.key}=${s.entries.length}`)
        .join(" ");
      this.bus.publish({
        taskId: task.id,
        event: {
          kind: "raw",
          stream: "stdout",
          text: `[repo-ctx] ${summary}`,
        },
        ts: Date.now(),
      });
    }
    const appendParts: string[] = [];
    if (cfg.agentInstructions) appendParts.push(cfg.agentInstructions);
    if (catalog.text) appendParts.push(catalog.text);
    if (repoCtx.text) appendParts.push(repoCtx.text);
    // Tell the agent to land its own work. We always ask it to commit
    // because the agent has full context of what it changed and writes
    // a much more accurate message than a separate Claude pass over the
    // diff. The daemon-side post-hook still runs as a safety net (it
    // becomes a no-op when there's nothing left to commit / push).
    const finishParts: string[] = [
      "After every meaningful step (a file edit, a successful build, a tool call that produced a useful result, or whenever you're about to wait on the user), report what you did by running this exact Bash command: `agentd-progress \"<one-line summary of what you just did>\"`.",
      "When you believe the entire task is finished, run `agentd-progress \"<final summary>\" --done` and then stop. The operator may be on their phone watching the chat mirror — that progress stream is how they see your work in real time.",
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
    } else if (event.kind === "status") {
      updateTaskStatus(this.db, taskId, event.status);
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
