import { Link } from "react-router-dom";
import { FolderGit2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { useProjects } from "@/queries";
import { useStore } from "@/store";
import { cn, formatTs } from "@/lib/utils";

const PALETTE = [
  "#DC2626",
  "#EA580C",
  "#D97706",
  "#65A30D",
  "#059669",
  "#0891B2",
  "#2563EB",
  "#7C3AED",
  "#DB2777",
];

function colorFor(id: string, override: string | null | undefined): string {
  if (override) return override;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export function Projects() {
  const projectsQ = useProjects();
  const unread = useStore((s) => s.unreadByProject);
  const items = projectsQ.data?.projects ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>workspace</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Projects
        </span>
        <Count>{items.length}</Count>
        <Spacer />
        <Button size="xs" asChild>
          <Link to="/tasks">
            <Plus className="h-3 w-3" /> New task
          </Link>
        </Button>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {projectsQ.isLoading && !projectsQ.data ? (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="h-16 px-5 flex items-center gap-3">
                <Skeleton className="h-3 w-3 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-72" />
                </div>
                <Skeleton className="h-3 w-12" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {items.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                color={colorFor(p.id, p.color)}
                unread={unread[p.id] ?? 0}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProjectRow({
  project: p,
  color,
  unread,
}: {
  project: import("@agentd/contracts").Project;
  color: string;
  unread: number;
}) {
  const active = p.activeCount ?? 0;
  return (
    <li>
      <Link
        to={`/projects/${p.slug}`}
        className="group h-16 px-5 flex items-center gap-4 hover:bg-paper-100 transition-colors dark:hover:bg-ink-700"
      >
        <span
          className="size-3 rounded-md shrink-0"
          style={{ background: color }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
              {p.name}
            </span>
            {active > 0 && (
              <span
                className="inline-flex items-center gap-1 h-4 px-1 rounded font-mono text-[9px] uppercase tracking-[0.08em] bg-ember-500/10 text-ember-700 dark:text-ember-300 border border-ember-500/25"
                title={`${active} active task${active === 1 ? "" : "s"}`}
              >
                <span className="h-1 w-1 rounded-full bg-ember-500 animate-blink" />
                {active} active
              </span>
            )}
            {unread > 0 && (
              <span className="inline-flex items-center h-4 px-1 rounded font-mono text-[9px] uppercase tracking-[0.08em] bg-ember-500 !text-white">
                +{unread}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-500 dark:text-ink-400">
            <FolderGit2 className="h-2.5 w-2.5" />
            <span className="truncate">{p.path}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 shrink-0 font-mono text-[10px] tabular-nums">
          <span
            className={cn(
              "text-ink-700 dark:text-ink-200",
              p.taskCount === 0 && "text-ink-400 dark:text-ink-500",
            )}
          >
            {p.taskCount ?? 0} tasks
          </span>
          <span className="text-ink-400 dark:text-ink-500">
            {formatTs(p.lastActiveAt)}
          </span>
        </div>
      </Link>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <FolderGit2 className="h-7 w-7 text-ink-300 dark:text-ink-600" />
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        No projects yet
      </div>
      <p className="max-w-md text-[12px] text-ink-500 dark:text-ink-400">
        Projects auto-create when you spawn a task at a path. Try{" "}
        <kbd className="rounded border border-ink-900/15 bg-ink-900/[0.04] px-1.5 py-0.5 font-mono text-[10px] dark:border-ink-50/15 dark:bg-ink-50/[0.04]">
          ⌘N
        </kbd>{" "}
        to start one.
      </p>
    </div>
  );
}
