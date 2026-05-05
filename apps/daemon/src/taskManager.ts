import type {
  AgentEvent,
  AgentKind,
  BranchMode,
  Council,
  CouncilMember,
  PermissionMode,
  PlanSlice,
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
  appendMessageAt,
  autoCommit,
  checkoutPrInWorktree,
  createTask,
  deleteTask,
  detectDefaultBranch,
  EventBus,
  getTask,
  getTasksDependingOn,
  listTasks,
  listTasksByPlanGroup,
  listMessages,
  markTaskCompacted,
  pruneTaskMessagesBefore,
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
  loadConfig,
  resolveModelInRegistry,
  newId,
  renderRepoContext,
  renderSkillsCatalog,
  ensureProjectForPath,
  touchProject,
  pushBranch,
  removeWorktree,
  setProviderRateLimitWindow,
  syncAgentPlan,
  setTaskCodexThreadId,
  setTaskPlanGroupId,
  updateTaskStatus,
  createWorktree,
  type AiHelperOptions,
  type AgentdPaths,
  type Db,
} from "@agentd/core";
import {
  ClaudeRunner,
  CodexRunner,
  type AgentRunner,
} from "@agentd/agent-runner";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join as pjoin,
  normalize,
  relative,
  resolve,
} from "node:path";

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
  autoCommit?: boolean;
  autoPush?: boolean;
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
  /**
   * Plan-slice chain: when set, the task is created as `pending` and
   * spawnRunner is held until the parent transitions to `done`. The
   * lifecycle hook in `runCompletionHooks` fans out from the parent.
   */
  dependsOnTaskId?: string | null;
  /** Group key shared by every sibling slice in one plan. */
  planGroupId?: string | null;
  /**
   * Pre-created worktree path (used by `createBatch` so every sibling
   * reuses the single shared worktree). When set, the manager skips
   * its own `createWorktree` call.
   */
  sharedWorktreePath?: string;
  /**
   * Pre-resolved branch name for the shared worktree. Required when
   * `sharedWorktreePath` is set so the persisted task row matches the
   * branch the worktree is checked out on.
   */
  sharedBranch?: string;
  /**
   * GitHub-spawn metadata. When `githubPr` is set, the manager runs
   * `gh pr checkout <n>` inside the freshly-created worktree before
   * the runner starts, so the agent lands on the PR's branch instead
   * of an agentd-named one. Both ids are persisted on the task row
   * for the UI's PR action bar / issue deep link.
   */
  githubIssue?: number | null;
  githubPr?: number | null;
}

export class TaskManager {
  private running = new Map<string, RunningSession>();
  /**
   * Inputs typed while the agent was mid-turn. Drained on exit so the next
   * runner starts with the user's queued message. Multiple queued lines are
   * joined with blank lines so they read like one continuous note.
   */
  private inputQueue = new Map<string, string[]>();
  private compacting = new Map<string, { startedAt: number }>();
  /**
   * Wall-clock when the current turn started — set on every `status:
   * "running"` we see from a runner, and used as the prune cutoff when
   * the CLI auto-compacts mid-turn. Pruning at "now" would drop the
   * agent message of the in-flight turn (codex emits its agent_message
   * BEFORE the compaction signal lands in `turn.completed`); pruning at
   * the start of the turn keeps the post-compaction summary intact while
   * still cutting away everything the CLI no longer remembers.
   */
  private turnStartedAt = new Map<string, number>();
  /**
   * Tasks whose agent signaled clean completion via `agentd-progress
   * --done`. The runner closes stdin in response, but claude's CLI may
   * still exit with a non-zero code (the EOF lands mid-turn before the
   * final result settles). Treat any "failed" status emitted after a
   * done-signal as "done" so successful work doesn't show up red.
   * Cleared on exit so a future steer starts fresh.
   */
  private completedSignaled = new Set<string>();
  /**
   * Per-task in-memory snapshot of file content captured AFTER each
   * codex `file_change`. Codex's JSONL stream only carries `{path,
   * kind}` for edits — to render the same inline-diff claude rows
   * use, we reconstruct each per-edit unified diff by comparing the
   * post-edit disk content against the prior snapshot (or HEAD on
   * first sighting). The snapshot is updated to the post-edit
   * content so the next edit to the same file diffs against the
   * right baseline. Cleared on task `exit`.
   */
  private codexFileSnapshots = new Map<string, Map<string, string>>();

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

  /**
   * Reset orphaned tasks at startup. When the daemon dies mid-turn the
   * runner subprocess goes with it, but the task's row stays at
   * `running` / `waiting_input` / `waiting_perm` / `idle` in the DB.
   * After restart the UI keeps drawing "agent is thinking…" and the
   * Stop button can't kill anything because there's no process. Sweep
   * those rows back to `stopped`, drop a system breadcrumb so the
   * operator knows what happened, and publish a status event so any
   * connected client repaints. Called once from the daemon entry
   * after the TaskManager is constructed.
   */
  recoverOrphans(): void {
    const orphaned = listTasks(this.db).filter(
      (t) =>
        t.status === "running" ||
        t.status === "waiting_input" ||
        t.status === "waiting_perm" ||
        t.status === "idle",
    );
    for (const t of orphaned) {
      updateTaskStatus(this.db, t.id, "stopped");
      try {
        appendMessage(
          this.db,
          t.id,
          "system",
          "[daemon restarted — turn interrupted; send a new message to resume]",
        );
      } catch {
        // never let a logging hiccup block startup
      }
      this.bus.publish({
        taskId: t.id,
        event: { kind: "status", status: "stopped" },
        ts: Date.now(),
      });
    }
  }

  private helperForTask(params: {
    agent: AgentKind;
    model?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }): AiHelperOptions {
    const cfg = loadConfig(this.paths.root);
    const helper: AiHelperOptions = {
      agent: params.agent,
      effort: params.thinkingLevel ?? cfg.aiHelpers.effort,
    };
    const selectedModel =
      params.model?.trim() || cfg.defaultModel?.[params.agent] || "";
    if (selectedModel) {
      helper.model = selectedModel;
    }
    return helper;
  }

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

