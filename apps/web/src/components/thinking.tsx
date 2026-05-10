import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared "agent is alive" primitives - the ShimmerText label, an
 * elapsed-ms ticker, and a small formatter. Both the brainstorm
 * thread and the idea workshop pull from here so the in-flight feel
 * is consistent with the task timeline.
 */

/**
 * Living text label. Renders a readable solid orange (orange-700 on
 * the cream paper, orange-300 on the near-black ink) with a slow
 * opacity pulse so the line reads as "alive thinking" without
 * relying on `background-clip: text`.
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
