import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared "agent is alive" primitives - the ShimmerText label, an
 * elapsed-ms ticker, and a small formatter. Both the brainstorm
 * thread and the idea workshop pull from here so the in-flight feel
 * is consistent with the task timeline.
 */

/**
 * "Thinking" label with a gradient wave that sweeps across the
 * text - the same look the task timeline uses (codex-style status
 * line). A 200%-wide three-stop gradient is clipped to the text
 * and slid via the `shimmer` keyframe so a brighter highlight
 * travels left→right while the mid-tone stays readable.
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
        "bg-[linear-gradient(90deg,rgba(194,65,12,0.45),rgba(194,65,12,1),rgba(194,65,12,0.45))]",
        "dark:bg-[linear-gradient(90deg,rgba(252,165,107,0.4),rgba(252,165,107,1),rgba(252,165,107,0.4))]",
        "bg-[length:200%_100%] animate-shimmer",
        className,
      )}
    >
      {children}
    </span>
  );
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
