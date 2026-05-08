import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared "agent is alive" primitives — the ShimmerText label, a
 * pool-rotating thinking message, an elapsed-ms ticker, and a small
 * formatter. Both the brainstorm thread and the idea workshop pull
 * from here so the in-flight feel is consistent.
 */

/**
 * Living text label. Base color stays at full opacity so the label
 * reads cleanly even when the highlight isn't passing over; a lighter
 * tone (amber-400 in light mode, yellow-300 in dark) drifts across
 * as the alive cue. Slower than the global shimmer (3.2s) so it
 * feels like calm thinking instead of a frantic loading bar.
 *
 * Both modes keep base + peak at full opacity but pick different
 * hues per mode: orange-700 base on the cream paper, orange-400 base
 * on the near-black ink so the same warm orange identity reads
 * clearly on either background.
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
        "bg-clip-text text-transparent",
        "bg-[linear-gradient(90deg,rgba(194,65,12,1)_0%,rgba(194,65,12,1)_35%,rgba(252,191,36,1)_50%,rgba(194,65,12,1)_65%,rgba(194,65,12,1)_100%)]",
        "dark:bg-[linear-gradient(90deg,rgba(251,146,60,1)_0%,rgba(251,146,60,1)_35%,rgba(253,224,71,1)_50%,rgba(251,146,60,1)_65%,rgba(251,146,60,1)_100%)]",
        "bg-[length:200%_100%] animate-shimmer [animation-duration:3.2s]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Crossfades string content with a per-letter wave. When the text
 * changes, the old characters drift up and blur out while the new
 * characters rise from below and sharpen in — each letter staggered
 * by ~18ms so the wave reads as a quick ripple, not a single beat.
 *
 * Both copies render in the same grid cell so the container only
 * sizes for the longer of the two and the gradient on a parent
 * `<ShimmerText>` clips through both copies cleanly. Stagger caps
 * around 250ms so the whole transition stays under ~half a second
 * even on long labels.
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
  useEffect(() => {
    if (prev.current === text) return;
    setExiting(prev.current);
    prev.current = text;
    const t = setTimeout(() => setExiting(null), 520);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span
      className={cn(
        "relative inline-grid align-baseline [&>*]:[grid-area:1/1]",
        className,
      )}
    >
      {exiting !== null && (
        <Letters key={`out-${exiting}`} text={exiting} kind="out" />
      )}
      <Letters key={`in-${text}`} text={text} kind="in" />
    </span>
  );
}

function Letters({ text, kind }: { text: string; kind: "in" | "out" }) {
  const safe = text ?? "";
  // Tighter stagger so the letters move as a soft wave instead of
  // a rolling banner. Capped to keep total animation under ~half a
  // second on long phrases.
  const stagger = Math.min(16, Math.max(6, 180 / Math.max(safe.length, 1)));
  return (
    <span className="inline-flex whitespace-pre" aria-hidden={kind === "out"}>
      {[...safe].map((c, i) => (
        <span
          key={i}
          className={cn(
            "inline-block will-change-transform",
            kind === "in" ? "animate-letter-in" : "animate-letter-out",
          )}
          style={{
            animationDelay: `${i * stagger}ms`,
            animationFillMode: kind === "in" ? "backwards" : "forwards",
          }}
        >
          {c === " " ? " " : c}
        </span>
      ))}
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
 * (e.g. "scouting" → "shaping the plan" the moment the first
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
  // hasn't fired yet for this render — so a raw pool[idx] would
  // return undefined and crash <TransitioningText>'s letter loop.
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
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}
