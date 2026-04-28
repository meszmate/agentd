import { lazy, Suspense, useState } from "react";
import {
  FileText,
  GitCommit,
  GitPullRequest,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { Task } from "@agentd/contracts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskFiles } from "@/views/TaskFiles";
import { TaskDiff } from "@/views/TaskDiff";
import { TaskLog } from "@/views/TaskLog";

const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);

type Tab = "files" | "diff" | "log" | "term";

export function TaskWorkspace({
  task,
  onError,
}: {
  task: Task;
  onError: (m: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="flex h-full min-h-0 flex-col bg-cream-50 dark:bg-ink-900">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex items-center justify-between px-3 shrink-0">
          <TabsList className="border-b-0">
            <TabsTrigger value="files">
              <FileText className="h-3 w-3" />
              Files
            </TabsTrigger>
            <TabsTrigger value="diff">
              <GitPullRequest className="h-3 w-3" />
              Diff
            </TabsTrigger>
            <TabsTrigger value="log">
              <GitCommit className="h-3 w-3" />
              Log
            </TabsTrigger>
            <TabsTrigger value="term">
              <TerminalIcon className="h-3 w-3" />
              Term
            </TabsTrigger>
          </TabsList>
          <span className="hidden md:inline truncate max-w-[24ch] font-mono text-2xs text-ink-400 dark:text-ink-500">
            {task.worktreePath}
          </span>
        </div>

        <TabsContent value="files" className="flex-1 min-h-0 mt-0 overflow-hidden border-t border-ink-900/10 dark:border-ink-50/10">
          <TaskFiles taskId={task.id} onError={onError} />
        </TabsContent>
        <TabsContent value="diff" className="flex-1 min-h-0 mt-0 overflow-hidden border-t border-ink-900/10 dark:border-ink-50/10">
          <TaskDiff taskId={task.id} />
        </TabsContent>
        <TabsContent value="log" className="flex-1 min-h-0 mt-0 overflow-hidden border-t border-ink-900/10 dark:border-ink-50/10">
          <TaskLog taskId={task.id} onError={onError} />
        </TabsContent>
        <TabsContent value="term" className="flex-1 min-h-0 mt-0 overflow-hidden border-t border-ink-900/10 dark:border-ink-50/10">
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
      <div className="text-xs text-ink-500 dark:text-ink-400">Loading terminal…</div>
    </div>
  );
}
