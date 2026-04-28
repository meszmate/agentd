import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/wordmark";
import { ServerCard } from "@/components/server-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Kbd } from "@/components/ui/kbd";
import { useTasks } from "@/queries";

interface NavItem {
  to: string;
  label: string;
  glyph: string;
  kbd?: string;
  end?: boolean;
}

const SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Primary",
    items: [
      { to: "/home", label: "Home", glyph: "§", kbd: "g h" },
      { to: "/tasks", label: "Tasks", glyph: "◆", kbd: "g t" },
      { to: "/templates", label: "Templates", glyph: "▤", kbd: "g e" },
      { to: "/schedules", label: "Schedules", glyph: "◇", kbd: "g s" },
    ],
  },
  {
    heading: "Observe",
    items: [
      { to: "/activity", label: "Activity", glyph: "λ", kbd: "g a" },
      { to: "/plugins", label: "Plugins", glyph: "∷", kbd: "g p" },
    ],
  },
  {
    heading: "Account",
    items: [
      { to: "/devices", label: "Devices", glyph: "▢", kbd: "g d" },
      { to: "/settings", label: "Settings", glyph: "⚙", kbd: "g ," },
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
  const activeCount =
    tasksQ.data?.tasks.filter(
      (t) =>
        t.status === "running" ||
        t.status === "waiting_input" ||
        t.status === "waiting_perm",
    ).length ?? 0;

  return (
    <aside className="flex h-full w-60 flex-col border-r border-ink-900/10 bg-cream-100/40 dark:border-ink-50/10 dark:bg-ink-900/40">
      {/* Wordmark band */}
      <div className="flex h-12 items-center px-5 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0">
        <Wordmark />
      </div>

      {/* Server identity */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <ServerCard />
      </div>

      {/* Quick actions */}
      <div className="px-3 pb-2 flex flex-col gap-1 shrink-0">
        <button
          onClick={onOpenPalette}
          className="flex h-7 items-center gap-2 rounded-md border border-ink-900/10 bg-cream-50 px-2.5 text-[11px] text-ink-500 transition-colors hover:bg-ink-900/[0.02] hover:text-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/30 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:bg-ink-50/[0.03] dark:hover:text-ink-200"
        >
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
            ⌕
          </span>
          <span className="flex-1 text-left">Search</span>
          <Kbd className="h-4">⌘K</Kbd>
        </button>
        <button
          onClick={onSpawn}
          className="flex h-7 items-center gap-2 rounded-md bg-ink-900 px-2.5 text-[11px] font-medium text-cream-50 transition-colors hover:bg-vermilion-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/40 dark:bg-vermilion-500 dark:hover:bg-vermilion-600"
        >
          <span className="font-mono text-[10px] text-cream-50/60">+</span>
          <span className="flex-1 text-left">New task</span>
          <Kbd className="h-4 border-cream-50/20 bg-cream-50/10 text-cream-50/80">
            ⌘N
          </Kbd>
        </button>
      </div>

      {/* Nav sections — flush, with mono glyph column + left border activation */}
      <nav className="flex flex-col gap-3 overflow-y-auto py-2">
        {SECTIONS.map((sec) => (
          <div key={sec.heading}>
            <div className="px-5 mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 font-medium">
              {sec.heading}
            </div>
            <div className="flex flex-col">
              {sec.items.map((it) => (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end ?? true}
                  className={({ isActive }) =>
                    cn(
                      "group h-7 flex items-center gap-2.5 pl-[14px] pr-4 text-[12px] transition-colors border-l-2",
                      isActive
                        ? "bg-cream-50 text-ink-900 border-vermilion-500 font-medium dark:bg-ink-50/[0.05] dark:text-ink-50"
                        : "text-ink-500 hover:bg-cream-50/60 hover:text-ink-900 border-transparent dark:text-ink-400 dark:hover:bg-ink-50/[0.03] dark:hover:text-ink-50",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={cn(
                          "font-mono text-[11px] w-3 shrink-0 transition-colors",
                          isActive
                            ? "text-vermilion-500"
                            : "text-ink-400 dark:text-ink-500",
                        )}
                      >
                        {it.glyph}
                      </span>
                      <span className="flex-1">{it.label}</span>
                      {it.to === "/tasks" && activeCount > 0 && (
                        <span className="font-mono text-[10px] tabular-nums text-vermilion-700 dark:text-vermilion-300">
                          {activeCount}
                        </span>
                      )}
                      {it.kbd && (
                        <Kbd className="h-4 hidden md:inline-flex opacity-0 group-hover:opacity-100 transition-opacity">
                          {it.kbd}
                        </Kbd>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="mt-auto border-t border-ink-900/10 px-4 py-2 dark:border-ink-50/10 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
            v0.1
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
