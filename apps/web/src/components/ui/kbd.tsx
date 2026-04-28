import * as React from "react";
import { cn } from "@/lib/utils";

export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-ink-900/15 bg-ink-900/[0.04] px-1.5 font-mono text-[10px] font-medium text-ink-700 dark:border-ink-50/15 dark:bg-ink-50/[0.04] dark:text-ink-300",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
