import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Eraser, LayoutGrid, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AnimatePresence,
  LayoutGroup,
  Reorder,
  motion,
  useDragControls,
} from "motion/react";
import type { Task } from "@agentd/contracts";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { usePatchPrefs, usePrefs, useTasks } from "@/queries";
import { TaskPane } from "@/components/task-pane";
import { cn } from "@/lib/utils";

const ACTIVE_STATUSES = new Set<Task["status"]>([
  "running",
  "waiting_input",
  "waiting_perm",
]);

const FINISHED_STATUSES = new Set<Task["status"]>([
  "done",
  "failed",
  "stopped",
]);

/**
 * How a brand-new tile slots into the grid when no operator-pinned
 * position exists yet. Lower numbers go higher. Status transitions
 * NEVER reorder an existing tile — that's the whole point of sticky
 * positions: a non-focused tile that runs → done stays exactly where
 * it was, instead of jumping to the recent strip and looking like it
 * disappeared. Manual drag is the only thing that moves tiles after
 * insertion. "Clear done" prunes finished tiles from the order.
 */
function statusPriority(status: Task["status"]): number {
  if (status === "waiting_perm") return 0;
  if (status === "waiting_input") return 1;
  if (status === "running") return 2;
  if (status === "pending") return 3;
  return 4;
}

/**
 * Flex weight that auto-sizes a tile in the stack column based on its
 * status. Running and waiting_perm tiles render bigger so the
 * operator's attention naturally flows to the lanes that are actively
 * burning tokens or blocked on a permission ask. Finished tiles
 * compress because their content is frozen — the headline already
 * tells the story. Master pane (the focused tile) ignores this; it
 * always gets the full left column.
 */
function statusWeight(status: Task["status"]): number {
  if (status === "waiting_perm") return 1.7;
  if (status === "running") return 1.5;
  if (status === "waiting_input") return 1.3;
  if (status === "pending") return 1.0;
  return 0.7;
}

