import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Two-column settings row — 200px label, flex right column.
 */
export function InfoRow({
  label,
  hint,
  top = false,
  className,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /** When true, the right column is allowed to grow (textareas, code blocks). */
  top?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 md:grid-cols-[200px_1fr] gap-2 md:gap-6 px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]",
        top ? "md:items-start" : "md:items-center",
        className,
      )}
    >
      <div className={top ? "pt-1" : ""}>
        <div className="text-[12px] text-ink-900 dark:text-ink-50 font-medium">
          {label}
        </div>
        {hint && (
          <div className="text-[10px] text-ink-400 dark:text-ink-500 mt-0.5 leading-relaxed">
            {hint}
          </div>
        )}
      </div>
      <div
        className={cn(
          "min-w-0",
          top ? "flex flex-col gap-2" : "flex items-center gap-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <InfoRow label={label} hint={hint}>
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-pressed={value}
        className={cn(
          "relative w-9 h-5 rounded-full transition-colors shrink-0 ml-auto md:ml-0",
          value
            ? "bg-vermilion-500"
            : "bg-ink-900/15 dark:bg-ink-50/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-cream-50 shadow-sm transition-transform",
            value && "translate-x-4",
          )}
        />
      </button>
    </InfoRow>
  );
}
