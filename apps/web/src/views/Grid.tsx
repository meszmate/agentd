import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Eye, EyeOff, LayoutGrid, Maximize2, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import type { Task } from "@agentd/contracts";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { usePatchPrefs, usePrefs, useTasks } from "@/queries";
import { useRealtime } from "@/realtime";
import { TaskPane } from "@/components/task-pane";
import { StatusDot } from "@/components/ui/status-dot";
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
 * Recent-finished window for FOCUSED layout (rail + big pane). Tasks
 * that ended more than this ago drop off the rail; the operator can
 * still reach them from /tasks. Keeps the rail from accumulating
 * everything that ever ran during a long session.
 *
 * TILES layout uses a different rule (see `recentlyFinished` /
 * `MAX_FINISHED_TILES` in the layout component) — there we keep the
 * most recent few finished tasks regardless of age so the operator
 * can scan "ready / done / failed" alongside the live ones the way
 * a real-world dashboard would. Operators explicitly asked for this.
 */
const RECENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * How many recently-finished tasks the tiles layout keeps visible
 * after they wrap. Bigger than the focused-mode rail because the
 * tiles dashboard is the "see everything" surface — operators want
 * a strip of done / failed tiles right next to the live ones so they
 * can spot a finished result without paging away from the grid. Past
 * this many, the oldest fall off.
 */
const MAX_FINISHED_TILES = 8;

