import { NavLink } from "react-router-dom";
import {
  Activity,
  CalendarClock,
  FileTerminal,
  Home,
  Inbox,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/wordmark";
import { ServerCard } from "@/components/server-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Kbd } from "@/components/ui/kbd";
import { useTasks } from "@/queries";

const SECTIONS: {
  heading: string;
  items: {
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    kbd?: string;
    end?: boolean;
  }[];
}[] = [
  {
    heading: "Primary",
    items: [
      { to: "/home", label: "Home", icon: Home, kbd: "g h" },
      { to: "/tasks", label: "Tasks", icon: Inbox, kbd: "g t", end: false },
      { to: "/templates", label: "Templates", icon: FileTerminal, kbd: "g e" },
      {
        to: "/schedules",
        label: "Schedules",
        icon: CalendarClock,
        kbd: "g s",
      },
    ],
  },
  {
    heading: "Observe",
    items: [
      { to: "/activity", label: "Activity", icon: Activity, kbd: "g a" },
      { to: "/plugins", label: "Plugins", icon: Plug, kbd: "g p" },
    ],
  },
  {
    heading: "Account",
    items: [
      { to: "/devices", label: "Devices", icon: Smartphone, kbd: "g d" },
      {
        to: "/settings",
        label: "Settings",
        icon: SettingsIcon,
        kbd: "g ,",
      },
    ],
  },
];

export function Sidebar({
  onOpenPalette,
  onSpawn,
}: {
  onOpenPalette: () => void;
  onSpawn: () => void;
}) {
  const tasksQ = useTasks();
  const activeCount = tasksQ.data?.tasks.filter(
    (t) =>
      t.status === "running" ||
      t.status === "waiting_input" ||
      t.status === "waiting_perm",
  ).length ?? 0;

  return (
    <aside className="flex h-full w-60 flex-col border-r border-ink-900/10 bg-cream-100/60 backdrop-blur-sm dark:border-ink-50/10 dark:bg-ink-900/40">
      {/* Wordmark band */}
      <div className="flex h-14 items-center px-4 shrink-0">
        <Wordmark />
      </div>

      {/* Server-identity card */}
      <ServerCard />

      {/* Quick actions */}
      <div className="mt-3 px-2 flex flex-col gap-1 shrink-0">
        <button
          onClick={onOpenPalette}
          className="flex h-8 items-center gap-2 rounded-md border border-ink-900/10 bg-cream-50 px-2.5 text-xs text-ink-500 transition-colors hover:bg-ink-900/[0.02] hover:text-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/30 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:bg-ink-50/[0.03] dark:hover:text-ink-200"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Search…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button
          onClick={onSpawn}
          className="flex h-8 items-center gap-2 rounded-md bg-ink-900 px-2.5 text-xs font-medium text-cream-50 transition-colors hover:bg-vermilion-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/40 dark:bg-vermilion-500 dark:hover:bg-vermilion-600"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">New task</span>
          <Kbd className="border-cream-50/20 bg-cream-50/10 text-cream-50/80">
            ⌘N
          </Kbd>
        </button>
      </div>

      {/* Navigation sections */}
      <nav className="mt-4 flex flex-col gap-3 overflow-y-auto pb-4">
        {SECTIONS.map((sec) => (
          <div key={sec.heading}>
            <div className="px-4 mb-1.5 label-section">{sec.heading}</div>
            <div className="px-2 flex flex-col gap-0.5">
              {sec.items.map((it) => {
                const Icon = it.icon;
                return (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.end ?? true}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex h-7 items-center gap-2.5 rounded-md px-2.5 text-[12.5px] transition-colors duration-100",
                        isActive
                          ? "bg-ink-900/[0.05] text-ink-900 font-medium dark:bg-ink-50/[0.06] dark:text-ink-50"
                          : "text-ink-600 hover:text-ink-900 hover:bg-ink-900/[0.03] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.03]",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-colors",
                            isActive
                              ? "text-vermilion-600 dark:text-vermilion-400"
                              : "text-ink-400 group-hover:text-ink-600 dark:text-ink-500 dark:group-hover:text-ink-300",
                          )}
                        />
                        <span className="flex-1">{it.label}</span>
                        {it.to === "/tasks" && activeCount > 0 && (
                          <span className="rounded-full bg-vermilion-500/15 px-1.5 font-mono text-[10px] font-medium text-vermilion-700 dark:text-vermilion-300">
                            {activeCount}
                          </span>
                        )}
                        {it.kbd && (
                          <Kbd className="ml-0 hidden font-mono text-[9px] opacity-0 group-hover:opacity-100 transition-opacity sm:inline-flex">
                            {it.kbd}
                          </Kbd>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="mt-auto border-t border-ink-900/10 px-2 py-2 dark:border-ink-50/10">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="font-mono text-2xs text-ink-400 dark:text-ink-500">
            v0.1
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
