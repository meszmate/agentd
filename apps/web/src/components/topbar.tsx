import { useLocation } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

const ROUTE_LABELS: Record<string, string> = {
  home: "Home",
  tasks: "Tasks",
  templates: "Templates",
  schedules: "Schedules",
  plugins: "Plugins",
  settings: "Settings",
  devices: "Devices",
  activity: "Activity",
};

function deriveCrumbs(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return ["Home"];
  const head = parts[0]!;
  const rest = parts.slice(1);
  const headLabel = ROUTE_LABELS[head] ?? head;
  return rest.length ? [headLabel, ...rest] : [headLabel];
}

export function Topbar({
  onOpenPalette,
  onSpawn,
}: {
  onOpenPalette: () => void;
  onSpawn: () => void;
}) {
  const loc = useLocation();
  const crumbs = deriveCrumbs(loc.pathname);

  return (
    <header className="flex h-12 items-center gap-3 border-b border-ink-900/10 px-4 shrink-0 dark:border-ink-50/10">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1.5"
      >
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && (
              <span className="text-ink-300 select-none dark:text-ink-600">
                /
              </span>
            )}
            <span
              className={
                i === crumbs.length - 1
                  ? "truncate font-mono text-2xs uppercase tracking-[0.14em] text-ink-900 dark:text-ink-50"
                  : "truncate font-mono text-2xs uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500"
              }
            >
              {c}
            </span>
          </span>
        ))}
      </nav>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="hidden md:flex gap-2 text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50"
          onClick={onOpenPalette}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="text-xs">Command</span>
          <Kbd>⌘K</Kbd>
        </Button>
        <Button size="sm" onClick={onSpawn}>
          <Plus className="h-3.5 w-3.5" />
          New task
        </Button>
      </div>
    </header>
  );
}
