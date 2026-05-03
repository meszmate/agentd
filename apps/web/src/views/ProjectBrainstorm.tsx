import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronRight,
  Filter,
  Flame,
  HelpCircle,
  Lightbulb,
  Plus,
  Repeat,
  Shuffle,
  Loader2,
  MessageSquare,
  PanelRight,
  PanelRightClose,
  Search,
  Send,
  Sparkles,
  Trash2,
  User2,
  Wand2,
  X,
} from "lucide-react";
import type { IdeaChatEvent, IdeationEvent } from "@agentd/client";
import type { Idea, IdeaStatus, Suggestion } from "@agentd/contracts";
import { Markdown } from "@/components/markdown";
import { ToolLine, WorkCard, pairToolEvents } from "@/components/tool-line";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ShimmerText,
  TransitioningText,
  useRotatingLabel,
  useElapsedMs,
  formatElapsed,
  type ThinkingPhase,
} from "@/components/thinking";
import { useApp, useClient } from "@/AppContext";
import {
  qk,
  useClearProjectBrainstorm,
  useDeleteSavedIdea,
  useIdeateForProject,
  useModels,
  useInvalidateSuggestions,
  useProject,
  useProjectGitState,
  useProjectSuggestions,
  usePullProject,
  useSaveIdea,
  useSavedIdeas,
} from "@/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatTs } from "@/lib/utils";

const PROMPT_PRESETS: { label: string; brief: string }[] = [
  {
    label: "next features",
    brief:
      "Propose the highest-leverage features to build next for this project. Think about what would move the needle most — for users, for adoption, for retention — given where the project is right now.",
  },
  {
    label: "tech debt",
    brief:
      "Where is this project carrying the most painful tech debt? Think about what's slowing future work down, what's brittle, what's likely to bite us in production.",
  },
  {
    label: "growth",
    brief:
      "Brainstorm growth and distribution angles for this project. Things that get more people to discover it, try it, or stick with it.",
  },
  {
    label: "moats",
    brief:
      "What could turn this into something hard to copy? Think structural advantages — workflows, data, integrations, network effects — not just features.",
  },
  {
    label: "polish",
    brief:
      "Where are the rough edges in the day-to-day experience of this project? Small things that punch above their weight once fixed.",
  },
  {
    label: "risks",
    brief:
      "What could blow up? Think failure modes — security, data loss, performance cliffs, operator footguns — and what we'd need to harden against them.",
  },
  {
    label: "wild",
    brief:
      "Forget the obvious roadmap. Pitch ideas that would make this project weird, opinionated, or memorable — directions a careful PM would never green-light. Don't sandbag with safety; lean into the strange ones. The operator wants to see the edges of the design space, not the median path.",
  },
];

