import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import type { Task } from "@agentd/contracts";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { useTasks } from "@/queries";
import { TaskPane } from "@/components/task-pane";
import { cn } from "@/lib/utils";

const ACTIVE_STATUSES = new Set<Task["status"]>([
  "running",
  "waiting_input",
  "waiting_perm",
]);

/**
 * Live dashboard of every currently-active task. Always shows everything
 * that's running / waiting on a human — no manual pinning, no filters.
 * Goal: walk up to the desk, hit the sidebar grid icon, see every agent
 * in flight at once without scrolling.
 *
 * Layout: CSS grid with auto-fit columns. When the operator clicks the
 * Maximize2 icon on a pane it becomes "focused" — that pane spans 2
 * columns + 2 rows so it's roughly 4x the size of the surrounding
 * tiles. Other panes stay visible at tile density. Click the same
 * pane's Minimize2 to release focus and return to uniform tiles. A
 * `waiting_perm` task always renders with a pulsing amber ring so a
 * blocked agent is impossible to miss even at small density.
 *
 * The pane content (transcript tail, stream, hint) is read-only — to
 * actually steer the task the operator clicks through to /tasks/:id.
 */
export function Grid() {
  const tasksQ = useTasks();
  const tasks = tasksQ.data?.tasks ?? [];

  const active = useMemo(() => {
    return tasks
      .filter((t) => ACTIVE_STATUSES.has(t.status) && !t.closedAt)
      .sort((a, b) => {
        // `waiting_perm` first (blocked, needs eyes), then by recency.
        const pa = a.status === "waiting_perm" ? 0 : 1;
        const pb = b.status === "waiting_perm" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return b.updatedAt - a.updatedAt;
      });
  }, [tasks]);

  const [focusedId, setFocusedId] = useState<string | null>(null);

  // If the focused task drops off the active list (turn finished /
  // closed / removed), release focus so the layout doesn't keep a
  // phantom slot reserved for a pane that no longer renders.
  const activeIds = useMemo(() => new Set(active.map((t) => t.id)), [active]);
  useEffect(() => {
    if (focusedId && !activeIds.has(focusedId)) setFocusedId(null);
  }, [focusedId, activeIds]);

  const toggleFocus = (id: string) => {
    setFocusedId((cur) => (cur === id ? null : id));
  };

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>workspace</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Grid
        </span>
        <Count>{active.length}</Count>
        <span className="font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500">
          live
        </span>
        <Spacer />
        {focusedId && (
          <button
            type="button"
            onClick={() => setFocusedId(null)}
            className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50"
          >
            unfocus
          </button>
        )}
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-hidden p-3">
        {tasksQ.isLoading && active.length === 0 ? (
          <LoadingState />
        ) : active.length === 0 ? (
          <EmptyState />
        ) : (
          <GridLayout
            tasks={active}
            focusedId={focusedId}
            onToggleFocus={toggleFocus}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Grid layout that keeps every pane visible without scrolling. Sized
 * with auto-fit minmax so columns reflow as the window grows; the
 * focused pane spans 2x2 so it's clearly the prominent one. When no
 * pane is focused every tile shares the same size.
 *
 * Pane count → target column count (at default viewport widths):
 *   ≤2  → 1 or 2 columns (tile fills width)
 *   3-4 → 2 columns
 *   5-9 → 3 columns
 *   10+ → 4 columns (auto-fit handles the rest)
 *
 * We use plain `repeat(auto-fit, minmax(…))` so the breakpoints come
 * from CSS, not JS — resizing the window or docking a sidebar pane
 * recomputes the grid without re-rendering React.
 */
function GridLayout({
  tasks,
  focusedId,
  onToggleFocus,
}: {
  tasks: Task[];
  focusedId: string | null;
  onToggleFocus: (id: string) => void;
}) {
  // Smaller minimum when we're packing a lot of tiles so they don't all
  // wrap into one column at common laptop widths. Above 6 tiles we drop
  // to a ~240px minimum so the auto-fit can stage 4 columns at ~1280px.
  const minTile = tasks.length > 6 ? 240 : 320;

  return (
    <div
      className="grid h-full w-full gap-3"
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(${minTile}px, 1fr))`,
        gridAutoRows: "minmax(180px, 1fr)",
      }}
    >
      {tasks.map((t) => {
        const focused = focusedId === t.id;
        return (
          <div
            key={t.id}
            className={cn(
              "min-h-0 min-w-0",
              focused && "col-span-2 row-span-2",
            )}
          >
            <TaskPane
              task={t}
              focused={focused}
              onToggleFocus={() => onToggleFocus(t.id)}
              density={focused ? "focused" : "tile"}
            />
          </div>
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16">
      <LayoutGrid className="h-8 w-8 text-ink-300 dark:text-ink-600" />
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        No live tasks
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        Anything currently running or waiting for you shows up here.
        Start a task from the{" "}
        <Link
          to="/tasks"
          className="text-ember-700 hover:underline dark:text-ember-300"
        >
          Tasks
        </Link>{" "}
        view and it'll appear automatically.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
      Loading…
    </div>
  );
}
