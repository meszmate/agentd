import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronRight,
  Filter,
  LayoutGrid,
  Lightbulb,
  Loader2,
  MessageSquare,
  Play,
  Send,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import type {
  Idea,
  IdeaStatus,
  Suggestion,
} from "@agentd/contracts";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { StatCell } from "@/components/ui/big-num";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp, useClient } from "@/AppContext";
import {
  qk,
  useDeleteSavedIdea,
  useIdeateForProject,
  useModels,
  useProject,
  useProjectSuggestions,
  useSaveIdea,
  useSavedIdeas,
} from "@/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatTs } from "@/lib/utils";

type View = "board" | "sessions" | "library";

const PROMPT_PRESETS: { label: string; brief: string }[] = [
  {
    label: "next features",
    brief:
      "Look at the codebase and propose the highest-value features to build next, ranked by impact-vs-effort. Be specific — name files / surfaces.",
  },
  {
    label: "tech debt",
    brief:
      "Scan the repo for the most painful tech debt — deprecated APIs, dead code, smelly modules, missing tests, performance traps.",
  },
  {
    label: "missing tests",
    brief:
      "Find the highest-value untested logic and propose specific test files / cases to add. Cite file paths.",
  },
  {
    label: "polish",
    brief:
      "Find rough edges in the user-facing UI/UX — small fixes that punch above their weight.",
  },
  {
    label: "perf wins",
    brief:
      "Hunt for performance regressions, hot paths, wasted work. Each idea should name a specific function or file and the symptom.",
  },
];

const COLUMNS: {
  key: IdeaStatus;
  label: string;
  hint?: string;
  accent?: boolean;
}[] = [
  { key: "draft", label: "Drafts" },
  { key: "refining", label: "Refining", hint: "active conversation", accent: true },
  { key: "validated", label: "Validated", hint: "ready to ship" },
  { key: "spawned", label: "Spawned", hint: "task fired" },
  { key: "archived", label: "Archive" },
];

/**
 * Brainstorm command center — `/projects/:slug/brainstorm`. Mirrors
 * the TaskDetail page chrome (PageTopbar + h-9 sub-strip) but the
 * body is a multi-pane dashboard:
 *
 *   1. Hero stats strip (5 BigNum cells)
 *   2. View switcher (Board / Sessions / Library)
 *   3. Active brainstorm banner with aurora border (sticky when streaming)
 *   4. Main pane changes per view:
 *        Board    — kanban-style columns, one per IdeaStatus
 *        Sessions — chronological session cards with per-option pin/refine
 *        Library  — flat searchable list of every idea ever
 *   5. Right rail (lg+): recent sessions + tag cloud + model settings
 *   6. Composer footer pinned to the bottom with model + preset chips
 */
