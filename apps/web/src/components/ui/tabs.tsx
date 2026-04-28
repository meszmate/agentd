import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva("inline-flex items-center gap-0.5", {
  variants: {
    variant: {
      // Underline-row: list itself draws no line; triggers carry their own bottom border.
      underline: "",
      // Filled stretch: triggers fill height and have a -mb-px underline meeting topbar's bottom border.
      stretch: "items-stretch h-full",
    },
  },
  defaultVariants: { variant: "underline" },
});

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> &
    VariantProps<typeof tabsListVariants>
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(tabsListVariants({ variant }), className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const tabsTriggerVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors",
    "focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        underline: [
          "px-3 h-9 text-[12px] border-b-2 -mb-px",
          "border-transparent text-ink-400 dark:text-ink-500",
          "hover:text-ink-900 dark:hover:text-ink-50",
          "data-[state=active]:border-vermilion-500 data-[state=active]:text-ink-900 dark:data-[state=active]:text-ink-50",
        ].join(" "),
        stretch: [
          "px-3.5 text-[12px] flex items-center border-b-2 -mb-px",
          "border-transparent text-ink-400 dark:text-ink-500",
          "hover:text-ink-900 dark:hover:text-ink-50",
          "data-[state=active]:border-vermilion-500 data-[state=active]:text-ink-900 dark:data-[state=active]:text-ink-50 data-[state=active]:font-medium",
        ].join(" "),
      },
    },
    defaultVariants: { variant: "underline" },
  },
);

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> &
    VariantProps<typeof tabsTriggerVariants>
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(tabsTriggerVariants({ variant }), className)}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("focus-visible:outline-none", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
