import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  THINKING_LEVELS_BY_AGENT,
  clampThinkingLevel,
  type AgentKind,
  type PermissionMode,
  type PlanSlice,
  type SavedIdea,
  type Suggestion,
  type ThinkingLevel,
} from "@agentd/contracts";

const THINK_HINT: Record<ThinkingLevel, string> = {
  minimal: "minimal · codex-only",
  low: "low · fastest",
  medium: "medium · balanced",
  high: "high · default",
  xhigh: "xhigh · deepest",
  max: "max · claude-only",
};
import { PlanSlicesEditor } from "@/components/plan-slices-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp, useClient } from "@/AppContext";
import {
  useDeleteSavedIdea,
  useDismissSuggestion,
  useModels,
  useProjectSuggestions,
  useResolveSuggestion,
  useSaveIdea,
  useSavedIdeas,
  useSpawnMultiFromSavedIdea,
  useUpdateSavedIdeaSlices,
} from "@/queries";
import { qk } from "@/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatTs } from "@/lib/utils";

interface Props {
  projectId: string;
  projectSlug: string;
  projectName: string;
  /**
   * "card" — compact rendering for embedding inside other surfaces.
   * "page" — full-width layout used by /projects/:slug/brainstorm:
   *   the chrome border is dropped and the sections breathe across
   *   the entire main pane instead of living inside a single card.
   * Defaults to "card".
   */
  layout?: "card" | "page";
}

const PROMPT_PRESETS: { label: string; brief: string }[] = [
  {
    label: "next features",
    brief:
      "Look at the codebase and propose the highest-value features to build next, ranked by impact-vs-effort. Be specific — name files / surfaces.",
  },
  {
    label: "tech debt",
    brief:
      "Scan the repo for the most painful tech debt — deprecated APIs, dead code, smelly modules, missing tests, performance traps. Each item should be actionable.",
  },
  {
    label: "missing tests",
    brief:
      "Find the highest-value untested logic and propose specific test files / cases to add. Cite file paths.",
  },
  {
    label: "refactor passes",
    brief:
      "Identify cohesive refactor opportunities — places where structure has drifted from the rest of the codebase. Each idea should be a one-PR scope.",
  },
];

/**
 * Per-project Idea Factory — the primary surface for project work.
 *
 * Streaming brainstorm: options arrive one-by-one over a long-poll
 * fetch. The active card wears an animated aurora border while the
 * agent reads the repo, and each landing option pops in with an
 * idea-pop animation, giving the surface an agentic feel close to
 * how the task timeline looks while a runner is producing tokens.
 *
 * Saved ideas live in their own pile above the pending suggestions
 * — independent of the suggestion lifecycle, so the operator can
 * star a handful from one brainstorm, dismiss the parent, and
 * still come back to the saved ones later. Each saved idea opens
 * the Plan-and-Spawn sheet exactly like a fresh option does.
 */
