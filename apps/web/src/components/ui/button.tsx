import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-all duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
    "active:scale-[0.985]",
  ].join(" "),
  {
    variants: {
      variant: {
        // Default: solid ink in light mode, ember in dark — always white text.
        default:
          "bg-ink-900 !text-white hover:bg-ember-600 dark:bg-ember-500 dark:hover:bg-ember-600",
        // Always-ember variant.
        vermilion:
          "bg-ember-500 !text-white hover:bg-ember-600",
        outline:
          "border border-ink-900/20 bg-paper-50 text-ink-900 hover:bg-paper-200 hover:border-ink-900/40 dark:border-ink-50/20 dark:bg-ink-800 dark:text-ink-50 dark:hover:bg-ink-700 dark:hover:border-ink-50/30",
        secondary:
          "bg-paper-200 text-ink-900 hover:bg-paper-300 dark:bg-ink-800 dark:text-ink-50 dark:hover:bg-ink-700",
        ghost:
          "text-ink-700 hover:text-ink-900 hover:bg-paper-200 dark:text-ink-300 dark:hover:text-ink-50 dark:hover:bg-ink-700",
        link: "text-ember-600 dark:text-ember-400 underline-offset-4 hover:underline",
        destructive:
          "bg-red-600 !text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600",
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
