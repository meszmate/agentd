import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import type { ProviderRateLimit, ProviderRateLimitWindow } from "@agentd/contracts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRateLimits } from "@/queries";
import { cn } from "@/lib/utils";

type Tone = "ok" | "warn" | "danger";

function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === "exceeded" || s === "blocked" || s === "rejected") return "danger";
  if (s === "allowed") return "ok";
  return "warn";
}

function worstTone(a: Tone, b: Tone): Tone {
  const rank: Record<Tone, number> = { ok: 0, warn: 1, danger: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function windowLabel(type: string): string {
  if (type === "five_hour") return "5h";
  if (type === "weekly_limit") return "wk";
  return type.replace(/_/g, " ");
}

function formatResetIn(secondsLeft: number): string {
  if (secondsLeft <= 0) return "now";
  if (secondsLeft < 60) return `${secondsLeft}s`;
  const m = Math.floor(secondsLeft / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function providerLabel(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return provider;
}

/**
 * Header chip surfacing the operator's plan rate-limit state. Today
 * only Claude emits the underlying telemetry — the chip stays hidden
 * for providers we have no snapshot for. Auto-rerenders every 30s so
 * the reset countdown stays fresh without per-second work.
 */
export function RateLimitChip() {
  const { data } = useRateLimits();
  // Tick once a minute so countdowns stay reasonably fresh; resets
  // are hours away so per-second precision is wasted work.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const limits = data?.rateLimits ?? [];
  if (limits.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {limits.map((rl) => (
        <ProviderChip key={rl.provider} rl={rl} />
      ))}
    </div>
  );
}

function ProviderChip({ rl }: { rl: ProviderRateLimit }) {
  const entries = Object.entries(rl.windows);
  if (entries.length === 0) return null;

  const tone = entries.reduce<Tone>(
    (acc, [, w]) => worstTone(acc, statusTone(w.status)),
    "ok",
  );

  // Pick the window we want to show inline — the worst-toned one,
  // tiebreaking on whichever resets sooner so the operator sees the
  // most pressing limit first.
  const sorted = [...entries].sort(([, a], [, b]) => {
    const ta = statusTone(a.status);
    const tb = statusTone(b.status);
    const rank: Record<Tone, number> = { ok: 0, warn: 1, danger: 2 };
    if (rank[tb] !== rank[ta]) return rank[tb] - rank[ta];
    return a.resetsAt - b.resetsAt;
  });
  const [primaryType, primary] = sorted[0]!;
  const nowSec = Math.floor(Date.now() / 1000);
  const primaryReset = formatResetIn(primary.resetsAt - nowSec);

  const toneClass =
    tone === "danger"
      ? "border-red-500/30 bg-red-500/[0.06] text-red-700 dark:text-red-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300"
        : "border-ink-900/10 dark:border-ink-50/10 text-ink-500 dark:text-ink-400";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-1.5 text-[10px] font-mono tabular-nums",
              toneClass,
              tone === "danger" && "animate-pulse",
            )}
            aria-label={`${providerLabel(rl.provider)} rate limit: ${primary.status} (${windowLabel(primaryType)} resets in ${primaryReset})`}
          >
            <Gauge className="h-3 w-3" />
            <span>{primaryReset}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[260px]">
          <div className="space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400 dark:text-ink-500">
              {providerLabel(rl.provider)} usage
            </div>
            {entries.map(([type, w]) => (
              <WindowRow
                key={type}
                type={type}
                window={w}
                nowSec={nowSec}
              />
            ))}
            <div className="pt-1 font-mono text-[9.5px] text-ink-400 dark:text-ink-500">
              the agent CLI tells us when the window flips, no exact %
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function WindowRow({
  type,
  window: w,
  nowSec,
}: {
  type: string;
  window: ProviderRateLimitWindow;
  nowSec: number;
}) {
  const tone = statusTone(w.status);
  const dot =
    tone === "danger"
      ? "bg-red-500"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      <span className="font-medium">{windowLabel(type)}</span>
      <span className="text-ink-500 dark:text-ink-400">{w.status}</span>
      <span className="ml-auto font-mono text-[10px] text-ink-400 dark:text-ink-500 tabular-nums">
        resets {formatResetIn(w.resetsAt - nowSec)}
      </span>
    </div>
  );
}
