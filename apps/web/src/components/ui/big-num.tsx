import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Brae-style hero numeric — 28px light tabular-nums, leading-none.
 * Used in stat cells. Wrap in tabular containers (px-5 py-4 cells).
 */
export function BigNum({
  className,
  children,
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "text-[28px] text-ink-900 dark:text-ink-50 font-light leading-none mt-2 tabular-nums",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatCell({
  label,
  value,
  sublabel,
  href,
  accent = false,
  onClick,
  last = false,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  href?: string;
  accent?: boolean;
  onClick?: () => void;
  /** Omit right border (use on the last cell). */
  last?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 font-medium">
          {label}
        </span>
        {accent && (
          <span className="size-1.5 rounded-full bg-vermilion-500 animate-blink" />
        )}
        {(href || onClick) && (
          <span className="ml-auto text-[10px] text-ink-300 dark:text-ink-600 group-hover:text-ink-500 dark:group-hover:text-ink-400 transition-colors">
            →
          </span>
        )}
      </div>
      <BigNum>{value}</BigNum>
      {sublabel && (
        <div className="text-[10px] text-ink-400 dark:text-ink-500 mt-1.5 font-mono">
          {sublabel}
        </div>
      )}
    </>
  );

  const baseClass = cn(
    "group px-5 py-4 transition-colors",
    !last && "border-r border-ink-900/10 dark:border-ink-50/10",
    (href || onClick) && "hover:bg-cream-100/40 dark:hover:bg-ink-50/[0.02]",
  );

  if (href) {
    return (
      <a href={href} className={baseClass}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(baseClass, "text-left")}>
        {inner}
      </button>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}
