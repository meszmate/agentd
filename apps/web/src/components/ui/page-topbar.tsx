import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Thin h-12 page topbar — brae's signature page identity strip.
 *   <PageTopbar>
 *     <Kicker>workspace</Kicker>
 *     <VRule />
 *     <span className="text-[13px] text-ink-900 font-medium">Home</span>
 *     <Count>{n}</Count>
 *     <PageTopbarSpacer />
 *     <Button>...</Button>
 *   </PageTopbar>
 */
export function PageTopbar({
  className,
  children,
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex h-12 items-center gap-3 px-5 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0 bg-cream-100/40 backdrop-blur-sm dark:bg-ink-900/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Kicker({
  className,
  children,
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 shrink-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function VRule({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-4 w-px bg-ink-900/10 dark:bg-ink-50/10 shrink-0",
        className,
      )}
    />
  );
}

export function MidDot() {
  return <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>;
}

export function Count({
  className,
  children,
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] text-ink-400 dark:text-ink-500 tabular-nums shrink-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PageTitle({
  className,
  children,
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spacer({ className }: { className?: string }) {
  return <span className={cn("ml-auto", className)} />;
}
