import * as React from "react";
import { cn } from "@/lib/utils";

export interface FilterOption<V extends string = string> {
  key: V;
  label: string;
  count?: number;
}

/**
 * Brae-style rounded-pill filter row with count badges.
 * Active = subtle ink-900/[0.06] background, count slightly more visible.
 */
export function FilterPills<V extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: FilterOption<V>[];
  value: V;
  onChange: (v: V) => void;
  className?: string;
}) {
  return (
    <nav className={cn("flex items-center gap-0.5", className)}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] transition-colors",
              active
                ? "bg-ink-900/[0.06] text-ink-900 font-medium dark:bg-ink-50/[0.06] dark:text-ink-50"
                : "text-ink-500 hover:text-ink-900 hover:bg-ink-900/[0.03] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-700",
            )}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span
                className={cn(
                  "font-mono tabular-nums text-[10px]",
                  active
                    ? "text-ink-500 dark:text-ink-400"
                    : "text-ink-400 dark:text-ink-500",
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
