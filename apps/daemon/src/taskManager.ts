import type { AgentEvent, Task, AgentKind } from "@agentd/contracts";
import {
  appendMessage,
  autoCommit,
  createTask,
  detectDefaultBranch,
  EventBus,
  getTask,
  listTasks,
  listMessages,
  newId,
  removeWorktree,
  slugify,
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
}

export class TaskManager {
  private running = new Map<string, RunningSession>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly paths: AgentdPaths,
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

  async create(params: CreateTaskParams): Promise<Task> {
    const baseBranch =
      params.baseBranch ?? (await detectDefaultBranch(params.repoPath));
    const title = params.title ?? params.prompt.split("\n")[0]!.slice(0, 80);
    const taskId = newId("task");
    const branch = `agentd/${slugify(title)}-${taskId.slice(-6)}`;
    const { worktreePath } = await createWorktree({
      repoPath: params.repoPath,
      worktreeRoot: this.paths.worktrees,
      taskId,
      baseBranch,
      branchName: branch,
    });
    const task: Task = createTask(this.db, {
      id: taskId,
      title,
      agent: params.agent,
      repoPath: params.repoPath,
      worktreePath,
      branch,
      baseBranch,
    });
    appendMessage(this.db, task.id, "user", params.prompt);
    await this.spawnRunner(task, params.prompt, false);
    return task;
  }

  async sendInput(taskId: string, text: string): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error("task not found");
    if (this.isRunning(taskId)) {
      throw new Error("task is busy; wait for it to finish before sending input");
    }
    appendMessage(this.db, taskId, "user", text);
    await this.spawnRunner(task, text, true);
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
    try {
      await runner.start({ prompt, cwd: task.worktreePath, resume });
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
    } else if (event.kind === "exit") {
      const session = this.running.get(taskId);
      if (session) {
        session.unsubscribe();
        this.running.delete(taskId);
      }
      // Fire-and-forget; auto-commit runs after the agent process exits.
      void this.maybeAutoCommit(taskId);
    }
    this.bus.publish({ taskId, event, ts: Date.now() });
  }

  private async maybeAutoCommit(taskId: string): Promise<void> {
    const task = getTask(this.db, taskId);
    if (!task) return;
    const lastUserMsg = findLastUserMessage(this.db, taskId);
    const title = `agent: ${task.title}`.slice(0, 72);
    try {
      const result = await autoCommit({
        cwd: task.worktreePath,
        title,
        body: lastUserMsg ?? undefined,
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
    } catch (e) {
      appendMessage(
        this.db,
        taskId,
        "system",
        `auto-commit failed: ${(e as Error).message}`,
      );
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
