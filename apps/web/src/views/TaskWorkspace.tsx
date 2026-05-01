import { lazy, Suspense, useState } from "react";
import type { Task } from "@agentd/contracts";
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

const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);

type Tab = "files" | "diff" | "log" | "term" | "context";

export function TaskWorkspace({
  task,
  onError,
}: {
  task: Task;
  onError: (m: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper-50 dark:bg-ink-900">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex h-9 items-stretch border-b border-ink-900/10 dark:border-ink-50/10 px-1 shrink-0 overflow-x-auto">
          <TabsList variant="stretch" className="h-9">
            <TabsTrigger value="files" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Files
              </span>
            </TabsTrigger>
            <TabsTrigger value="diff" variant="stretch">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Diff
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
