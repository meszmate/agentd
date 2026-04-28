import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-all duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
    "active:scale-[0.985]",
  ].join(" "),
  {
    variants: {
      variant: {
        // Brae's signature — ink-900 default, vermilion on hover
        default:
          "bg-ink-900 text-cream-50 hover:bg-vermilion-500 dark:bg-vermilion-500 dark:text-cream-50 dark:hover:bg-vermilion-600",
        vermilion:
          "bg-vermilion-500 text-cream-50 hover:bg-vermilion-600",
        outline:
          "border border-ink-900/15 bg-cream-50 text-ink-900 hover:bg-ink-900/[0.04] hover:border-ink-900/30 dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-50 dark:hover:bg-ink-50/[0.05] dark:hover:border-ink-50/25",
        secondary:
          "bg-ink-900/[0.04] text-ink-900 hover:bg-ink-900/[0.08] dark:bg-ink-50/[0.05] dark:text-ink-50 dark:hover:bg-ink-50/[0.10]",
        ghost:
          "text-ink-700 hover:text-ink-900 hover:bg-ink-900/[0.05] dark:text-ink-300 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.05]",
        link: "text-vermilion-600 dark:text-vermilion-400 underline-offset-4 hover:underline",
        destructive:
          "bg-red-600 text-cream-50 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600",
      },
      size: {
        default: "h-9 px-4 text-sm rounded-lg",
        sm: "h-8 px-3 text-xs rounded-md",
        xs: "h-7 px-2.5 text-xs rounded-md",
        lg: "h-11 px-6 text-sm rounded-xl",
        xl: "h-12 px-7 text-sm rounded-xl",
        pill: "h-11 px-6 text-sm rounded-full",
        icon: "h-9 w-9 rounded-lg",
        "icon-sm": "h-7 w-7 rounded-md",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
