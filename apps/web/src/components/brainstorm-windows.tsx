import { useState } from "react";
import { create } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronUp,
  Lightbulb,
  Loader2,
  Minus,
  Sparkles,
  X,
} from "lucide-react";
import type { Suggestion } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { useApp, useClient } from "@/AppContext";
import { useModels } from "@/queries";
import { PlanAndSpawnSheet } from "@/components/idea-factory";
import { cn } from "@/lib/utils";
import type { AgentdClient } from "@agentd/client";

/**
 * Floating "brainstorm windows" surface.
 *
 * Kicked off by running an ideation-kind template (and any future entry
 * point that wants the same UX). Each window streams options into a
 * compact panel docked at the bottom-right of the viewport, so the
 * operator can keep working while the helper drafts. Multiple windows
 * stack — the user can have several brainstorms in flight at once.
 *
 * Lifecycle:
 *   - open()   → push a window in `streaming` state, kick off the stream
 *   - stream events append to `options` for the live preview
 *   - on completion the persisted `Suggestion` lands; status flips to
 *     `ready` so the operator can pick / dismiss
 *   - close on a streaming window aborts; close on a ready window
 *     dismisses the suggestion (server-side TTL eventually purges it)
 *   - listening on `suggestion_removed` auto-closes any window pinned
 *     to a swept id so devices stay in sync
 *
 * State lives in zustand (not react-query) because each window is a
 * transient UI element with its own AbortController — react-query is
 * a poor fit for that. The persisted suggestion still flows through
 * the existing project-suggestions cache via realtime, so the inline
 * brainstorm page sees the same row.
 */

export type BrainstormWindowStatus =
  | { kind: "streaming" }
  | { kind: "ready"; suggestion: Suggestion }
  | { kind: "error"; error: string };

export interface BrainstormWindow {
  id: string;
  templateId: string;
  templateName: string;
  args: Record<string, string>;
  options: string[];
  status: BrainstormWindowStatus;
  createdAt: number;
  minimized: boolean;
  abort: AbortController;
}

interface BrainstormWindowsStore {
  windows: BrainstormWindow[];
  push: (w: BrainstormWindow) => void;
  setOptions: (id: string, opts: string[]) => void;
  appendOption: (id: string, opt: string) => void;
  setStatus: (id: string, status: BrainstormWindowStatus) => void;
  setMinimized: (id: string, minimized: boolean) => void;
  remove: (id: string) => void;
  removeBySuggestionId: (suggestionId: string) => void;
}

export const useBrainstormWindows = create<BrainstormWindowsStore>((set) => ({
  windows: [],
  push: (w) => set((s) => ({ windows: [...s.windows, w] })),
  setOptions: (id, opts) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, options: opts } : w)),
    })),
  appendOption: (id, opt) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id ? { ...w, options: [...w.options, opt] } : w,
      ),
    })),
  setStatus: (id, status) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, status } : w)),
    })),
  setMinimized: (id, minimized) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, minimized } : w)),
    })),
  remove: (id) =>
    set((s) => ({ windows: s.windows.filter((w) => w.id !== id) })),
  removeBySuggestionId: (suggestionId) =>
    set((s) => ({
      windows: s.windows.filter(
        (w) => !(w.status.kind === "ready" && w.status.suggestion.id === suggestionId),
      ),
    })),
}));

let windowIdCounter = 0;
function nextWindowId(): string {
  windowIdCounter += 1;
  return `bw-${Date.now().toString(36)}-${windowIdCounter}`;
}

/**
 * Hook returning a function that opens a new brainstorm window. Caller
 * provides the template id + args; the helper stream is kicked off
 * immediately and the function returns the window id so the caller
 * can pre-minimize / inspect it later if needed.
 */
export function useOpenBrainstormWindow(): (input: {
  templateId: string;
  templateName: string;
  args?: Record<string, string>;
}) => string {
  const client = useClient();
  const { toast } = useApp();
  const qc = useQueryClient();
  return (input) => {
    const id = nextWindowId();
    const abort = new AbortController();
    useBrainstormWindows.getState().push({
      id,
      templateId: input.templateId,
      templateName: input.templateName,
      args: input.args ?? {},
      options: [],
      status: { kind: "streaming" },
      createdAt: Date.now(),
      minimized: false,
      abort,
    });
    void runStream({ id, client, qc, toast, input, abort });
    return id;
  };
}

interface RunStreamArgs {
  id: string;
  client: AgentdClient;
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useApp>["toast"];
  input: {
    templateId: string;
    templateName: string;
    args?: Record<string, string>;
  };
  abort: AbortController;
}

