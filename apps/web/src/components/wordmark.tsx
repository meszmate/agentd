import { cn } from "@/lib/utils";

/**
 * agentd brand lockup — geometric "a" mark + wordmark.
 * Mark is the same bowl + stem shape used in /mark.svg (and the
 * favicon), so the icon and the sidebar lockup match exactly.
 * "agentd" is set in Geist 800 with tight tracking.
 */
export function Wordmark({
  className,
  size = "default",
}: {
  className?: string;
  size?: "sm" | "default" | "lg" | "xl";
}) {
  const textCls =
    size === "sm"
      ? "text-sm"
      : size === "lg"
        ? "text-2xl"
        : size === "xl"
          ? "text-3xl"
          : "text-lg"; // default — h-12 sidebar header
  const markPx =
    size === "sm" ? 14 : size === "lg" ? 24 : size === "xl" ? 30 : 18;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[0.4em] leading-none select-none",
        "tracking-[-0.04em] text-ink-900 dark:text-ink-50",
        textCls,
        className,
      )}
      style={{
        fontFamily:
          'Geist, "Helvetica Neue", "Arial Black", Arial, sans-serif',
        fontWeight: 800,
      }}
      aria-label="agentd"
    >
      <AgentdMark size={markPx} />
      <span>agentd</span>
    </span>
  );
}

/**
 * The same geometric "a" used by the favicon / mark.svg — a rounded
 * ember bowl on the left, a rounded ember stem on the right. Single
 * color so it reads cleanly at any size.
 */
function AgentdMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="4" y="14" width="17" height="14" rx="3.5" fill="#DC2626" />
      <rect x="21" y="6" width="6" height="22" rx="3" fill="#DC2626" />
    </svg>
  );
}
