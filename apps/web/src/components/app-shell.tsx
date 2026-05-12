import { useEffect, useState } from "react";
import { Menu, Plus, Search } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { HelpOverlay } from "@/components/help-overlay";
import { SpawnSheet } from "@/components/spawn-sheet";
import { ErrorBoundary } from "@/ErrorBoundary";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { RouteProgress } from "@/components/route-progress";
import { UpdateBanner } from "@/components/update-banner";
import { Wordmark } from "@/components/wordmark";
import { useLegacyPrefsMigration } from "@/lib/legacyPrefsMigrator";
import { cn } from "@/lib/utils";

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  // Mobile sidebar drawer. Closes automatically on route change so
  // tapping a sidebar nav row on mobile feels right.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => setMobileNavOpen(false), [location.pathname]);

  useLegacyPrefsMigration();

  return (
    <>
      <div className="flex h-full w-full flex-col md:flex-row">
        {/* Mobile top bar — hamburger + brand + spawn shortcut. */}
        <div className="md:hidden flex h-12 items-center gap-2 border-b border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-800 px-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            className="grid place-items-center size-8 rounded-md hover:bg-ink-900/[0.05] dark:hover:bg-ink-50/[0.05] active:scale-95 transition-transform"
          >
            <Menu className="h-4 w-4" />
          </button>
          <Wordmark size="sm" />
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              className="grid place-items-center size-8 rounded-md hover:bg-ink-900/[0.05] dark:hover:bg-ink-50/[0.05]"
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setSpawnOpen(true)}
              aria-label="New task"
              className="grid place-items-center size-8 rounded-md bg-ember-500 text-white active:scale-95 transition-transform"
            >
              <Plus className="h-4 w-4" />
            </button>
          </span>
        </div>

        {/* Desktop sidebar — fixed column. */}
        <div className="hidden md:block shrink-0">
          <Sidebar
            onOpenPalette={() => setPaletteOpen(true)}
            onSpawn={() => setSpawnOpen(true)}
          />
        </div>

        {/* Mobile sidebar drawer — slides in from the left. */}
        <div
          className={cn(
            "md:hidden fixed inset-0 z-40 transition-opacity",
            mobileNavOpen
              ? "opacity-100 pointer-events-auto"
              : "opacity-0 pointer-events-none",
          )}
          onClick={() => setMobileNavOpen(false)}
        >
          <div className="absolute inset-0 bg-ink-900/40 dark:bg-black/60" />
          <div
            className={cn(
              "absolute inset-y-0 left-0 w-[80vw] max-w-[300px] transition-transform duration-200 ease-out",
              mobileNavOpen ? "translate-x-0" : "-translate-x-full",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar
              onOpenPalette={() => {
                setMobileNavOpen(false);
                setPaletteOpen(true);
              }}
              onSpawn={() => {
                setMobileNavOpen(false);
                setSpawnOpen(true);
              }}
            />
          </div>
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <RouteProgress />
          <UpdateBanner />
          <main className="flex-1 min-h-0 overflow-hidden">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSpawn={() => {
          setPaletteOpen(false);
          setSpawnOpen(true);
        }}
        onHelp={() => {
          setPaletteOpen(false);
          setHelpOpen(true);
        }}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SpawnSheet open={spawnOpen} onClose={() => setSpawnOpen(false)} />
      <KeyboardShortcuts
        onPalette={() => setPaletteOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onSpawn={() => setSpawnOpen(true)}
        onNavigate={(path) => navigate(path)}
      />
    </>
  );
}
