import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * h-9 sticky section band. Eyebrow label · bullet · hint · (right side).
 */
export function SectionHeader({
  label,
  hint,
  right,
  sticky = true,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 items-center gap-3 px-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-cream-100/60 dark:bg-ink-900/60 backdrop-blur-sm shrink-0 z-10",
        sticky && "sticky top-0",
        className,
      )}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 font-medium shrink-0">
        {label}
      </span>
      {hint != null && (
        <>
          <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
          <span className="text-[11px] text-ink-500 dark:text-ink-400 truncate">
            {hint}
          </span>
        </>
      )}
      {right && <span className="ml-auto flex items-center gap-3">{right}</span>}
    </div>
  );
}
