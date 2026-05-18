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
 * How many recently-finished tasks the grid keeps visible after they
 * wrap. The dashboard is the "see everything" surface, so operators
 * want a strip of done / failed tiles right next to the live ones
 * even after they finished. Past this many, the oldest fall off.
 */
const MAX_FINISHED_TILES = 8;

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
  const { lastStatusChange } = useRealtime();

  // Verbose mode: panes render the agent's tool calls inline (Bash
  // commands, file edits, Reads) instead of the compact agent-text-
  // only view. Persisted as a cross-device pref.
  const prefsQ = usePrefs();
  const verbose = prefsQ.data?.prefs.gridVerbose ?? false;
  const patchPrefs = usePatchPrefs();
  const toggleVerbose = () => {
    patchPrefs.mutate({ gridVerbose: !verbose });
  };

  // Force a re-render every ~1s while open so finished tiles can
  // sort by recency without waiting for some other event to retrigger
  // React. Cheap because the only thing it gates is the memo below.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  // One unified list. Live tasks (priority-sorted so waiting_perm
  // pops to the front of the auto-focus pick) then recently-finished
  // tiles (newest-finished first, capped). The grid renders this
  // entire list — focused goes to master, rest go to the stack.
  const { all, live, recent } = useMemo(() => {
    const liveTasks: Task[] = [];
    const recentTasks: Task[] = [];
    for (const t of tasks) {
      if (t.closedAt) continue;
      if (ACTIVE_STATUSES.has(t.status)) liveTasks.push(t);
      else if (FINISHED_STATUSES.has(t.status)) recentTasks.push(t);
    }
    const pri = (t: Task): number => {
      if (t.status === "waiting_perm") return 0;
      if (t.status === "waiting_input") return 1;
      if (t.status === "running") return 2;
      return 3;
    };
    liveTasks.sort((a, b) => {
      const p = pri(a) - pri(b);
      return p !== 0 ? p : a.createdAt - b.createdAt;
    });
    recentTasks.sort((a, b) => {
      const fa = lastStatusChange[a.id]?.ts ?? a.updatedAt;
      const fb = lastStatusChange[b.id]?.ts ?? b.updatedAt;
      return fb - fa;
    });
    const capped = recentTasks.slice(0, MAX_FINISHED_TILES);
    return {
      all: [...liveTasks, ...capped],
      live: liveTasks,
      recent: capped,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, lastStatusChange, tick]);

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
            <CountTicker count={live.length} tone="live" label="live" />
            {recent.length > 0 && (
              <CountTicker
                count={recent.length}
                tone="recent"
                label="recent"
              />
            )}
            <Spacer />
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
                verbose={verbose}
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
 * Clicking any stack tile promotes it to master; the old master
 * demotes into the slot the click came from. Motion's LayoutGroup
 * wraps both columns so the layoutId match across the swap animates
 * via FLIP rather than snapping. Clicking the inline composer inside
 * a stack tile does NOT promote (InlineReply stopPropagation) so the
 * operator can type to a tile without focusing it first.
 *
 * Keyboard nav (vim-style) cycles the focus through the unified list.
 * j/ArrowDown moves forward, k/ArrowUp moves back, g/G jump to
 * first/last, 1..9 jump by ordinal. Bails when an editable element
 * has focus so typing into any composer isn't hijacked.
 */
function MasterStack({
  focused,
  others,
  onFocus,
  verbose,
}: {
  focused: Task;
  others: Task[];
  onFocus: (id: string) => void;
  verbose: boolean;
}) {
  const all = useMemo(() => [focused, ...others], [focused, others]);
  const focusedIdx = 0;

  // Stack tiles adapt their height to how many are showing. Few tiles
  // get tall, generous rooms (transcript, tool calls, code preview,
  // composer all readable at once). Many tiles compress so the
  // operator can scan 10+ live tasks without endless scrolling. Above
  // the upper bound the stack column scrolls. Past a count threshold
  // we also flip on `compact` per tile, which drops the meta strip
  // and code-preview chrome so the transcript / tool-call area gets
  // every spare pixel — the operator promotes a tile to master if
  // they want the full experience.
  const tileHeight = (() => {
    const n = others.length;
    if (n <= 1) return 420;
    if (n <= 2) return 360;
    if (n <= 3) return 300;
    if (n <= 5) return 250;
    if (n <= 7) return 210;
    return 180;
  })();
  const compactTile = tileHeight < 260;

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
            verbose={verbose}
          />
        </motion.div>

        {others.length > 0 && (
          <div className="min-h-0 min-w-0 flex flex-col gap-2 overflow-y-auto pr-0.5">
            <AnimatePresence mode="popLayout" initial={false}>
              {others.map((t) => (
                <motion.div
                  key={t.id}
                  layoutId={`tile-${t.id}`}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
                  transition={{
                    layout: { type: "spring", stiffness: 280, damping: 32 },
                    opacity: { duration: 0.18 },
                  }}
                  onClick={() => onFocus(t.id)}
                  style={{ height: tileHeight }}
                  className="shrink-0 cursor-pointer"
                >
                  <TaskPane
                    task={t}
                    focused={false}
                    onToggleFocus={() => onFocus(t.id)}
                    density="tile"
                    verbose={verbose}
                    compact={compactTile}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </LayoutGroup>
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
