import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-lg border border-ink-900/15 bg-paper-50 px-3 py-1 text-sm text-ink-900 shadow-sm transition-colors",
          "placeholder:text-ink-400",
          "focus-visible:outline-none focus-visible:border-ink-900/40 focus-visible:ring-2 focus-visible:ring-ember-500/30 focus-visible:ring-offset-0",
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
Input.displayName = "Input";

export { Input };
