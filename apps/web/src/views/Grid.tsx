import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Eye, EyeOff, LayoutGrid, X } from "lucide-react";
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
 * Recent-finished window: how long after a task ends do we keep it on
 * the grid? Long enough that the operator can see "this one just
 * wrapped" on their next glance (so the celebrate flash on TaskPane
 * doesn't fire into the void), short enough that the recent strip
 * doesn't accumulate forever during a long session. 10 minutes feels
 * about right — most operators will have eyeballed the grid at least
 * once in that window, and tasks that finished hours ago belong on
 * the main /tasks list anyway.
 */
const RECENT_WINDOW_MS = 10 * 60 * 1000;

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
  const patchPrefs = usePatchPrefs();
  const toggleVerbose = () => {
    patchPrefs.mutate({ gridVerbose: !verbose });
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

  const { live, recent } = useMemo(() => {
    const now = Date.now();
    const liveTasks: Task[] = [];
    const recentTasks: Task[] = [];
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
        if (now - finishedAt < RECENT_WINDOW_MS) {
          recentTasks.push(t);
        }
      }
    }
    // Sort live: waiting_perm first (blocked, needs eyes), then by
    // CREATION time (stable). We deliberately do NOT sort by
    // updatedAt — every agent token bumps updatedAt and the grid
    // would re-shuffle on every WS event, which is disorienting and
    // makes tracking a specific tile by position impossible. Stable
    // creation-order means a tile's position only changes when its
    // status crosses the waiting_perm boundary (something that
    // genuinely needs the operator's attention), not every time it
    // exhales a token.
    liveTasks.sort((a, b) => {
      const pa = a.status === "waiting_perm" ? 0 : 1;
      const pb = b.status === "waiting_perm" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.createdAt - b.createdAt;
    });
    recentTasks.sort((a, b) => {
      const fa = lastStatusChange[a.id]?.ts ?? a.updatedAt;
      const fb = lastStatusChange[b.id]?.ts ?? b.updatedAt;
      return fb - fa;
    });
    return { live: liveTasks, recent: recentTasks };
    // tick is intentionally in deps — it drives the recent window
    // sliding forward each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, lastStatusChange, tick]);

  const [focusedId, setFocusedId] = useState<string | null>(null);

  // If the focused task drops off the active list (turn finished /
  // closed / removed), release focus so the layout doesn't keep a
  // phantom slot reserved for a pane that no longer renders.
  const liveIds = useMemo(() => new Set(live.map((t) => t.id)), [live]);
  useEffect(() => {
    if (focusedId && !liveIds.has(focusedId)) setFocusedId(null);
  }, [focusedId, liveIds]);

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

  const totalShown = live.length + recent.length;

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
            {focusedId && (
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

          {/* Body — flex column. Two distinct shapes here, switched
              on whether a pane is focused:

              - Unfocused: grid of equal-size tiles + the recent strip
                docked at the bottom. The dashboard view.

              - Focused: a compact rail of other-live tiles across the
                top so the operator can hop tasks, then the focused
                pane fills the remaining vertical space and gets the
                full TaskTimeline experience. Recent strip is hidden in
                this mode — operators wanted "feel like I'm in the
                task" and finished-task fingertips compete with that.

              LayoutGroup wraps both shapes so a task that shifts zones
              (live → recent, tile → focused) animates between regions
              via FLIP rather than dis/re-appearing. */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-3 gap-3">
            <LayoutGroup>
              {tasksQ.isLoading && totalShown === 0 ? (
                <LoadingState />
              ) : totalShown === 0 ? (
                <EmptyState />
              ) : focusedId &&
                live.some((t) => t.id === focusedId) ? (
                <FocusedLayout
                  tasks={live}
                  focusedId={focusedId}
                  onToggleFocus={toggleFocus}
                  verbose={verbose}
                />
              ) : (
                <>
                  <div className="flex-1 min-h-0">
                    {live.length === 0 ? (
                      <IdleLiveZone hasRecent={recent.length > 0} />
                    ) : (
                      <GridLayout
                        tasks={live}
                        focusedId={focusedId}
                        onToggleFocus={toggleFocus}
                        verbose={verbose}
                      />
                    )}
                  </div>
                  {recent.length > 0 && (
                    <RecentStrip
                      tasks={recent}
                      onToggleFocus={toggleFocus}
                      verbose={verbose}
                    />
                  )}
                </>
              )}
            </LayoutGroup>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Default grid layout — equal-size tiles, every pane visible without
 * scrolling. Auto-fit minmax so columns reflow with the window. Used
 * when no pane is focused; the focused state hands rendering off to
 * FocusedLayout below.
 *
 * Each tile is a `motion.div` with `layout` and `layoutId={task.id}` —
 * reorders (waiting_perm jumping to the front), migrations between
 * zones (live → recent), and the morph into FocusedLayout (this grid
 * cell → the big focused pane down there) all animate via FLIP rather
 * than snapping. AnimatePresence handles enter/exit.
 */
function GridLayout({
  tasks,
  focusedId,
  onToggleFocus,
  verbose,
}: {
  tasks: Task[];
  focusedId: string | null;
  onToggleFocus: (id: string) => void;
  verbose: boolean;
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
      <AnimatePresence mode="popLayout" initial={false}>
        {tasks.map((t) => {
          const focused = focusedId === t.id;
          return (
            <motion.div
              key={t.id}
              layout
              layoutId={t.id}
              initial={{ opacity: 0, scale: 0.94, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.18 } }}
              transition={{
                layout: { type: "spring", stiffness: 320, damping: 32 },
                opacity: { duration: 0.22 },
                scale: { duration: 0.22 },
                y: { duration: 0.22 },
              }}
              className="min-h-0 min-w-0"
            >
              <TaskPane
                task={t}
                focused={focused}
                onToggleFocus={() => onToggleFocus(t.id)}
                density="tile"
                verbose={verbose}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/**
 * Focused layout — the operator picked a task to dive into. The big
 * focused pane takes the entire vertical canvas; a thin horizontal
 * rail above it shows compact tiles for the OTHER live tasks so the
 * operator keeps peripheral vision (and can hop with one click).
 *
 * Each task keeps its `layoutId` from the unfocused GridLayout, so the
 * morph from "tile in a 4x3 grid" to either "tile in the rail" or
 * "the big focused pane below" animates as a single coordinated FLIP
 * transition — the clicked tile smoothly grows into the focused
 * region while the others reshape into the rail.
 *
 * The rail is hidden entirely when there's only one live task, since
 * a one-tile rail would just be visual noise.
 */
function FocusedLayout({
  tasks,
  focusedId,
  onToggleFocus,
  verbose,
}: {
  tasks: Task[];
  focusedId: string;
  onToggleFocus: (id: string) => void;
  verbose: boolean;
}) {
  const focusedTask = tasks.find((t) => t.id === focusedId);
  const others = tasks.filter((t) => t.id !== focusedId);

  // Defensive: useEffect in the parent releases focus when the
  // focused task drops off the live list, but on the same render
  // tick it's possible we're here with a stale id. Render nothing
  // and let the parent un-focus on the next tick.
  if (!focusedTask) return null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {others.length > 0 && (
        <div className="shrink-0">
          <div className="flex items-center gap-2 px-1 pb-1.5">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
              other live
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-ink-900/10 via-ink-900/5 to-transparent dark:from-ink-50/10 dark:via-ink-50/5" />
            <span className="font-mono text-[9.5px] tabular-nums text-ink-400 dark:text-ink-500">
              {others.length}
            </span>
          </div>
          {/* Horizontal scrolling rail. Fixed tile width keeps the
              rail height stable as tasks come and go. */}
          <div className="overflow-x-auto">
            <div className="flex gap-3 h-[160px]">
              <AnimatePresence mode="popLayout" initial={false}>
                {others.map((t) => (
                  <motion.div
                    key={t.id}
                    layout
                    layoutId={t.id}
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{
                      opacity: 0,
                      scale: 0.92,
                      transition: { duration: 0.18 },
                    }}
                    transition={{
                      layout: {
                        type: "spring",
                        stiffness: 320,
                        damping: 32,
                      },
                      opacity: { duration: 0.22 },
                    }}
                    className="w-[260px] shrink-0"
                  >
                    <TaskPane
                      task={t}
                      focused={false}
                      onToggleFocus={() => onToggleFocus(t.id)}
                      density="tile"
                      verbose={verbose}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}
      {/* Big focused pane — fills whatever vertical space remains. */}
      <motion.div
        layout
        layoutId={focusedTask.id}
        initial={false}
        transition={{
          layout: { type: "spring", stiffness: 280, damping: 30 },
        }}
        className="flex-1 min-h-0"
      >
        <TaskPane
          task={focusedTask}
          focused
          onToggleFocus={() => onToggleFocus(focusedTask.id)}
          density="focused"
          verbose={verbose}
        />
      </motion.div>
    </div>
  );
}

/**
 * Bottom strip of recently-finished tasks. Stays at a fixed height
 * (one row, narrower minimum width) so it doesn't compete for visual
 * weight with the live grid above. Each tile is the same TaskPane
 * component — opacity dimming + smaller dimensions are the only
 * differences, handled by TaskPane's own status-aware styling.
 *
 * Tiles here share `layoutId` with their corresponding live entry, so
 * when a task transitions running → done it animates DOWN from the
 * live grid into this strip instead of disappearing and re-appearing.
 */
function RecentStrip({
  tasks,
  onToggleFocus,
  verbose,
}: {
  tasks: Task[];
  onToggleFocus: (id: string) => void;
  verbose: boolean;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="shrink-0"
    >
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
          recent
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-ink-900/10 via-ink-900/5 to-transparent dark:from-ink-50/10 dark:via-ink-50/5" />
        <span className="font-mono text-[9.5px] tabular-nums text-ink-400 dark:text-ink-500">
          {tasks.length}
        </span>
      </div>
      <div
        className="grid gap-3 h-[150px]"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`,
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {tasks.slice(0, 6).map((t) => (
            <motion.div
              key={t.id}
              layout
              layoutId={t.id}
              initial={{ opacity: 0, scale: 0.94, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{
                opacity: 0,
                scale: 0.92,
                transition: { duration: 0.18 },
              }}
              transition={{
                layout: { type: "spring", stiffness: 320, damping: 32 },
                opacity: { duration: 0.22 },
              }}
              className="min-h-0 min-w-0"
            >
              <TaskPane
                task={t}
                focused={false}
                onToggleFocus={() => onToggleFocus(t.id)}
                density="tile"
                verbose={verbose}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
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

/** Top zone when there are no live tasks but recent ones exist — keeps
 *  the layout balanced and tells the operator "nothing's running, but
 *  here's what just finished" rather than dropping them into a blank
 *  half-screen. */
function IdleLiveZone({ hasRecent }: { hasRecent: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
      <div className="relative flex h-3 w-3 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-emerald-500/30 animate-pulse-ring" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </div>
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        All clear
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        {hasRecent
          ? "No live tasks. The strip below shows what just wrapped."
          : "No live tasks. Anything you start will appear here."}
      </p>
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
