import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle theme"
          className="text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50"
        >
          <Sun className="h-3.5 w-3.5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-3.5 w-3.5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[8rem]">
        {(["light", "dark", "system"] as const).map((t) => {
          const Icon = t === "light" ? Sun : t === "dark" ? Moon : Monitor;
          return (
            <DropdownMenuItem key={t} onClick={() => setTheme(t)}>
              <Icon />
              <span className="capitalize">{t}</span>
              <span
                className={cn(
                  "ml-auto h-1.5 w-1.5 rounded-full",
                  theme === t ? "bg-ember-500" : "bg-transparent",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
