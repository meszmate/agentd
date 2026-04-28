import { cn } from "@/lib/utils";

export function Wordmark({
  className,
  size = "default",
}: {
  className?: string;
  size?: "sm" | "default" | "lg";
}) {
  const dim =
    size === "sm" ? "text-base" : size === "lg" ? "text-2xl" : "text-lg";
  const dot =
    size === "sm" ? "h-1.5 w-1.5" : size === "lg" ? "h-2.5 w-2.5" : "h-2 w-2";

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-display italic font-medium tracking-tight text-ink-900 dark:text-ink-50",
        dim,
        className,
      )}
    >
      <span className={cn("rounded-full bg-vermilion-500 self-center", dot)} />
      <span>agentd</span>
    </span>
  );
}