export function ProjectBrainstorm() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const projectQ = useProject(slug);
  const project = projectQ.data?.project ?? null;
  const sugQ = useProjectSuggestions(projectQ.data?.project.id);
  const savedQ = useSavedIdeas(slug);
  const ideate = useIdeateForProject();
  const save = useSaveIdea();
  const unsave = useDeleteSavedIdea();
  const modelsQ = useModels();
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();

  const [brief, setBrief] = useState("");
  const [view, setView] = useState<View>("board");
  const [streaming, setStreaming] = useState(false);
  const [liveOptions, setLiveOptions] = useState<string[]>([]);
  const [liveBrief, setLiveBrief] = useState("");
  const [brainstormPick, setBrainstormPick] = useState<string>("");
  const [librarySearch, setLibrarySearch] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const claudeModels = modelsQ.data?.models.claude ?? [];
  const codexModels = modelsQ.data?.models.codex ?? [];
  const choice = decodeAgentModel(brainstormPick);
  const choiceLabel = brainstormPick
    ? `${choice.agent} · ${choice.modelLabel ?? "default"}`
    : "default · claude";

  const allSuggestions = sugQ.data?.suggestions ?? [];
  const allIdeas = savedQ.data?.ideas ?? [];

  const savedKeys = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of allIdeas) {
      if (i.suggestionId != null && i.optionIndex != null) {
        m.set(`${i.suggestionId}:${i.optionIndex}`, i.id);
      }
    }
    return m;
  }, [allIdeas]);

  const sessions = useMemo(
    () =>
      [...allSuggestions]
        .filter((s) => s.options.length > 0)
        .sort((a, b) => b.createdAt - a.createdAt),
    [allSuggestions],
  );

  const counts = useMemo(() => {
    const out: Record<IdeaStatus, number> = {
      draft: 0,
      refining: 0,
      validated: 0,
      spawned: 0,
      archived: 0,
    };
    for (const i of allIdeas) out[i.status] += 1;
    return out;
  }, [allIdeas]);

  const brewedThisWeek = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return allSuggestions
      .filter((s) => s.createdAt >= cutoff)
      .reduce((n, s) => n + s.options.length, 0);
  }, [allSuggestions]);

  // Recent activity — flatten saved-idea + spawned events into one
  // chronological feed for the right rail.
  const recentActivity = useMemo(() => {
    const items: { id: string; ts: number; text: string; kind: "saved" | "spawned" }[] = [];
    for (const i of allIdeas) {
      items.push({
        id: i.id,
        ts: i.savedAt,
        text: i.text,
        kind: "saved",
      });
      if (i.spawnedAt) {
        items.push({
          id: i.id + ":spawn",
          ts: i.spawnedAt,
          text: i.text,
          kind: "spawned",
        });
      }
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 8);
  }, [allIdeas]);

  // Tag cloud — top 10 tags by frequency.
  const tags = useMemo(() => {
    const f = new Map<string, number>();
    for (const i of allIdeas) {
      for (const t of i.tags) f.set(t, (f.get(t) ?? 0) + 1);
    }
    return [...f.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [allIdeas]);

  if (projectQ.isLoading || !project) {
    return (
      <div className="flex h-full flex-col">
        <PageTopbar>
          <Link
            to="/projects"
            className="text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
          >
            ← Projects
          </Link>
          <VRule />
          <Skeleton className="h-3.5 w-32" />
        </PageTopbar>
        <div className="px-5 py-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const cancel = () => abortRef.current?.abort();

  const submit = async () => {
    const text = brief.trim();
    if (!text) {
      toast("type a brief first", true);
      return;
    }
    setStreaming(true);
    setLiveOptions([]);
    setLiveBrief(text);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await client.streamIdeateForProject(
        project.slug,
        {
          prompt: text,
          ...(choice.agent ? { agent: choice.agent } : {}),
          ...(choice.model ? { model: choice.model } : {}),
        },
        (line) => setLiveOptions((opts) => [...opts, line]),
        ctrl.signal,
      );
      if (r.ok === false) {
        toast(r.error || "the helper returned no options", true);
      } else {
        setBrief("");
        void qc.invalidateQueries({
          queryKey: qk.projectSuggestions(project.id),
        });
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        toast((e as Error).message, true);
      }
    } finally {
      setStreaming(false);
      setLiveOptions([]);
      setLiveBrief("");
      abortRef.current = null;
    }
  };

  const togglePinned = async (
    suggestionId: string,
    index: number,
    text: string,
  ) => {
    const key = `${suggestionId}:${index}`;
    const existing = savedKeys.get(key);
    try {
      if (existing) {
        await unsave.mutateAsync(existing);
      } else {
        await save.mutateAsync({
          projectSlug: project.slug,
          text,
          suggestionId,
          optionIndex: index,
        });
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const openIdea = (id: string) =>
    navigate(`/projects/${encodeURIComponent(project.slug)}/ideas/${id}`);

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Link
          to={`/projects/${encodeURIComponent(project.slug)}`}
          className="text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
        >
          ← {project.name}
        </Link>
        <VRule />
        <Kicker>ideas</Kicker>
        <span
          className="size-3 rounded-md shrink-0"
          style={{ background: project.color || "#DC2626" }}
        />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate max-w-[44ch]">
          Brainstorm
        </span>
        <Count>{allIdeas.length}</Count>
        {streaming && <LiveBadge />}
        <Spacer />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400 hidden lg:inline">
          board · sessions · library
        </span>
      </PageTopbar>

      {/* Hero stats strip (matches ProjectDetail's stat strip) */}
      <div className="grid grid-cols-2 sm:grid-cols-5 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0">
        <StatCell
          label="drafts"
          value={counts.draft}
          sublabel="not yet refined"
        />
        <StatCell
          label="refining"
          value={counts.refining}
          sublabel="active threads"
          accent={counts.refining > 0}
        />
        <StatCell
          label="validated"
          value={counts.validated}
          sublabel="ready to ship"
        />
        <StatCell
          label="spawned"
          value={counts.spawned}
          sublabel="became tasks"
        />
        <StatCell
          label="this week"
          value={brewedThisWeek}
          sublabel="ideas brewed"
          last
        />
      </div>

      {/* Sub-strip — meta + view switcher */}
      <div className="flex h-9 items-center gap-3 px-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0 overflow-x-auto">
        <div className="inline-flex items-center gap-0.5 rounded border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 p-0.5 shrink-0">
          {(
            [
              { v: "board", label: "Board", icon: LayoutGrid },
              { v: "sessions", label: "Sessions", icon: Play },
              { v: "library", label: "Library", icon: Filter },
            ] as const
          ).map(({ v, label, icon: Icon }) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors",
                view === v
                  ? "bg-ember-500/15 text-ember-700 dark:text-ember-300"
                  : "text-ink-500 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-50",
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 shrink-0">
          {sessions.length} brainstorm{sessions.length === 1 ? "" : "s"}
        </span>
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 shrink-0 truncate">
          {project.path}
        </span>
      </div>

      {/* Live banner pinned at the top of the body when streaming */}
      {streaming && (
        <LiveBanner
          brief={liveBrief}
          options={liveOptions}
          onCancel={cancel}
        />
      )}

      {/* Body — split: main + right rail (lg+) */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-w-0 min-h-0 overflow-y-auto">
          {view === "board" && (
            <BoardView
              ideas={allIdeas}
              counts={counts}
              onOpen={openIdea}
              empty={!streaming && allIdeas.length === 0}
              onBrainstormFocus={() => {
                const el = document.getElementById("brainstorm-composer");
                el?.scrollIntoView({ behavior: "smooth" });
                el?.querySelector("textarea")?.focus();
              }}
            />
          )}
          {view === "sessions" && (
            <SessionsView
              sessions={sessions}
              savedKeys={savedKeys}
              onTogglePin={togglePinned}
              onOpenIdea={openIdea}
              empty={!streaming && sessions.length === 0}
            />
          )}
          {view === "library" && (
            <LibraryView
              ideas={allIdeas}
              search={librarySearch}
              onSearch={setLibrarySearch}
              onOpen={openIdea}
            />
          )}
        </main>

        {/* Right rail */}
        <aside className="hidden lg:flex flex-col min-h-0 border-l border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50/40 dark:bg-ink-900/30 overflow-y-auto">
          <RailSection title="Brainstorm with">
            <ToolbarPick
              label={`agent · ${choiceLabel}`}
              options={buildModelOptions(claudeModels, codexModels)}
              onSelect={setBrainstormPick}
              full
            />
            <p className="mt-2 text-[10.5px] text-ink-400 dark:text-ink-500 leading-relaxed">
              The brainstorm helper reads this project's repo. Pick claude
              for creative scope or codex for tighter exploration.
            </p>
          </RailSection>

          <RailSection
            title="Recent activity"
            count={recentActivity.length}
          >
            {recentActivity.length === 0 ? (
              <p className="text-[11px] text-ink-400 dark:text-ink-500">
                No activity yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {recentActivity.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-2 text-[11px] leading-snug"
                  >
                    <span
                      className={cn(
                        "mt-1 inline-block size-1.5 rounded-full shrink-0",
                        a.kind === "spawned"
                          ? "bg-violet-500"
                          : "bg-amber-500",
                      )}
                    />
                    <span className="flex-1 text-ink-700 dark:text-ink-200 line-clamp-2">
                      {a.text}
                    </span>
                    <span className="font-mono text-[9.5px] text-ink-400 dark:text-ink-500 shrink-0">
                      {formatTs(a.ts)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </RailSection>

          {tags.length > 0 && (
            <RailSection title="Tags" count={tags.length}>
              <div className="flex flex-wrap gap-1">
                {tags.map(([t, n]) => (
                  <span
                    key={t}
                    className="inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-ember-500/10 text-ember-700 dark:text-ember-300 border border-ember-500/20"
                  >
                    ◆ {t}
                    <span className="ml-1 text-[9px] tabular-nums text-ink-400 dark:text-ink-500">
                      {n}
                    </span>
                  </span>
                ))}
              </div>
            </RailSection>
          )}

          <RailSection title="How this works">
            <ol className="space-y-1.5 text-[11px] text-ink-700 dark:text-ink-200 leading-relaxed">
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-ember-700 dark:text-ember-300 shrink-0 w-3">
                  1
                </span>
                <span>
                  Type a brief and hit Brainstorm. The agent reads the repo
                  and proposes options.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-ember-700 dark:text-ember-300 shrink-0 w-3">
                  2
                </span>
                <span>
                  Save the good ones — they land in the board as drafts.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-ember-700 dark:text-ember-300 shrink-0 w-3">
                  3
                </span>
                <span>
                  Click any idea to refine it with the agent (questions,
                  challenges) until it's validated.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-ember-700 dark:text-ember-300 shrink-0 w-3">
                  4
                </span>
                <span>
                  Spawn a real task with planner-drafted spec and the
                  executor of your choice.
                </span>
              </li>
            </ol>
          </RailSection>
        </aside>
      </div>

      {/* Composer pinned at the bottom */}
      <Composer
        id="brainstorm-composer"
        brief={brief}
        onChange={setBrief}
        onSubmit={() => void submit()}
        disabled={streaming}
        streaming={streaming}
        projectName={project.name}
        choiceLabel={choiceLabel}
        modelOptions={buildModelOptions(claudeModels, codexModels)}
        onModelSelect={setBrainstormPick}
      />
    </div>
  );
}

/* ── Live banner ────────────────────────────────────────────────── */

function LiveBanner({
  brief,
  options,
  onCancel,
}: {
  brief: string;
  options: string[];
  onCancel: () => void;
}) {
  return (
    <div className="relative shrink-0 border-b border-ember-500/20 bg-ember-500/[0.04] dark:bg-ember-500/[0.07]">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(247,127,0,0.7), rgba(99,102,241,0.6), rgba(34,211,238,0.6), rgba(244,63,94,0.7), transparent)",
          backgroundSize: "200% 100%",
          animation: "aurora-sweep 4s ease-in-out infinite",
        }}
      />
      <div className="px-5 py-2.5 flex items-start gap-3">
        <span className="grid place-items-center h-7 w-7 rounded-md bg-ember-500/20 text-ember-600 dark:text-ember-300 shrink-0 animate-active-glow">
          <Lightbulb className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <ShimmerText className="block font-mono text-[10.5px] uppercase tracking-[0.14em]">
            agent is reading the repo and drafting…
          </ShimmerText>
          <p className="text-[12px] text-ink-700 dark:text-ink-200 truncate">
            {brief.split("\n")[0]?.slice(0, 200) || "brainstorming"}
          </p>
          {options.length > 0 && (
            <ul className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {options.map((opt, i) => (
                <li
                  key={`${i}-${opt.slice(0, 24)}`}
                  className="flex items-start gap-2 px-2 py-1 rounded animate-idea-pop bg-paper-50/50 dark:bg-ink-800/50"
                >
                  <span className="grid place-items-center h-4 w-4 rounded-full border border-ember-500/40 font-mono text-[9px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <span className="flex-1 text-[12px] text-ink-700 dark:text-ink-200 leading-snug">
                    {opt}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="shrink-0 inline-flex items-center gap-2">
          <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300">
            {options.length} so far
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={onCancel}
            className="text-ink-500 dark:text-ink-400"
          >
            <X className="h-3 w-3" />
            Stop
          </Button>
        </span>
      </div>
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
        "bg-clip-text text-transparent",
        "bg-[linear-gradient(90deg,rgba(194,65,12,0.45),rgba(194,65,12,1),rgba(99,102,241,1),rgba(34,211,238,1),rgba(194,65,12,0.45))]",
        "dark:bg-[linear-gradient(90deg,rgba(252,165,107,0.4),rgba(252,165,107,1),rgba(165,180,252,1),rgba(103,232,249,1),rgba(252,165,107,0.4))]",
        "bg-[length:300%_100%] animate-shimmer",
        className,
      )}
    >
      {children}
    </span>
  );
}

function LiveBadge() {
  return (
    <span className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em] bg-ember-500/15 text-ember-700 dark:text-ember-300">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-ember-500 opacity-60 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember-500" />
      </span>
      Live
    </span>
  );
}

/* ── Board view ─────────────────────────────────────────────────── */

function BoardView({
  ideas,
  counts,
  onOpen,
  empty,
  onBrainstormFocus,
}: {
  ideas: Idea[];
  counts: Record<IdeaStatus, number>;
  onOpen: (id: string) => void;
  empty: boolean;
  onBrainstormFocus: () => void;
}) {
  const grouped = useMemo(() => {
    const out: Record<IdeaStatus, Idea[]> = {
      draft: [],
      refining: [],
      validated: [],
      spawned: [],
      archived: [],
    };
    for (const i of ideas) out[i.status].push(i);
    return out;
  }, [ideas]);

  if (empty) {
    return <EmptyMain onBrainstormFocus={onBrainstormFocus} />;
  }

  return (
    <div className="h-full overflow-x-auto">
      <div className="grid grid-cols-5 gap-3 p-4 min-w-[1100px] h-full">
        {COLUMNS.map((col) => (
          <BoardColumn
            key={col.key}
            label={col.label}
            hint={col.hint}
            accent={col.accent}
            count={counts[col.key]}
            ideas={grouped[col.key]}
            onOpen={onOpen}
            muted={col.key === "archived" || col.key === "spawned"}
          />
        ))}
      </div>
    </div>
  );
}

function BoardColumn({
  label,
  hint,
  accent,
  count,
  ideas,
  onOpen,
  muted,
}: {
  label: string;
  hint?: string;
  accent?: boolean;
  count: number;
  ideas: Idea[];
  onOpen: (id: string) => void;
  muted?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col min-h-0 rounded-lg border bg-paper-50/60 dark:bg-ink-900/40 overflow-hidden",
        accent
          ? "border-ember-500/40"
          : "border-ink-900/[0.06] dark:border-ink-50/[0.06]",
        muted && "opacity-80",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-2 px-3 py-2 shrink-0 border-b",
          accent
            ? "border-ember-500/20 bg-ember-500/5"
            : "border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-100/40 dark:bg-ink-900/40",
        )}
      >
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.14em]",
            accent
              ? "text-ember-700 dark:text-ember-300"
              : "text-ink-500 dark:text-ink-400",
          )}
        >
          {label}
        </span>
        {hint && (
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
            · {hint}
          </span>
        )}
        <span
          className={cn(
            "ml-auto font-mono text-[10px] tabular-nums",
            accent
              ? "text-ember-700 dark:text-ember-300"
              : "text-ink-400 dark:text-ink-500",
          )}
        >
          {count}
        </span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {ideas.length === 0 ? (
          <div className="text-center py-6 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-300 dark:text-ink-600">
            empty
          </div>
        ) : (
          ideas.map((idea) => (
            <BoardCard key={idea.id} idea={idea} onOpen={onOpen} />
          ))
        )}
      </div>
    </section>
  );
}

function BoardCard({ idea, onOpen }: { idea: Idea; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(idea.id)}
      className="group w-full text-left rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 px-2.5 py-2 hover:border-ember-500/40 hover:shadow-sm transition-all"
    >
      <p
        className={cn(
          "text-[12px] leading-snug line-clamp-3",
          idea.status === "archived"
            ? "text-ink-400 dark:text-ink-500 line-through"
            : "text-ink-900 dark:text-ink-50",
        )}
      >
        {idea.text}
      </p>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[9.5px] text-ink-400 dark:text-ink-500">
        {(idea.messageCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="h-2.5 w-2.5" />
            {idea.messageCount}
          </span>
        )}
        {idea.planDraft && (
          <span className="text-amber-700 dark:text-amber-300">plan</span>
        )}
        {idea.spawnedTaskId && (
          <span className="text-violet-700 dark:text-violet-300 inline-flex items-center gap-0.5">
            <ArrowUpRight className="h-2.5 w-2.5" />
            task
          </span>
        )}
        <span className="ml-auto tabular-nums">
          {formatTs(idea.lastMessageAt ?? idea.updatedAt)}
        </span>
      </div>
      {idea.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {idea.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-400 dark:text-ink-500"
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function EmptyMain({
  onBrainstormFocus,
}: {
  onBrainstormFocus: () => void;
}) {
  return (
    <div className="grid place-items-center h-full p-10 text-center">
      <div className="space-y-3 max-w-md">
        <div className="grid place-items-center h-12 w-12 mx-auto rounded-xl bg-ember-500/15 text-ember-600 dark:text-ember-300">
          <Lightbulb className="h-5 w-5" />
        </div>
        <div className="text-[15px] font-semibold tracking-tight text-ink-900 dark:text-ink-50">
          The board is empty
        </div>
        <p className="text-[12.5px] text-ink-500 dark:text-ink-400 leading-relaxed">
          Use the composer below to ask the agent for ideas. They land
          here as drafts — refine, validate, then spawn real tasks.
        </p>
        <Button onClick={onBrainstormFocus}>
          <Wand2 className="h-3.5 w-3.5" />
          Brainstorm first ideas
        </Button>
      </div>
    </div>
  );
}

/* ── Sessions view ──────────────────────────────────────────────── */

function SessionsView({
  sessions,
  savedKeys,
  onTogglePin,
  onOpenIdea,
  empty,
}: {
  sessions: Suggestion[];
  savedKeys: Map<string, string>;
  onTogglePin: (suggestionId: string, index: number, text: string) => void;
  onOpenIdea: (id: string) => void;
  empty: boolean;
}) {
  if (empty) {
    return <EmptyMain onBrainstormFocus={() => {}} />;
  }
  return (
    <div className="px-5 py-5 space-y-4">
      {sessions.map((s) => (
        <SessionCard
          key={s.id}
          suggestion={s}
          savedKeys={savedKeys}
          onTogglePin={onTogglePin}
          onOpenIdea={onOpenIdea}
        />
      ))}
    </div>
  );
}

function SessionCard({
  suggestion,
  savedKeys,
  onTogglePin,
  onOpenIdea,
}: {
  suggestion: Suggestion;
  savedKeys: Map<string, string>;
  onTogglePin: (suggestionId: string, index: number, text: string) => void;
  onOpenIdea: (id: string) => void;
}) {
  return (
    <section className="rounded-xl border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-900/[0.06] bg-paper-100/40 px-4 py-2.5 dark:border-ink-50/[0.06] dark:bg-ink-900/30">
        <span className="grid place-items-center h-6 w-6 rounded-md bg-ember-500/15 text-ember-600 dark:text-ember-300 shrink-0">
          <Lightbulb className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {suggestion.title}
          </div>
          {suggestion.prompt && (
            <div className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
              {suggestion.prompt.split("\n")[0]?.slice(0, 200)}
            </div>
          )}
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {suggestion.options.length} ideas · {formatTs(suggestion.createdAt)}
        </span>
      </div>
      <ul>
        {suggestion.options.map((opt, i) => {
          const savedId = savedKeys.get(`${suggestion.id}:${i}`);
          const saved = !!savedId;
          return (
            <li
              key={i}
              className="group flex items-start gap-3 px-4 py-3 border-t border-ink-900/[0.04] dark:border-ink-50/[0.04] first:border-t-0 hover:bg-paper-100/60 dark:hover:bg-ink-700/60 transition-colors"
            >
              <span
                className={cn(
                  "grid place-items-center h-5 w-5 rounded-full border font-mono text-[10px] tabular-nums shrink-0 mt-0.5",
                  saved
                    ? "border-amber-500/50 text-amber-700 dark:text-amber-300"
                    : "border-ink-900/15 text-ink-500 dark:border-ink-50/15 dark:text-ink-400",
                )}
              >
                {i + 1}
              </span>
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-[13.5px] text-ink-700 dark:text-ink-100 leading-relaxed">
                  {opt}
                </p>
                <div className="flex items-center gap-2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
                  <button
                    type="button"
                    onClick={() => onTogglePin(suggestion.id, i, opt)}
                    className={cn(
                      "inline-flex items-center gap-1 hover:underline",
                      saved
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-ink-500 dark:text-ink-400",
                    )}
                  >
                    {saved ? "remove" : "save"}
                  </button>
                  {saved && savedId && (
                    <button
                      type="button"
                      onClick={() => onOpenIdea(savedId)}
                      className="inline-flex items-center gap-1 text-ember-700 dark:text-ember-300 hover:underline"
                    >
                      <MessageSquare className="h-2.5 w-2.5" />
                      refine
                      <ArrowUpRight className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onTogglePin(suggestion.id, i, opt)}
                title={saved ? "Unsave" : "Save for later"}
                className={cn(
                  "shrink-0 grid place-items-center h-7 w-7 rounded transition-colors",
                  saved
                    ? "text-amber-600 dark:text-amber-300"
                    : "text-ink-300 dark:text-ink-600 hover:text-amber-600 dark:hover:text-amber-300",
                )}
              >
                {saved ? (
                  <BookmarkCheck className="h-4 w-4 fill-current" />
                ) : (
                  <Bookmark className="h-4 w-4" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── Library view ───────────────────────────────────────────────── */

function LibraryView({
  ideas,
  search,
  onSearch,
  onOpen,
}: {
  ideas: Idea[];
  search: string;
  onSearch: (v: string) => void;
  onOpen: (id: string) => void;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ideas.filter((i) => {
      if (!q) return true;
      return (
        i.text.toLowerCase().includes(q) ||
        (i.description ?? "").toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [ideas, search]);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] shrink-0">
        <div className="relative max-w-md">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
            ⌕
          </span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search title, description, tag…"
            className="h-7 w-full pl-7 pr-2 rounded border border-ink-900/15 bg-paper-50 text-[12px] outline-none focus:border-ember-500/40 dark:border-ink-50/15 dark:bg-ink-800"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-[12px] text-ink-500 dark:text-ink-400">
            No matches.
          </div>
        ) : (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {filtered.map((idea) => (
              <li key={idea.id}>
                <button
                  type="button"
                  onClick={() => onOpen(idea.id)}
                  className="group h-12 w-full px-5 flex items-center gap-3 hover:bg-paper-100 dark:hover:bg-ink-700 text-left transition-colors"
                >
                  <StatusDotSm status={idea.status} />
                  <span
                    className={cn(
                      "text-[13px] truncate flex-1",
                      idea.status === "archived"
                        ? "text-ink-400 dark:text-ink-500 line-through"
                        : "text-ink-900 dark:text-ink-50 font-medium",
                    )}
                  >
                    {idea.text}
                  </span>
                  {idea.tags.slice(0, 2).map((t) => (
                    <span
                      key={t}
                      className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0"
                    >
                      #{t}
                    </span>
                  ))}
                  {idea.planDraft && (
                    <span className="shrink-0 inline-flex h-4 px-1 rounded text-[9px] font-medium uppercase tracking-[0.08em] bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      plan
                    </span>
                  )}
                  {(idea.messageCount ?? 0) > 0 && (
                    <span className="font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 inline-flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {idea.messageCount}
                    </span>
                  )}
                  <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600 w-14 text-right shrink-0">
                    {formatTs(idea.lastMessageAt ?? idea.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── Composer ───────────────────────────────────────────────────── */

function Composer({
  id,
  brief,
  onChange,
  onSubmit,
  disabled,
  streaming,
  projectName,
  choiceLabel,
  modelOptions,
  onModelSelect,
}: {
  id?: string;
  brief: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  streaming: boolean;
  projectName: string;
  choiceLabel: string;
  modelOptions: { value: string; label: string }[];
  onModelSelect: (v: string) => void;
}) {
  return (
    <div
      id={id}
      className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 px-5 py-3 shrink-0"
    >
      <Textarea
        value={brief}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={`What should we brainstorm in ${projectName}? — e.g. "tests we're missing", "perf wins", "next features"…`}
        rows={2}
        disabled={disabled}
        className="text-[14px] leading-relaxed resize-none"
      />
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {PROMPT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(p.brief)}
            disabled={disabled}
            className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors disabled:opacity-50 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
          >
            <Sparkles className="h-2.5 w-2.5 opacity-70" />
            {p.label}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <ToolbarPick
            label={`with · ${choiceLabel}`}
            options={modelOptions}
            onSelect={onModelSelect}
          />
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden md:inline">
            ⌘↵
          </span>
          <Button
            size="sm"
            onClick={onSubmit}
            disabled={disabled || !brief.trim()}
          >
            {streaming ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            {streaming ? "brewing…" : "Brainstorm"}
          </Button>
        </span>
      </div>
    </div>
  );
}

/* ── Right rail bits ────────────────────────────────────────────── */

function RailSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          {title}
        </span>
        {count != null && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/* ── Hero (project landing) ─────────────────────────────────────── */

export function BrainstormHero({
  projectId,
  projectSlug,
  projectName,
}: {
  projectId: string;
  projectSlug: string;
  projectName: string;
}) {
  void projectId;
  const navigate = useNavigate();
  const ideasQ = useSavedIdeas(projectSlug);
  const all = ideasQ.data?.ideas ?? [];
  const open = all.filter(
    (i) => i.status !== "spawned" && i.status !== "archived",
  );
  const refining = open.filter((i) => i.status === "refining").length;
  const validated = open.filter((i) => i.status === "validated").length;
  const draft = open.filter((i) => i.status === "draft").length;

  const navTo = () =>
    navigate(`/projects/${encodeURIComponent(projectSlug)}/brainstorm`);

  const previewRows = open.slice(0, 4);

  return (
    <section className="rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 overflow-hidden divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
      <button
        type="button"
        onClick={navTo}
        className="group relative w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors"
      >
        <span className="grid place-items-center h-6 w-6 rounded-md bg-ember-500/15 text-ember-600 dark:text-ember-300 shrink-0">
          <Lightbulb className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">
              Brainstorm
            </span>
            <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
              in {projectName}
            </span>
          </div>
        </div>
        <span className="shrink-0 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums">
          {draft > 0 && (
            <span className="text-ink-500 dark:text-ink-400">{draft} draft</span>
          )}
          {refining > 0 && (
            <span className="text-ember-700 dark:text-ember-300">
              {refining} refining
            </span>
          )}
          {validated > 0 && (
            <span className="text-emerald-700 dark:text-emerald-300">
              {validated} ready
            </span>
          )}
          {open.length === 0 && (
            <span className="text-ink-500 dark:text-ink-400">
              no ideas yet
            </span>
          )}
        </span>
        <span className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400 dark:text-ink-500 group-hover:text-ember-700 dark:group-hover:text-ember-300 transition-colors">
          Open
          <ArrowUpRight className="h-3 w-3" />
        </span>
      </button>
      {previewRows.length === 0 ? (
        <button
          type="button"
          onClick={navTo}
          className="group flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors"
        >
          <Wand2 className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
          <span className="text-[12px] text-ink-500 dark:text-ink-400">
            Open the brainstorm to ask the agent for ideas.
          </span>
        </button>
      ) : (
        <ul>
          {previewRows.map((idea) => (
            <li key={idea.id}>
              <Link
                to={`/projects/${encodeURIComponent(projectSlug)}/ideas/${idea.id}`}
                className="group h-11 px-4 flex items-center gap-3 w-full hover:bg-paper-100 transition-colors dark:hover:bg-ink-700 text-left"
              >
                <StatusDotSm status={idea.status} />
                <span
                  className={cn(
                    "text-[12.5px] truncate flex-1",
                    idea.status === "archived"
                      ? "text-ink-400 dark:text-ink-500 line-through"
                      : "text-ink-700 dark:text-ink-200",
                  )}
                >
                  {idea.text}
                </span>
                {(idea.messageCount ?? 0) > 0 && (
                  <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 inline-flex items-center gap-0.5 shrink-0">
                    <MessageSquare className="h-2.5 w-2.5" />
                    {idea.messageCount}
                  </span>
                )}
                <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600 w-14 text-right shrink-0">
                  {formatTs(idea.lastMessageAt ?? idea.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusDotSm({ status }: { status: IdeaStatus }) {
  const tone =
    status === "refining"
      ? "bg-ember-500 animate-blink"
      : status === "validated"
        ? "bg-emerald-500"
        : status === "spawned"
          ? "bg-violet-500"
          : status === "archived"
            ? "bg-ink-200 dark:bg-ink-700"
            : "bg-ink-300 dark:bg-ink-600";
  return (
    <span className={cn("inline-block size-1.5 rounded-full shrink-0", tone)} />
  );
}

/* ── Bits ────────────────────────────────────────────────────────── */

function ToolbarPick({
  label,
  options,
  onSelect,
  full,
}: {
  label: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
  full?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 h-7 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[11px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors",
            full && "w-full justify-between",
          )}
        >
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <span className="font-mono text-[12px]">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function decodeAgentModel(raw: string): {
  agent?: "claude" | "codex";
  model?: string;
  modelLabel?: string;
} {
  if (!raw) return {};
  const idx = raw.indexOf(":");
  if (idx < 0) return { agent: "claude", model: raw, modelLabel: raw };
  const agent = raw.slice(0, idx) as "claude" | "codex";
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

void ChevronRight;
