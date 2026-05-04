import { lazy, Suspense, useState } from "react";
import type { Message, Task } from "@agentd/contracts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { TaskFiles } from "@/views/TaskFiles";
import { TaskDiff } from "@/views/TaskDiff";
import { TaskLog } from "@/views/TaskLog";
import { TaskContext } from "@/views/TaskContext";
import { TaskActivity } from "@/views/TaskActivity";
import type { TaskPlanItem } from "@/views/TaskPlan";
import { TodosPanel } from "@/components/todos-panel";

const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);

type Tab = "live" | "diff" | "todos" | "files" | "log" | "term" | "context";

export function TaskWorkspace({
  task,
  onError,
  plan,
  messages,
}: {
  task: Task;
  onError: (m: string) => void;
  /** Live plan from the agent's most recent TodoWrite/update_plan tool call. */
  plan?: TaskPlanItem[];
  /** Kept for back-compat; no longer rendered. */
  planUpdatedAt?: number | null;
  /** Persisted message stream — feeds the Live activity tab. */
  messages?: Message[];
}) {
  const [tab, setTab] = useState<Tab>("live");

  const planCount = plan?.length ?? 0;
  const planActive = (plan ?? []).filter((p) => p.status === "in_progress").length;
  const planDone = (plan ?? []).filter((p) => p.status === "completed").length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper-50 dark:bg-ink-900">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex h-9 items-stretch border-b border-ink-900/10 dark:border-ink-50/10 px-1 shrink-0 overflow-x-auto">
          <TabsList variant="stretch" className="h-9">
            <TabsTrigger value="live" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Live
              </span>
            </TabsTrigger>
            <TabsTrigger value="diff" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Diff
              </span>
            </TabsTrigger>
            <TabsTrigger value="todos" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Todos
              </span>
              {planCount > 0 && (
                <>
                  <span className="ml-1.5 font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300">
                    {planDone}/{planCount}
                  </span>
                  {planActive > 0 && (
                    <span className="ml-1 h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink" />
                  )}
                </>
              )}
            </TabsTrigger>
            <TabsTrigger value="files" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Files
              </span>
            </TabsTrigger>
            <TabsTrigger value="log" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Log
              </span>
            </TabsTrigger>
            <TabsTrigger value="context" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Context
              </span>
            </TabsTrigger>
            <TabsTrigger value="term" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Term
              </span>
            </TabsTrigger>
          </TabsList>
          <span className="ml-auto self-center font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate max-w-[28ch] hidden md:inline">
            {task.worktreePath}
          </span>
        </div>

        <TabsContent value="live" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <TaskActivity messages={messages ?? []} />
        </TabsContent>
        <TabsContent value="todos" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <TodosPanel taskId={task.id} />
        </TabsContent>
        <TabsContent value="files" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <TaskFiles taskId={task.id} onError={onError} />
        </TabsContent>
        <TabsContent value="diff" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <TaskDiff taskId={task.id} />
        </TabsContent>
        <TabsContent value="log" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <TaskLog taskId={task.id} onError={onError} />
        </TabsContent>
        <TabsContent value="context" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <TaskContext task={task} />
        </TabsContent>
        <TabsContent value="term" className="flex-1 min-h-0 mt-0 overflow-hidden">
          <Suspense fallback={<TermLoading />}>
            <Terminal taskId={task.id} onError={onError} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TermLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="font-mono text-[11px] text-ink-500 dark:text-ink-400">
        Loading terminal…
      </div>
    </div>
  );
}
