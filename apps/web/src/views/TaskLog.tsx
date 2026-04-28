import { Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLog, useRevertCommit } from "@/queries";
import { formatTsAbsolute, shortSha } from "@/lib/utils";

export function TaskLog({
  taskId,
  onError,
}: {
  taskId: string;
  onError: (m: string) => void;
}) {
  const logQ = useLog(taskId);
  const revert = useRevertCommit(taskId);

  const doRevert = async (sha: string) => {
    if (!confirm(`Revert ${shortSha(sha)}?`)) return;
    try {
      await revert.mutateAsync(sha);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  if (logQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-ink-500 dark:text-ink-400">
        Loading log…
      </div>
    );
  }
  if (!logQ.data || logQ.data.log.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-ink-500 dark:text-ink-400">
        No commits in this worktree yet.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ol className="relative pl-9 pr-3 py-3 before:absolute before:left-3 before:top-3 before:bottom-3 before:w-px before:bg-ink-900/10 dark:before:bg-ink-50/10">
        {logQ.data.log.map((c) => (
          <li key={c.sha} className="relative pb-4 last:pb-0">
            <span className="absolute -left-9 top-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-vermilion-500 ring-4 ring-cream-50 dark:ring-ink-900" />
            <div className="flex items-start gap-3">
              <code className="font-mono text-2xs font-bold text-vermilion-700 dark:text-vermilion-300 mt-0.5 shrink-0">
                {shortSha(c.sha)}
              </code>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink-900 dark:text-ink-50">
                  {c.subject}
                </div>
                <div className="mt-0.5 font-mono text-2xs text-ink-500 dark:text-ink-400">
                  {c.author} · {formatTsAbsolute(c.ts)}
                </div>
              </div>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void doRevert(c.sha)}
                disabled={revert.isPending}
                className="shrink-0"
              >
                {revert.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Undo2 className="h-3 w-3" />
                )}
                Revert
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}