/**
 * Live dashboard. ONE unified layout: a master pane on the left with
 * the currently-focused task (full chat + workspace, same UI as
 * /tasks/:id), and a vertical column of stack tiles on the right
 * showing every other live + recently-finished task with their
 * transcript / live activity / code preview / inline composer.
 *
 * Click any stack tile to promote it to the master slot — the old
 * master demotes to a stack tile in its place. Motion's LayoutGroup
 * animates the swap via FLIP so the swap reads as physical motion
 * rather than a jump. Something is ALWAYS focused: when the overlay
 * opens with no prior focus, we auto-pick (waiting_perm first, then
 * running, then anything).
 *
 * Read+drive: every tile (master AND stack) carries an inline
 * composer, so the operator can type to any task without focusing it
 * first. The composer's input stops propagation so clicking into it
 * doesn't promote the tile mid-type. The ↗ button in each tile's
 * header is the explicit escape hatch to the full /tasks/:id page.
 *
 * Built on Radix Dialog so we get focus trap, scroll lock,
 * aria-modal, and the data-state hooks tailwindcss-animate consumes.
 *
 * Dismissal:
 *   - Escape closes (Radix)
 *   - Click outside the panel closes (Radix overlay)
 *   - The X button in the topbar closes
 *   - Route change closes — clicking the ↗ navigates to /tasks/:id,
 *     or the toast "Open task" action fires while open. We snapshot
 *     the path on open and fire `onClose` when it changes.
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
  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();

  // Eligible-for-grid map. Used for both the order reconcile and the
  // counters in the topbar. A task is eligible if it isn't closed and
  // is currently active OR recently finished — we keep finished tiles
  // around (the dashboard is the "see everything" surface) and the
  // operator prunes via Clear done.
  const eligibleById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) {
      if (t.closedAt) continue;
      if (ACTIVE_STATUSES.has(t.status) || FINISHED_STATUSES.has(t.status)) {
        map.set(t.id, t);
      }
    }
    return map;
  }, [tasks]);

  // The grid's source of truth for tile order: a stable sequence of
  // task ids the operator currently sees, left/top → right/bottom.
  // Seeded once from prefs.gridOrder so the layout survives reload /
  // device switch. New tasks slot in by status priority. Status
  // transitions NEVER reorder — that's the fix for the
  // disappearing-tile bug (running → done used to teleport into the
  // recent strip; now it stays where it was). Manual drag is the only
  // thing that reshuffles after insertion.
  const [tileOrder, setTileOrder] = useState<string[]>([]);
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!prefsQ.data) return;
    const persisted = prefsQ.data.prefs.gridOrder ?? [];
    // Keep only ids that still exist in the eligible set so we don't
    // resurrect ghosts. Tasks not in the persisted order will be
    // appended by the reconcile effect below.
    const seeded = persisted.filter((id) => eligibleById.has(id));
    setTileOrder(seeded);
    seededRef.current = true;
  }, [prefsQ.data, eligibleById]);

  // Reconcile the order against the live eligible set. Adds new tasks
  // (sorted by status priority so a waiting_perm shows up at the top,
  // a finished one at the bottom of the new arrivals) and prunes ids
  // that no longer exist. Existing ids keep their slot.
  useEffect(() => {
    if (!seededRef.current) return;
    setTileOrder((prev) => {
      const known = new Set(prev);
      const additions: Task[] = [];
      for (const [id, task] of eligibleById) {
        if (!known.has(id)) additions.push(task);
      }
      additions.sort((a, b) => {
        const p = statusPriority(a.status) - statusPriority(b.status);
        return p !== 0 ? p : b.createdAt - a.createdAt;
      });
      const next: string[] = [];
      for (const id of prev) {
        if (eligibleById.has(id)) next.push(id);
      }
      for (const t of additions) next.push(t.id);
      // Avoid setState churn if nothing meaningful changed — same
      // length AND same ids in the same positions.
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
        return prev;
      }
      return next;
    });
  }, [eligibleById]);

  // Debounced persistence. Drags fire many onReorder events; we only
  // want to PATCH /api/prefs once the operator settles. Persists the
  // current tileOrder, not a snapshot, so the latest state always
  // wins.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistOrder = useCallback(
    (next: string[]) => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        patchPrefs.mutate({ gridOrder: next });
      }, 400);
    },
    [patchPrefs],
  );
  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, []);

  // Hydrated list of tasks in display order. Skips ids that have
  // dropped out of the eligible set (handled by the reconcile above
  // on the next tick, but we filter here too so render is consistent).
  const orderedTasks = useMemo(() => {
    const out: Task[] = [];
    for (const id of tileOrder) {
      const t = eligibleById.get(id);
      if (t) out.push(t);
    }
    return out;
  }, [tileOrder, eligibleById]);

  // Counts for the topbar — drive the live / done chips and the
  // Clear-done button visibility.
  const liveCount = useMemo(
    () => orderedTasks.filter((t) => ACTIVE_STATUSES.has(t.status)).length,
    [orderedTasks],
  );
  const finishedCount = useMemo(
    () => orderedTasks.filter((t) => FINISHED_STATUSES.has(t.status)).length,
    [orderedTasks],
  );

  const clearFinished = useCallback(() => {
    setTileOrder((prev) => {
      const next = prev.filter((id) => {
        const t = eligibleById.get(id);
        if (!t) return false;
        return !FINISHED_STATUSES.has(t.status);
      });
      patchPrefs.mutate({ gridOrder: next });
      return next;
    });
  }, [eligibleById, patchPrefs]);

  const all = orderedTasks;

  const focusableIds = useMemo(() => new Set(all.map((t) => t.id)), [all]);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Auto-pick a focused task — the overlay should never sit on an
  // empty master pane. Blocked-on-permission first, then running,
  // then anything. Replaces a stale id if the focused task closed
  // or aged off the list.
  useEffect(() => {
    if (!open) {
      setFocusedId(null);
      return;
    }
    if (focusedId && focusableIds.has(focusedId)) return;
    if (all.length === 0) {
      if (focusedId !== null) setFocusedId(null);
      return;
    }
    const blocked = all.find((t) => t.status === "waiting_perm");
    const running = all.find((t) => t.status === "running");
    const next = blocked?.id ?? running?.id ?? all[0]?.id ?? null;
    setFocusedId(next);
  }, [open, focusedId, focusableIds, all]);

  // Route change closes — clicking the ↗ navigates to /tasks/:id, or
  // the toast "Open task" action firing while open. Snapshot the
  // path at open time and bail on any subsequent change.
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

  const focused = focusedId ? all.find((t) => t.id === focusedId) : null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
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
            <CountTicker count={liveCount} tone="live" label="live" />
            {finishedCount > 0 && (
              <CountTicker
                count={finishedCount}
                tone="recent"
                label="done"
              />
            )}
            <Spacer />
            {finishedCount > 0 && (
              <button
                type="button"
                onClick={clearFinished}
                aria-label="Clear finished tiles"
                title="Clear done tiles"
                className="inline-flex items-center gap-1 rounded-md px-2 h-6 text-[11px] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50 hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06] transition-colors"
              >
                <Eraser className="h-3 w-3" />
                <span>Clear done</span>
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

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-3">
            {tasksQ.isLoading && all.length === 0 ? (
              <LoadingState />
            ) : all.length === 0 || !focused ? (
              <EmptyState />
            ) : (
              <MasterStack
                focused={focused}
                others={all.filter((t) => t.id !== focused.id)}
                onFocus={setFocusedId}
                onReorder={(nextOthers) => {
                  // Reorder.Group hands back the ids in the new order
                  // for the stack column. Keep the focused id where it
                  // is (position 0 conceptually — the master) and rebuild
                  // tileOrder so persistence captures it.
                  setTileOrder(() => {
                    const next = [focused.id, ...nextOthers.map((t) => t.id)];
                    persistOrder(next);
                    return next;
                  });
                }}
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Master + stack layout. The master pane is the focused task with the
 * full chat + workspace (TaskTimeline + TaskWorkspace, same as
 * /tasks/:id). The stack column on the right is every OTHER task as
 * a rich tile (transcript tail, live stream, code preview, inline
 * composer) — small enough to fit several at once, big enough to
 * actually show what the agent is doing.
 *
 * Click any stack tile to promote it to master; the old master demotes
 * into the slot the click came from. Drag the small handle on a stack
 * tile to manually reorder — the new order persists across reloads /
 * devices via prefs.gridOrder. Status changes never reorder; that's
 * the operator's job (or the auto-sort for fresh arrivals).
 *
 * Tiles auto-size by status: running and waiting_perm get extra
 * height (the lanes where the operator's attention should go), idle
 * and finished compress. Past a tile-count threshold every tile flips
 * to `compact` to keep 10+ in view.
 *
 * Keyboard nav (vim-style) cycles focus through the unified list.
 * j/ArrowDown moves forward, k/ArrowUp moves back, g/G jump to
 * first/last, 1..9 jump by ordinal. Bails when an editable element
 * has focus so typing into any composer isn't hijacked.
 */