/**
 * Live dashboard of every currently-active task (and recently-finished
 * ones, dimmed in a strip below). Rendered as a fullscreen overlay —
 * not a route, no `/grid` URL. Triggered by the LayoutGrid icon in
 * the sidebar.
 *
 * Layout: motion-animated CSS grid with auto-fit columns. When the
 * operator clicks Maximize on a pane it becomes "focused" — that pane
 * spans 2x2 with the resize animated by motion's `layout` prop so the
 * other tiles slide rather than snap. Recently-finished tasks
 * accumulate in a dimmed strip below the live grid for ~10 minutes,
 * so the operator sees the celebrate flash on their next glance even
 * if they weren't watching the moment a task wrapped. `waiting_perm`
 * tasks always sort to the front of the active grid AND get a pulsing
 * amber halo (see TaskPane) so a blocked agent is impossible to miss.
 *
 * Read-only: panes show transcript tail + stream + tool hint, but to
 * steer a task the operator clicks through to /tasks/:id (which
 * closes the overlay below).
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
  const { lastStatusChange } = useRealtime();

  // Verbose mode: panes render the agent's tool calls inline (Bash
  // commands, file edits, Reads) instead of the compact agent-text-
  // only view. Persisted as a cross-device pref so the operator's
  // choice rides their account, not the device. Default off — dense
  // tool spam across 12 tiles overwhelms quickly, so most operators
  // will flip it on situationally (e.g. when watching a coding agent
  // edit files) and back off for general dashboard glances.
  const prefsQ = usePrefs();
  const verbose = prefsQ.data?.prefs.gridVerbose ?? false;
  // Layout mode — "tiles" is the multi-pane dashboard (all tasks at
  // once, no rail, stable creation-order). "focused" is the rail +
  // single-task experience. Persisted so the operator's preferred
  // dashboard shape rides their account.
  const layout: "tiles" | "focused" =
    prefsQ.data?.prefs.gridLayout ?? "tiles";
  const patchPrefs = usePatchPrefs();
  const toggleVerbose = () => {
    patchPrefs.mutate({ gridVerbose: !verbose });
  };
  const setLayout = (next: "tiles" | "focused") => {
    if (next === layout) return;
    patchPrefs.mutate({ gridLayout: next });
  };

  // Force a re-render every ~1s while open so the "recent window"
  // boundary advances — without this, finished tasks would linger past
  // their 10-minute fade unless some other event happened to retrigger
  // React. Cheap because the only thing it gates is the memo below.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  const { live, recent, recentTiles } = useMemo(() => {
    const now = Date.now();
    const liveTasks: Task[] = [];
    const recentTasks: Task[] = [];
    const recentTileTasks: Task[] = [];
    for (const t of tasks) {
      if (t.closedAt) continue;
      if (ACTIVE_STATUSES.has(t.status)) {
        liveTasks.push(t);
      } else if (FINISHED_STATUSES.has(t.status)) {
        // Use the status-flip ts when we have one (more accurate —
        // it's the moment the task actually transitioned) and fall
        // back to updatedAt for tasks that finished before the page
        // loaded (no flip event observed locally).
        const finishedAt = lastStatusChange[t.id]?.ts ?? t.updatedAt;
        // Focused-mode rail: only the last 10 minutes (the rail is a
        // narrow strip and doesn't have room for everything that ever
        // wrapped during a long session).
        if (now - finishedAt < RECENT_WINDOW_MS) {
          recentTasks.push(t);
        }
        // Tiles mode: keep recently-finished tiles around no matter
        // when they wrapped, so the operator sees ready/done/failed
        // alongside live ones on the dashboard. Capped by count below
        // so a 100-task day doesn't paint a wall of green tiles.
        recentTileTasks.push(t);
      }
    }
    // Sort live STRICTLY by creation time. We deliberately do NOT
    // sort by updatedAt (every agent token would re-shuffle the
    // grid) and we deliberately do NOT promote waiting_perm to the
    // top — operators explicitly want tile positions to NEVER jump,
    // so they can train their muscle memory on "task X always lives
    // in the upper-left." Attention on blocked tasks is conveyed
    // visually instead: amber border + pulsing halo + "approve"
    // badge on the pane itself (see TaskPane.needsApproval). The
    // operator can see a blocked task from anywhere on the grid
    // without it shouldering its way to the front and displacing
    // everything else.
    liveTasks.sort((a, b) => a.createdAt - b.createdAt);
    recentTasks.sort((a, b) => {
      const fa = lastStatusChange[a.id]?.ts ?? a.updatedAt;
      const fb = lastStatusChange[b.id]?.ts ?? b.updatedAt;
      return fb - fa;
    });
    // Tiles-mode finished list: newest-finished first, then capped.
    // The cap goes by finish time (recent ones win) but the OUTPUT
    // is then re-sorted by createdAt asc so the strip itself
    // doesn't shuffle when a new task wraps. That gives the
    // operator both "recent ones make it onto the dashboard" AND
    // "tile positions don't move."
    recentTileTasks.sort((a, b) => {
      const fa = lastStatusChange[a.id]?.ts ?? a.updatedAt;
      const fb = lastStatusChange[b.id]?.ts ?? b.updatedAt;
      return fb - fa;
    });
    const capped = recentTileTasks.slice(0, MAX_FINISHED_TILES);
    capped.sort((a, b) => a.createdAt - b.createdAt);
    return { live: liveTasks, recent: recentTasks, recentTiles: capped };
    // tick is intentionally in deps — it drives the recent window
    // sliding forward each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, lastStatusChange, tick]);

  const [focusedId, setFocusedId] = useState<string | null>(null);

  // All tasks the operator can focus from inside the overlay: every
  // currently-active task plus everything that wrapped within the
  // recent window. Finished tasks intentionally remain focusable so
  // the operator can scroll back through their transcript / diff /
  // log without leaving the grid. waiting_perm tasks float to the
  // top so a blocked agent is the first thing the operator sees on
  // open and after task transitions.
  const focusable = useMemo(() => [...live, ...recent], [live, recent]);
  const focusableIds = useMemo(
    () => new Set(focusable.map((t) => t.id)),
    [focusable],
  );

  // Tasks rendered in TILES layout. Live + recently-finished, merged
  // into ONE list sorted strictly by createdAt asc. This is the
  // critical anti-jumping invariant: a task's grid position depends
  // ONLY on when it was created, never on its status. When a task
  // flips from running → done, it stays in the exact same tile slot
  // (just changes its visual treatment via TaskPane's status-aware
  // styling). Operators consistently asked for this — they want to
  // train muscle memory on "task X always lives in the upper-left"
  // and have it actually be true. If we kept live and recent as
  // separate concatenated groups, a status flip would move the task
  // from the "live" cluster to the "recent" cluster, which IS a
  // jump — even though each group is internally stable. One sort,
  // no clusters.
  const tilesList = useMemo(() => {
    const merged = [...live, ...recentTiles];
    merged.sort((a, b) => a.createdAt - b.createdAt);
    return merged;
  }, [live, recentTiles]);
  const tilesCount = tilesList.length;

  // The overlay opens *into* a focused task — there's no separate
  // tile-grid dashboard step. Pick whichever task wants the
  // operator's attention most: blocked-on-permission first, then
  // running, then anything in the focusable list. The rail on the
  // left handles hopping between tasks; the focused pane is what
  // the operator actually came here for (live activity, code, the
  // composer to steer with). If the currently-focused task drops
  // off the focusable set (closed, aged out), pick a replacement
  // instead of falling back to a stale id.
  const pickAutoFocus = (list: Task[]): string | null => {
    if (list.length === 0) return null;
    const blocked = list.find((t) => t.status === "waiting_perm");
    if (blocked) return blocked.id;
    const running = list.find((t) => t.status === "running");
    if (running) return running.id;
    return list[0]?.id ?? null;
  };

  useEffect(() => {
    if (!open) {
      setFocusedId(null);
      return;
    }
    if (!focusedId || !focusableIds.has(focusedId)) {
      const next = pickAutoFocus(focusable);
      setFocusedId(next);
    }
  }, [open, focusedId, focusableIds, focusable]);

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

  const totalShown = focusable.length;

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
            {/* Two-part count: live (ember dot) + recent (muted dot),
                each animated when the number changes so the eye picks
                up "one more just landed" without staring. */}
            <CountTicker count={live.length} tone="live" label="live" />
            {recent.length > 0 && (
              <CountTicker
                count={recent.length}
                tone="recent"
                label="recent"
              />
            )}
            <Spacer />
            {/* Layout toggle — tiles dashboard vs focused single-pane.
                Persisted as the `gridLayout` pref so the operator's
                preferred shape rides their account. Renders as a
                segmented control: two small icon-labelled buttons,
                the active one filled. */}
            <div
              role="group"
              aria-label="Layout"
              className="inline-flex items-center rounded-md border border-ink-900/10 dark:border-ink-50/10 overflow-hidden h-6"
            >
              <button
                type="button"
                onClick={() => setLayout("tiles")}
                aria-pressed={layout === "tiles"}
                title="Tiles: see every open task at once"
                className={cn(
                  "inline-flex items-center gap-1 h-full px-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors",
                  layout === "tiles"
                    ? "bg-ember-500/15 text-ember-700 dark:text-ember-300"
                    : "text-ink-500 hover:text-ink-900 hover:bg-ink-900/[0.04] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.04]",
                )}
              >
                <LayoutGrid className="h-3 w-3" />
                tiles
              </button>
              <button
                type="button"
                onClick={() => setLayout("focused")}
                aria-pressed={layout === "focused"}
                title="Focused: rail + single big pane"
                className={cn(
                  "inline-flex items-center gap-1 h-full px-1.5 font-mono text-[10px] uppercase tracking-[0.06em] border-l border-ink-900/10 dark:border-ink-50/10 transition-colors",
                  layout === "focused"
                    ? "bg-ember-500/15 text-ember-700 dark:text-ember-300"
                    : "text-ink-500 hover:text-ink-900 hover:bg-ink-900/[0.04] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.04]",
                )}
              >
                <Maximize2 className="h-3 w-3" />
                focus
              </button>
            </div>
            {layout === "focused" && focusedId && (
              <button
                type="button"
                onClick={() => setFocusedId(null)}
                className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50 transition-colors"
              >
                unfocus
              </button>
            )}
            {/* Verbose toggle — flips the cross-device `gridVerbose`
                pref so panes start including tool calls (Bash, Edit,
                Read) inline. Optimistically reflects the click while
                the PATCH is in flight so it feels instant. */}
            <button
              type="button"
              onClick={toggleVerbose}
              aria-label={verbose ? "Hide tool calls" : "Show tool calls"}
              aria-pressed={verbose}
              title={
                verbose
                  ? "Verbose: showing tool calls (click to hide)"
                  : "Compact: agent text only (click to show tool calls)"
              }
              className={cn(
                "inline-flex items-center gap-1 h-6 px-1.5 rounded-md font-mono text-[10px] uppercase tracking-[0.06em] border transition-colors",
                verbose
                  ? "border-ember-500/30 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                  : "border-ink-900/10 text-ink-500 hover:text-ink-900 hover:bg-ink-900/[0.04] dark:border-ink-50/10 dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.04]",
              )}
            >
              {verbose ? (
                <Eye className="h-3 w-3" />
              ) : (
                <EyeOff className="h-3 w-3" />
              )}
              verbose
            </button>
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

          {/* Body — two layouts, selected by the `gridLayout` pref.
              TILES is the dashboard (every open task as a stable
              tile, no rail). FOCUSED is the rail + one big pane —
              the in-task experience for steering a single task from
              inside the overlay.

              LayoutGroup wraps both so tasks crossing layouts (live →
              recent strip) animate via FLIP rather than snapping. */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-3">
            <LayoutGroup>
              {tasksQ.isLoading &&
              (layout === "tiles" ? tilesCount === 0 : totalShown === 0) ? (
                <LoadingState />
              ) : layout === "tiles" ? (
                tilesCount === 0 ? (
                  <EmptyState />
                ) : (
                  <TilesLayout
                    tasks={tilesList}
                    verbose={verbose}
                    onFocusTask={(id) => {
                      setFocusedId(id);
                      setLayout("focused");
                    }}
                  />
                )
              ) : totalShown === 0 || !focusedId ? (
                <EmptyState />
              ) : (
                <FocusedLayout
                  tasks={focusable}
                  focusedId={focusedId}
                  onFocus={(id) => setFocusedId(id)}
                  verbose={verbose}
                />
              )}
            </LayoutGroup>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * TILES layout — a real bento grid. One unified CSS grid where each
 * tile gets explicit placement (gridColumn / gridRow start + span)
 * from a hand-designed template chosen by task count. Templates 1-9
 * are tiled by hand so every cell of the grid is consumed exactly,
 * with the hero slot (a 2x2 quadrant) reserved for the most-important
 * task and surrounding slots filled by smaller tiles. For 10+ tasks
 * we generate a layout programmatically (hero + uniform 1x1 tail).
 *
 * Tasks are mapped to slots in PRIORITY order: running > waiting >
 * others, then createdAt asc within each priority class. This is what
 * the operator actually meant by "running tasks are bigger" — the
 * hero is whichever task is currently most important, not whichever
 * was created first. Status changes do move a task between slots
 * (running → done shrinks it out of the hero), but slot positions
 * themselves are fixed by the template, and within each priority
 * class the createdAt sort keeps things from shuffling.
 *
 * The grid uses `gridTemplateColumns/Rows: 1fr` so every cell shares
 * the available canvas evenly — no `auto` rows / minmax(220px, auto)
 * trickery that left empty bands. With explicit placement, every
 * cell is consumed and the rows stretch to fill the overlay height
 * exactly. That's "fill the whole space."
 */
function TilesLayout({
  tasks,
  verbose,
  onFocusTask,
}: {
  tasks: Task[];
  verbose: boolean;
  /** Switch the overlay to focused layout on this task. Wired to the
   *  maximize button on each tile so "see all" → "drive one" is one
   *  click without leaving the overlay. */
  onFocusTask: (id: string) => void;
}) {
  // Sort by priority — running tasks first, then waiting, then the
  // rest. createdAt asc within each class for stable ordering.
  const ordered = useMemo(() => {
    const pri = (t: Task): number => {
      if (t.status === "running") return 0;
      if (t.status === "waiting_perm" || t.status === "waiting_input") return 1;
      return 2;
    };
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      const pa = pri(a);
      const pb = pri(b);
      if (pa !== pb) return pa - pb;
      return a.createdAt - b.createdAt;
    });
    return sorted;
  }, [tasks]);

  const layout = useMemo(() => bentoLayout(ordered.length), [ordered.length]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pr-1">
      <div
        className="grid gap-2 h-full"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
          minHeight: "100%",
        }}
      >
        {ordered.map((t, i) => {
          const slot = layout.slots[i];
          if (!slot) return null;
          return (
            <div
              key={t.id}
              className="min-h-0 min-w-0 transition-[grid-area] duration-200 ease-out"
              style={{
                gridColumn: `${slot.col} / span ${slot.colSpan}`,
                gridRow: `${slot.row} / span ${slot.rowSpan}`,
              }}
            >
              <TaskPane
                task={t}
                focused={false}
                onToggleFocus={() => onFocusTask(t.id)}
                density="tile"
                verbose={verbose}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

type BentoSlot = {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
};

type BentoTemplate = {
  cols: number;
  rows: number;
  slots: BentoSlot[];
};

/**
 * Pick the right bento template for a given tile count. Templates
 * 1-9 are hand-tiled — every cell of the grid is consumed. For 10+
 * we generate a 4-col grid with a 2x2 hero at the top-left and 1x1
 * tiles filling the remaining cells; when the last row would be
 * short, the trailing tile spans wide to consume the remainder so
 * there's still no empty cell.
 */
function bentoLayout(n: number): BentoTemplate {
  if (n <= 0) return { cols: 1, rows: 1, slots: [] };

  // Hand-tiled templates 1-9. Each one is verified to tile its
  // (cols × rows) rectangle exactly: sum(colSpan × rowSpan) === cols × rows.
  if (n === 1) {
    return {
      cols: 1,
      rows: 1,
      slots: [{ col: 1, row: 1, colSpan: 1, rowSpan: 1 }],
    };
  }
  if (n === 2) {
    return {
      cols: 2,
      rows: 1,
      slots: [
        { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      ],
    };
  }
  if (n === 3) {
    // Hero (2x2) on the left, two stacked tiles on the right.
    return {
      cols: 3,
      rows: 2,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
      ],
    };
  }
  if (n === 4) {
    // Hero (2x2) + 2 small (1x1) + 1 wide (2x1). 8 cells in a 4×2.
    return {
      cols: 4,
      rows: 2,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 2, rowSpan: 1 },
      ],
    };
  }
  if (n === 5) {
    // Hero + 2 small (right column) + 1 wide (bottom-left) + 1 small.
    // 9 cells in a 3×3.
    return {
      cols: 3,
      rows: 3,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 3, colSpan: 2, rowSpan: 1 },
        { col: 3, row: 3, colSpan: 1, rowSpan: 1 },
      ],
    };
  }
  if (n === 6) {
    // Hero + 2 small (right) + 3 small (bottom). 9 cells in a 3×3.
    return {
      cols: 3,
      rows: 3,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 2, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 3, colSpan: 1, rowSpan: 1 },
      ],
    };
  }
  if (n === 7) {
    // Hero + 4 small + 2 wide (bottom). 12 cells in a 4×3.
    return {
      cols: 4,
      rows: 3,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 3, colSpan: 2, rowSpan: 1 },
        { col: 3, row: 3, colSpan: 2, rowSpan: 1 },
      ],
    };
  }
  if (n === 8) {
    // Hero + 4 small (right) + 2 small (bottom-left) + 1 wide.
    // 12 cells in a 4×3.
    return {
      cols: 4,
      rows: 3,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 2, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 3, colSpan: 2, rowSpan: 1 },
      ],
    };
  }
  if (n === 9) {
    // Hero + 8 small (right column + bottom row). 12 cells in a 4×3.
    return {
      cols: 4,
      rows: 3,
      slots: [
        { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 2, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 2, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 3, row: 3, colSpan: 1, rowSpan: 1 },
        { col: 4, row: 3, colSpan: 1, rowSpan: 1 },
      ],
    };
  }

  // n >= 10 — generate a 4-col layout with a 2x2 hero in the
  // top-left and 1x1 tiles filling the remainder in row-major order.
  // If the LAST row would be short, extend the final tile to span
  // the trailing empty cells so the grid is still fully consumed.
  const cols = 4;
  const slots: BentoSlot[] = [];
  // Hero
  slots.push({ col: 1, row: 1, colSpan: 2, rowSpan: 2 });
  // Remaining small tiles fill cells in row-major scan, skipping
  // those occupied by the hero (cols 1-2 of rows 1-2).
  const remaining = n - 1;
  // Cells we need = 4 (hero) + remaining. Round up to a full row.
  const cells = 4 + remaining;
  const rows = Math.ceil(cells / cols);
  const filledByHero = new Set<string>();
  for (let r = 1; r <= 2; r++) {
    for (let c = 1; c <= 2; c++) {
      filledByHero.add(`${c},${r}`);
    }
  }
  const freeCells: Array<{ col: number; row: number }> = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      if (filledByHero.has(`${c},${r}`)) continue;
      freeCells.push({ col: c, row: r });
    }
  }
  for (let i = 0; i < remaining; i++) {
    const cell = freeCells[i];
    if (!cell) break;
    slots.push({
      col: cell.col,
      row: cell.row,
      colSpan: 1,
      rowSpan: 1,
    });
  }
  // If trailing cells are unconsumed (cells > 4 + remaining), expand
  // the last tile to absorb them along its row.
  const consumed = 4 + remaining;
  const totalCells = cols * rows;
  const trailingEmpty = totalCells - consumed;
  if (trailingEmpty > 0 && slots.length > 1) {
    const last = slots[slots.length - 1]!;
    // Trailing empties live to the right of the last tile in its row.
    const maxExtend = cols - (last.col + last.colSpan - 1);
    const extend = Math.min(trailingEmpty, maxExtend);
    last.colSpan += extend;
  }
  return { cols, rows, slots };
}

