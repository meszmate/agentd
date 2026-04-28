import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border border-ink-900/15 bg-cream-50 px-3 py-2 text-sm text-ink-900 shadow-sm transition-colors",
          "placeholder:text-ink-400",
          "focus-visible:outline-none focus-visible:border-ink-900/40 focus-visible:ring-2 focus-visible:ring-vermilion-500/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-50 dark:placeholder:text-ink-500 dark:focus-visible:border-ink-50/30",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
