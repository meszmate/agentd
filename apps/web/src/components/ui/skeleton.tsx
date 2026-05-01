import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Animated shimmer rectangle. Use as a placeholder for any value that's
 * still loading — keeps layout stable so the page doesn't jump when
 * the real data arrives.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded bg-ink-900/[0.06] dark:bg-ink-50/[0.06] relative overflow-hidden",
        "before:absolute before:inset-0 before:-translate-x-full",
        "before:bg-[linear-gradient(90deg,transparent,rgba(0,0,0,0.06),transparent)] dark:before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)]",
        "before:animate-[shimmer_2s_linear_infinite]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 2xl numeric placeholder — height matches our 28px BigNum line so the
 * stat cell layout stays put.
 */
export function SkeletonNum({ className }: { className?: string }) {
  return <Skeleton className={cn("h-7 w-20", className)} />;
}

/** A row placeholder for list views (h-12 to match TaskRow / row patterns). */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-12 px-5 flex items-center gap-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]",
        className,
      )}
    >
      <Skeleton className="h-1.5 w-1.5 rounded-full" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3 w-20" />
      <span className="ml-auto" />
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3 w-10" />
    </div>
  );
}
