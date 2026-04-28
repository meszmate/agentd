import { Fragment, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useDiff } from "@/queries";
import { cn } from "@/lib/utils";

export function TaskDiff({ taskId }: { taskId: string }) {
  const diffQ = useDiff(taskId);

  const lines = useMemo(() => {
    const text = diffQ.data?.diff ?? "";
    if (!text) return [] as { kind: string; text: string }[];
    return text.split("\n").map((line) => {
      let kind = "ctx";
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff --git") ||
        line.startsWith("index ")
      ) {
        kind = "meta";
      } else if (line.startsWith("@@")) {
        kind = "hunk";
      } else if (line.startsWith("+")) {
        kind = "add";
      } else if (line.startsWith("-")) {
        kind = "del";
      }
      return { kind, text: line };
    });
  }, [diffQ.data?.diff]);

  if (diffQ.isLoading) {
    return <Empty>Loading diff…</Empty>;
  }
  if (!diffQ.data) {
    return <Empty>No diff available.</Empty>;
  }
  if (!diffQ.data.diff.trim()) {
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
        {diffQ.data.stat && (
          <span className="font-mono text-2xs text-ink-500 dark:text-ink-400 truncate">
            {diffQ.data.stat}
          </span>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <pre className="p-3 text-xs font-mono leading-snug">
          {lines.map((l, i) => (
            <Fragment key={i}>
              <span
                className={cn(
                  "block",
                  l.kind === "add" && "diff-add",
                  l.kind === "del" && "diff-del",
                  l.kind === "hunk" && "diff-hunk",
                  l.kind === "meta" && "diff-meta",
                )}
              >
                {l.text || " "}
              </span>
            </Fragment>
          ))}
        </pre>
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
