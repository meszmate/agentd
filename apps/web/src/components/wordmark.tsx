import { cn } from "@/lib/utils";

/**
 * /agentd wordmark — HTML, Inter heaviest weight. Sized to fit an h-12
 * sidebar header without crowding it; slash is `font-weight: 900` with
 * a small breathing gap before the word.
 */
export function Wordmark({
  className,
  size = "default",
}: {
  className?: string;
  size?: "sm" | "default" | "lg" | "xl";
}) {
  const cls =
    size === "sm"
      ? "text-sm"
      : size === "lg"
      ? "text-2xl"
      : size === "xl"
      ? "text-3xl"
      : "text-lg"; // default — sits comfortably in an h-12 header

  return (
    <span
      className={cn(
        "inline-flex items-center leading-none select-none",
        "tracking-[-0.04em]",
        cls,
        className,
      )}
      style={{
        fontFamily:
          'Inter, "Helvetica Neue", "Arial Black", Arial, sans-serif',
      }}
      aria-label="/agentd"
    >
      <span
        className="text-ember-500 mr-[0.05em]"
        style={{ fontWeight: 900 }}
      >
        /
      </span>
      <span
        className="text-ink-900 dark:text-ink-50"
        style={{ fontWeight: 800 }}
      >
        agentd
      </span>
    </span>
  );
}