function MasterStack({
  focused,
  others,
  onFocus,
  onReorder,
}: {
  focused: Task;
  others: Task[];
  onFocus: (id: string) => void;
  onReorder: (next: Task[]) => void;
}) {
  const all = useMemo(() => [focused, ...others], [focused, others]);
  const focusedIdx = 0;

  // Compactness kicks in past ~6 stack tiles so the operator can scan
  // a wall of work without endless scroll. Below that the rich tile
  // chrome (composer, code preview, header) stays in place.
  const compactTile = others.length > 6;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (editable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = all.length;
      if (n <= 1) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = all[(focusedIdx + 1) % n];
        if (next) onFocus(next.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = all[(focusedIdx - 1 + n) % n];
        if (prev) onFocus(prev.id);
      } else if (e.key === "g") {
        e.preventDefault();
        const first = all[0];
        if (first) onFocus(first.id);
      } else if (e.key === "G") {
        e.preventDefault();
        const last = all[n - 1];
        if (last) onFocus(last.id);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const t = all[idx];
        if (t) onFocus(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, focusedIdx, onFocus]);

  return (
    <LayoutGroup>
      <div
        className="flex-1 min-h-0 grid gap-2 overflow-hidden"
        style={{
          // Master takes the lion's share of the canvas (~68%) because
          // it's the full chat + workspace where the operator actually
          // steers. Stack column at ~32% leaves enough room that the
          // rich tile body (transcript + code panel + composer) is
          // readable rather than cramped.
          gridTemplateColumns:
            others.length === 0
              ? "1fr"
              : "minmax(0, 2.1fr) minmax(320px, 1fr)",
        }}
      >
        <motion.div
          key={focused.id}
          layoutId={`tile-${focused.id}`}
          layout
          transition={{
            layout: { type: "spring", stiffness: 280, damping: 32 },
          }}
          className="min-h-0 min-w-0"
        >
          <TaskPane
            task={focused}
            focused
            onToggleFocus={() => {}}
            density="focused"
          />
        </motion.div>

        {others.length > 0 && (
          <Reorder.Group
            axis="y"
            values={others}
            onReorder={onReorder}
            as="div"
            className="min-h-0 min-w-0 flex flex-col gap-2 overflow-y-auto pr-0.5"
            // Don't let motion's default `layout` reflow the entire
            // group on every status change — we drive layout from our
            // sticky order, not the children array's stability.
            layoutScroll
          >
            {others.map((t) => (
              <StackTile
                key={t.id}
                task={t}
                onFocus={() => onFocus(t.id)}
                compact={compactTile}
                weight={statusWeight(t.status)}
                tileCount={others.length}
              />
            ))}
          </Reorder.Group>
        )}
      </div>
    </LayoutGroup>
  );
}

/**
 * One tile in the reorderable stack. The whole tile body is clickable
 * (promote to master). Drag is gated behind a small handle in the
 * top-right so a stray drag on the transcript body doesn't kick off a
 * reorder — `useDragControls` + explicit `dragListener={false}` makes
 * the listener-area limited to the handle.
 *
 * Sizing uses flex-grow with a status-derived weight (running and
 * waiting_perm grow faster than idle / finished tiles) plus a hard
 * minHeight floor so the smallest tile is still readable. At high tile
 * counts the floor wins out and the column scrolls — that's the
 * graceful-degradation path for 10+ live tasks.
 */
function StackTile({
  task,
  onFocus,
  compact,
  weight,
  tileCount,
}: {
  task: Task;
  onFocus: () => void;
  compact: boolean;
  weight: number;
  tileCount: number;
}) {
  const controls = useDragControls();

  // Floor scales down as the tile count grows so a wall of 10+ tasks
  // doesn't blow out the column with required space. Min floor of
  // 140px keeps the transcript area usable.
  const minHeight = tileCount <= 2
    ? 320
    : tileCount <= 4
    ? 240
    : tileCount <= 6
    ? 200
    : tileCount <= 8
    ? 170
    : 140;

  return (
    <Reorder.Item
      value={task}
      layoutId={`tile-${task.id}`}
      dragListener={false}
      dragControls={controls}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
      transition={{
        layout: { type: "spring", stiffness: 280, damping: 32 },
        opacity: { duration: 0.18 },
      }}
      onClick={onFocus}
      style={{
        // flex-grow weighted by status, no shrink (so tiles don't
        // collapse under each other), basis 0 so growth is purely
        // weight-driven. The minHeight floor is the safety net.
        flexGrow: weight,
        flexShrink: 0,
        flexBasis: 0,
        minHeight,
      }}
      className="relative cursor-pointer select-none"
    >
      <TaskPane
        task={task}
        focused={false}
        onToggleFocus={onFocus}
        density="tile"
        compact={compact}
      />
      {/* Drag handle — small grip pinned top-right. Stops click
          propagation so grabbing the handle doesn't promote the tile,
          and pointer-down hands off to motion's drag controls. */}
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          controls.start(e);
        }}
        onClick={(e) => e.stopPropagation()}
        role="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        className="absolute top-1.5 right-1.5 z-20 grid place-items-center size-5 rounded text-ink-400/70 hover:text-ink-900 dark:text-ink-500/70 dark:hover:text-ink-50 hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06] cursor-grab active:cursor-grabbing"
      >
        <DragGrip />
      </div>
    </Reorder.Item>
  );
}

function DragGrip() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
      <circle cx="4" cy="3" r="1" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="9" r="1" />
      <circle cx="8" cy="3" r="1" />
      <circle cx="8" cy="6" r="1" />
      <circle cx="8" cy="9" r="1" />
    </svg>
  );
}


/**
 * Animated count chip. Number swap is animated (slide up + fade) so a
 * jump from 3 → 4 lives is perceivable without explicit attention.
 * Tone differentiates "live" (ember, animated dot) from "recent"
 * (muted, static dot).
 */
function CountTicker({
  count,
  tone,
  label,
}: {
  count: number;
  tone: "live" | "recent";
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums",
        tone === "live"
          ? "text-ink-900 dark:text-ink-50"
          : "text-ink-500 dark:text-ink-400",
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          tone === "live"
            ? "bg-ember-500 animate-blink"
            : "bg-emerald-500/60",
        )}
      />
      <Count>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={count}
            initial={{ y: -8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="inline-block"
          >
            {count}
          </motion.span>
        </AnimatePresence>
      </Count>
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-[0.06em]",
          tone === "live"
            ? "text-ink-400 dark:text-ink-500"
            : "text-ink-400 dark:text-ink-500",
        )}
      >
        {label}
      </span>
    </span>
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
