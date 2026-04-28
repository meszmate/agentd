import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { HelpOverlay } from "@/components/help-overlay";
import { SpawnSheet } from "@/components/spawn-sheet";
import { ErrorBoundary } from "@/ErrorBoundary";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <div className="flex h-full w-full">
        <div className="hidden md:block shrink-0">
          <Sidebar
            onOpenPalette={() => setPaletteOpen(true)}
            onSpawn={() => setSpawnOpen(true)}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
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