/**
 * Brainstorm — chat-first single-column page. Each user message is a
 * brainstorm prompt; the agent replies inline with a streamed cluster
 * of options the operator can save with one click. Saved ideas live
 * in a popover pinned to the topbar so they're one tap away without
 * crowding the conversation.
 *
 * Designed to feel like ChatGPT scoped to one project. The whole
 * surface is the conversation; everything else is a small accessory.
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
  const invalidateSuggestions = useInvalidateSuggestions();
  const modelsQ = useModels();
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();

  const [brief, setBrief] = useState("");
  const [streaming, setStreaming] = useState(false);
  /** Suggestion id currently being validated + which rater fired it. */
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [validateLabel, setValidateLabel] = useState<string>("");
  /** Live tool calls from the in-flight rater so the suggestion can
   *  show "claude opus is reading the README…" instead of a spinner. */
  const [validateTools, setValidateTools] = useState<IdeationEvent[]>([]);
  const [liveOptions, setLiveOptions] = useState<string[]>([]);
  /**
   * Tool calls the agent is firing during the brainstorm — Read,
   * Glob, Grep, Bash. Renders inline below the rotating-label so the
   * operator sees the agent actually doing repo work, not a spinner.
   */
  const [liveTools, setLiveTools] = useState<IdeationEvent[]>([]);
  const [liveBrief, setLiveBrief] = useState("");
  const [brainstormPick, setBrainstormPick] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const clear = useClearProjectBrainstorm();

  // Right panel: open by default, persisted per-project in localStorage.
  // Mobile (<lg) collapses to a drawer instead.
  const [isWide, setIsWide] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const sidebarKey = `brainstorm:${slug}:sidebarOpen`;
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return true;
    const v = localStorage.getItem(sidebarKey);
    return v == null ? true : v === "1";
  });
  const setSidebarOpen = (v: boolean) => {
    setSidebarOpenState(v);
    try {
      localStorage.setItem(sidebarKey, v ? "1" : "0");
    } catch {
      // private mode — ignore
    }
  };
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [sidebarFilter, setSidebarFilter] = useState<"all" | IdeaStatus>("all");

  const claudeModels = modelsQ.data?.models.claude ?? [];
  const codexModels = modelsQ.data?.models.codex ?? [];
  const choice = decodeAgentModel(brainstormPick);
  const choiceLabel = brainstormPick
    ? `${choice.agent} · ${choice.modelLabel ?? "default"}`
    : "default · claude";

  const sessions = useMemo(
    () =>
      [...(sugQ.data?.suggestions ?? [])]
        .filter((s) => s.options.length > 0)
        .sort((a, b) => a.createdAt - b.createdAt),
    [sugQ.data],
  );
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

  const savedOpen = allIdeas.filter(
    (i) => i.status !== "spawned" && i.status !== "archived",
  );

  // Sticky-bottom autoscroll for the chat thread.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [sessions.length, streaming, liveOptions.length]);

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
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  const cancel = () => abortRef.current?.abort();

  // Composer mode — `brainstorm` (default, agent generates ideas)
  // vs `idea` (user is dropping their own idea, no agent). The mode
  // changes Send's behavior + the visual treatment of the input.
  const [composerMode, setComposerMode] = useState<"brainstorm" | "idea">(
    "brainstorm",
  );

  const submit = async () => {
    const text = brief.trim();
    if (!text) {
      toast("type a brief first", true);
      return;
    }
    await runBrainstorm(text, { clearComposer: true });
  };

  /** Dispatched by Send + ⌘↵ — picks the right path for the active mode. */
  const onSend = async () => {
    if (composerMode === "idea") {
      await submitValidateIdea();
    } else {
      await submit();
    }
  };

  // "I have an idea" — full agentic flow. The agent reads the repo
  // (live tool activity visible in the thread), drafts a critique +
  // sketch + suggested title, and finishes. The operator then clicks
  // Save (button labeled with the suggested title) to land it as a
  // SavedIdea — or Discard. Nothing is persisted until the explicit
  // save. Same realtime feel as a normal brainstorm session.
  interface InlineIdeaTurn {
    id: string;
    text: string;
    /** Streaming critique body — accumulated text deltas. */
    body: string;
    /** Live tool activity (tool_use + tool_result events). */
    events: IdeaChatEvent[];
    /** Set when the helper finishes — drives the action row. */
    finished: boolean;
    suggestedTitle: string;
    error: string | null;
    /** Once the operator hits Save, the resulting SavedIdea id. */
    savedIdeaId: string | null;
    saving: boolean;
    discarded: boolean;
    ts: number;
  }
  const [localIdeas, setLocalIdeas] = useState<InlineIdeaTurn[]>([]);
  const [savingIdea, setSavingIdea] = useState(false);
  const ideaAbortRefs = useRef(new Map<string, AbortController>());

  const removeLocalIdea = (turnId: string) => {
    const ctrl = ideaAbortRefs.current.get(turnId);
    if (ctrl) {
      ctrl.abort();
      ideaAbortRefs.current.delete(turnId);
    }
    setLocalIdeas((cur) => cur.filter((p) => p.id !== turnId));
  };

  const cancelIdea = (turnId: string) => {
    const ctrl = ideaAbortRefs.current.get(turnId);
    if (ctrl) ctrl.abort();
  };

  const saveLocalIdea = async (turnId: string, title: string) => {
    setLocalIdeas((cur) =>
      cur.map((p) => (p.id === turnId ? { ...p, saving: true } : p)),
    );
    try {
      const turn = localIdeas.find((p) => p.id === turnId);
      if (!turn) return;
      const r = await save.mutateAsync({
        projectSlug: project.slug,
        text: title.trim() || turn.suggestedTitle || turn.text.slice(0, 60),
        description: turn.body || turn.text,
      });
      setLocalIdeas((cur) =>
        cur.map((p) =>
          p.id === turnId
            ? { ...p, saving: false, savedIdeaId: r.idea.id }
            : p,
        ),
      );
      void qc.invalidateQueries({ queryKey: qk.savedIdeas(project.slug) });
      toast("idea saved");
    } catch (e) {
      setLocalIdeas((cur) =>
        cur.map((p) => (p.id === turnId ? { ...p, saving: false } : p)),
      );
      toast((e as Error).message, true);
    }
  };

  const submitValidateIdea = async () => {
    const text = brief.trim();
    if (!text) {
      toast("type your idea first", true);
      return;
    }
    const turnId = `idea-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ctrl = new AbortController();
    ideaAbortRefs.current.set(turnId, ctrl);
    setLocalIdeas((cur) => [
      ...cur,
      {
        id: turnId,
        text,
        body: "",
        events: [],
        finished: false,
        suggestedTitle: "",
        error: null,
        savedIdeaId: null,
        saving: false,
        discarded: false,
        ts: Date.now(),
      },
    ]);
    setBrief("");
    setSavingIdea(true);
    try {
      const r = await client.streamValidateIdea(
        project.id,
        { text },
        (event) => {
          setLocalIdeas((cur) =>
            cur.map((p) => {
              if (p.id !== turnId) return p;
              if (event.kind === "text") {
                return { ...p, body: p.body + event.delta };
              }
              if (event.kind === "tool_use" || event.kind === "tool_result") {
                return { ...p, events: [...p.events, event] };
              }
              return p;
            }),
          );
        },
        ctrl.signal,
      );
      if (r.ok === false) {
        setLocalIdeas((cur) =>
          cur.map((p) =>
            p.id === turnId
              ? { ...p, finished: true, error: r.error || "agent returned no response" }
              : p,
          ),
        );
      } else {
        setLocalIdeas((cur) =>
          cur.map((p) =>
            p.id === turnId
              ? {
                  ...p,
                  finished: true,
                  body: r.critique || p.body,
                  suggestedTitle: r.suggestedTitle,
                }
              : p,
          ),
        );
      }
    } catch (e) {
      const aborted = (e as { name?: string }).name === "AbortError";
      setLocalIdeas((cur) =>
        cur.map((p) =>
          p.id === turnId
            ? {
                ...p,
                finished: true,
                error: aborted ? "stopped" : (e as Error).message,
              }
            : p,
        ),
      );
    } finally {
      setSavingIdea(false);
      ideaAbortRefs.current.delete(turnId);
    }
  };

  /**
   * Shared brainstorm runner. Used by the composer's Send and the
   * per-session "More" button. When a `nudge` is passed (from the
   * "more like these" / "completely different" / "go wild"
   * dropdown) we send ONLY the nudge as the prompt — the original
   * brief is already represented by the prior options in the dedup
   * context block, so re-sending it just bloats the prompt and
   * shows duplicate text in the new suggestion's heading.
   */
  const runBrainstorm = async (
    briefText: string,
    opts: { clearComposer?: boolean; nudge?: string } = {},
  ) => {
    const finalBrief = opts.nudge ? opts.nudge : briefText;
    setStreaming(true);
    setLiveOptions([]);
    setLiveTools([]);
    // Show what the agent will actually see, not the original brief —
    // otherwise the live PromptHeading and the persisted suggestion
    // PromptHeading flip-flop on first render.
    setLiveBrief(finalBrief);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await client.streamIdeateForProject(
        project.slug,
        {
          prompt: finalBrief,
          ...(choice.agent ? { agent: choice.agent } : {}),
          ...(choice.model ? { model: choice.model } : {}),
        },
        (event) => {
          if (event.kind === "option") {
            setLiveOptions((opts) => [...opts, event.text]);
          } else {
            setLiveTools((prev) => [...prev, event]);
          }
        },
        ctrl.signal,
      );
      if (r.ok === false) {
        toast(r.error || "the helper returned no options", true);
      } else {
        if (opts.clearComposer) setBrief("");
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
      setLiveTools([]);
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

  const runValidate = async (
    sid: string,
    agent: "claude" | "codex",
    model: string,
  ) => {
    setValidatingId(sid);
    setValidateLabel(`${agent}${model ? ` · ${model}` : ""}`);
    setValidateTools([]);
    try {
      const r = await client.streamValidateSuggestion(
        sid,
        { agent, ...(model ? { model } : {}) },
        (event) => {
          if (event.kind === "tool_use" || event.kind === "tool_result") {
            setValidateTools((prev) => [
              ...prev,
              event as unknown as IdeationEvent,
            ]);
          }
        },
      );
      if (r.ok === false) {
        toast(r.error || "validation failed", true);
      } else {
        toast(`scored with ${agent}${model ? `:${model}` : ""}`);
        invalidateSuggestions();
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setValidatingId(null);
      setValidateLabel("");
      setValidateTools([]);
    }
  };

  const isEmpty = sessions.length === 0 && !streaming;

  const onResetChat = async () => {
    if (sessions.length === 0) {
      toast("nothing to clear");
      return;
    }
    if (
      !confirm(
        `Clear ${sessions.length} brainstorm session${sessions.length === 1 ? "" : "s"} for ${project.name}? Saved ideas survive.`,
      )
    )
      return;
    try {
      await clear.mutateAsync(project.slug);
      toast("conversation cleared");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const chatColumn = (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 relative">
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
          <div className="px-5 lg:px-7 py-6 space-y-7">
            {isEmpty && localIdeas.length === 0 ? (
              <EmptyChat
                projectName={project.name}
                onPickPreset={setBrief}
              />
            ) : (
              <>
                {sessions.map((s, i) => (
                  <ChatTurn
                    key={s.id}
                    index={i}
                    suggestion={s}
                    savedKeys={savedKeys}
                    onTogglePin={togglePinned}
                    onOpenIdea={openIdea}
                    onValidate={runValidate}
                    onMore={(nudge) =>
                      void runBrainstorm(s.prompt, { nudge })
                    }
                    validating={validatingId}
                    validateLabel={validateLabel}
                    validateTools={validateTools}
                    streaming={streaming}
                  />
                ))}
                {localIdeas.map((p) => (
                  <IdeaValidationTurn
                    key={p.id}
                    turn={p}
                    projectSlug={project.slug}
                    onCancel={() => cancelIdea(p.id)}
                    onSave={(title) => void saveLocalIdea(p.id, title)}
                    onDismiss={() => removeLocalIdea(p.id)}
                    onOpenIdea={openIdea}
                  />
                ))}
              </>
            )}
            {streaming && (
              <LiveTurn
                brief={liveBrief}
                options={liveOptions}
                tools={liveTools}
                onCancel={cancel}
              />
            )}
          </div>
        </div>
      </div>

      {/* Composer — terminal-style. The composer has two modes: the
          default `brainstorm` mode (Send fires the agent), and an
          opt-in `idea` mode (toggle below the input lights everything
          up amber and Send becomes "save to library"). The toggle
          frames the intent BEFORE the user types, so they always
          know which path they're on. */}
      <div className={cn(
        "border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] shrink-0 transition-colors",
        composerMode === "idea"
          ? "bg-amber-500/[0.06] dark:bg-amber-500/[0.04] border-t-amber-500/30"
          : "bg-paper-50 dark:bg-ink-900",
      )}>
        <div className="px-5 lg:px-6 py-2">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "shrink-0 mt-1.5 font-mono text-[14px] font-semibold leading-none transition-colors",
                streaming || savingIdea
                  ? "animate-blink"
                  : "",
                composerMode === "idea"
                  ? "text-amber-600 dark:text-amber-400"
                  : streaming
                    ? "text-ember-500"
                    : "text-sky-700 dark:text-sky-300",
              )}
            >
              {composerMode === "idea" ? "✦" : "›"}
            </span>
            <Textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void onSend();
                }
              }}
              placeholder={
                streaming
                  ? "agent is thinking…"
                  : savingIdea
                    ? "saving idea…"
                    : composerMode === "idea"
                      ? "tell me your idea — I'll save it to your library"
                      : `brainstorm something for ${project.name}`
              }
              rows={2}
              disabled={streaming}
              className={cn(
                "flex-1 resize-none border-none shadow-none bg-transparent focus-visible:ring-0 px-0 py-1 font-mono text-[12.5px] leading-snug",
                composerMode === "idea"
                  ? "placeholder:text-amber-700/50 dark:placeholder:text-amber-300/40 text-amber-900 dark:text-amber-100"
                  : "placeholder:text-ink-400/60 dark:placeholder:text-ink-500/60",
              )}
            />
            <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
              <span className="hidden sm:flex items-center gap-1 text-2xs text-ink-400 dark:text-ink-500">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
              </span>
              <Button
                size="sm"
                onClick={() => void onSend()}
                disabled={streaming || savingIdea || !brief.trim()}
                className={cn(
                  composerMode === "idea" &&
                    "bg-amber-500 hover:bg-amber-500/90 text-amber-50",
                )}
                title={
                  composerMode === "idea"
                    ? "save your idea to the library"
                    : "brainstorm with the agent"
                }
              >
                {streaming || savingIdea ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : composerMode === "idea" ? (
                  <Lightbulb className="h-3 w-3" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
          <div className="mt-1 ml-5 flex items-center gap-2 flex-wrap">
            {/* Mode toggle — click BEFORE typing to frame the intent.
                Default = brainstorm; flip to idea when you've already
                got an idea you just want to capture. */}
            <button
              type="button"
              onClick={() =>
                setComposerMode((m) => (m === "idea" ? "brainstorm" : "idea"))
              }
              disabled={streaming || savingIdea}
              title={
                composerMode === "idea"
                  ? "back to brainstorm mode"
                  : "switch to idea mode — I'll just save what you type"
              }
              className={cn(
                "inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] border transition-colors disabled:opacity-40",
                composerMode === "idea"
                  ? "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                  : "border-ink-900/10 dark:border-ink-50/10 text-ink-500 hover:text-amber-700 dark:hover:text-amber-300 hover:border-amber-500/40",
              )}
            >
              <Lightbulb className="h-2.5 w-2.5" />
              {composerMode === "idea" ? "idea mode · on" : "i have an idea"}
            </button>
            {composerMode !== "idea" && (
              <ToolbarPick
                label={`with · ${choiceLabel}`}
                options={buildModelOptions(claudeModels, codexModels)}
                onSelect={setBrainstormPick}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );

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
        <Kicker>brainstorm</Kicker>
        <span
          className="size-3 rounded-md shrink-0"
          style={{ background: project.color || "#DC2626" }}
        />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate max-w-[44ch]">
          {project.name}
        </span>
        <Count>{sessions.length}</Count>
        {streaming && <LiveBadge />}
        <Spacer />
        <GitStatePill slug={project.slug} />
        {/* Mobile: saved popover. Desktop: ideas live in the right panel. */}
        {!isWide && (
          <SavedPill
            ideas={savedOpen}
            onOpenIdea={openIdea}
            onUnsave={(id) => void unsave.mutateAsync(id)}
          />
        )}
        <Button
          variant="outline"
          size="xs"
          onClick={() => void onResetChat()}
          disabled={clear.isPending || sessions.length === 0}
          title="Clear the conversation. Saved ideas survive."
        >
          <Trash2 className="h-3 w-3" />
          Reset
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label={sidebarOpen ? "Hide ideas" : "Show ideas"}
          title={sidebarOpen ? "Hide ideas" : "Show ideas"}
        >
          {sidebarOpen ? (
            <PanelRightClose className="h-3.5 w-3.5" />
          ) : (
            <PanelRight className="h-3.5 w-3.5" />
          )}
        </Button>
      </PageTopbar>

      {/* Body — chat (left) + collapsible sidebar (right). Mobile drops the
          sidebar entirely; saved ideas surface via the topbar popover. */}
      <div className="flex-1 min-h-0">
        {sidebarOpen && isWide ? (
          <PanelGroup direction="horizontal" className="h-full">
            <Panel id="brainstorm-chat" defaultSize={68} minSize={48}>
              {chatColumn}
            </Panel>
            <PanelResizeHandle className="w-px bg-ink-900/10 hover:bg-ember-500/40 transition-colors dark:bg-ink-50/10" />
            <Panel id="brainstorm-sidebar" defaultSize={32} minSize={22}>
              <SavedSidebar
                ideas={savedOpen}
                allIdeas={allIdeas}
                search={sidebarSearch}
                onSearch={setSidebarSearch}
                statusFilter={sidebarFilter}
                onFilter={setSidebarFilter}
                onOpenIdea={openIdea}
                onUnsave={(id) => void unsave.mutateAsync(id)}
              />
            </Panel>
          </PanelGroup>
        ) : (
          chatColumn
        )}
      </div>
    </div>
  );
}

/* ── Chat turn (a brainstorm session rendered as user msg + agent cluster) ── */

function ChatTurn({
  suggestion,
  savedKeys,
  onTogglePin,
  onOpenIdea,
  onValidate,
  onMore,
  validating,
  validateLabel,
  validateTools,
  streaming,
  index,
}: {
  suggestion: Suggestion;
  savedKeys: Map<string, string>;
  onTogglePin: (sid: string, i: number, text: string) => void;
  onOpenIdea: (id: string) => void;
  onValidate: (sid: string, agent: "claude" | "codex", model: string) => void;
  onMore: (nudge: string) => void;
  validating: string | null;
  validateLabel: string;
  validateTools: IdeationEvent[];
  streaming: boolean;
  index: number;
}) {
  const isValidating = validating === suggestion.id;
  return (
    <article className="relative">
      {/* Hairline rule between turns — the only chrome between
          successive prompts. Quiet, editorial, never card-y. */}
      {index > 0 && (
        <div
          aria-hidden
          className="mb-6 h-px bg-ink-900/[0.06] dark:bg-ink-50/[0.06]"
        />
      )}
      <PromptHeading text={suggestion.prompt} ts={suggestion.createdAt} />
      <AgentCluster
        suggestion={suggestion}
        savedKeys={savedKeys}
        onTogglePin={onTogglePin}
        onOpenIdea={onOpenIdea}
        onValidate={onValidate}
        onMore={onMore}
        streaming={streaming}
        validating={isValidating}
        validateLabel={isValidating ? validateLabel : ""}
        validateTools={isValidating ? validateTools : []}
      />
    </article>
  );
}

/**
 * Minimal prompt framing — small "you" kicker + the prompt text on
 * one tight block. ChatGPT-style: keep the chat itself out of the
 * way, let the ideas have the breathing room.
 */
function PromptHeading({ text, ts }: { text: string; ts: number }) {
  return (
    <div className="mb-4 flex items-start gap-2.5">
      <span className="shrink-0 mt-0.5 font-mono text-[14px] font-semibold text-sky-700 dark:text-sky-300 leading-none select-none">
        ›
      </span>
      <p className="flex-1 font-mono text-[13px] leading-relaxed text-ink-800 dark:text-ink-100 whitespace-pre-wrap">
        {text}
      </p>
      <span className="shrink-0 mt-1 font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600">
        {formatTs(ts)}
      </span>
    </div>
  );
}

function splitIdea(raw: string): {
  title: string;
  critique?: string;
  score?: number;
} {
  // Lines now arrive as "[score: NN] <pitch> — <critique>". Pull the
  // score out, then split the rest on the em-dash separator. Falls
  // back gracefully if either piece is missing — a legacy suggestion
  // without scores still renders, just without the score badge.
  let body = raw.trim();
  let score: number | undefined;
  const sm = body.match(/^\[score:\s*(\d{1,3})\]\s*/i);
  if (sm) {
    const n = parseInt(sm[1]!, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) score = n;
    body = body.slice(sm[0]!.length);
  }
  const parts = body.split(/\s+—\s+|\s+-\s+/);
  if (parts.length >= 2) {
    return {
      title: parts[0]!.trim(),
      critique: parts.slice(1).join(" - ").trim(),
      ...(score !== undefined ? { score } : {}),
    };
  }
  return {
    title: body.trim(),
    ...(score !== undefined ? { score } : {}),
  };
}

/**
 * Activity history persisted on a finished suggestion — what files
 * the agent read, what it grepped for, what shell commands it ran
 * while drafting these ideas. Collapsed behind a small disclosure
 * so the option list stays the focus, but always available so the
 * operator can verify the agent grounded its thinking in the repo.
 */
function PersistedActivity({
  events,
}: {
  events: ReadonlyArray<{
    kind: string;
    name?: string;
    input?: unknown;
    ok?: boolean;
    preview?: string;
  }>;
}) {
  const pairs = pairToolEvents(events);
  if (pairs.length === 0) return null;
  return <WorkCard className="mb-3" pairs={pairs} />;
}

/**
 * Live activity panel for an in-flight validation run. Renders the
 * rater's tool calls (Read / Glob / Bash) inline so the operator
 * sees what the model is actually doing while it scores. Same
 * `<ToolLine>` rendering the workshop + brainstorm use, so the
 * dashboard reads the same way everywhere.
 */
function ValidatingFeed({
  label,
  tools,
}: {
  label: string;
  tools: IdeationEvent[];
}) {
  const pairs = pairToolEvents(tools);
  const elapsedMs = useElapsedMs(true);
  return (
    <div className="mb-2 -mx-1 px-2 py-1.5 rounded border border-ember-500/20 bg-ember-500/[0.04] dark:bg-ember-500/[0.06]">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-ember-500 opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember-500" />
        </span>
        <ShimmerText className="text-[11px] font-medium">
          <TransitioningText>
            {pairs.length === 0
              ? `${label} reading the repo`
              : `${label} scoring`}
          </TransitioningText>
        </ShimmerText>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-ember-700/70 dark:text-ember-300/70">
          {formatElapsed(elapsedMs)}
          {pairs.length > 0 && ` · ${pairs.length}`}
        </span>
      </div>
      {pairs.length > 0 && (
        <WorkCard
          pairs={pairs}
          liveTrailing
          className="border-ember-500/30 bg-ember-500/[0.04] dark:bg-ember-500/[0.06]"
        />
      )}
    </div>
  );
}

/**
 * "More" dropdown — re-runs the same brief in a fresh suggestion
 * with one of three nudges. Dedup against existing ideas / past
 * options / recent tasks happens server-side via the prompt context.
 */
function MorePicker({
  onMore,
  disabled,
}: {
  onMore: (nudge: string) => void;
  disabled: boolean;
}) {
  const choices: { label: string; icon: React.ReactNode; nudge: string }[] = [
    {
      label: "more like these",
      icon: <Repeat className="h-3 w-3" />,
      nudge:
        "Generate fresh ideas in the same direction as the brief above. Don't restate ideas the dedup list already covers — find adjacent angles, sharper variants, or things in the same neighborhood that haven't been raised yet.",
    },
    {
      label: "completely different",
      icon: <Shuffle className="h-3 w-3" />,
      nudge:
        "IMPORTANT: pivot. The previous round already covered the obvious directions for this brief. Now propose ideas from a DIFFERENT angle entirely — orthogonal directions, contrarian takes, things that re-frame the brief instead of answering it directly. Avoid anything that overlaps with the dedup list.",
    },
    {
      label: "go wild",
      icon: <Flame className="h-3 w-3" />,
      nudge:
        "Forget the safe roadmap. Propose ideas that would make this project weird, opinionated, or memorable — directions a careful PM would never green-light. Lean into the strange ones. Don't sandbag with safety. The operator wants to see the edges of the design space, not the median path.",
    },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="Generate more ideas off this brief"
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700 disabled:opacity-50 disabled:cursor-wait"
        >
          <Plus className="h-3 w-3" />
          more
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        {choices.map((c) => (
          <DropdownMenuItem
            key={c.label}
            onClick={() => onMore(c.nudge)}
            className="gap-2"
          >
            {c.icon}
            <span className="font-mono text-[11.5px]">{c.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Validate with…" dropdown — picks an agent + model to re-score
 * the suggestion's options. Disables agent/model pairs that already
 * validated this suggestion to avoid pointless re-runs.
 */
function ValidatePicker({
  suggestion,
  onValidate,
  validating,
}: {
  suggestion: Suggestion;
  onValidate: (sid: string, agent: "claude" | "codex", model: string) => void;
  validating: boolean;
}) {
  const modelsQ = useModels();
  const models = modelsQ.data?.models;
  const used = new Set(
    (suggestion.validations ?? []).map((v) => `${v.agent}:${v.model}`),
  );
  type Choice = { agent: "claude" | "codex"; model: string; label: string };
  const choices: Choice[] = [];
  for (const a of ["claude", "codex"] as const) {
    for (const m of models?.[a] ?? []) {
      choices.push({ agent: a, model: m.id, label: `${a} · ${m.label}` });
    }
  }
  if (choices.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={validating}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700 disabled:opacity-50 disabled:cursor-wait"
        >
          {validating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          validate
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {choices.map((c) => {
          const key = `${c.agent}:${c.model}`;
          const already = used.has(key);
          return (
            <DropdownMenuItem
              key={key}
              onClick={() => onValidate(suggestion.id, c.agent, c.model)}
            >
              <span className="font-mono text-[11.5px] flex-1">
                {c.label}
              </span>
              {already && (
                <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Per-idea score badge. Color shifts emerald (90+, ship-now) →
 * amber (70-89, strong) → ink (<70, worth considering). Operators
 * skim the whole list by these colors before reading the words.
 */
function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 90
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20"
      : score >= 70
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/20"
        : score >= 50
          ? "bg-ink-900/[0.06] text-ink-600 dark:bg-ink-50/[0.08] dark:text-ink-300 ring-ink-900/[0.05] dark:ring-ink-50/[0.05]"
          : "bg-ink-900/[0.04] text-ink-400 dark:bg-ink-50/[0.04] dark:text-ink-500 ring-ink-900/[0.04] dark:ring-ink-50/[0.04]";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center h-5 px-1.5 rounded font-mono text-[10px] tabular-nums font-semibold ring-1 ring-inset",
        tone,
      )}
      title={`${score}/100 — value vs. effort estimate from the agent`}
    >
      {score}
    </span>
  );
}

/**
 * Detect a clarifying-question turn — prompt template tells the agent
 * to emit a single line starting with `?? ` when the brief is too
 * vague to commit to. We pull the bare question out so it can render
 * as a question card instead of as a numbered "idea".
 */
function clarifyingQuestion(opts: string[]): string | null {
  if (opts.length === 0) return null;
  const first = opts[0]!.trim();
  if (!first.startsWith("?? ")) return null;
  // If the agent slipped extra option lines after the `?? ` line we
  // ignore them — the protocol is a single question, no list.
  return first.slice(3).trim();
}

/**
 * Compact idea list — small numeric prefix, title at 13.5, critique
 * muted italic below. Saved items get a quiet amber tint. Hover
 * surfaces the bookmark + refine actions on the right edge.
 */
function AgentCluster({
  suggestion,
  savedKeys,
  onTogglePin,
  onOpenIdea,
  onValidate,
  onMore,
  streaming,
  validating,
  validateLabel,
  validateTools,
}: {
  suggestion: Suggestion;
  savedKeys: Map<string, string>;
  onTogglePin: (sid: string, i: number, text: string) => void;
  onOpenIdea: (id: string) => void;
  onValidate: (sid: string, agent: "claude" | "codex", model: string) => void;
  onMore: (nudge: string) => void;
  streaming: boolean;
  validating: boolean;
  validateLabel: string;
  validateTools: IdeationEvent[];
}) {
  // Clarifying-question turn — agent decided the brief was too vague
  // and asked back instead of generating speculative options. Render
  // as a quiet question card; the operator answers in the composer.
  const question = clarifyingQuestion(suggestion.options);
  if (question) return <QuestionTurn question={question} />;
  // Decorate options with parsed score + each rater's score so we
  // can sort by the average across all available raters (original
  // generation + every validation pass).
  const validationsForCluster = suggestion.validations ?? [];
  const decorated = suggestion.options.map((opt, i) => {
    const parsed = splitIdea(opt);
    const raterScores: number[] = [];
    if (parsed.score !== undefined) raterScores.push(parsed.score);
    for (const v of validationsForCluster) {
      const s = v.scores[i];
      if (typeof s === "number") raterScores.push(s);
    }
    const avg =
      raterScores.length > 0
        ? Math.round(
            raterScores.reduce((a, b) => a + b, 0) / raterScores.length,
          )
        : null;
    return { raw: opt, index: i, parsed, avg };
  });
  const hasScores = decorated.some((d) => d.avg !== null);
  const sorted = hasScores
    ? [...decorated].sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
    : decorated;
  const savedHere = suggestion.options.filter((_, i) =>
    savedKeys.has(`${suggestion.id}:${i}`),
  ).length;
  const topScore = hasScores
    ? Math.max(...decorated.map((d) => d.parsed.score ?? 0))
    : null;
  // Pass the full events array (use + result interleaved) so
  // PersistedActivity can pair them and show output previews.
  const events = (suggestion.events ?? []) as ReadonlyArray<{
    kind: string;
    name?: string;
    input?: unknown;
    ok?: boolean;
    preview?: string;
  }>;
  const validations = suggestion.validations ?? [];
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="shrink-0 font-mono text-[14px] font-semibold text-ember-700 dark:text-ember-300 leading-none select-none">
          λ
        </span>
        <span className="font-mono text-[10.5px] tabular-nums text-ink-500 dark:text-ink-400">
          {suggestion.options.length} ideas
          {topScore !== null && (
            <span className="text-ink-400 dark:text-ink-500">
              {" "}· top {topScore}
            </span>
          )}
          {validations.length > 0 && (
            <span className="text-ink-400 dark:text-ink-500">
              {" "}· {1 + validations.length} raters
            </span>
          )}
        </span>
        {savedHere > 0 && (
          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
            <BookmarkCheck className="h-2.5 w-2.5 fill-current" />
            {savedHere}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1">
          <MorePicker onMore={onMore} disabled={streaming || validating} />
          <ValidatePicker
            suggestion={suggestion}
            onValidate={onValidate}
            validating={validating}
          />
        </span>
      </div>
      {events.length > 0 && <PersistedActivity events={events} />}
      {validating && (
        <ValidatingFeed label={validateLabel} tools={validateTools} />
      )}
      <ol className="space-y-1.5">
        {sorted.map(({ raw: opt, index: i, parsed }) => {
          const savedId = savedKeys.get(`${suggestion.id}:${i}`);
          const saved = !!savedId;
          const { title, critique, score } = parsed;
          const validationScores = validationsForCluster
            .map((v) => ({
              agent: v.agent,
              model: v.model,
              score: v.scores[i],
            }))
            .filter(
              (s): s is { agent: typeof s.agent; model: string; score: number } =>
                typeof s.score === "number",
            );
          return (
            <li
              key={i}
              className={cn(
                "group relative -mx-2 px-2 py-2 rounded-md transition-colors",
                saved
                  ? "bg-amber-500/[0.05] dark:bg-amber-500/[0.07]"
                  : "hover:bg-ink-900/[0.025] dark:hover:bg-ink-50/[0.03]",
              )}
            >
              <div className="flex items-start gap-2.5 pr-16">
                {score !== undefined || validationScores.length > 0 ? (
                  <span className="shrink-0 mt-0.5 flex flex-col items-start gap-1">
                    {score !== undefined && <ScoreBadge score={score} />}
                    {validationScores.map((v, vi) => (
                      <span
                        key={vi}
                        title={`${v.agent}${v.model ? ` · ${v.model}` : ""}`}
                      >
                        <ScoreBadge score={v.score} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "grid place-items-center shrink-0 mt-0.5 size-5 rounded-md font-mono text-[10px] tabular-nums font-semibold",
                      saved
                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                        : "bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.06] dark:text-ink-400 group-hover:bg-ember-500/15 group-hover:text-ember-700 dark:group-hover:text-ember-300 transition-colors",
                    )}
                  >
                    {i + 1}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] leading-relaxed text-ink-900 dark:text-ink-50">
                    {title}
                  </p>
                  {critique && (
                    <p className="mt-1 text-[12px] text-ink-500 dark:text-ink-400 leading-snug">
                      {critique}
                    </p>
                  )}
                </div>
              </div>
              <div className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {saved && savedId && (
                  <button
                    type="button"
                    onClick={() => onOpenIdea(savedId)}
                    title="Refine in workshop"
                    className="grid place-items-center h-7 w-7 rounded text-ember-700 hover:bg-ember-500/15 dark:text-ember-300 transition-colors"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onTogglePin(suggestion.id, i, opt)}
                  title={saved ? "Unsave" : "Save"}
                  className={cn(
                    "grid place-items-center h-7 w-7 rounded transition-colors",
                    saved
                      ? "text-amber-600 dark:text-amber-300 hover:bg-amber-500/15 opacity-100"
                      : "text-ink-400 dark:text-ink-500 hover:bg-paper-100 hover:text-amber-600 dark:hover:bg-ink-700 dark:hover:text-amber-300",
                  )}
                >
                  {saved ? (
                    <BookmarkCheck className="h-3.5 w-3.5 fill-current" />
                  ) : (
                    <Bookmark className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The agent decided the brief was too thin to commit to — render its
 * follow-up question prominently so the operator's eye reads "agent
 * needs more from me", not "agent gave me bad ideas". A small hint
 * underneath nudges them back to the composer to refine the brief.
 */
function QuestionTurn({ question }: { question: string }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <HelpCircle className="h-3 w-3 text-amber-600 dark:text-amber-300" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
          agent needs more
        </span>
      </div>
      <div className="rounded-lg border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.06] to-transparent px-4 py-3 dark:from-amber-500/[0.10]">
        <p className="text-[13.5px] leading-relaxed text-ink-900 dark:text-ink-50 whitespace-pre-wrap">
          {question}
        </p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
          add detail in the composer below and re-send
        </p>
      </div>
    </section>
  );
}

/* ── Saved sidebar (right pane) ─────────────────────────────────── */

function SavedSidebar({
  ideas,
  allIdeas,
  search,
  onSearch,
  statusFilter,
  onFilter,
  onOpenIdea,
  onUnsave,
}: {
  ideas: Idea[];
  allIdeas: Idea[];
  search: string;
  onSearch: (v: string) => void;
  statusFilter: "all" | IdeaStatus;
  onFilter: (s: "all" | IdeaStatus) => void;
  onOpenIdea: (id: string) => void;
  onUnsave: (id: string) => void;
}) {
  // Apply browse filter + search across the full library so the operator
  // can browse spawned/archived too via the dropdown.
  const pool =
    statusFilter === "all"
      ? ideas
      : allIdeas.filter((i) => i.status === statusFilter);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? pool.filter(
        (i) =>
          i.text.toLowerCase().includes(q) ||
          (i.description ?? "").toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q)),
      )
    : pool;

  const filterOpts: { key: "all" | IdeaStatus; label: string }[] = [
    { key: "all", label: "Open" },
    { key: "draft", label: "Drafts" },
    { key: "refining", label: "Refining" },
    { key: "validated", label: "Validated" },
    { key: "spawned", label: "Spawned" },
    { key: "archived", label: "Archived" },
  ];

  return (
    <aside className="flex flex-col h-full min-h-0 bg-paper-50/60 dark:bg-ink-900/40">
      <header className="px-4 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] shrink-0 space-y-2">
        <div className="flex items-baseline gap-2">
          <BookmarkCheck className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" />
          <span className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">
            Ideas
          </span>
          <span className="font-mono text-[10px] tabular-nums text-amber-700 dark:text-amber-300">
            {ideas.length} saved
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
              >
                <Filter className="h-2.5 w-2.5" />
                {filterOpts.find((f) => f.key === statusFilter)!.label}
                <ChevronDown className="h-2.5 w-2.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {filterOpts.map((f) => (
                <DropdownMenuItem
                  key={f.key}
                  onClick={() => onFilter(f.key)}
                >
                  <span className="font-mono text-[12px]">{f.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-400" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search ideas, descriptions, tags…"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Lightbulb className="h-4 w-4 mx-auto mb-1.5 text-ink-400 dark:text-ink-500" />
            <p className="text-[11.5px] text-ink-500 dark:text-ink-400 leading-snug">
              {q
                ? "no matches"
                : statusFilter === "all"
                  ? "save ideas from the chat — they land here"
                  : "no ideas in this status yet"}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-ink-900/[0.04] dark:divide-ink-50/[0.04]">
            {filtered.map((idea) => (
              <SidebarRow
                key={idea.id}
                idea={idea}
                onOpen={onOpenIdea}
                onUnsave={onUnsave}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function SidebarRow({
  idea,
  onOpen,
  onUnsave,
}: {
  idea: Idea;
  onOpen: (id: string) => void;
  onUnsave: (id: string) => void;
}) {
  const { title, critique } = splitIdea(idea.text);
  return (
    <li className="group">
      <div className="flex items-start gap-2 px-3 py-2 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors">
        <button
          type="button"
          onClick={() => onOpen(idea.id)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-baseline gap-2">
            <StatusDotSm status={idea.status} />
            <span
              className={cn(
                "text-[12.5px] line-clamp-2 leading-snug",
                idea.status === "archived"
                  ? "text-ink-400 dark:text-ink-500 line-through"
                  : "text-ink-900 dark:text-ink-50",
              )}
            >
              {title}
            </span>
          </div>
          {critique && (
            <p className="mt-0.5 ml-3.5 text-[11px] text-ink-500 dark:text-ink-400 leading-snug line-clamp-2">
              {critique}
            </p>
          )}
          <div className="mt-1 ml-3.5 flex items-center gap-2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
            <StatusBadgeSm status={idea.status} />
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
              <span className="text-violet-700 dark:text-violet-300">
                task
              </span>
            )}
            <span className="ml-auto tabular-nums">
              {formatTs(idea.lastMessageAt ?? idea.updatedAt)}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onUnsave(idea.id)}
          title="Remove from saved"
          className="opacity-0 group-hover:opacity-100 grid place-items-center h-6 w-6 rounded text-ink-400 hover:text-red-700 dark:hover:text-red-300 transition-opacity"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
}

function StatusBadgeSm({ status }: { status: IdeaStatus }) {
  const tone: Record<IdeaStatus, string> = {
    draft: "text-ink-500 dark:text-ink-400",
    refining: "text-ember-700 dark:text-ember-300",
    validated: "text-emerald-700 dark:text-emerald-300",
    spawned: "text-violet-700 dark:text-violet-300",
    archived: "text-ink-400 dark:text-ink-500",
  };
  return (
    <span className={cn("uppercase tracking-[0.1em]", tone[status])}>
      {status}
    </span>
  );
}

/* ── Idea validation turn ────────────────────────────────────────── */

/**
 * Renders an "I have an idea" agentic turn. While streaming: shows
 * the operator's idea text + live tool activity (Read/Glob/Grep/Bash
 * cards as the agent reads the repo) + the streaming critique body.
 * When finished: action row appears with [Save with suggested title]
 * + [Discard]. After save: card flips to "saved" state with a
 * workshop link so the user can keep refining the idea there.
 */
function IdeaValidationTurn({
  turn,
  projectSlug,
  onCancel,
  onSave,
  onDismiss,
  onOpenIdea,
}: {
  turn: {
    id: string;
    text: string;
    body: string;
    events: IdeaChatEvent[];
    finished: boolean;
    suggestedTitle: string;
    error: string | null;
    savedIdeaId: string | null;
    saving: boolean;
    discarded: boolean;
    ts: number;
  };
  projectSlug: string;
  onCancel: () => void;
  onSave: (title: string) => void;
  onDismiss: () => void;
  onOpenIdea: (id: string) => void;
}) {
  const unsave = useDeleteSavedIdea();
  const { toast } = useApp();
  const streaming = !turn.finished;
  const tools = pairToolEvents(turn.events);

  const [titleDraft, setTitleDraft] = useState("");
  // Sync the title draft to the suggested title once it lands. The
  // user can still edit it before saving.
  useEffect(() => {
    if (turn.suggestedTitle && !titleDraft) {
      setTitleDraft(turn.suggestedTitle);
    }
  }, [turn.suggestedTitle, titleDraft]);

  const removeSaved = async () => {
    if (!turn.savedIdeaId) {
      onDismiss();
      return;
    }
    try {
      await unsave.mutateAsync(turn.savedIdeaId);
      onDismiss();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] dark:bg-amber-500/[0.06] px-4 py-3 animate-fade-in">
      {/* Header */}
      <div className="flex items-baseline gap-2 mb-2">
        <Lightbulb
          className={cn(
            "h-3 w-3 self-center text-amber-500",
            streaming && "animate-blink",
          )}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
          your idea
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {formatTs(turn.ts)}
        </span>
        {streaming ? (
          <span className="font-mono text-[10px] text-amber-700/80 dark:text-amber-300/80 inline-flex items-center gap-1">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            agent is reading the repo…
          </span>
        ) : turn.savedIdeaId ? (
          <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
            <CheckCircle2 className="h-2.5 w-2.5" />
            saved
          </span>
        ) : turn.error ? (
          <span className="font-mono text-[10px] text-red-700 dark:text-red-400">
            {turn.error}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-amber-700/80 dark:text-amber-300/80">
            ready
          </span>
        )}
        {streaming && (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-red-700 dark:hover:text-red-400"
            title="stop the agent"
          >
            stop
          </button>
        )}
      </div>

      {/* Operator's typed idea — quoted so it reads like a chat turn. */}
      <div className="mb-3 pl-2 border-l-2 border-amber-500/40">
        <p className="font-mono text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed whitespace-pre-wrap">
          {turn.text}
        </p>
      </div>

      {/* Tool activity (live or replayed). */}
      {tools.length > 0 && (
        <WorkCard pairs={tools} liveTrailing={streaming} className="mb-3" />
      )}

      {/* Agent body — streaming markdown. */}
      {turn.body ? (
        <div className="rounded-md border border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-800/40 px-3 py-2 mb-3">
          <Markdown text={turn.body} />
          {streaming && (
            <span className="inline-block w-1.5 h-3 bg-amber-500/70 animate-pulse ml-0.5 align-baseline" />
          )}
        </div>
      ) : streaming ? (
        <div className="font-mono text-[11px] text-amber-700/70 dark:text-amber-300/70 italic mb-3">
          thinking…
        </div>
      ) : null}

      {/* Action row — only after the agent finishes. */}
      {!streaming && !turn.error && (
        <div className="space-y-2">
          {!turn.savedIdeaId && (
            <div className="flex items-center gap-2">
              <Lightbulb className="h-3 w-3 text-amber-500 shrink-0" />
              <Input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder={turn.suggestedTitle || "title for this idea"}
                disabled={turn.saving}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSave(titleDraft);
                  }
                }}
                className="h-7 text-[12px] font-mono"
              />
              <button
                type="button"
                onClick={() => onSave(titleDraft)}
                disabled={turn.saving}
                className="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded text-[11px] font-medium border border-amber-500/40 bg-amber-500 text-amber-50 hover:bg-amber-500/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {turn.saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <BookmarkCheck className="h-3 w-3" />
                )}
                Save to library
              </button>
              <button
                type="button"
                onClick={onDismiss}
                disabled={turn.saving}
                className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-red-700 dark:hover:text-red-400 disabled:opacity-40"
                title="discard this turn"
              >
                <X className="h-2.5 w-2.5" />
                discard
              </button>
            </div>
          )}
          {turn.savedIdeaId && (
            <div className="flex items-center gap-2">
              <Link
                to={`/projects/${encodeURIComponent(projectSlug)}/ideas/${turn.savedIdeaId}`}
                className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15 transition-colors"
                onClick={() => turn.savedIdeaId && onOpenIdea(turn.savedIdeaId)}
              >
                <ArrowUpRight className="h-2.5 w-2.5" />
                open in workshop
              </Link>
              <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                plan, challenge, refine — all in the workshop
              </span>
              <button
                type="button"
                onClick={() => void removeSaved()}
                disabled={unsave.isPending}
                className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-red-700 dark:hover:text-red-400 disabled:opacity-40"
              >
                {unsave.isPending ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Trash2 className="h-2.5 w-2.5" />
                )}
                remove
              </button>
            </div>
          )}
        </div>
      )}
      {!streaming && turn.error && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-red-700 dark:hover:text-red-400"
          >
            <X className="h-2.5 w-2.5" />
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Live turn (during streaming) ────────────────────────────────── */

function LiveTurn({
  brief,
  options,
  tools,
  onCancel,
}: {
  brief: string;
  options: string[];
  tools: IdeationEvent[];
  onCancel: () => void;
}) {
  // Phase auto-shifts based on what the agent's actually doing —
  // "scouting" while it's still inspecting the repo, "brainstorming"
  // once the first option lands.
  const phase: ThinkingPhase =
    options.length === 0 ? "scouting" : "brainstorming";
  const label = useRotatingLabel(phase);
  const elapsedMs = useElapsedMs(true);
  // Clarifying-question turn: agent decided the brief was too vague.
  // Skip the option layout and just render the question card.
  const question = clarifyingQuestion(options);
  if (question) {
    return (
      <article className="relative">
        <PromptHeading text={brief} ts={Date.now()} />
        <QuestionTurn question={question} />
      </article>
    );
  }
  const pairs = pairToolEvents(tools);
  return (
    <article className="relative">
      <PromptHeading text={brief} ts={Date.now()} />
      <section>
        <div className="flex items-center gap-2 mb-3">
          <span className="grid place-items-center size-5 rounded-md bg-ember-500/15 text-ember-700 dark:text-ember-300">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-ember-500 opacity-60 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember-500" />
            </span>
          </span>
          <ShimmerText className="text-[12.5px] font-medium">
            <TransitioningText>{label}</TransitioningText>
          </ShimmerText>
          <span className="font-mono text-[10px] tabular-nums text-ember-700/80 dark:text-ember-300/80">
            {formatElapsed(elapsedMs)}
          </span>
          {(options.length > 0 || pairs.length > 0) && (
            <>
              <span className="text-ink-300 dark:text-ink-600 font-mono text-[10px]">
                ·
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ember-700/80 dark:text-ember-300/80">
                {options.length > 0
                  ? `${options.length} ${options.length === 1 ? "idea" : "ideas"}`
                  : `${pairs.length} ${pairs.length === 1 ? "step" : "steps"}`}
              </span>
            </>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400 hover:text-ink-900 dark:hover:text-ink-50 transition-colors"
          >
            stop
          </button>
        </div>
        {/* Live tool activity grouped into one card so the timeline
            doesn't fragment when the agent fires a long sequence. */}
        {pairs.length > 0 && (
          <WorkCard
            pairs={pairs}
            liveTrailing={options.length === 0}
            className="mb-4"
          />
        )}
        {options.length === 0 && pairs.length === 0 && (
          <p className="text-[12px] italic text-ink-500 dark:text-ink-400">
            first option usually lands within ~10 seconds…
          </p>
        )}
        {options.length > 0 && (
          <ol className="space-y-1">
            {options.map((opt, i) => {
              const { title, critique, score } = splitIdea(opt);
              return (
                <li
                  key={`${i}-${opt.slice(0, 24)}`}
                  className="-mx-2 px-2 py-2 rounded-md animate-idea-pop"
                >
                  <div className="flex items-start gap-2.5">
                    {score !== undefined ? (
                      <span className="shrink-0 mt-0.5">
                        <ScoreBadge score={score} />
                      </span>
                    ) : (
                      <span className="grid place-items-center shrink-0 mt-0.5 size-5 rounded-md font-mono text-[10px] tabular-nums font-semibold bg-ember-500/15 text-ember-700 dark:text-ember-300">
                        {i + 1}
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] leading-relaxed text-ink-900 dark:text-ink-50">
                        {title}
                      </p>
                      {critique && (
                        <p className="mt-1 text-[12px] text-ink-500 dark:text-ink-400 leading-snug">
                          {critique}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </article>
  );
}

/**
 * Topbar pill that surfaces the project's git state vs `origin`. Three
 * states:
 *   - up to date: tiny "synced" with a check, very low contrast.
 *   - N commits behind: amber pill with "N behind · pull" — clicking
 *     fast-forwards origin into the working tree.
 *   - pull error (local commits, conflicts, no upstream): red toast.
 *
 * Auto-refreshes every minute against the remote so a colleague's
 * push lands here without the operator hunting for the state.
 */
function GitStatePill({ slug }: { slug: string }) {
  const stateQ = useProjectGitState(slug);
  const pull = usePullProject();
  const { toast } = useApp();
  const s = stateQ.data;
  if (!s || !s.hasUpstream) return null;
  const onPull = async () => {
    try {
      const r = await pull.mutateAsync(slug);
      if (r.ok) toast(r.message ? r.message : "fast-forwarded");
      else toast(r.error || "pull failed", true);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (s.behind === 0) {
    // Quietly confirm we're synced — same place the warning would
    // sit, so the operator's eye learns the spot.
    return (
      <span
        className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500"
        title={`${s.branch} · up to date with origin`}
      >
        <Check className="h-3 w-3" />
        synced
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void onPull()}
      disabled={pull.isPending}
      title={`${s.behind} commit${s.behind === 1 ? "" : "s"} behind origin/${s.branch} — click to fast-forward${s.ahead > 0 ? ` (${s.ahead} local commit${s.ahead === 1 ? "" : "s"} stay)` : ""}`}
      className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em] bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors disabled:opacity-60 disabled:cursor-wait"
    >
      {pull.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <ArrowDownToLine className="h-3 w-3" />
      )}
      {s.behind} behind · pull
    </button>
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

/* ── Empty state ────────────────────────────────────────────────── */

function EmptyChat({
  projectName,
  onPickPreset,
}: {
  projectName: string;
  onPickPreset: (brief: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16">
      <span className="font-mono text-[24px] text-ink-300 dark:text-ink-600">
        ✦
      </span>
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        Brainstorm in {projectName}
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        Ask the agent for ideas. It reads the repo, proposes options with
        a one-line critique each. Save the good ones — they live in the
        right rail.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 max-w-md">
        {PROMPT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onPickPreset(p.brief)}
            className="inline-flex items-center h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ink-900/10 bg-paper-50 text-ink-600 hover:bg-paper-100 hover:border-ink-900/20 transition-colors dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Saved pile (popover from topbar) ───────────────────────────── */

function SavedPill({
  ideas,
  onOpenIdea,
  onUnsave,
}: {
  ideas: Idea[];
  onOpenIdea: (id: string) => void;
  onUnsave: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (ideas.length === 0) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500 hidden sm:inline">
        save ideas with the bookmark
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors font-mono text-[11px] uppercase tracking-[0.08em]"
        >
          <BookmarkCheck className="h-3.5 w-3.5 fill-current" />
          {ideas.length} saved
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] p-0 max-h-[60vh] overflow-y-auto"
      >
        <div className="px-3 py-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] flex items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
            Saved
          </span>
          <span className="font-mono text-[10px] tabular-nums text-amber-700 dark:text-amber-300">
            {ideas.length}
          </span>
          <span className="ml-auto font-mono text-[10px] text-ink-400 dark:text-ink-500">
            click to refine
          </span>
        </div>
        <ul className="divide-y divide-ink-900/[0.04] dark:divide-ink-50/[0.04]">
          {ideas.map((idea) => (
            <li key={idea.id}>
              <div className="group flex items-start gap-2 px-3 py-2 hover:bg-paper-100 dark:hover:bg-ink-700">
                <button
                  type="button"
                  onClick={() => {
                    onOpenIdea(idea.id);
                    setOpen(false);
                  }}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-baseline gap-2">
                    <StatusDotSm status={idea.status} />
                    <span
                      className={cn(
                        "text-[12.5px] truncate",
                        idea.status === "archived"
                          ? "text-ink-400 dark:text-ink-500 line-through"
                          : "text-ink-700 dark:text-ink-100",
                      )}
                    >
                      {idea.text}
                    </span>
                  </div>
                  <div className="mt-0.5 ml-3.5 flex items-center gap-2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
                    {(idea.messageCount ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <MessageSquare className="h-2.5 w-2.5" />
                        {idea.messageCount}
                      </span>
                    )}
                    {idea.planDraft && (
                      <span className="text-amber-700 dark:text-amber-300">
                        plan ready
                      </span>
                    )}
                    <span className="ml-auto tabular-nums">
                      {formatTs(idea.lastMessageAt ?? idea.updatedAt)}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onUnsave(idea.id)}
                  title="Unsave"
                  className="opacity-0 group-hover:opacity-100 grid place-items-center h-6 w-6 rounded text-ink-400 hover:text-red-700 dark:hover:text-red-300 transition-opacity"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
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
  const sugQ = useProjectSuggestions(projectId);

  const all = ideasQ.data?.ideas ?? [];
  const open = all.filter(
    (i) => i.status !== "spawned" && i.status !== "archived",
  );
  const sessions = (sugQ.data?.suggestions ?? []).filter(
    (s) => s.options.length > 0,
  );

  const navTo = () =>
    navigate(`/projects/${encodeURIComponent(projectSlug)}/brainstorm`);

  return (
    <button
      type="button"
      onClick={navTo}
      className="group relative w-full text-left rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 px-4 py-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors"
    >
      <div className="flex items-center gap-3">
        <span className="grid place-items-center h-7 w-7 rounded-md bg-ember-500/15 text-ember-600 dark:text-ember-300 shrink-0">
          <Lightbulb className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">
              Brainstorm
            </span>
            <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
              chat with the agent in {projectName}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums text-ink-500 dark:text-ink-400">
            {sessions.length} session{sessions.length === 1 ? "" : "s"} ·{" "}
            <span className="text-amber-700 dark:text-amber-300">
              {open.length} saved
            </span>
          </div>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400 dark:text-ink-500 group-hover:text-ember-700 dark:group-hover:text-ember-300 transition-colors">
          Open
          <ArrowUpRight className="h-3 w-3" />
        </span>
      </div>
    </button>
  );
}

/* ── Bits ────────────────────────────────────────────────────────── */

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

function ToolbarPick({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-7 px-2 rounded-full font-mono text-[11px] text-ink-700 hover:bg-paper-100 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors"
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

void Wand2;
void X;