export function IdeaFactory({
  projectId,
  projectSlug,
  projectName,
  layout = "card",
}: Props) {
  const isPage = layout === "page";
  const { toast } = useApp();
  const client = useClient();
  const qc = useQueryClient();
  const sugQ = useProjectSuggestions(projectId);
  const savedQ = useSavedIdeas(projectSlug);
  const modelsQ = useModels();

  const [brief, setBrief] = useState("");
  // Brainstorm pick is `<agent>:<model>` — empty = daemon default.
  const [brainstormPick, setBrainstormPick] = useState<string>("");
  const [showHistory, setShowHistory] = useState(false);
  const [showSaved, setShowSaved] = useState(true);

  // Live streaming state — when the brainstorm fetch is in flight,
  // we hold a "draft" suggestion locally so options can appear with
  // the idea-pop animation before the persisted Suggestion lands.
  const [streaming, setStreaming] = useState(false);
  const [liveOptions, setLiveOptions] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Plan-and-spawn sheet state — opens when an option (pending or
  // saved) is picked.
  const [planFor, setPlanFor] = useState<{
    seed: { index?: number; text?: string; preview: string };
    suggestion?: Suggestion;
    savedIdea?: SavedIdea;
  } | null>(null);

  const claudeModels = modelsQ.data?.models.claude ?? [];
  const codexModels = modelsQ.data?.models.codex ?? [];
  const brainstormChoice = decodeAgentModel(brainstormPick);
  const brainstormLabel = brainstormPick
    ? `${brainstormChoice.agent} · ${brainstormChoice.modelLabel ?? "default"}`
    : "default · claude";

  const all = sugQ.data?.suggestions ?? [];
  const pending = all.filter((s) => s.status === "pending");
  const history = all.filter((s) => s.status !== "pending");
  const saved = (savedQ.data?.ideas ?? []).filter((s) => !s.spawnedTaskId);

  const savedKeys = useMemo(() => {
    const map = new Map<string, string>(); // suggestionId:optionIndex → savedIdea.id
    for (const s of savedQ.data?.ideas ?? []) {
      if (s.suggestionId != null && s.optionIndex != null) {
        map.set(`${s.suggestionId}:${s.optionIndex}`, s.id);
      }
    }
    return map;
  }, [savedQ.data]);

  const submit = async () => {
    const text = brief.trim();
    if (!text) {
      toast("type a brief first", true);
      return;
    }
    if (streaming) return;
    setStreaming(true);
    setLiveOptions([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await client.streamIdeateForProject(
        projectSlug,
        {
          prompt: text,
          ...(brainstormChoice.agent ? { agent: brainstormChoice.agent } : {}),
          ...(brainstormChoice.model ? { model: brainstormChoice.model } : {}),
        },
        (event) => {
          if (event.kind === "option")
            setLiveOptions((opts) => [...opts, event.text]);
        },
        ctrl.signal,
      );
      if (r.ok === false) {
        toast(r.error || "the helper returned no options", true);
      } else {
        setBrief("");
        toast(`brewed ${r.suggestion.options.length} ideas`);
        // Realtime bus also fires; force-invalidate so the freshly
        // persisted suggestion replaces the streaming draft instantly.
        void qc.invalidateQueries({
          queryKey: qk.projectSuggestions(projectId),
        });
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        toast((e as Error).message, true);
      }
    } finally {
      setStreaming(false);
      setLiveOptions([]);
      abortRef.current = null;
    }
  };

  const cancelBrainstorm = () => {
    abortRef.current?.abort();
  };

  return (
    <section
      className={cn(
        "relative bg-paper-50 dark:bg-ink-800 transition-shadow",
        isPage
          ? "rounded-2xl border-2 border-ink-900/[0.04] dark:border-ink-50/[0.04] shadow-sm overflow-hidden"
          : cn(
              "rounded-xl border overflow-hidden shadow-sm",
              streaming
                ? "border-transparent shadow-[0_0_0_1px_rgba(247,127,0,0.25),0_30px_60px_-30px_rgba(247,127,0,0.35)]"
                : "border-ink-900/10 dark:border-ink-50/10",
            ),
      )}
    >
      {streaming && <AuroraBorder />}

      {!isPage && (
        <div className="relative flex items-center gap-2 border-b border-ink-900/[0.06] bg-gradient-to-r from-ember-500/[0.06] to-transparent px-4 py-2.5 dark:border-ink-50/[0.06]">
          <span
            className={cn(
              "grid place-items-center h-6 w-6 rounded-md text-ember-600 dark:text-ember-300",
              streaming ? "bg-ember-500/20" : "bg-ember-500/15",
            )}
          >
            <Lightbulb className="h-3.5 w-3.5" />
          </span>
          <div>
            <div className="text-[13px] font-semibold text-ink-900 dark:text-ink-50 leading-tight">
              Idea factory
            </div>
            <div className="font-mono text-[10px] text-ink-500 dark:text-ink-400">
              brainstorm in {projectName}
            </div>
          </div>
          <span className="ml-auto inline-flex items-center gap-2">
            {streaming && (
              <Button
                size="xs"
                variant="ghost"
                onClick={cancelBrainstorm}
                className="text-ink-500 dark:text-ink-400"
              >
                <X className="h-3 w-3" />
                Stop
              </Button>
            )}
            <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
              {pending.length} pending · {saved.length} saved
            </span>
          </span>
        </div>
      )}

      <div className={cn("relative space-y-4", isPage ? "p-6 lg:p-8" : "p-4")}>
        {isPage && (
          <div className="flex items-baseline gap-3">
            <span
              className={cn(
                "grid place-items-center h-7 w-7 rounded-md text-ember-600 dark:text-ember-300",
                streaming
                  ? "bg-ember-500/20"
                  : "bg-ember-500/15",
              )}
            >
              <Lightbulb className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold tracking-tight text-ink-900 dark:text-ink-50">
                What should we ship in {projectName}?
              </div>
              <div className="mt-0.5 text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
                The agent reads the repo, drafts ideas, and you pick the
                ones worth shipping. Save the good ones; pick one and a
                planner writes the spec before any executor touches code.
              </div>
            </div>
            {streaming && (
              <Button
                size="xs"
                variant="ghost"
                onClick={cancelBrainstorm}
                className="text-ink-500 dark:text-ink-400 shrink-0"
              >
                <X className="h-3 w-3" />
                Stop
              </Button>
            )}
          </div>
        )}
        <Textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="What should we brainstorm? e.g. 'next high-value features ranked by impact', 'where are we losing perf', 'what tests are we missing'…"
          rows={isPage ? 4 : 3}
          disabled={streaming}
          className={cn(
            "leading-relaxed resize-none",
            isPage ? "text-[15px]" : "text-[14px]",
          )}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {PROMPT_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setBrief(p.brief)}
              disabled={streaming}
              className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors disabled:opacity-50 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
            >
              <Sparkles className="h-2.5 w-2.5 opacity-70" />
              {p.label}
            </button>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <ToolbarPick
              label={`with · ${brainstormLabel}`}
              width="auto"
              options={buildModelOptions(claudeModels, codexModels)}
              onSelect={setBrainstormPick}
            />
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden sm:inline">
              ⌘↵
            </span>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={streaming || !brief.trim()}
            >
              {streaming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Wand2 className="h-3 w-3" />
              )}
              {streaming ? "brewing…" : "Brainstorm"}
            </Button>
          </span>
        </div>

        {streaming && <BrainstormLiveCard options={liveOptions} />}

        {/* Saved pile — promoted above pending so the curated stash is
            always one glance away. */}
        {saved.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowSaved((v) => !v)}
              className="flex items-center gap-2 w-full"
            >
              <BookmarkCheck className="h-3 w-3 text-amber-600 dark:text-amber-300" />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                Saved
              </span>
              <span className="font-mono text-[10px] tabular-nums text-amber-700 dark:text-amber-300">
                {saved.length}
              </span>
              <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 ml-1">
                · waiting to be picked
              </span>
              <ChevronRight
                className={cn(
                  "ml-auto h-3 w-3 text-ink-400 transition-transform",
                  showSaved && "rotate-90",
                )}
              />
            </button>
            {showSaved && (
              <ul className="space-y-1.5">
                {saved.map((idea) => (
                  <SavedIdeaRow
                    key={idea.id}
                    idea={idea}
                    onPick={() =>
                      setPlanFor({
                        seed: { text: idea.text, preview: idea.text },
                        savedIdea: idea,
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        )}

        {pending.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-3 w-3 text-ember-500" />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                Pending brainstorms
              </span>
              <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
                {pending.length}
              </span>
            </div>
            <ul className="space-y-2">
              {pending.map((s) => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  projectSlug={projectSlug}
                  savedKeys={savedKeys}
                  onPick={(seed) =>
                    setPlanFor({ seed, suggestion: s })
                  }
                />
              ))}
            </ul>
          </div>
        )}

        {pending.length === 0 && saved.length === 0 && !streaming && (
          <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-4 py-6 text-center">
            <Lightbulb className="h-5 w-5 mx-auto mb-2 text-ink-400 dark:text-ink-500" />
            <p className="text-[12px] text-ink-600 dark:text-ink-300">
              No ideas yet — type a brief above or pick a preset.
            </p>
            <p className="mt-1 text-[10.5px] text-ink-400 dark:text-ink-500 leading-relaxed">
              The agent reads this project's repo before suggesting, so the
              options reference real files / surfaces.
            </p>
          </div>
        )}

        {history.length > 0 && (
          <div className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] pt-2">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="flex w-full items-center gap-2 py-1 text-left"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                History
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
                {history.length}
              </span>
              <ChevronRight
                className={cn(
                  "ml-auto h-3 w-3 text-ink-400 transition-transform",
                  showHistory && "rotate-90",
                )}
              />
            </button>
            {showHistory && (
              <ul className="mt-2 space-y-1.5">
                {history.map((s) => (
                  <HistoryRow key={s.id} suggestion={s} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {planFor && (
        <PlanAndSpawnSheet
          seed={planFor.seed}
          suggestion={planFor.suggestion}
          savedIdea={planFor.savedIdea}
          models={modelsQ.data}
          onClose={() => setPlanFor(null)}
        />
      )}
    </section>
  );
}

/* ── Aurora border (the agentic shimmer) ─────────────────────────── */

/**
 * Multi-color animated gradient border that wraps the brainstorm
 * card while it's streaming. Drifts a wide aurora across the box
 * and bleeds a soft glow inward so it feels alive without being
 * loud.
 */
function AuroraBorder() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-xl"
      style={{
        padding: "1px",
        background:
          "conic-gradient(from var(--aurora-angle, 0deg), rgba(247,127,0,0.65), rgba(99,102,241,0.55), rgba(34,211,238,0.5), rgba(244,63,94,0.6), rgba(247,127,0,0.65))",
        backgroundSize: "300% 300%",
        WebkitMask:
          "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
        WebkitMaskComposite: "xor",
        maskComposite: "exclude",
        animation: "aurora-sweep 4.5s ease-in-out infinite",
      }}
    />
  );
}

function BrainstormLiveCard({ options }: { options: string[] }) {
  return (
    <div className="rounded-md border border-ember-500/30 bg-ember-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="relative inline-flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-ember-500 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-ember-500" />
        </span>
        <ShimmerText className="font-mono text-[10.5px] uppercase tracking-[0.12em]">
          agent is reading the repo and drafting…
        </ShimmerText>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {options.length} so far
        </span>
      </div>
      {options.length > 0 ? (
        <ul className="space-y-1">
          {options.map((opt, i) => (
            <li
              key={`${i}-${opt.slice(0, 24)}`}
              className="flex items-start gap-2 px-2 py-1.5 rounded animate-idea-pop"
            >
              <span className="grid place-items-center h-4 w-4 rounded-full border border-ember-500/40 font-mono text-[9px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span className="flex-1 text-[12.5px] text-ink-700 dark:text-ink-200 leading-snug">
                {opt}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[10.5px] text-ink-500 dark:text-ink-400">
          first option usually lands within ~10s…
        </p>
      )}
    </div>
  );
}

function ShimmerText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-orange-700 dark:text-orange-300",
        "animate-thinking-pulse",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Suggestion card (with save-each-option) ─────────────────────── */

function SuggestionCard({
  suggestion,
  projectSlug,
  savedKeys,
  onPick,
}: {
  suggestion: Suggestion;
  projectSlug: string;
  savedKeys: Map<string, string>;
  onPick: (seed: { index?: number; text?: string; preview: string }) => void;
}) {
  const dismiss = useDismissSuggestion();
  const save = useSaveIdea();
  const unsave = useDeleteSavedIdea();
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const { toast } = useApp();

  const onDismiss = async () => {
    try {
      await dismiss.mutateAsync(suggestion.id);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const toggleSaved = async (index: number, text: string) => {
    const key = `${suggestion.id}:${index}`;
    const existingId = savedKeys.get(key);
    try {
      if (existingId) {
        await unsave.mutateAsync(existingId);
      } else {
        await save.mutateAsync({
          projectSlug,
          text,
          suggestionId: suggestion.id,
          optionIndex: index,
        });
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <li className="rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-900/40 overflow-hidden animate-fade-in">
      <div className="px-3 py-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-ink-900 dark:text-ink-50 truncate flex-1">
          {suggestion.title}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
          {formatTs(suggestion.createdAt)}
        </span>
      </div>
      {suggestion.prompt && (
        <p className="px-3 pt-2 text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
          {suggestion.prompt.slice(0, 240)}
          {suggestion.prompt.length > 240 ? "…" : ""}
        </p>
      )}
      <ul className="p-2 space-y-1">
        {suggestion.options.map((opt, i) => {
          const isSaved = savedKeys.has(`${suggestion.id}:${i}`);
          return (
            <li
              key={i}
              className="group flex items-start gap-1 rounded transition-colors hover:bg-ember-500/[0.04] dark:hover:bg-ember-500/[0.08] border border-transparent hover:border-ember-500/20"
            >
              <button
                type="button"
                onClick={() => onPick({ index: i, preview: opt })}
                className="flex-1 flex items-start gap-2 px-2 py-1.5 text-left"
              >
                <span className="grid place-items-center h-4 w-4 rounded-full border border-ink-900/15 dark:border-ink-50/15 font-mono text-[9px] tabular-nums text-ink-500 shrink-0 mt-0.5 group-hover:border-ember-500/50 group-hover:text-ember-700 dark:group-hover:text-ember-300">
                  {i + 1}
                </span>
                <span className="flex-1 text-[12.5px] text-ink-700 dark:text-ink-200 leading-snug">
                  {opt}
                </span>
                <span className="font-mono text-[10px] tracking-[0.06em] text-ink-400 dark:text-ink-500 opacity-0 group-hover:opacity-100 group-hover:text-ember-700 dark:group-hover:text-ember-300 transition-opacity shrink-0 mt-0.5">
                  plan →
                </span>
              </button>
              <button
                type="button"
                onClick={() => void toggleSaved(i, opt)}
                disabled={save.isPending || unsave.isPending}
                title={isSaved ? "Unsave" : "Save for later"}
                className={cn(
                  "shrink-0 grid place-items-center h-7 w-7 rounded transition-colors",
                  isSaved
                    ? "text-amber-600 dark:text-amber-300"
                    : "text-ink-300 dark:text-ink-600 hover:text-amber-600 dark:hover:text-amber-300",
                )}
              >
                {isSaved ? (
                  <BookmarkCheck className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Bookmark className="h-3.5 w-3.5" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] p-2">
        {showCustom ? (
          <div className="space-y-1.5">
            <Input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (custom.trim()) {
                    onPick({ text: custom.trim(), preview: custom.trim() });
                  }
                }
              }}
              placeholder="Or write your own direction… opens the plan + spawn flow."
              className="text-[12px]"
              autoFocus
            />
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setShowCustom(false);
                  setCustom("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  if (custom.trim()) {
                    onPick({ text: custom.trim(), preview: custom.trim() });
                  }
                }}
                disabled={!custom.trim()}
              >
                <Wand2 className="h-3 w-3" />
                Plan it
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setShowCustom(true)}
            >
              <Sparkles className="h-3 w-3" />
              Type your own
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void onDismiss()}
              disabled={dismiss.isPending}
              className="text-ink-500 dark:text-ink-400 ml-auto"
            >
              <Trash2 className="h-3 w-3" />
              Dismiss
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/* ── Saved idea row ──────────────────────────────────────────────── */

function SavedIdeaRow({
  idea,
  onPick,
}: {
  idea: SavedIdea;
  onPick: () => void;
}) {
  const unsave = useDeleteSavedIdea();
  return (
    <li className="group flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/[0.04] dark:bg-amber-500/[0.08] hover:bg-amber-500/[0.08] dark:hover:bg-amber-500/[0.14] transition-colors animate-fade-in">
      <button
        type="button"
        onClick={onPick}
        className="flex-1 flex items-start gap-2 px-2 py-1.5 text-left"
      >
        <BookmarkCheck className="h-3 w-3 text-amber-600 dark:text-amber-300 fill-current shrink-0 mt-0.5" />
        <span className="flex-1 text-[12px] text-ink-700 dark:text-ink-200 leading-snug">
          {idea.text}
        </span>
        {idea.planDraft && (
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-amber-600 dark:text-amber-300 shrink-0 mt-0.5">
            plan ready
          </span>
        )}
        <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500 shrink-0 mt-0.5">
          {formatTs(idea.savedAt)}
        </span>
        <span className="font-mono text-[10px] tracking-[0.06em] text-ink-400 dark:text-ink-500 opacity-0 group-hover:opacity-100 group-hover:text-ember-700 dark:group-hover:text-ember-300 transition-opacity shrink-0 mt-0.5">
          plan →
        </span>
      </button>
      <button
        type="button"
        onClick={() => void unsave.mutateAsync(idea.id)}
        disabled={unsave.isPending}
        title="Unsave"
        className="shrink-0 grid place-items-center h-7 w-7 rounded text-ink-300 dark:text-ink-600 hover:text-red-700 dark:hover:text-red-300 transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

/* ── Plan & Spawn sheet ──────────────────────────────────────────── */

interface PlanSheetProps {
  seed: { index?: number; text?: string; preview: string };
  suggestion?: Suggestion;
  savedIdea?: SavedIdea;
  models: ReturnType<typeof useModels>["data"];
  onClose: () => void;
}

export function PlanAndSpawnSheet({
  seed,
  suggestion,
  savedIdea,
  models,
  onClose,
}: PlanSheetProps) {
  const client = useClient();
  const navigate = useNavigate();
  const { toast } = useApp();
  const resolve = useResolveSuggestion();
  const spawnMulti = useSpawnMultiFromSavedIdea();
  const persistSlices = useUpdateSavedIdeaSlices();

  const [plan, setPlan] = useState(savedIdea?.planDraft ?? "");
  const [planSource, setPlanSource] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(!savedIdea?.planDraft);
  const [planError, setPlanError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Slice editor state. Seeded from the idea's persisted slices when
  // we open from a saved idea; the planner can overwrite this when it
  // emits a json-slices block. The operator can edit / clear at any
  // time — clearing reverts to single-task spawn.
  const [slices, setSlices] = useState<PlanSlice[]>(
    savedIdea?.planSlices ?? [],
  );
  const [shareWorktree, setShareWorktree] = useState<boolean>(true);

  // Planner pick mirrors brainstorm — encoded as `<agent>:<model>`.
  const [planPick, setPlanPick] = useState<string>("");
  const planChoice = decodeAgentModel(planPick);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [model, setModel] = useState<string>("");
  const [thinking, setThinking] = useState<ThinkingLevel>("high");
  const [permission, setPermission] = useState<PermissionMode>(
    "bypassPermissions",
  );

  // Clamp the thinking level whenever the operator picks a different
  // agent so an inapplicable choice (e.g. `max` on codex, `minimal`
  // on claude) doesn't get sent to the runner.
  useEffect(() => {
    setThinking((cur) => clampThinkingLevel(agent, cur));
  }, [agent]);

  const generatePlan = useMemo(
    () => async () => {
      if (!suggestion) return; // saved-idea path: nothing to stream
      const ctrl = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ctrl;
      setPlan("");
      setPlanSource(null);
      setPlanError(null);
      setStreaming(true);
      try {
        const r = await client.streamSuggestionPlan(
          suggestion.id,
          {
            ...(seed.index != null ? { index: seed.index } : {}),
            ...(seed.text ? { text: seed.text } : {}),
            ...(planChoice.agent ? { agent: planChoice.agent } : {}),
            ...(planChoice.model ? { model: planChoice.model } : {}),
          },
          (chunk) => setPlan((p) => p + chunk),
          ctrl.signal,
        );
        if (r.error) setPlanError(r.error);
        if (r.plan && r.source !== "fallback-error") setPlan(r.plan);
        if (r.slices && r.slices.length > 0) setSlices(r.slices);
        setPlanSource(r.source);
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          setPlanError((e as Error).message);
        }
      } finally {
        setStreaming(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, suggestion?.id, seed.index, seed.text, planPick],
  );

  // Auto-generate when opened from a brainstorm option (no draft yet).
  useEffect(() => {
    if (!savedIdea?.planDraft) void generatePlan();
    return () => {
      abortRef.current?.abort();
    };
  }, [generatePlan, savedIdea?.planDraft]);

  const onSpawn = async () => {
    if (!plan.trim()) {
      toast("plan is empty — wait for it to stream or write your own", true);
      return;
    }
    try {
      if (savedIdea) {
        const r = await client.spawnFromSavedIdea(savedIdea.id, {
          prompt: plan.trim(),
          agent,
          ...(model.trim() ? { model: model.trim() } : {}),
          thinkingLevel: thinking,
          permissionMode: permission,
          title: seed.preview.split("\n")[0]!.slice(0, 80),
        });
        toast(
          `spawning ${r.task.id.slice(-8)} on ${agent}${model ? "/" + model : ""}`,
        );
        onClose();
        navigate(`/tasks/${r.task.id}`);
      } else if (suggestion) {
        const r = await resolve.mutateAsync({
          id: suggestion.id,
          pick: {
            ...(seed.index != null ? { index: seed.index } : { text: seed.text }),
            text: plan.trim(),
            agent,
            ...(model.trim() ? { model: model.trim() } : {}),
            thinkingLevel: thinking,
            permissionMode: permission,
            title: seed.preview.split("\n")[0]!.slice(0, 80),
          },
        });
        toast(
          `spawning ${r.task.id.slice(-8)} on ${agent}${model ? "/" + model : ""}`,
        );
        onClose();
        navigate(`/tasks/${r.task.id}`);
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const onSpawnMulti = async () => {
    if (!savedIdea) {
      toast("save the idea first to fan it into slices", true);
      return;
    }
    if (slices.length === 0) {
      toast("add at least one slice to fan out", true);
      return;
    }
    const bad = slices.find((s) => !s.title.trim() || !s.prompt.trim());
    if (bad) {
      toast("each slice needs a title and a prompt", true);
      return;
    }
    try {
      const r = await spawnMulti.mutateAsync({
        id: savedIdea.id,
        slices,
        shareWorktree,
        title: seed.preview.split("\n")[0]!.slice(0, 80),
      });
      toast(
        `spawned ${r.tasks.length} sibling task${r.tasks.length === 1 ? "" : "s"}${
          shareWorktree ? " on a shared branch" : ""
        }`,
      );
      onClose();
      navigate(`/tasks/${r.tasks[0]!.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  // Persist slice edits to the saved idea on a small debounce so a
  // closed sheet (or refresh) doesn't lose the operator's work.
  useEffect(() => {
    if (!savedIdea) return;
    const t = setTimeout(() => {
      void persistSlices.mutateAsync({
        id: savedIdea.id,
        slices: slices.length > 0 ? slices : null,
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slices, savedIdea?.id]);

  const stashPlan = async () => {
    if (!suggestion) return;
    try {
      await client.createSavedIdea(suggestion.projectId ?? "", {
        text: seed.preview,
        suggestionId: suggestion.id,
        ...(seed.index != null ? { optionIndex: seed.index } : {}),
        planDraft: plan.trim() || undefined,
      });
      toast("saved with plan — find it in Saved");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const agentModels = (models?.models[agent] ?? []) as {
    id: string;
    label: string;
  }[];
  const modelLabel =
    model.trim()
      ? agentModels.find((m) => m.id === model)?.label || model
      : "default";
  const wordCount = plan.trim() ? plan.trim().split(/\s+/).length : 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-end sm:place-items-center bg-ink-900/40 backdrop-blur-sm animate-in fade-in">
      <div className="relative w-full sm:max-w-2xl max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-ink-900/10 bg-paper-50 shadow-2xl dark:border-ink-50/10 dark:bg-ink-800 animate-in slide-in-from-bottom-4">
        <header className="flex items-start gap-3 p-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
          <span className="grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-ember-500/15 text-ember-600 dark:text-ember-300">
            <Wand2 className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-ink-900 dark:text-ink-50">
              Plan &amp; spawn
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-500 dark:text-ink-400 truncate">
              {seed.preview}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-900/[0.05] hover:text-ink-900 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <div className="flex items-baseline gap-2 mb-2 flex-wrap">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                Plan
              </span>
              <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                · reads the repo
              </span>
              <span className="ml-auto inline-flex items-center gap-2 flex-wrap">
                {streaming ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ember-700 dark:text-ember-300">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    streaming…
                  </span>
                ) : (
                  <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
                    {wordCount}w
                  </span>
                )}
                {suggestion && (
                  <ToolbarPick
                    label={`with · ${
                      planPick
                        ? `${planChoice.agent} · ${planChoice.modelLabel ?? "default"}`
                        : "default · claude"
                    }`}
                    width="auto"
                    options={buildModelOptions(
                      models?.models.claude ?? [],
                      models?.models.codex ?? [],
                    )}
                    onSelect={setPlanPick}
                  />
                )}
                {suggestion && (
                  <button
                    type="button"
                    onClick={() => void generatePlan()}
                    disabled={streaming}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors disabled:opacity-50 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    regenerate
                  </button>
                )}
              </span>
            </div>
            <Textarea
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              rows={Math.min(20, Math.max(8, plan.split("\n").length + 1))}
              placeholder={
                streaming
                  ? "the planner is reading the repo…"
                  : "write the plan yourself, or hit regenerate above"
              }
              className="text-[12.5px] font-mono leading-relaxed resize-y"
            />
            {planError && (
              <p className="mt-1 font-mono text-[10.5px] text-red-700 dark:text-red-300">
                {planError}
              </p>
            )}
            {!streaming && planSource && planSource !== "claude" && !planError && (
              <p className="mt-1 font-mono text-[10.5px] text-amber-700 dark:text-amber-300">
                planner returned an empty plan — write your own below or regenerate
              </p>
            )}
          </div>

          <div className="rounded-lg border border-ink-900/10 bg-paper-100/40 dark:border-ink-50/10 dark:bg-ink-900/30 p-3 space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
              Execute with
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ToolbarPick
                label={agent}
                width="auto"
                options={[
                  { value: "claude", label: "claude" },
                  { value: "codex", label: "codex" },
                ]}
                onSelect={(v) => {
                  setAgent(v as AgentKind);
                  setModel("");
                }}
              />
              <ToolbarPick
                label={`model · ${modelLabel}`}
                width="auto"
                options={[
                  { value: "", label: "(default)" },
                  ...agentModels.map((m) => ({
                    value: m.id,
                    label: m.label || m.id,
                  })),
                ]}
                onSelect={setModel}
              />
              <ToolbarPick
                label={`think · ${thinking}`}
                width="auto"
                options={THINKING_LEVELS_BY_AGENT[agent].map((v) => ({
                  value: v,
                  label: THINK_HINT[v],
                }))}
                onSelect={(v) => setThinking(v as ThinkingLevel)}
              />
              <ToolbarPick
                label={
                  permission === "bypassPermissions"
                    ? "bypass"
                    : permission === "acceptEdits"
                      ? "accept-edits"
                      : "plan"
                }
                width="auto"
                options={[
                  { value: "bypassPermissions", label: "bypass · auto-allow" },
                  { value: "acceptEdits", label: "accept-edits · edits only" },
                  { value: "plan", label: "plan · read-only" },
                ]}
                onSelect={(v) => setPermission(v as PermissionMode)}
              />
            </div>
            <p className="text-[10.5px] text-ink-400 dark:text-ink-500 leading-relaxed">
              Spawns in a fresh worktree on a new branch. The plan above
              becomes the agent's prompt — edit it before hitting spawn.
            </p>
          </div>

          {savedIdea && (
            <div className="rounded-lg border border-ink-900/10 bg-paper-100/40 dark:border-ink-50/10 dark:bg-ink-900/30 p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                  Slices
                </span>
                <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                  · split the plan across agents/models · run sequentially on the same branch
                </span>
                <span className="ml-auto inline-flex items-center gap-2">
                  {slices.length > 1 && (
                    <label className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-600 dark:text-ink-300">
                      <input
                        type="checkbox"
                        checked={shareWorktree}
                        onChange={(e) => setShareWorktree(e.target.checked)}
                        className="h-3 w-3 accent-ember-500"
                      />
                      share branch
                    </label>
                  )}
                  {slices.length === 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSlices([
                          {
                            title: "slice 1",
                            prompt: plan.trim() || "",
                          },
                        ])
                      }
                      className="inline-flex items-center gap-1 h-6 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
                    >
                      split into slices
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSlices([])}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.06em] text-ink-500 hover:text-red-600 dark:text-ink-400 dark:hover:text-red-300"
                    >
                      clear slices
                    </button>
                  )}
                </span>
              </div>
              {slices.length > 0 && (
                <PlanSlicesEditor
                  slices={slices}
                  onChange={setSlices}
                  modelSuggestions={{
                    claude: (models?.models.claude ?? []).map((m) => m.id),
                    codex: (models?.models.codex ?? []).map((m) => m.id),
                  }}
                  disabled={spawnMulti.isPending}
                />
              )}
              {slices.length === 0 && (
                <p className="text-[10.5px] text-ink-400 dark:text-ink-500 leading-relaxed">
                  Single task by default. Add a slice to use a different
                  agent/model for part of the plan — siblings run in
                  order on a shared branch so each can land its own commit.
                </p>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] px-5 py-3 bg-paper-100/40 dark:bg-ink-900/30">
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
            picks → fresh worktree
          </span>
          <span className="ml-auto" />
          {suggestion && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void stashPlan()}
              disabled={streaming}
            >
              <Bookmark className="h-3.5 w-3.5" />
              Save for later
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void onSpawn()}
            disabled={
              resolve.isPending ||
              spawnMulti.isPending ||
              streaming ||
              !plan.trim()
            }
            title="Spawn one task using the plan above"
          >
            {resolve.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            Spawn as one
          </Button>
          {savedIdea && slices.length > 0 && (
            <Button
              size="sm"
              onClick={() => void onSpawnMulti()}
              disabled={spawnMulti.isPending || resolve.isPending || streaming}
              title="Spawn one task per slice on a shared branch"
            >
              {spawnMulti.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              Spawn {slices.length} slices
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ── Bits ────────────────────────────────────────────────────────── */

function ToolbarPick({
  label,
  options,
  onSelect,
  width,
}: {
  label: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
  width?: "auto";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-7 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[11px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors"
        >
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn(width === "auto" ? "" : "min-w-[200px]")}>
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <span className="font-mono text-[12px]">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HistoryRow({ suggestion }: { suggestion: Suggestion }) {
  const navigate = useNavigate();
  const isResolved = suggestion.status === "resolved";
  const summary = useMemo(() => {
    if (suggestion.chosenText) {
      const t = suggestion.chosenText.replace(/\s+/g, " ").trim();
      return t.length > 80 ? t.slice(0, 77) + "…" : t;
    }
    return suggestion.title;
  }, [suggestion]);
  return (
    <li className="flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors">
      <span
        className={cn(
          "font-mono text-[9px] uppercase tracking-[0.12em] shrink-0",
          isResolved
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-ink-400 dark:text-ink-500",
        )}
      >
        {isResolved ? "spawned" : "dismissed"}
      </span>
      <span className="text-ink-700 dark:text-ink-200 truncate flex-1">
        {summary}
      </span>
      {suggestion.spawnedTaskId && (
        <button
          type="button"
          onClick={() => navigate(`/tasks/${suggestion.spawnedTaskId}`)}
          className="font-mono text-[10px] text-ember-700 dark:text-ember-300 hover:underline shrink-0"
        >
          → {suggestion.spawnedTaskId.slice(-8)}
        </button>
      )}
      <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
        {formatTs(suggestion.resolvedAt ?? suggestion.createdAt)}
      </span>
    </li>
  );
}

/**
 * Picker payloads encode `{agent}:{model}` so a single flat menu can
 * span both registries (claude opus/sonnet/haiku alongside codex
 * models loaded from `~/.codex/models_cache.json`). Empty string =
 * "use the daemon defaults". `claude:` = "claude default model".
 */
function decodeAgentModel(raw: string): {
  agent?: AgentKind;
  model?: string;
  modelLabel?: string;
} {
  if (!raw) return {};
  const idx = raw.indexOf(":");
  if (idx < 0) return { agent: "claude", model: raw, modelLabel: raw };
  const agent = raw.slice(0, idx) as AgentKind;
  const model = raw.slice(idx + 1);
  return {
    agent,
    ...(model ? { model, modelLabel: model } : {}),
  };
}

function buildModelOptions(
  claude: { id: string; label: string }[],
  codex: { id: string; label: string }[],
): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [
    { value: "", label: "(default · claude)" },
    { value: "claude:", label: "claude · default" },
    ...claude.map((m) => ({
      value: `claude:${m.id}`,
      label: `claude · ${m.label || m.id}`,
    })),
  ];
  if (codex.length > 0) {
    opts.push({ value: "codex:", label: "codex · default" });
    for (const m of codex) {
      opts.push({
        value: `codex:${m.id}`,
        label: `codex · ${m.label || m.id}`,
      });
    }
  }
  return opts;
}
