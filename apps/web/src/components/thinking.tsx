import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared "agent is alive" primitives, the ShimmerText label, a
 * pool-rotating thinking message, an elapsed-ms ticker, and a small
 * formatter. Both the brainstorm thread and the idea workshop pull
 * from here so the in-flight feel is consistent.
 */

/**
 * Living text label. Renders a readable solid orange (orange-700 on
 * the cream paper, orange-300 on the near-black ink) with a slow
 * opacity pulse so the line reads as "alive thinking" without
 * relying on `background-clip: text`. The previous gradient-clip
 * approach didn't paint reliably through the nested
 * `<TransitioningText>` spans, the label rendered as transparent
 * text and was invisible on both backgrounds.
 */
export function ShimmerText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-orange-700 dark:text-orange-300",
        "animate-thinking-pulse",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Vertical drop transition. New line falls in from above and lands
 * in place; old line continues falling out the bottom. Reads as a
 * top→bottom roll, like a slot machine row landing into the slot.
 * translateY uses 100% (one own-line-height) so both lines clear
 * the row exactly. IN uses an `easeOutExpo`-ish curve so it
 * decelerates into rest; OUT uses ease-in so it accelerates out
 * (gravity-like).
 *
 * Both copies share a grid cell so the parent only sizes for the
 * longer of the two and there's no layout shift mid-transition.
 * `useLayoutEffect` so the exiting copy is in the DOM before paint,
 * avoids a one-frame flash where the new text appears alone.
 * `overflow-hidden` clips off-row halves so the drop reads as text
 * moving through a window rather than ghosting above/below.
 */
export function TransitioningText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const text = children;
  const [exiting, setExiting] = useState<string | null>(null);
  const prev = useRef(text);
  useLayoutEffect(() => {
    if (prev.current === text) return;
    setExiting(prev.current);
    prev.current = text;
  }, [text]);
  useEffect(() => {
    if (exiting === null) return;
    const t = setTimeout(() => setExiting(null), 500);
    return () => clearTimeout(t);
  }, [exiting]);
  return (
    <span
      className={cn(
        "relative inline-grid overflow-hidden align-baseline [&>*]:[grid-area:1/1]",
        className,
      )}
    >
      {exiting !== null && (
        <span
          key={`out-${exiting}`}
          className="inline-block whitespace-pre animate-label-out will-change-[opacity,transform]"
          aria-hidden
        >
          {exiting}
        </span>
      )}
      <span
        key={`in-${text}`}
        className="inline-block whitespace-pre animate-label-in will-change-[opacity,transform]"
      >
        {text}
      </span>
    </span>
  );
}


/**
 * What flavor of work the agent is doing right now. Drives both the
 * label pool and any phase-specific UI affordances.
 */
export type ThinkingPhase =
  | "scouting"
  | "chatting"
  | "challenging"
  | "planDrafting"
  | "planRefining"
  | "brainstorming";

/**
 * Pools of "vibe" labels the rotating shimmer text picks from. Goal:
 * feel like a thinking partner, not a loading spinner. Each pool is
 * 6+ entries so the same line doesn't recur in a single turn.
 */
const THINKING_LABELS: Record<ThinkingPhase, string[]> = {
  scouting: [
    "scouting the repo",
    "tracing call sites",
    "skimming the imports",
    "mapping the territory",
    "checking what already exists",
    "reading between the lines",
    "pinning down the files",
    "feeling out the shape",
  ],
  chatting: [
    "thinking it through",
    "weighing the trade-offs",
    "lining up an answer",
    "sitting with the question",
    "looking for the right angle",
    "circling the point",
  ],
  challenging: [
    "looking for cracks",
    "stress-testing assumptions",
    "playing devil's advocate",
    "poking holes",
    "questioning the premise",
    "imagining the failure modes",
  ],
  planDrafting: [
    "shaping the plan",
    "writing the spec",
    "spelling out the steps",
    "stitching the approach together",
    "naming the files",
    "anchoring the acceptance",
  ],
  planRefining: [
    "rewriting the plan",
    "filling in the gaps",
    "tightening the steps",
    "patching the spec",
    "reworking the approach",
    "smoothing the edges",
  ],
  brainstorming: [
    "spinning up angles",
    "casting a wide net",
    "pulling threads",
    "riffing on the brief",
    "warming up",
    "circling the brief",
    "freewheeling",
    "throwing options at the wall",
  ],
};

/**
 * Cycles through a phase's label pool every `intervalMs`. Phase
 * change resets to a fresh random label so the transition is visible
 * (e.g. "scouting" -> "shaping the plan" the moment the first
 * tool result lands and we know we're past reconnaissance).
 */
export function useRotatingLabel(
  phase: ThinkingPhase,
  intervalMs = 2600,
): string {
  const pool = THINKING_LABELS[phase];
  const [idx, setIdx] = useState(() =>
    Math.floor(Math.random() * pool.length),
  );
  useEffect(() => {
    setIdx(Math.floor(Math.random() * pool.length));
  }, [phase]);
  useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % pool.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [phase, intervalMs, pool.length]);
  // Defensive modulo: when `phase` changes to a pool with fewer
  // entries than the current `idx`, the setIdx in the effect above
  // hasn't fired yet for this render, so a raw pool[idx] would
  // return undefined.
  return pool[idx % pool.length] ?? pool[0]!;
}

/**
 * Live elapsed-ms counter for an in-flight turn. Starts ticking when
 * `running` flips true; latches the start timestamp internally so the
 * caller doesn't have to thread one through. Returns 0 when idle.
 */
export function useElapsedMs(running: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running) {
      setStartedAt(Date.now());
      const id = setInterval(() => setTick((n) => n + 1), 1000);
      return () => clearInterval(id);
    }
    setStartedAt(null);
    return undefined;
  }, [running]);
  return running && startedAt ? Date.now() - startedAt : 0;
}

/**
 * Sub-second precision for the first beat (so 0.4s actually shows),
 * then s, then m s for long-runners. Mirrors the formatter the task
 * timeline uses so the dashboard reads the same way everywhere.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(ms / 1000 / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}