async function runStream({
  id,
  client,
  qc,
  toast,
  input,
  abort,
}: RunStreamArgs): Promise<void> {
  const store = useBrainstormWindows.getState();
  try {
    const r = await client.streamIdeateForTemplate(
      input.templateId,
      { args: input.args ?? {} },
      (event) => {
        if (event.kind === "option") {
          useBrainstormWindows.getState().appendOption(id, event.text);
        }
      },
      abort.signal,
    );
    if (r.ok) {
      useBrainstormWindows
        .getState()
        .setStatus(id, { kind: "ready", suggestion: r.suggestion });
      // The suggestion landed — refresh project-scoped suggestion lists
      // so the inline brainstorm page also sees it without polling.
      void qc.invalidateQueries({ queryKey: ["project-suggestions"] });
    } else {
      useBrainstormWindows
        .getState()
        .setStatus(id, { kind: "error", error: r.error });
    }
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      // Operator closed the window mid-stream. Just drop it.
      useBrainstormWindows.getState().remove(id);
      return;
    }
    useBrainstormWindows
      .getState()
      .setStatus(id, { kind: "error", error: (e as Error).message });
    toast(`brainstorm failed: ${(e as Error).message}`, true);
  }
}

/**
 * Global brainstorm-window stack. Mount once near the root so windows
 * appear regardless of which route is active. Auto-close-on-removal
 * is handled by RealtimeProvider, which already owns the single
 * `/ws` connection — see {@link applySuggestionEvent}.
 */
export function BrainstormWindows() {
  const windows = useBrainstormWindows((s) => s.windows);

  if (windows.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-40 flex flex-col-reverse items-end gap-2">
      {windows.map((w) => (
        <BrainstormWindowCard key={w.id} window={w} />
      ))}
    </div>
  );
}

