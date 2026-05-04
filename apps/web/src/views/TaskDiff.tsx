import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDiff } from "@/queries";
import {
  parseUnifiedDiff,
  StructuredDiff,
} from "@/components/structured-diff";

export function TaskDiff({ taskId }: { taskId: string }) {
  const diffQ = useDiff(taskId);

  const files = useMemo(
    () => parseUnifiedDiff(diffQ.data?.diff ?? ""),
    [diffQ.data?.diff],
  );

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [files]);

  if (diffQ.isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b border-ink-900/10 dark:border-ink-50/10 px-3 py-1.5 shrink-0">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-2.5 w-40" />
        </div>
        <div className="p-3 space-y-1.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-3"
              style={{ width: `${30 + (i * 7) % 60}%` }}
            />
          ))}
        </div>
      </div>
    );
  }
  if (!diffQ.data) {
    return <Empty>No diff available.</Empty>;
  }
  if (!diffQ.data.diff.trim() || files.length === 0) {
    return (
      <Empty>
        <div className="text-ink-900 dark:text-ink-50 font-medium">
          No changes yet.
        </div>
        <div className="mt-1 text-ink-500 dark:text-ink-400">
          Agent hasn't modified any files vs{" "}
          <span className="font-mono">{diffQ.data.baseRef}</span>.
        </div>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-ink-900/10 dark:border-ink-50/10 px-3 py-1.5 shrink-0">
        <Badge variant="outline" className="font-mono">
          vs {diffQ.data.baseRef}
        </Badge>
        <span className="font-mono text-2xs text-ink-500 dark:text-ink-400">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <span className="font-mono text-2xs tabular-nums text-emerald-600 dark:text-emerald-400">
          +{totals.add}
        </span>
        <span className="font-mono text-2xs tabular-nums text-red-600 dark:text-red-400">
          -{totals.del}
        </span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <StructuredDiff files={files} />
      </ScrollArea>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-ink-500 dark:text-ink-400">
      <div>{children}</div>
    </div>
  );
}