/**
 * FOCUSED layout — rail on the left + one big focused pane. The
 * operator is always inside one task. The rail on the left lists every focusable task
 * (live + recently-finished, so finished tasks remain inspectable)
 * for one-click hopping; the big focused pane on the right is a
 * split: TaskTimeline (chat with thinking pulse + composer) on
 * the left, TaskWorkspace (Live / Diff / Todos / Files / Log /
 * Context / Term tabs) on the right — the same shape as
 * `/tasks/:id`, just embedded in the overlay.
 *
 * Keyboard nav (vim-style):
 *   - j / ArrowDown: focus the next task in the rail
 *   - k / ArrowUp:   focus the previous task
 *   - g:             jump to the first task
 *   - G:             jump to the last task
 *   - 1..9:          jump to the Nth task in the rail
 *   - Esc:           close the overlay (Radix Dialog default —
 *                    we don't intercept it because there's no
 *                    intermediate state to step back to)
 *
 * Typing into the composer is unaffected — the handler bails when
 * an editable element has focus so j / k / 1 don't hijack input.
 *
 * Each task keeps its `layoutId` so reorderings (waiting_perm
 * jumping to the top, status flips) animate via FLIP.
 */
function FocusedLayout({
  tasks,
  focusedId,
  onFocus,
  verbose,
}: {
  tasks: Task[];
  focusedId: string;
  onFocus: (id: string) => void;
  verbose: boolean;
}) {
  const focusedTask = tasks.find((t) => t.id === focusedId);
  const focusedIdx = tasks.findIndex((t) => t.id === focusedId);

  // Keyboard navigation. Attached to window so it works no matter
  // where focus sits, but bails when the target is an editable
  // element so the operator's typing isn't hijacked.
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
      const n = tasks.length;
      if (n === 0) return;
      const cur = focusedIdx;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = tasks[(cur + 1 + n) % n];
        if (next) onFocus(next.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = tasks[(cur - 1 + n) % n];
        if (prev) onFocus(prev.id);
      } else if (e.key === "g") {
        e.preventDefault();
        const first = tasks[0];
        if (first) onFocus(first.id);
      } else if (e.key === "G") {
        e.preventDefault();
        const last = tasks[n - 1];
        if (last) onFocus(last.id);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const t = tasks[idx];
        if (t) onFocus(t.id);
      }
      // Esc is handled at the Dialog level (onEscapeKeyDown) so a
      // single press goes "focused pane → grid → close overlay"
      // in two presses without racing this window listener.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tasks, focusedIdx, onFocus]);

  // Defensive: parent releases focus when the focused id drops out
  // of the focusable set, but on the same render tick it's possible
  // we're here with a stale id. Render nothing and let the parent
  // un-focus on the next tick.
  if (!focusedTask) return null;

  return (
    <div className="flex h-full min-h-0 gap-3">
      {tasks.length > 1 && (
        <RailSidebar
          tasks={tasks}
          focusedId={focusedId}
          onFocus={onFocus}
        />
      )}
      {/* Big focused pane — fills the remaining width. layoutId
          preserved so reorderings (waiting_perm flips to the top,
          status changes) animate the rail+pane together rather
          than snapping. onToggleFocus is a no-op here because the
          focus toggle button is hidden in always-focused mode. */}
      <motion.div
        layout
        layoutId={focusedTask.id}
        initial={false}
        transition={{
          layout: { type: "spring", stiffness: 280, damping: 30 },
        }}
        className="flex-1 min-w-0 min-h-0"
      >
        <TaskPane
          task={focusedTask}
          focused
          onToggleFocus={() => {}}
          density="focused"
          verbose={verbose}
        />
      </motion.div>
    </div>
  );
}

