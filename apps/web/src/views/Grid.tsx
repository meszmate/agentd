import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Eraser, LayoutGrid, Plus, RotateCcw, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  // Tasks the operator explicitly dismissed (per-tile X or Clear
  // done). These are skipped by the reconcile effect so the auto-add
  // doesn't undo a manual remove. NEW tasks (never previously seen)
  // bypass this set, so spawning a fresh task always shows up.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!prefsQ.data) return;
    const persistedOrder = prefsQ.data.prefs.gridOrder ?? [];
    const persistedDismissed = prefsQ.data.prefs.gridDismissed ?? [];
    // Keep only ids that still exist in the eligible set so we don't
    // resurrect ghosts. Tasks not in the persisted order will be
    // appended by the reconcile effect below.
    const seeded = persistedOrder.filter((id) => eligibleById.has(id));
    setTileOrder(seeded);
    setDismissedIds(new Set(persistedDismissed));
    seededRef.current = true;
  }, [prefsQ.data, eligibleById]);

  // Reconcile the order against the live eligible set. Adds eligible
  // tasks that are NEW (not in tileOrder, not in dismissedIds), sorted
  // by status priority. Prunes ids that no longer exist. Existing ids
  // keep their slot.
  useEffect(() => {
    if (!seededRef.current) return;
    setTileOrder((prev) => {
      const known = new Set(prev);
      const additions: Task[] = [];
      for (const [id, task] of eligibleById) {
        if (known.has(id)) continue;
        if (dismissedIds.has(id)) continue;
        additions.push(task);
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
  }, [eligibleById, dismissedIds]);

  // Debounced persistence. Drags fire many onReorder events; we only
  // want to PATCH /api/prefs once the operator settles. The patch
  // accepts a partial body so we can send only the keys that changed.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistPending = useRef<{
    gridOrder?: string[];
    gridDismissed?: string[];
  }>({});
  const flushPersist = useCallback(() => {
    const patch = persistPending.current;
    persistPending.current = {};
    if (Object.keys(patch).length === 0) return;
    patchPrefs.mutate(patch);
  }, [patchPrefs]);
  const persistPrefs = useCallback(
    (patch: { gridOrder?: string[]; gridDismissed?: string[] }) => {
      persistPending.current = { ...persistPending.current, ...patch };
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(flushPersist, 400);
    },
    [flushPersist],
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

  // Tasks eligible to be added but NOT currently shown. Powers the
  // "+ Add task" picker. Includes the dismissed-but-still-eligible
  // tasks so the operator can bring them back, plus any eligible
  // task that's somehow out of sync (rare — usually the reconcile has
  // caught it). Sorted by status priority then recency so the picker
  // surfaces urgent stuff first.
  const addableTasks = useMemo(() => {
    const inGrid = new Set(tileOrder);
    const out: Task[] = [];
    for (const [id, task] of eligibleById) {
      if (inGrid.has(id)) continue;
      out.push(task);
    }
    out.sort((a, b) => {
      const p = statusPriority(a.status) - statusPriority(b.status);
      return p !== 0 ? p : b.updatedAt - a.updatedAt;
    });
    return out;
  }, [eligibleById, tileOrder]);

  // Per-tile dismiss — drop from tileOrder AND remember the
  // dismissal so reconcile doesn't auto-re-add it on the next tick.
  // The "Add task" picker is how it comes back.
  const dismissTile = useCallback(
    (id: string) => {
      setTileOrder((prev) => {
        const next = prev.filter((x) => x !== id);
        persistPrefs({ gridOrder: next });
        return next;
      });
      setDismissedIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        persistPrefs({ gridDismissed: [...next] });
        return next;
      });
    },
    [persistPrefs],
  );

  // Re-add a previously-dismissed (or never-yet-seen) task. Lands at
  // the top of the stack so it's visible immediately. Removes from
  // dismissedIds so future status changes don't gate it.
  const addTile = useCallback(
    (id: string) => {
      if (!eligibleById.has(id)) return;
      setTileOrder((prev) => {
        if (prev.includes(id)) return prev;
        // Insert at index 1 so the focused master stays put — the new
        // tile slots in as the FIRST stack tile.
        const next = prev.length === 0 ? [id] : [prev[0]!, id, ...prev.slice(1)];
        persistPrefs({ gridOrder: next });
        return next;
      });
      setDismissedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        persistPrefs({ gridDismissed: [...next] });
        return next;
      });
    },
    [eligibleById, persistPrefs],
  );

  const clearFinished = useCallback(() => {
    // Capture the finished ids first; we need them for both the order
    // prune and the dismissed-set update so reconcile doesn't bring
    // them back.
    const finishedIds: string[] = [];
    for (const id of tileOrder) {
      const t = eligibleById.get(id);
      if (t && FINISHED_STATUSES.has(t.status)) finishedIds.push(id);
    }
    if (finishedIds.length === 0) return;
    setTileOrder((prev) => {
      const skip = new Set(finishedIds);
      const next = prev.filter((id) => !skip.has(id));
      persistPrefs({ gridOrder: next });
      return next;
    });
    setDismissedIds((prev) => {
      const next = new Set(prev);
      for (const id of finishedIds) next.add(id);
      persistPrefs({ gridDismissed: [...next] });
      return next;
    });
  }, [tileOrder, eligibleById, persistPrefs]);

  // "Show all" — wipe the dismissed set so previously-hidden tasks
  // auto-re-add on the next reconcile tick. Surfaced as a reset
  // affordance in the add-task picker footer when there's anything
  // hidden.
  const resetDismissed = useCallback(() => {
    setDismissedIds(new Set());
    persistPrefs({ gridDismissed: [] });
  }, [persistPrefs]);

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
            <AddTaskPicker
              addable={addableTasks}
              dismissedCount={dismissedIds.size}
              onAdd={addTile}
              onResetDismissed={resetDismissed}
            />
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
                onDismiss={dismissTile}
                onReorder={(nextOthers) => {
                  // Reorder.Group hands back the ids in the new order
                  // for the stack column. Keep the focused id where it
                  // is (position 0 conceptually — the master) and rebuild
                  // tileOrder so persistence captures it.
                  setTileOrder(() => {
                    const next = [focused.id, ...nextOthers.map((t) => t.id)];
                    persistPrefs({ gridOrder: next });
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
  onDismiss,
}: {
  focused: Task;
  others: Task[];
  onFocus: (id: string) => void;
  onReorder: (next: Task[]) => void;
  onDismiss: (id: string) => void;
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
                onDismiss={() => onDismiss(t.id)}
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
  onDismiss,
  compact,
  weight,
  tileCount,
}: {
  task: Task;
  onFocus: () => void;
  onDismiss: () => void;
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
      {/* Tile chrome — drag handle and remove button pinned top-right.
          Both stop click propagation so they don't promote the tile.
          Drag pointer-down hands off to motion's drag controls.
          Remove button calls onDismiss to drop this tile from the grid
          (the operator can re-add it from the topbar picker). */}
      <div className="absolute top-1.5 right-1.5 z-20 flex items-center gap-0.5">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          aria-label="Remove from grid"
          title="Remove from grid"
          className="grid place-items-center size-5 rounded text-ink-400/70 hover:text-rose-600 dark:text-ink-500/70 dark:hover:text-rose-400 hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06]"
        >
          <X className="h-3 w-3" />
        </button>
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            controls.start(e);
          }}
          onClick={(e) => e.stopPropagation()}
          role="button"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className="grid place-items-center size-5 rounded text-ink-400/70 hover:text-ink-900 dark:text-ink-500/70 dark:hover:text-ink-50 hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06] cursor-grab active:cursor-grabbing"
        >
          <DragGrip />
        </div>
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
 * Topbar "+ Add" picker. Lists every eligible-but-not-currently-shown
 * task — running ones the operator removed, finished ones cleared
 * away, brand-new ones the reconcile hasn't picked up yet — and lets
 * them slot any one back into the grid. Sorted by status priority so
 * a waiting_perm in the dismissed pile is impossible to miss.
 *
 * When the dismissed set is non-empty the footer surfaces a
 * "Show dismissed" reset that wipes it, so future status changes
 * auto-re-add. The button is hidden entirely when there's nothing to
 * add — no point in a trigger that opens an empty list.
 */
function AddTaskPicker({
  addable,
  dismissedCount,
  onAdd,
  onResetDismissed,
}: {
  addable: Task[];
  dismissedCount: number;
  onAdd: (id: string) => void;
  onResetDismissed: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (addable.length === 0 && dismissedCount === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add task to grid"
          title="Add task to grid"
          className="inline-flex items-center gap-1 rounded-md px-2 h-6 text-[11px] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50 hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06] transition-colors"
        >
          <Plus className="h-3 w-3" />
          <span>Add task</span>
          {addable.length > 0 && (
            <span className="font-mono tabular-nums text-[10px] text-ink-400 dark:text-ink-500">
              {addable.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="max-h-[min(60vh,28rem)] flex flex-col">
          <div className="px-3 py-2 border-b border-ink-900/10 dark:border-ink-50/10 flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-[0.06em] text-ink-500 dark:text-ink-400">
              Add to grid
            </span>
            <span className="text-[10px] text-ink-400 dark:text-ink-500">
              {addable.length} available
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {addable.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-ink-500 dark:text-ink-400">
                Nothing to add. Every eligible task is already on the grid.
              </div>
            ) : (
              addable.map((t) => (
                <AddPickerRow
                  key={t.id}
                  task={t}
                  onPick={() => {
                    onAdd(t.id);
                    setOpen(false);
                  }}
                />
              ))
            )}
          </div>
          {dismissedCount > 0 && (
            <div className="px-2 py-1.5 border-t border-ink-900/10 dark:border-ink-50/10">
              <button
                type="button"
                onClick={() => {
                  onResetDismissed();
                  setOpen(false);
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-md px-2 h-7 text-[11px] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50 hover:bg-ink-900/[0.06] dark:hover:bg-ink-50/[0.06] transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Show all {dismissedCount} hidden
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AddPickerRow({ task, onPick }: { task: Task; onPick: () => void }) {
  const dotClass =
    task.status === "waiting_perm"
      ? "bg-rose-500"
      : task.status === "waiting_input"
      ? "bg-amber-500"
      : task.status === "running"
      ? "bg-ember-500 animate-blink"
      : task.status === "done"
      ? "bg-emerald-500/70"
      : task.status === "failed"
      ? "bg-rose-500/60"
      : "bg-ink-400/50";
  const statusLabel =
    task.status === "waiting_perm"
      ? "needs approval"
      : task.status === "waiting_input"
      ? "needs reply"
      : task.status;
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-ink-900/[0.04] dark:hover:bg-ink-50/[0.04] transition-colors"
    >
      <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", dotClass)} />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[12px] text-ink-900 dark:text-ink-50">
          {task.title || task.id.slice(0, 8)}
        </span>
        <span className="block truncate text-[10px] text-ink-500 dark:text-ink-400 font-mono uppercase tracking-[0.04em]">
          {statusLabel}
        </span>
      </span>
      <Plus className="h-3 w-3 text-ink-400 shrink-0" />
    </button>
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