  private publishQueue(taskId: string): string[] {
    const queue = this.queuedInput(taskId);
    this.bus.publish({
      taskId,
      event: { kind: "queue_updated", queue },
      ts: Date.now(),
    });
    return queue;
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
    return this.publishQueue(taskId);
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
      // Remember that this run completed cleanly so the runner's exit
      // doesn't get classified as "failed" if the CLI returns a
      // non-zero code on stdin EOF.
      this.completedSignaled.add(taskId);
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
    let branch: string;
    let worktreePath: string;
    if (params.sharedWorktreePath && params.sharedBranch) {
      // Plan-slice sibling: the batch already created the shared
      // worktree + branch; just reuse them so every slice lands on
      // the same checkout.
      worktreePath = params.sharedWorktreePath;
      branch = params.sharedBranch;
    } else {
      // Auto-name the branch when the caller didn't provide one. The
      // AI helper picks both the conventional prefix (feature/fix/
      // refactor/chore) and a tight slug, so a "fix the worktree
      // delete bug" prompt becomes `fix/worktree-delete` rather than
      // getting jammed under `feature/`. Falls back to a heuristic
      // prefix + deterministic slug if Claude isn't available — and
      // we never include the task id, so names stay short.
      if (branchMode === "existing") {
        branch = params.branchName?.trim() || baseBranch;
      } else if (params.branchName?.trim()) {
        branch = params.branchName.trim();
      } else {
        const ai = await generateBranchName(params.prompt, {
          helper: this.helperForTask({
            agent: params.agent,
            model: params.model,
            thinkingLevel: params.thinkingLevel,
          }),
        });
        branch = `${ai.prefix}/${ai.slug}`;
      }
      const result = await createWorktree({
        repoPath: params.repoPath,
        worktreeRoot: this.paths.worktrees,
        taskId,
        baseBranch,
        branchName: branch,
        workspaceMode,
        branchMode: branchMode === "shared" ? "new" : branchMode,
        pullLatest: params.pullLatest ?? false,
      });
      worktreePath = result.worktreePath;
      // `result.branch` may have been auto-suffixed (`-2`, `-3`, …) when
      // the AI's chosen name collided with an existing branch. Persist
      // the actual one so the task row, PR generator, and `git push`
      // line all reference the real ref. The PR-checkout block below
      // can still override this for `params.githubPr` runs.
      branch = result.branch;
      // PR task: switch the worktree onto the PR's branch so the agent
      // sees the proposed changes (and any commits we add land back on
      // the right branch). `gh pr checkout` resolves the head ref —
      // including fork branches — and sets up the upstream tracking.
      if (params.githubPr) {
        const co = await checkoutPrInWorktree(worktreePath, params.githubPr);
        if (!co.ok) {
          throw new Error(
            `gh pr checkout #${params.githubPr} failed: ${co.error ?? "unknown"}`,
          );
        }
        // Pick up the new HEAD as the persisted branch name so the row
        // reflects the PR branch rather than the agentd-generated one.
        const headProc = Bun.spawn({
          cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
          cwd: worktreePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        const head = (await new Response(headProc.stdout).text()).trim();
        await headProc.exited;
        if (head) branch = head;
      }
    }
    // Auto-create or look up the project for this repo path. Tasks belong
    // to projects so the sidebar can group them and surface what's new.
    const project = ensureProjectForPath(this.db, params.repoPath);
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
      // Default ON for commit + push (the agent commits + pushes when
      // done; the post-hook is a safety net). Pull requests stay manual
      // from the Ship menu.
      autoCommit: params.autoCommit ?? true,
      autoPush: params.autoPush ?? true,
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
      dependsOnTaskId: params.dependsOnTaskId ?? null,
      planGroupId: params.planGroupId ?? null,
      githubIssue: params.githubIssue ?? null,
      githubPr: params.githubPr ?? null,
    });
    touchProject(this.db, project.id);
    appendMessage(this.db, task.id, "user", params.prompt);
    if (params.dependsOnTaskId) {
      // Chained child — wait for parent to finish. The lifecycle hook
      // in runCompletionHooks fires spawnRunner once the parent reaches
      // `done`. Tell the operator on the timeline so the pending state
      // isn't a mystery.
      const parent = getTask(this.db, params.dependsOnTaskId);
      const label = parent?.title?.slice(0, 60) ?? params.dependsOnTaskId;
      appendMessage(
        this.db,
        task.id,
        "system",
        `Waiting on parent slice "${label}" to finish before this slice runs.`,
      );
      this.bus.publishSystem({ kind: "task_changed", task });
      return task;
    }
    await this.spawnRunner(task, params.prompt, false);
    return task;
  }

  /**
   * Spawn N sibling tasks from a single plan. Every slice shares one
   * worktree on one branch (when `shareWorktree` is true, the default);
   * slices run sequentially via `dependsOnTaskId` chains so two runners
   * never race on the same checkout.
   *
   * Returns the created tasks in slice order. The first slice is
   * spawned immediately; subsequent slices stay pending until the hook
   * in `runCompletionHooks` drives them on parent completion.
   */
  async createBatch(params: {
    repoPath: string;
    baseBranch?: string;
    slices: PlanSlice[];
    titlePrefix?: string;
    branchName?: string;
    shareWorktree?: boolean;
    autoPush?: boolean;
  }): Promise<Task[]> {
    if (params.slices.length === 0) {
      throw new Error("createBatch needs at least one slice");
    }
    const baseBranch =
      params.baseBranch ?? (await detectDefaultBranch(params.repoPath));
    const project = ensureProjectForPath(this.db, params.repoPath);
    const planGroupId = newId("grp");
    const shareWorktree = params.shareWorktree ?? params.slices.length > 1;

    let sharedWorktreePath: string | undefined;
    let sharedBranch: string | undefined;
    if (shareWorktree) {
      let branchName = params.branchName?.trim();
      if (!branchName) {
        const ai = await (() => {
          const first = params.slices[0]!;
          return generateBranchName(params.titlePrefix || first.prompt, {
            helper: this.helperForTask({
              agent: first.agent ?? "claude",
              model: first.model,
              thinkingLevel: first.thinkingLevel,
            }),
          });
        })();
        branchName = `${ai.prefix}/${ai.slug}`;
      }
      const result = await createWorktree({
        repoPath: params.repoPath,
        worktreeRoot: this.paths.worktrees,
        taskId: planGroupId,
        baseBranch,
        branchName,
        workspaceMode: "worktree",
        branchMode: "shared",
        planGroupId,
        pullLatest: false,
      });
      sharedWorktreePath = result.worktreePath;
      sharedBranch = result.branch;
    }

    const created: Task[] = [];
    let prevId: string | null = null;
    for (let i = 0; i < params.slices.length; i++) {
      const slice = params.slices[i]!;
      const agent: AgentKind = slice.agent ?? "claude";
      const titleBase =
        params.titlePrefix?.trim() || slice.prompt.split("\n")[0]!.slice(0, 60);
      const title =
        params.slices.length > 1
          ? `[${i + 1}/${params.slices.length}] ${slice.title || titleBase}`.slice(
              0,
              120,
            )
          : slice.title || titleBase;
      const task = await this.create({
        agent,
        repoPath: params.repoPath,
        baseBranch,
        prompt: slice.prompt,
        title,
        ...(slice.model ? { model: slice.model } : {}),
        ...(slice.thinkingLevel ? { thinkingLevel: slice.thinkingLevel } : {}),
        ...(slice.permissionMode
          ? { permissionMode: slice.permissionMode }
          : {}),
        ...(params.autoPush != null ? { autoPush: params.autoPush } : {}),
        ...(prevId ? { dependsOnTaskId: prevId } : {}),
        planGroupId,
        ...(sharedWorktreePath ? { sharedWorktreePath } : {}),
        ...(sharedBranch ? { sharedBranch } : {}),
      });
      created.push(task);
      prevId = task.id;
    }
    void project;
    return created;
  }