/**
 * Vertical rail listing every focusable task. Each row is a thin
 * card (status dot, agent badge, title, optional approve pulse, hint
 * + tokens), small enough to fit a dozen in view. The currently-
 * focused row gets an ember border + filled background so it reads
 * as the selected item in a list.
 *
 * Per-row footnotes show keybind index (1-9) for the first nine
 * tasks so the operator learns the shortcut without a tutorial.
 */
function RailSidebar({
  tasks,
  focusedId,
  onFocus,
}: {
  tasks: Task[];
  focusedId: string;
  onFocus: (id: string) => void;
}) {
  return (
    <div className="shrink-0 w-[220px] flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1 shrink-0">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
          tasks
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-ink-900/10 via-ink-900/5 to-transparent dark:from-ink-50/10 dark:via-ink-50/5" />
        <span className="font-mono text-[9.5px] tabular-nums text-ink-400 dark:text-ink-500">
          {tasks.length}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-1">
        <AnimatePresence mode="popLayout" initial={false}>
          {tasks.map((t, i) => (
            <motion.div
              key={t.id}
              layout
              layoutId={t.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8, transition: { duration: 0.15 } }}
              transition={{
                layout: { type: "spring", stiffness: 320, damping: 32 },
                opacity: { duration: 0.18 },
              }}
            >
              <RailRow
                task={t}
                index={i}
                focused={t.id === focusedId}
                onClick={() => onFocus(t.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="shrink-0 px-1 pt-1 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06]">
        <div className="font-mono text-[9px] leading-relaxed text-ink-400 dark:text-ink-500">
          <kbd className="text-ink-500 dark:text-ink-400">j</kbd>
          <kbd className="text-ink-500 dark:text-ink-400">k</kbd>
          {" cycle · "}
          <kbd className="text-ink-500 dark:text-ink-400">1-9</kbd>
          {" jump · "}
          <kbd className="text-ink-500 dark:text-ink-400">esc</kbd>
          {" close"}
        </div>
      </div>
    </div>
  );
}

function RailRow({
  task,
  index,
  focused,
  onClick,
}: {
  task: Task;
  index: number;
  focused: boolean;
  onClick: () => void;
}) {
  const { latestByTask, pulses } = useRealtime();
  const latest = latestByTask[task.id];
  const pulseTs = pulses[task.id] ?? 0;
  const hot = Date.now() - pulseTs < 1500;
  const needsApproval = task.status === "waiting_perm";
  const isRunning =
    task.status === "running" ||
    task.status === "waiting_input" ||
    task.status === "waiting_perm";
  const isFinished =
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "stopped";

  return (
    <button
      type="button"
      onClick={onClick}
      title={task.title}
      className={cn(
        "group w-full text-left flex flex-col gap-1 rounded-md border px-2 py-1.5 transition-colors",
        focused
          ? "border-ember-500/40 bg-ember-500/[0.06] dark:bg-ember-500/[0.08]"
          : "border-ink-900/[0.08] hover:bg-ink-900/[0.03] dark:border-ink-50/[0.08] dark:hover:bg-ink-50/[0.03]",
        needsApproval && !focused && "border-amber-500/40 bg-amber-500/[0.05]",
        isFinished && !focused && "opacity-65 hover:opacity-100",
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <StatusDot status={task.status} size="sm" />
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 w-3">
          {index < 9 ? index + 1 : ""}
        </span>
        <span
          className={cn(
            "flex-1 min-w-0 truncate text-[11.5px] font-medium",
            focused
              ? "text-ink-900 dark:text-ink-50"
              : "text-ink-700 dark:text-ink-200",
          )}
        >
          {task.title}
        </span>
        {needsApproval && (
          <span className="shrink-0 inline-flex items-center justify-center h-3.5 w-3.5 rounded font-mono text-[9px] bg-amber-500/20 text-amber-700 dark:text-amber-300 animate-pulse">
            !
          </span>
        )}
        {hot && !needsApproval && !focused && (
          <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink" />
        )}
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500 shrink-0">
          {task.agent}
        </span>
        <span className="font-mono text-[9.5px] text-ink-500 dark:text-ink-400 truncate min-w-0 flex-1">
          {isRunning
            ? latest?.text ?? "…"
            : task.branch}
        </span>
      </div>
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
