import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { LayoutGrid, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
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
 * Live dashboard of every currently-active task, rendered as a
 * fullscreen overlay (not a route — there's no `/grid` URL). Triggered
 * by the LayoutGrid icon next to the "LIVE" indicator in the sidebar.
 * Always shows everything that's running / waiting on a human — no
 * manual pinning, no filters. Walk up to the desk, hit the icon, see
 * every agent in flight at once without scrolling.
 *
 * Layout: CSS grid with auto-fit columns. When the operator clicks the
 * Maximize2 icon on a pane it becomes "focused" — that pane spans 2
 * columns + 2 rows so it's roughly 4x the size of the surrounding
 * tiles. Other panes stay at tile density. Click the same pane's
 * Minimize2 to release focus and return to uniform tiles. A
 * `waiting_perm` task always renders with a pulsing amber ring so a
 * blocked agent is impossible to miss even at small density.
 *
 * Read-only: the panes show transcript tail + stream + tool hint, but
 * to actually steer a task the operator clicks the pane and we
 * navigate to /tasks/:id (route change closes the overlay below).
 *
 * Built on Radix Dialog so we get focus trap, scroll lock,
 * aria-modal, and the data-state hooks tailwindcss-animate consumes.
 * Backdrop is a translucent blur (frosted glass over the page
 * underneath) and the content panel scales+fades in for the modern
 * "lifted from the canvas" feel rather than a hard cut.
 *
 * Dismissal:
 *   - Escape closes (Radix)
 *   - Click outside the panel closes (Radix overlay)
 *   - The X button in the topbar closes
 *   - Route change closes — clicking a pane → /tasks/:id, or the
 *     toast "Open task" action firing while open. We snapshot the
 *     path on open and fire `onClose` when it changes.
 */
export function GridOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
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

  // Reset focus each time the overlay opens — stale focus from a
  // previous session would expand the wrong pane on next open.
  useEffect(() => {
    if (!open) setFocusedId(null);
  }, [open]);

  // Route change closes — clicking a pane (or the global permission
  // toast's "Open task" action) navigates to /tasks/:id, and we don't
  // want the overlay to keep painting over the task page. Snapshot the
  // path at open time and bail on any subsequent change. Pause the
  // ref-write while closed so reopening on a different route doesn't
  // immediately self-close.
  const location = useLocation();
  const openedAtPath = useRef(location.pathname);
  useEffect(() => {
    if (!open) {
      openedAtPath.current = location.pathname;
      return;
    }
    if (location.pathname !== openedAtPath.current) {
      onClose();
    }
  }, [open, location.pathname, onClose]);

  const toggleFocus = (id: string) => {
    setFocusedId((cur) => (cur === id ? null : id));
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        {/* Backdrop — dimmed + heavy blur so the page underneath
            reads as frosted glass behind the panel. Fades in/out with
            the panel's open state for a smooth dismissal. */}
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-40",
            "bg-gradient-to-br from-ink-900/40 via-ink-900/50 to-ink-900/60 dark:from-black/55 dark:via-black/65 dark:to-black/75",
            "backdrop-blur-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:duration-200 data-[state=closed]:duration-150",
          )}
        />
        {/* Content panel — nearly-fullscreen with a small inset so
            the backdrop shows around the edges. Rounded, soft-edged,
            slight translucency so the blurred backdrop tints the
            panel itself. Scale+fade in from 97% for a tasteful lift. */}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-2rem)] h-[calc(100vh-2rem)]",
            "flex flex-col overflow-hidden",
            "rounded-2xl border border-ink-900/10 dark:border-ink-50/10",
            "bg-paper-50/90 dark:bg-ink-800/85 backdrop-blur-xl",
            "shadow-[0_20px_60px_-15px_rgba(0,0,0,0.35)] dark:shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "data-[state=open]:duration-200 data-[state=closed]:duration-150",
            "ease-out",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Live grid
          </DialogPrimitive.Title>

          {/* Subtle gradient sheen at the very top edge — gives the
              panel a "polished metal" feel without any actual chrome. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-ink-50/40 to-transparent dark:via-white/10"
          />

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
                className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50 transition-colors"
              >
                unfocus
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close grid"
              title="Close (Esc)"
              className="grid place-items-center size-6 rounded-md hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