  /**
   * Add a sibling task to an existing one, sharing the parent's
   * worktree + branch. The new task chains via `dependsOnTaskId`
   * (sequential, runs after the parent finishes its current turn) so
   * it never races on the shared checkout. The parent's planGroupId
   * is reused (or assigned now if the parent was solo) so the
   * sidebar clusters them as siblings — the operator visually sees
   * "these tasks live on the same branch."
   *
   * Use case: drop a different agent on the same checkout to handle
   * a different concern (codex picks up a refactor while claude
   * worked on the feature, etc.).
   */
  async addSiblingTask(
    parentId: string,
    params: {
      agent: AgentKind;
      prompt: string;
      title?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      permissionMode?: PermissionMode;
      autoCommit?: boolean;
      autoPush?: boolean;
    },
  ): Promise<Task> {
    const parent = getTask(this.db, parentId);
    if (!parent) throw new Error("parent task not found");

    // Promote a solo parent into a planGroup — the sidebar cluster
    // logic groups by planGroupId, so without this the sibling would
    // sit alone in the list.
    let groupId = parent.planGroupId;
    if (!groupId) {
      groupId = newId("grp");
      setTaskPlanGroupId(this.db, parent.id, groupId);
    }

    const titleBase =
      params.title?.trim() || params.prompt.split("\n")[0]!.slice(0, 60);

    return this.create({
      agent: params.agent,
      repoPath: parent.repoPath,
      baseBranch: parent.baseBranch,
      prompt: params.prompt,
      title: titleBase,
      ...(params.model ? { model: params.model } : {}),
      ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
      ...(params.permissionMode
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(params.autoCommit != null ? { autoCommit: params.autoCommit } : {}),
      ...(params.autoPush != null ? { autoPush: params.autoPush } : {}),
      // Always chain — concurrent runners on a shared worktree race
      // on the same files. The chain hook spawns this once the parent
      // reaches done/idle.
      dependsOnTaskId: parent.id,
      planGroupId: groupId,
      // Share the parent's existing worktree + branch verbatim. No
      // new checkout, no new branch — the agent appears on the same
      // commit history as everything else in this group.
      sharedWorktreePath: parent.worktreePath,
      sharedBranch: parent.branch,
    });
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

  async compact(taskId: string, focus?: string): Promise<string> {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error("task not found");
    const f = (focus ?? "").trim();
    const directive = f
      ? `Please summarize what you've done so far in this conversation in ~200 words, focusing on "${f}". Drop intermediate scratch work and continue from the compact summary.`
      : "Please summarize what you've done so far in this conversation in ~200 words. Drop intermediate scratch work and continue from the compact summary.";
    this.compacting.set(taskId, { startedAt: Date.now() });
    await this.sendInput(taskId, directive);
    markTaskCompacted(this.db, taskId);
    return directive;
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
      this.publishQueue(taskId);
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
      this.publishQueue(taskId);
      appendMessage(this.db, taskId, "user", text);
      await this.spawnRunner(task, text, true);
      return this.inputQueue.get(taskId)?.slice() ?? [];
    }

    // Spawn-per-turn runner (codex) is running — promote fired item
    // to the front and SIGINT so the drain takes everything in
    // queue order with the fired one leading. Do not persist here:
    // runCompletionHooks drains and persists the joined queue after
    // the runner exits, so persisting now would duplicate history.
    cur.splice(index, 1);
    cur.unshift(text);
    this.inputQueue.set(taskId, cur);
    this.publishQueue(taskId);
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
    this.publishQueue(taskId);
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
    this.publishQueue(taskId);
  }


  private drainQueue(taskId: string): string | null {
    const q = this.inputQueue.get(taskId);
    if (!q || q.length === 0) return null;
    this.inputQueue.delete(taskId);
    this.publishQueue(taskId);
    return q.join("\n\n");
  }

  /**
   * The CLI just compacted its own context — bring our DB into the same
   * state by:
   *   1. Inserting a synthetic `system` boundary message at the start of
   *      the current turn (or `now` if we somehow missed the start).
   *      This is what the timeline renders as the "Conversation
   *      compacted" divider.
   *   2. Pruning every message strictly before that boundary. The
   *      post-compaction summary message (which arrives in this same
   *      turn for both runners) lands AFTER the boundary, so it stays.
   *   3. Stamping `lastCompactedAt` on the task so future spawns inject
   *      the summary as system context (`appendParts` in spawnRunner).
   *   4. Publishing the boundary as a regular timeline event AND a
   *      `task_changed` system event so every connected surface (web,
   *      telegram, discord, CLI watchers) updates without polling.
   *
   * Importantly we do NOT clear `codexThreadId` here — that's a
   * resume-control id, not a context-resync trigger. The next codex
   * steer should resume the same thread; codex itself owns whether to
   * inject its compacted summary or replay the full history.
   */
  private handleAutoCompacted(
    taskId: string,
    event: AgentEvent & { kind: "auto_compacted" },
  ): void {
    const cut = this.turnStartedAt.get(taskId) ?? Date.now();
    const trigger = event.trigger ?? "auto";
    const preTokens = event.preTokens;
    // Tagged prefix so the web's parseSystemMessage can route this to a
    // dedicated divider treatment instead of the plain monospace row.
    const detail = preTokens
      ? `[compacted ${trigger} ${preTokens}] Conversation compacted`
      : `[compacted ${trigger}] Conversation compacted`;
    // The boundary message itself sits at the cut timestamp; with
    // `pruneTaskMessagesBefore`'s `<` predicate (not `<=`) it survives
    // the prune that immediately follows.
    appendMessageAt(this.db, taskId, "system", detail, cut);
    pruneTaskMessagesBefore(this.db, taskId, cut);
    markTaskCompacted(this.db, taskId);
    // A manual /compact-in-progress is now redundant (the CLI did the
    // work for us); clear it so finalizeCompaction doesn't double-prune
    // on the next idle/done.
    this.compacting.delete(taskId);
    const fresh = getTask(this.db, taskId);
    if (fresh) this.bus.publishSystem({ kind: "task_changed", task: fresh });
  }

  private finalizeCompaction(taskId: string): void {
    const pending = this.compacting.get(taskId);
    if (!pending) return;
    this.compacting.delete(taskId);
    const msgs = listMessages(this.db, taskId);
    const summary = [...msgs]
      .reverse()
      .find((m) => m.role === "agent" && m.ts >= pending.startedAt);
    pruneTaskMessagesBefore(this.db, taskId, summary?.ts ?? pending.startedAt);
    markTaskCompacted(this.db, taskId);
    setTaskCodexThreadId(this.db, taskId, null);
    const fresh = getTask(this.db, taskId);
    if (fresh) this.bus.publishSystem({ kind: "task_changed", task: fresh });
    const session = this.running.get(taskId);
    if (session?.runner.supportsLiveInput && session.runner.running) {
      void session.runner.stop("SIGTERM").catch(() => {});
    }
  }

  async stop(taskId: string): Promise<void> {
    const session = this.running.get(taskId);
    if (!session) {
      // Even if no runner is alive, a pending chained child can be
      // explicitly cancelled — propagate to its dependents and mark
      // the row stopped so the UI clears the "waiting on parent" pill.
      const cur = getTask(this.db, taskId);
      if (cur && cur.status === "pending" && cur.dependsOnTaskId) {
        updateTaskStatus(this.db, taskId, "stopped");
        this.bus.publish({
          taskId,
          event: { kind: "status", status: "stopped" },
          ts: Date.now(),
        });
        this.propagateCancelToDependents(
          taskId,
          "an upstream slice was cancelled",
        );
      }
      return;
    }
    await session.runner.stop("SIGTERM");
    session.unsubscribe();
    this.running.delete(taskId);
    updateTaskStatus(this.db, taskId, "stopped");
    this.bus.publish({
      taskId,
      event: { kind: "status", status: "stopped" },
      ts: Date.now(),
    });
    this.propagateCancelToDependents(
      taskId,
      "an upstream slice was cancelled",
    );
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
    deleteTask(this.db, taskId);
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
    // A new run starts fresh — drop any stale done-signal from a prior
    // spawn so this run's exit is classified on its own merits.
    this.completedSignaled.delete(task.id);
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
      // Honor the operator's "use these instructions" toggle — when
      // explicitly off, keep the draft in the DB but don't inject it.
      const enabled = project?.instructionsEnabled !== false;
      if (projectInstructions && enabled) {
        appendParts.push(
          `# Project instructions\n\n${projectInstructions}\n\nYou can update this guidance with \`agentd-instructions write "<text>"\` if you discover something important worth persisting for future runs.`,
        );
      }
    }
    if (task.lastCompactedAt) {
      const compactSummary = [...listMessages(this.db, task.id)]
        .reverse()
        .find((m) => m.role === "agent" && m.ts >= (task.lastCompactedAt ?? 0));
      if (compactSummary?.content.trim()) {
        appendParts.push(
          `# Compacted conversation summary\n\n${compactSummary.content.trim()}`,
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
      // Scope-effort hint, first so it lands before the operational
      // junk below. Without this, models on `xhigh` thinking will
      // spend tens of thousands of tokens "investigating" before
      // doing a one-line edit. The operator complaint that drove
      // this: "I asked it to change a title and it took forever."
      "Match effort to the task. For trivial / one-line changes (rename, typo, copy edit, single-file tweak), just make the change directly — do NOT pre-read CLAUDE.md / AGENTS.md / package.json, do NOT survey the codebase, do NOT run grep/find unless something is genuinely ambiguous. Read the target file, edit it, commit. Reserve deep exploration for tasks that actually require it (multi-file refactors, debugging, anything cross-cutting).",
      "You have three small Bash tools for talking to the operator. They are the ONLY way they see what you're doing when away from the laptop.",
      "  - `agentd-progress \"<text>\"`  — past-tense status. Run it after every meaningful step (file edit, successful build, useful tool result). One short line each.",
      "  - `agentd-share \"<text>\"`     — forward-looking thought, non-blocking. Use it BEFORE big moves (\"thinking we should X first then Y\") so the operator can nudge before you commit. Don't wait for an answer.",
      "  - `agentd-ask \"<question>\" \"opt1\" \"opt2\" ...`  — blocking decision. Use this at real forks (architectural choice, library to pick, ambiguous naming, \"should I also do X?\"). Stops you until the operator picks. The chosen option text comes back on stdout — capture it: `answer=$(agentd-ask \"Which approach?\" \"rewrite\" \"refactor\" \"add a flag\")`. Don't fabricate a default when you genuinely don't know — ASK.",
      "  - `agentd-instructions read` / `agentd-instructions write \"<text>\"` — read or update the project's persistent guidance (like AGENTS.md but stored in the daemon, not the repo). Use it to persist hard-won knowledge that should survive into future runs of the same project: conventions, gotchas, where things live, what NOT to do. Read at the start when in doubt; write after you've discovered something a future agent should know.",
      "When you believe the entire task is finished, run `agentd-progress \"<final summary>\" --done` and then stop.",
    ];
    if (task.autoCommit !== false) {
      finishParts.push(
        // Auto-commit ON — repeated until heard. The agent's natural
        // instinct is to ask "want me to commit?" and that's exactly
        // what the operator wants to NEVER see when this flag is on.
        "Auto-commit is ON. NEVER ask the operator if you should commit. NEVER write 'Want me to commit it?', 'Should I commit?', 'Ready to commit?', or any variant. Just commit. Stage everything and `git commit` whenever you reach a meaningful checkpoint — after a successful change, after fixing a bug, after a working feature step. Multiple small commits across a turn are fine; one big commit at the end is fine; either way, JUST COMMIT, don't ask. The operator turned this flag on because they want commits to flow without permission prompts.",
        "Use a single conventional-commit subject line (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `style:`, `test:`, `perf:`, `ci:`, `build:`) under 70 characters, lowercase, imperative mood, with no scope unless one is obvious.",
        "Do NOT add `Co-Authored-By`, `Generated with`, or any AI attribution to commit messages.",
      );
    } else {
      finishParts.push(
        // Auto-commit OFF — explicit hands-off. Operator wants to
        // craft the commit themselves.
        "Auto-commit is OFF. Do NOT run `git commit` and do NOT push. Leave the worktree dirty so the operator can review the diff and craft the commit themselves. Even if you finish the task cleanly: do not commit.",
      );
    }
    if (cfg.commitInstructions?.trim()) {
      finishParts.push(`Commit style notes:\n${cfg.commitInstructions.trim()}`);
    }
    if (task.autoPush && task.autoCommit !== false) {
      finishParts.push(
        "Auto-push is ON. After committing, push the branch to origin with `git push -u origin HEAD` without asking. Don't open a pull request, that step is manual.",
      );
    } else {
      finishParts.push(
        "Do NOT push the branch and do NOT open a pull request, those are manual steps.",
      );
    }
    // Writing-style rule, last so it's the freshest hint when the
    // agent composes its reply. Operators kept complaining the
    // model's chat sounded like a press release. Force a more
    // human cadence by yanking the em-dash crutch.
    finishParts.push(
      "Writing style: write like a human typing fast, not like a press release. NO em dashes (—) anywhere. Use commas, periods, parentheses, colons, or simple hyphens (-) instead. This applies to chat replies, code comments, commit messages, PR bodies, agentd-progress lines, everything you produce. Skip filler ('Great!', 'Perfect!', 'Of course'). Skip em-dash openers ('— and another thing'). Be direct.",
    );
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
      // Codex-only — when this task already has a thread id from a
      // prior turn, pass it so the runner builds `codex exec resume
      // <id>` instead of a fresh `codex exec`. Saves AGENTS.md/MCP
      // re-init + keeps conversation context across steers.
      const resumeThreadId =
        task.agent === "codex" && resume && task.codexThreadId
          ? task.codexThreadId
          : undefined;
      // Codex-only baseline for the auto-compact heuristic — see
      // CodexRunner's priorInputTokens / handleStdoutLine. Each `codex
      // exec` is single-shot, so the runner can't track turn-over-turn
      // drops itself; we hand it the previous turn's input_tokens (kept
      // on the task in `latestTurnInputTokens`) and let it fire a
      // synthetic `auto_compacted` event when this turn comes back with
      // a sharply lower count. Claude ignores the field — it gets a
      // clean `compact_boundary` system event in stream-json instead.
      const priorInputTokens =
        task.agent === "codex" && resume && task.latestTurnInputTokens
          ? task.latestTurnInputTokens
          : undefined;
      await runner.start({
        prompt,
        cwd: task.worktreePath,
        resume,
        ...(resumeThreadId ? { resumeThreadId } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        permissionMode: task.permissionMode ?? "bypassPermissions",
        thinkingLevel: task.thinkingLevel ?? "high",
        ...(model ? { model } : {}),
        ...(additionalReadDirs.length ? { additionalReadDirs } : {}),
        ...(priorInputTokens ? { priorInputTokens } : {}),
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
      this.propagateCancelToDependents(
        task.id,
        "an upstream slice failed to start",
      );
      throw err;
    }
  }

  private handleEvent(taskId: string, event: AgentEvent): void {
    // Codex enrichment runs first so every consumer below — DB
    // append, plan sync, bus publish — sees the args with
    // `codex_diff` already attached. The web's `parseToolCall`
    // picks that up to mount the same `<EditDiffPreview>` claude
    // edits use.
    if (event.kind === "tool_call") {
      event = this.enrichCodexToolCall(taskId, event);
    }
    if (event.kind === "message" && event.role === "agent") {
      appendMessage(this.db, taskId, "agent", event.text);
    } else if (event.kind === "tool_call") {
      // Persist the full args JSON. The old 500-char cap was small
      // enough that any non-trivial Edit/MultiEdit/Write call had its
      // JSON sliced mid-string — the web's parser fell back to a
      // truncated raw blob (no file_path → row showed "?"). 32K
      // covers virtually every real edit; pathological mega-edits
      // (a write of an entire 100KB file) still get clamped, but
      // the leading file_path stays intact so the row renders.
      //
      // Swarm nesting: inject `_agentdParent` / `_agentdToolId` into
      // args (underscore-prefixed so they don't collide with any
      // real tool arg). The web's `parseToolCall` reads them out
      // and strips them before per-tool rendering, so the existing
      // switch cases keep working untouched. Lets the timeline
      // group sub-agent tool_uses under their dispatching Task /
      // collab tool row instead of laying them flat.
      //
      // `codex_diff` (the synthetic unified-diff text the codex
      // enrichment attaches for inline diff rendering) gets dropped
      // from the persisted body — it can be ~30KB per file edit and
      // anything that reads message history end-to-end (the `agentd
      // show` / `agentd attach` history dump, future MCP servers,
      // operator-side LLMs ingesting via stdout) was inhaling those
      // diffs and blowing past its context window. The live bus
      // event below still carries `codex_diff` so the web's inline
      // diff renders during the run; on reload we just lose the
      // inline body for codex rows, which falls back to a plain
      // file-edit row with the +N/-M pill.
      const persistedArgs =
        event.args &&
        typeof event.args === "object" &&
        !Array.isArray(event.args)
          ? (() => {
              const { codex_diff: _diff, ...rest } = event.args as Record<
                string,
                unknown
              >;
              if (event.parentToolUseId) rest._agentdParent = event.parentToolUseId;
              if (event.toolUseId) rest._agentdToolId = event.toolUseId;
              return rest;
            })()
          : event.args;
      appendMessage(
        this.db,
        taskId,
        "tool",
        `[call ${event.tool}] ${JSON.stringify(persistedArgs).slice(0, 32_000)}`,
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
    } else if (event.kind === "tool_result") {
      // Persist the tool's response so the timeline can render the
      // claude-code-style output preview ("3 lines + N more") and a
      // green/red status dot under the matching tool_call row above.
      // Format keeps the next-message pairing logic simple — `[result
      // <tool> ok|err] <output>`. Optional `p:<parentId>` /
      // `u:<toolUseId>` segments carry swarm-tree info — they're
      // strict regex-anchored so legacy rows still parse cleanly.
      //
      // The persisted output is clamped to 1500 chars (down from 4000)
      // so a codex run that fires ~100+ tool calls doesn't push the
      // task's persisted history into the hundreds-of-KB range. A
      // typical bash stdout, MCP result, or error blurb fits well
      // under this; large compile/test dumps get a clear `(N more
      // chars truncated)` marker so the operator knows to scroll the
      // live event for the full text.
      const okFlag = event.ok ? "ok" : "err";
      const PERSIST_LIMIT = 1500;
      const raw = event.output;
      const trimmed =
        raw.length > PERSIST_LIMIT
          ? `${raw.slice(0, PERSIST_LIMIT)}\n… (${raw.length - PERSIST_LIMIT} more chars truncated)`
          : raw;
      const meta = [
        event.parentToolUseId ? `p:${event.parentToolUseId}` : null,
        event.toolUseId ? `u:${event.toolUseId}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const header = meta
        ? `[result ${event.tool} ${okFlag} ${meta}]`
        : `[result ${event.tool} ${okFlag}]`;
      appendMessage(this.db, taskId, "tool", `${header} ${trimmed}`);
    } else if (event.kind === "status") {
      // When the agent signaled clean completion via `agentd-progress
      // --done`, treat any subsequent "failed" emit as "done" — the
      // runner closes stdin in response and claude's CLI may exit
      // non-zero from the mid-turn EOF even though the work succeeded.
      let status = event.status;
      if (status === "failed" && this.completedSignaled.has(taskId)) {
        status = "done";
        event = { kind: "status", status };
      }
      // Stamp the turn start time on every `running` transition. The
      // auto-compact handler uses this as the prune cutoff so the
      // current turn's messages are preserved even when a CLI compaction
      // signal lands late within the turn (true for codex's heuristic
      // detection, harmless for claude's clean boundary).
      if (status === "running") {
        this.turnStartedAt.set(taskId, Date.now());
      }
      updateTaskStatus(this.db, taskId, status);
      // Auto-fire any queued items at the turn boundary for
      // long-lived runners (claude). `idle` means the agent
      // finished its turn and is waiting for the next stdin
      // message — perfect moment to flush the queue. The per-row
      // Steer button is the manual mid-turn force; if the operator
      // just lets the queue sit, items drain themselves here.
      if (status === "done" && this.compacting.has(taskId)) {
        this.finalizeCompaction(taskId);
      }
      if (status === "idle") {
        if (this.compacting.has(taskId)) {
          this.finalizeCompaction(taskId);
        } else {
        const sess = this.running.get(taskId);
        if (sess?.runner.supportsLiveInput) {
          void this.autoDrainQueue(taskId);
        }
        // Plan-slice chain trigger for long-lived runners. Codex
        // exits after each turn so its `exit` event drives the
        // chain naturally; claude in stream-json mode just goes
        // `idle` and waits for the next message — meaning a slice
        // parent would never hand off to its child. When this
        // claude task has pending dependents and the operator
        // hasn't queued anything, gracefully close the runner so
        // its `exit` fires `runCompletionHooks` → chain spawns the
        // next slice. The drain logic above already short-circuited
        // if there were queued items.
        if (sess?.runner.supportsLiveInput) {
          const queued = this.inputQueue.get(taskId)?.length ?? 0;
          if (queued === 0) {
            const dependents = getTasksDependingOn(this.db, taskId);
            const hasPending = dependents.some((d) => d.status === "pending");
            if (hasPending) {
              void sess.runner.stop("SIGTERM").catch(() => {
                // ignore — exit handler will still fire when the
                // process actually dies, even on a stop error
              });
            }
          }
        }
        }
      }
    } else if (event.kind === "usage") {
      addTaskUsage(this.db, taskId, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        cumulative: event.cumulative,
        costUsd: event.costUsd,
      });
    } else if (event.kind === "auto_compacted") {
      // Mirror the CLI's own prune. Claude fires this from a
      // `compact_boundary` system event in stream-json; codex fires it
      // from a sharp drop in `input_tokens` between turns. Either way
      // the agent's working memory is now a short summary, so we cut
      // pre-compaction messages out of our DB to match. Without this
      // mirror, the web shows the full history while the agent only
      // sees the summary, and the divergence accumulates with every
      // subsequent steer.
      this.handleAutoCompacted(taskId, event);
    } else if (event.kind === "rate_limit") {
      // Account-wide signal — mirror onto the singleton row keyed by
      // provider and broadcast as a system event so the global header
      // chip refreshes everywhere. Per-task fan-out is suppressed
      // (return below) because operators don't want this row in every
      // task's timeline.
      const session = this.running.get(taskId);
      const provider = session?.runner.kind ?? "claude";
      const snapshot = setProviderRateLimitWindow(
        this.db,
        provider,
        event.rateLimitType,
        {
          status: event.status,
          resetsAt: event.resetsAt,
          ...(event.overageStatus ? { overageStatus: event.overageStatus } : {}),
          ...(event.overageDisabledReason
            ? { overageReason: event.overageDisabledReason }
            : {}),
          ...(event.isUsingOverage != null
            ? { usingOverage: event.isUsingOverage }
            : {}),
          updatedAt: Date.now(),
        },
      );
      this.bus.publishSystem({
        kind: "provider_rate_limit_updated",
        rateLimit: snapshot,
      });
      return;
    } else if (event.kind === "exit") {
      const session = this.running.get(taskId);
      if (session) {
        session.unsubscribe();
        this.running.delete(taskId);
      }
      // Reset the done-signal flag so a future steer starts fresh.
      this.completedSignaled.delete(taskId);
      // Drop the codex per-file snapshots — a fresh run rebuilds them
      // from HEAD on first sighting.
      this.codexFileSnapshots.delete(taskId);
      // The turn is over — drop the cached start time so it doesn't
      // leak across spawns. The next runner will stamp a fresh value
      // on its first `status:running`.
      this.turnStartedAt.delete(taskId);
      // Fire-and-forget; commit + push + PR all run after the agent exits.
      void this.runCompletionHooks(taskId);
    } else if (event.kind === "raw" && event.stream === "stdout") {
      // CodexRunner emits a `[codex thread] <uuid>` marker the first
      // time it sees `thread.started`. Persist the id on the task so
      // every subsequent steer can call `codex exec resume <uuid>`
      // and keep AGENTS.md/MCP/conversation context. Suppress the
      // event after we consume it — it's an internal carrier and
      // would otherwise render as a `[codex thread] …` system row in
      // every connected client's timeline.
      const m = /^\[codex thread\] ([0-9a-f-]{36})$/i.exec(event.text.trim());
      if (m) {
        const tid = m[1]!;
        const cur = getTask(this.db, taskId);
        if (cur && cur.codexThreadId !== tid) {
          setTaskCodexThreadId(this.db, taskId, tid);
        }
        return;
      }
    }
    this.bus.publish({ taskId, event, ts: Date.now() });
  }

  private async runCompletionHooks(taskId: string): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) return;
    // Auto-commit + auto-push are operator-toggleable per task.
    // Crucially, this gate ONLY skips git work — drain, council
    // judging, and the slice chain hook below ALL still run when
    // autoCommit is off. Earlier this was an early `return` for the
    // whole function, which silently blocked plan-slice chains for
    // any task with autoCommit disabled.
    if (task.autoCommit !== false) {
      const committed = await this.maybeAutoCommit(taskId, task);
      if (committed && task.autoPush) {
        await this.maybePush(taskId, task);
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
    // Plan-slice chain hook — surface the next slice if this one
    // landed cleanly, or cancel dependents on a failure exit.
    const fresh = getTask(this.db, taskId);
    if (fresh?.status === "failed") {
      this.propagateCancelToDependents(
        taskId,
        "an upstream slice failed",
      );
    } else {
      void this.maybeChainNextSlice(taskId);
    }
  }

  /**
   * If the just-finished task has dependent slices, spawn the next
   * one(s). Reads the freshest task row so we see the post-commit
   * status. Idempotent: a sibling already running won't be respawned.
   */
  private async maybeChainNextSlice(parentTaskId: string): Promise<void> {
    const parent = getTask(this.db, parentTaskId);
    if (!parent) return;
    if (parent.status !== "done" && parent.status !== "idle") return;
    const dependents = getTasksDependingOn(this.db, parentTaskId);
    for (const child of dependents) {
      if (child.status !== "pending") continue;
      if (this.isRunning(child.id)) continue;
      try {
        appendMessage(
          this.db,
          child.id,
          "system",
          `Parent slice "${parent.title.slice(0, 60)}" finished — starting this slice.`,
        );
        const promptMsgs = listMessages(this.db, child.id, 50);
        const initial =
          promptMsgs.find((m) => m.role === "user")?.content ?? child.title;
        await this.spawnRunner(child, initial, false);
      } catch (e) {
        this.bus.publish({
          taskId: child.id,
          event: {
            kind: "raw",
            stream: "stderr",
            text: `[chain spawn failed] ${(e as Error).message}`,
          },
          ts: Date.now(),
        });
      }
    }
  }

  /**
   * Mark every dependent of `parentTaskId` (transitively) as `stopped`
   * with an explanatory system message. Used when a parent fails or is
   * cancelled — children would never start otherwise.
   */
  private propagateCancelToDependents(parentTaskId: string, reason: string): void {
    const dependents = getTasksDependingOn(this.db, parentTaskId);
    for (const child of dependents) {
      if (child.status !== "pending") continue;
      appendMessage(
        this.db,
        child.id,
        "system",
        `Cancelled — ${reason}`,
      );
      updateTaskStatus(this.db, child.id, "stopped");
      this.bus.publish({
        taskId: child.id,
        event: { kind: "status", status: "stopped" },
        ts: Date.now(),
      });
      const fresh = getTask(this.db, child.id);
      if (fresh) this.bus.publishSystem({ kind: "task_changed", task: fresh });
      // Cascade: a stopped child cancels its own children too.
      this.propagateCancelToDependents(child.id, reason);
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
    let chosenText: string | null = null;
    let chosenIndex: number | null = null;
    if (typeof pick.index === "number") {
      if (pick.index < 0 || pick.index >= sug.options.length) {
        throw new Error("index out of range");
      }
      chosenIndex = pick.index;
      chosenText = sug.options[pick.index]!;
    }
    // `text` (e.g. an edited plan) wins over the original option when both
    // are sent: the UI passes `index` to record which seed was picked but
    // `text` is the actual prompt the operator wants to spawn with.
    if (pick.text && pick.text.trim()) {
      chosenText = pick.text.trim();
    }
    if (chosenText == null) {
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
    const firstMember = params.members[0]!;
    const ai = await generateBranchName(params.prompt, {
      helper: this.helperForTask({
        agent: firstMember.agent,
        model: firstMember.model,
        thinkingLevel: firstMember.thinkingLevel,
      }),
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
      const requestedBranch = `${ai.prefix}/${baseSlug}-${safeLabel}-${taskId.slice(-4)}`;
      const { worktreePath, branch: actualBranch } = await createWorktree({
        repoPath: params.repoPath,
        worktreeRoot: this.paths.worktrees,
        taskId,
        baseBranch,
        branchName: requestedBranch,
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
        branch: actualBranch,
        baseBranch,
        projectId,
        // Council members default to no auto-push — the operator picks
        // a winner via the manual Ship action.
        autoPush: false,
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
      helper: this.helperForTask({
        agent: task.agent,
        model: task.model,
        thinkingLevel: task.thinkingLevel,
      }),
      ...(cfg.commitInstructions
        ? { extraInstructions: cfg.commitInstructions }
        : {}),
    });
    const generated = ai.source === "claude" || ai.source === "codex";
    const subject =
      generated
        ? ai.message.split("\n")[0]!.slice(0, 72)
        : task.title.slice(0, 72);
    const body =
      generated && ai.message.includes("\n")
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
            kind: "message",
            role: "system",
            text: `auto-committed ${result.sha?.slice(0, 7)}: ${result.message}`,
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

  /**
   * Codex's `file_change` items only carry `{path, kind}` — no patch
   * body. To render the same inline diff claude's Edit/Write rows
   * use, we synthesize a unified diff at observation time:
   *
   *   pre  = prior in-memory snapshot for this path, or HEAD blob on
   *          first sighting (so the very first edit diffs against
   *          what was committed)
   *   post = current on-disk file content (codex applies the patch
   *          before emitting `item.completed`, so the disk state IS
   *          the post-edit state)
   *
   * The diff is computed via `git diff --no-index` against two
   * tempfiles, the headers rewritten to point at the real path so
   * the web's `parseUnifiedDiff` ends up with a sensible
   * `displayPath`, and the result stuffed into args under
   * `codex_diff`. The post-edit content is then cached as the next
   * snapshot so a follow-up edit to the same file diffs correctly
   * against its actual prior state instead of cumulatively against
   * HEAD.
   *
   * No-op for events that don't carry `codex_change_kind` (i.e.
   * everything claude emits, plus codex tool calls that aren't
   * file edits).
   */
  private enrichCodexToolCall(taskId: string, event: AgentEvent): AgentEvent {
    if (event.kind !== "tool_call") return event;
    const args = event.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) return event;
    const a = args as Record<string, unknown>;
    const ckind =
      typeof a.codex_change_kind === "string" ? a.codex_change_kind : null;
    if (!ckind) return event;
    const filePath = typeof a.file_path === "string" ? a.file_path : null;
    if (!filePath) return event;
    const task = getTask(this.db, taskId);
    if (!task?.worktreePath) return event;

    const root = task.worktreePath;
    const abs = resolveCodexEditPath(root, filePath);
    if (!abs) return event;

    // Display path: prefer the path relative to the worktree root so
    // the rendered diff header reads `apps/web/src/x.ts` instead of
    // a noisy absolute path. Falls back to whatever codex sent.
    let displayPath = filePath;
    try {
      const rel = relative(resolve(root), abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) displayPath = rel;
    } catch {
      // keep filePath as-is
    }

    let snaps = this.codexFileSnapshots.get(taskId);
    if (!snaps) {
      snaps = new Map();
      this.codexFileSnapshots.set(taskId, snaps);
    }

    let pre: string;
    if (snaps.has(filePath)) {
      pre = snaps.get(filePath) ?? "";
    } else {
      pre = readGitHeadBlob(root, displayPath) ?? "";
    }

    let post = "";
    if (ckind !== "delete") {
      try {
        post = readFileSync(abs, "utf8");
      } catch {
        post = "";
      }
    }

    snaps.set(filePath, post);

    const diff = computeUnifiedDiff(pre, post, displayPath);
    if (!diff) return event;

    return {
      ...event,
      args: { ...a, codex_diff: diff },
    };
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

/**
 * Resolve a codex-supplied file_path against the task worktree.
 * Codex sometimes emits relative paths and sometimes absolute ones;
 * either is fine as long as the final path stays inside the
 * worktree. Returns null otherwise so we never read files outside
 * the agent's sandbox.
 */
function resolveCodexEditPath(root: string, requested: string): string | null {
  const absRoot = resolve(root);
  const joined = isAbsolute(requested)
    ? normalize(requested)
    : normalize(pjoin(absRoot, requested));
  const rel = relative(absRoot, joined);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) return null;
  return joined;
}

/**
 * Read a file at the worktree's HEAD via `git show`. Used as the
 * fallback "pre-edit" content the first time we see a path edited
 * in this task. Returns null when the path doesn't exist at HEAD
 * (e.g. it's being newly added) or git errors for any reason.
 */
function readGitHeadBlob(root: string, relPath: string): string | null {
  try {
    const r = spawnSync("git", ["show", `HEAD:${relPath}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout) return r.stdout.toString("utf8");
  } catch {
    // ignore — null falls through to "no prior content"
  }
  return null;
}

/**
 * Run `git diff --no-index` between two strings and return a
 * unified-diff text whose `diff --git` / `---` / `+++` headers
 * have been rewritten to point at `displayPath`. The web's
 * `parseUnifiedDiff` keys off `a/<path>` and `b/<path>` for the
 * header parsing — without the rewrite it'd display the temp dir
 * path. Returns "" when the diff fails or the inputs are
 * identical (caller decides what to do with that).
 */
function computeUnifiedDiff(
  pre: string,
  post: string,
  displayPath: string,
): string {
  if (pre === post) return "";
  const tmp = mkdtempSync(pjoin(tmpdir(), "agentd-codex-diff-"));
  try {
    const oldFile = pjoin(tmp, "pre");
    const newFile = pjoin(tmp, "post");
    writeFileSync(oldFile, pre);
    writeFileSync(newFile, post);
    // `--no-index` makes git diff arbitrary files (no repo
    // required); exit codes: 0 = identical, 1 = differ, ≥2 = error.
    const r = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--unified=3", oldFile, newFile],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    if (r.status !== 0 && r.status !== 1) return "";
    const text = r.stdout ? r.stdout.toString("utf8") : "";
    if (!text) return "";
    return rewriteDiffPaths(text, displayPath);
  } catch {
    return "";
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore — tmpdir cleanup is best-effort
    }
  }
}

/**
 * Replace the temp-file paths in a `git diff --no-index` output's
 * `diff --git` / `---` / `+++` headers with `displayPath`. Leaves
 * the body untouched — only the first three header lines need
 * rewriting for `parseUnifiedDiff` to come out with the right
 * `displayPath`.
 */
function rewriteDiffPaths(diff: string, displayPath: string): string {
  const lines = diff.split("\n");
  let seenDiff = false;
  let seenMinus = false;
  let seenPlus = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!seenDiff && line.startsWith("diff --git ")) {
      lines[i] = `diff --git a/${displayPath} b/${displayPath}`;
      seenDiff = true;
      continue;
    }
    if (!seenMinus && line.startsWith("--- ")) {
      lines[i] = `--- a/${displayPath}`;
      seenMinus = true;
      continue;
    }
    if (!seenPlus && line.startsWith("+++ ")) {
      lines[i] = `+++ b/${displayPath}`;
      seenPlus = true;
      continue;
    }
    if (seenDiff && seenMinus && seenPlus) break;
  }
  return lines.join("\n");
}