function BrainstormWindowCard({ window: w }: { window: BrainstormWindow }) {
  const setMinimized = useBrainstormWindows((s) => s.setMinimized);
  const remove = useBrainstormWindows((s) => s.remove);
  const client = useClient();
  const { toast } = useApp();
  const modelsQ = useModels();
  const [planFor, setPlanFor] = useState<{
    index: number;
    text: string;
  } | null>(null);

  const ready = w.status.kind === "ready" ? w.status.suggestion : null;
  const error = w.status.kind === "error" ? w.status.error : null;
  const streaming = w.status.kind === "streaming";

  // The list of options to render: when ready, prefer the persisted
  // suggestion's options (canonical, ordered as the helper finalized
  // them); while streaming, show whatever has accumulated locally.
  const visibleOptions = ready ? ready.options : w.options;

  const closeWindow = async () => {
    if (streaming) {
      w.abort.abort();
      remove(w.id);
      return;
    }
    if (ready) {
      try {
        // Server marks dismissed; the TTL sweep eventually purges. The
        // suggestion_updated push will close the window across other
        // devices via the listener above.
        await client.dismissSuggestion(ready.id);
      } catch (e) {
        toast((e as Error).message, true);
      }
    }
    remove(w.id);
  };

  return (
    <>
      <div
        className={cn(
          "pointer-events-auto w-[360px] max-w-[calc(100vw-1.5rem)] rounded-xl border bg-paper-50 shadow-2xl dark:bg-ink-800",
          streaming
            ? "border-ember-500/40"
            : error
              ? "border-red-500/40"
              : "border-ink-900/15 dark:border-ink-50/15",
        )}
      >
        <header className="flex items-center gap-2 border-b border-ink-900/[0.06] px-3 py-2 dark:border-ink-50/[0.06]">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-ember-500/15 text-ember-600 dark:text-ember-300">
            <Lightbulb className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold text-ink-900 dark:text-ink-50">
              {w.templateName}
            </div>
            <div className="font-mono text-[10px] text-ink-500 dark:text-ink-400">
              {streaming
                ? `brewing · ${w.options.length} so far`
                : error
                  ? `failed · ${error.slice(0, 40)}${error.length > 40 ? "…" : ""}`
                  : `${visibleOptions.length} option${visibleOptions.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMinimized(w.id, !w.minimized)}
            className="grid h-6 w-6 place-items-center rounded text-ink-400 hover:bg-ink-900/[0.05] hover:text-ink-900 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-50"
            aria-label={w.minimized ? "Expand" : "Minimize"}
            title={w.minimized ? "Expand" : "Minimize"}
          >
            {w.minimized ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <Minus className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void closeWindow()}
            className="grid h-6 w-6 place-items-center rounded text-ink-400 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-300"
            aria-label="Close"
            title={streaming ? "Cancel" : "Dismiss"}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {!w.minimized && (
          <div className="space-y-2 p-3">
            {streaming && (
              <div className="flex items-center gap-2 rounded-md border border-ember-500/30 bg-ember-500/5 px-2 py-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-ember-600 dark:text-ember-300" />
                <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
                  agent reading repo…
                </span>
              </div>
            )}
            {error && (
              <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {visibleOptions.length === 0 && !error && (
              <p className="font-mono text-[10.5px] text-ink-500 dark:text-ink-400">
                first option usually lands within ~10s…
              </p>
            )}
            <ul className="max-h-[40vh] space-y-1 overflow-y-auto">
              {visibleOptions.map((opt, i) => (
                <li
                  key={`${i}-${opt.slice(0, 24)}`}
                  className="group rounded border border-transparent transition-colors hover:border-ember-500/30 hover:bg-ember-500/[0.04] dark:hover:bg-ember-500/[0.08]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!ready) return;
                      setPlanFor({ index: i, text: opt });
                    }}
                    disabled={!ready}
                    className="flex w-full items-start gap-2 px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-70"
                    title={ready ? "Pick — open plan & spawn" : "wait for the helper to finish"}
                  >
                    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-ink-900/15 font-mono text-[9px] tabular-nums text-ink-500 group-hover:border-ember-500/50 group-hover:text-ember-700 dark:border-ink-50/15 dark:group-hover:text-ember-300">
                      {i + 1}
                    </span>
                    <span className="flex-1 text-[12.5px] leading-snug text-ink-700 dark:text-ink-200">
                      {opt}
                    </span>
                    {ready && (
                      <span className="mt-0.5 shrink-0 font-mono text-[10px] tracking-[0.06em] text-ink-400 opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-ember-700 dark:text-ink-500 dark:group-hover:text-ember-300">
                        plan →
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {ready && (
              <footer className="flex items-center gap-1.5 border-t border-ink-900/[0.06] pt-2 dark:border-ink-50/[0.06]">
                <Sparkles className="h-3 w-3 text-ink-400 dark:text-ink-500" />
                <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                  pick one to plan + spawn
                </span>
                <span className="ml-auto" />
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void closeWindow()}
                >
                  Dismiss
                </Button>
              </footer>
            )}
          </div>
        )}
      </div>

      {planFor && ready && (
        <PlanAndSpawnSheet
          seed={{ index: planFor.index, preview: planFor.text }}
          suggestion={ready}
          models={modelsQ.data}
          onClose={() => {
            setPlanFor(null);
            // If the operator spawned, the suggestion is now `resolved`
            // server-side and we'll get a `suggestion_updated` event
            // (status != dismissed, so the auto-close above won't fire).
            // Close the window proactively for a tidy desk.
            const fresh = useBrainstormWindows
              .getState()
              .windows.find((x) => x.id === w.id);
            if (
              fresh &&
              fresh.status.kind === "ready" &&
              fresh.status.suggestion.status === "resolved"
            ) {
              remove(w.id);
            }
          }}
        />
      )}
    </>
  );
}

/**
 * Apply a realtime suggestion event to any open brainstorm window.
 * Called from RealtimeProvider on the existing `/ws` channel, so
 * brainstorm windows participate in cross-device sync without spinning
 * up a second connection.
 *
 *   - `dismissed` (TTL sweep, another device, manual elsewhere) → close
 *     the window so operator stops poking at a dead row.
 *   - `resolved` (operator on another device picked one) → close the
 *     window since the brainstorm is settled.
 *   - any other update → patch the stored `Suggestion` so the picker
 *     reflects the latest options / status.
 */
export function applySuggestionEvent(
  suggestion: Suggestion,
): void {
  const state = useBrainstormWindows.getState();
  for (const w of state.windows) {
    if (!(w.status.kind === "ready" && w.status.suggestion.id === suggestion.id)) {
      continue;
    }
    if (suggestion.status === "dismissed" || suggestion.status === "resolved") {
      state.remove(w.id);
    } else {
      state.setStatus(w.id, { kind: "ready", suggestion });
    }
  }
}

/**
 * Drop any open brainstorm window pinned to `suggestionId`. Called
 * from RealtimeProvider when the daemon emits `suggestion_removed`
 * (TTL sweep purged the row).
 */
export function dropWindowForSuggestionId(suggestionId: string): void {
  useBrainstormWindows.getState().removeBySuggestionId(suggestionId);
}
