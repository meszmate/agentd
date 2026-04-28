import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-mono font-medium uppercase tracking-[0.06em] transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-ink-900/10 bg-ink-900/[0.05] text-ink-700 dark:border-ink-50/10 dark:bg-ink-50/[0.05] dark:text-ink-200",
        vermilion:
          "border-vermilion-500/20 bg-vermilion-500/10 text-vermilion-700 dark:border-vermilion-500/25 dark:bg-vermilion-500/15 dark:text-vermilion-300",
        secondary:
          "border-ink-900/10 bg-cream-50 text-ink-600 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300",
        outline:
          "border-ink-900/15 text-ink-600 dark:border-ink-50/15 dark:text-ink-300",
        success:
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-300",
        info:
          "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/15 dark:text-sky-300",
        destructive:
          "border-red-500/25 bg-red-500/10 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300",
        mute:
          "border-ink-900/10 bg-ink-900/[0.04] text-ink-500 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
