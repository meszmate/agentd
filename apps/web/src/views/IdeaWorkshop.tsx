import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { IdeaChatEvent } from "@agentd/client";
import {
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  Loader2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Send,
  Shuffle,
  Sparkles,
  Trash2,
  User2,
  X,
  Zap,
} from "lucide-react";
import type { AgentKind, IdeaMessage, IdeaStatus, ThinkingLevel } from "@agentd/contracts";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/markdown";
import { WorkCard, pairToolEvents } from "@/components/tool-line";
import {
  ShimmerText,
  TransitioningText,
  useRotatingLabel,
  formatElapsed,
  type ThinkingPhase,
} from "@/components/thinking";
import { useApp, useClient } from "@/AppContext";
import {
  qk,
  useDeleteSavedIdea,
  useIdea,
  useModels,
  useProject,
  useResolveSuggestion,
  useUpdateIdea,
} from "@/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatTs } from "@/lib/utils";

/**
 * `/projects/:slug/ideas/:id` — single-page workshop for one idea.
 *
 * Layout mirrors TaskDetail: PageTopbar + sub-strip, then a body that
 * shows the live plan above a TaskTimeline-style conversation thread.
 * The agent reads the project repo, refines the idea, drafts plans, and
 * eventually a real task is spawned with the operator's choice of agent
 * + model.
 */
export function IdeaWorkshop() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();
  const projectQ = useProject(slug);
  const ideaQ = useIdea(id ?? null);
  const update = useUpdateIdea();
  const remove = useDeleteSavedIdea();
  const resolve = useResolveSuggestion();
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();

  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingMode, setStreamingMode] = useState<
    "chat" | "challenge" | "plan" | null
  >(null);
  const [streamingReply, setStreamingReply] = useState("");
  const [streamingTools, setStreamingTools] = useState<IdeaChatEvent[]>([]);
  /**
   * The plan content the agent is writing right now — populated by
   * `plan_delta` events. While non-empty (or while plan mode is
   * running), this is what the right panel shows instead of the
   * persisted `idea.planDraft`. Cleared when the turn ends + the
   * idea query refetches with the new plan baked in.
   */
  const [streamingPlan, setStreamingPlan] = useState("");
  /**
   * Wall-clock the agent's turn began. Used to render an elapsed
   * counter next to the shimmer label so the operator can tell at a
   * glance how long the agent's been working.
   */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  /**
   * Tick the elapsed-time display once per second while a turn is in
   * flight — without this, the counter is stuck on whatever it was at
   * the last token / tool event.
   */
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [streaming]);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [editingPlan, setEditingPlan] = useState(false);
  const [planDraftEditor, setPlanDraftEditor] = useState("");
  const [planPanelOpen, setPlanPanelOpen] = useState(true);
  const [spawnOpen, setSpawnOpen] = useState(false);
  // Mobile collapses the plan into a stacked panel. The split layout
  // only kicks in at >= lg (1024px) so the chat doesn't get cramped.
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
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const planScrollRef = useRef<HTMLDivElement>(null);

  const idea = ideaQ.data?.idea ?? null;
  const messages = ideaQ.data?.messages ?? [];
  const project = projectQ.data?.project ?? null;

  useEffect(() => {
    if (idea) {
      setTitleDraft(idea.text);
      setDescriptionDraft(idea.description ?? "");
      setPlanDraftEditor(idea.planDraft ?? "");
    }
  }, [idea?.id, idea?.text, idea?.description, idea?.planDraft]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    messages.length,
    streamingReply,
    streamingTools.length,
    pendingUser,
  ]);

  // While the plan is being drafted/refined, the right panel renders
  // streamingReply (plan mode) or streamingPlan (chat-mode plan
  // update) live. Keep it pinned to the bottom so the operator
  // watches the plan grow instead of having to scroll manually.
  useEffect(() => {
    const el = planScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streamingMode, streamingReply, streamingPlan]);

  // Auto-open the right panel the moment plan-mode kicks off so the
  // operator can see the plan generate in real time.
  useEffect(() => {
    if (streamingMode === "plan") setPlanPanelOpen(true);
  }, [streamingMode]);

  if (projectQ.isLoading || ideaQ.isLoading || !idea || !project) {
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
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  const send = async (mode: "chat" | "challenge" | "plan") => {
    if (!id) return;
    if (mode === "chat" && !draft.trim()) return;
    const userText = draft.trim();
    if (mode === "chat") {
      setPendingUser(userText);
      setDraft("");
    } else if (mode === "plan" && userText) {
      // Plan mode treats the operator's text as a refinement note. We
      // don't show it as a user bubble — it's rolled into the system
      // marker the daemon writes ("Operator asked the agent to refine
      // the plan: <text>") so the thread stays clean.
      setDraft("");
    }
    setStreaming(true);
    setStreamingMode(mode);
    setStreamingReply("");
    setStreamingTools([]);
    setStreamingPlan("");
    setTurnStartedAt(Date.now());
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await client.streamIdeaChat(
        id,
        {
          mode,
          ...(mode === "chat" || mode === "plan"
            ? userText
              ? { text: userText }
              : {}
            : {}),
        },
        (event) => {
          if (event.kind === "text") {
            setStreamingReply((p) => p + event.delta);
          } else if (event.kind === "plan_delta") {
            // Live plan content streaming into the right panel —
            // either because the operator hit Plan, or because the
            // agent decided to update the plan during chat.
            setStreamingPlan((p) => p + event.delta);
            setPlanPanelOpen(true);
          } else {
            setStreamingTools((prev) => [...prev, event]);
          }
        },
        ctrl.signal,
      );
      if (r.ok === false) {
        toast(r.error || "agent didn't respond", true);
        if (userText) setDraft(userText);
      } else if (mode === "plan") {
        setPlanPanelOpen(true);
      }
      void qc.invalidateQueries({ queryKey: qk.idea(id) });
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        toast((e as Error).message, true);
        if (userText) setDraft(userText);
      }
    } finally {
      setStreaming(false);
      setStreamingMode(null);
      setStreamingReply("");
      setStreamingTools([]);
      setStreamingPlan("");
      setTurnStartedAt(null);
      setPendingUser(null);
      abortRef.current = null;
    }
  };

  const setStatus = async (status: IdeaStatus) => {
    if (!id) return;
    try {
      await update.mutateAsync({ id, status });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const saveTitle = async () => {
    if (!id) return;
    if (!titleDraft.trim() || titleDraft.trim() === idea.text) {
      setEditingTitle(false);
      return;
    }
    try {
      await update.mutateAsync({ id, text: titleDraft.trim() });
      setEditingTitle(false);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const saveDescription = async () => {
    if (!id) return;
    const t = descriptionDraft.trim() || null;
    if (t === (idea.description ?? null)) {
      setEditingDescription(false);
      return;
    }
    try {
      await update.mutateAsync({ id, description: t });
      setEditingDescription(false);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const savePlan = async () => {
    if (!id) return;
    const t = planDraftEditor.trim() || null;
    if (t === (idea.planDraft ?? null)) {
      setEditingPlan(false);
      return;
    }
    try {
      await update.mutateAsync({ id, planDraft: t });
      setEditingPlan(false);
      toast("plan stashed");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const onArchive = async () => {
    if (!confirm("Archive this idea?")) return;
    await setStatus("archived");
  };

  const onDelete = async () => {
    if (!id) return;
    if (!confirm("Delete idea + its conversation?")) return;
    try {
      await remove.mutateAsync(id);
      navigate(
        `/projects/${encodeURIComponent(project.slug)}/brainstorm`,
      );
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const elapsedMs =
    streaming && turnStartedAt ? Date.now() - turnStartedAt : 0;

  const lastPersistedUser = [...messages]
    .reverse()
    .find((m) => m.role === "user");
  const showPendingUser =
    pendingUser != null &&
    pendingUser.length > 0 &&
    lastPersistedUser?.content !== pendingUser;

  const allMessages: (IdeaMessage & { live?: boolean })[] = [
    ...messages,
    ...(showPendingUser
      ? [
          {
            id: "pending-user",
            ideaId: id ?? "",
            role: "user" as const,
            content: pendingUser!,
            createdAt: Date.now(),
            live: true,
          },
        ]
      : []),
    ...(streaming && streamingReply && streamingMode !== "plan"
      ? [
          {
            id: "live",
            ideaId: id ?? "",
            role: "agent" as const,
            content: streamingReply,
            createdAt: Date.now(),
            live: true,
            events: streamingTools as unknown as IdeaMessage["events"],
          },
        ]
      : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Link
          to={`/projects/${encodeURIComponent(project.slug)}/brainstorm`}
          className="text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
        >
          ← Ideas
        </Link>
        <VRule />
        <Kicker>idea</Kicker>
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate max-w-[44ch]">
          {idea.text}
        </span>
        <StatusPill status={idea.status} />
        <Spacer />
        {idea.spawnedTaskId ? (
          <Button asChild variant="outline" size="xs">
            <Link to={`/tasks/${idea.spawnedTaskId}`}>
              <ArrowUpRight className="h-3 w-3" /> Task
            </Link>
          </Button>
        ) : (
          <Button size="xs" onClick={() => setSpawnOpen(true)}>
            <Zap className="h-3 w-3" /> Spawn task
          </Button>
        )}
        {isWide && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPlanPanelOpen((v) => !v)}
            aria-label={planPanelOpen ? "Hide plan panel" : "Show plan panel"}
            title={planPanelOpen ? "Hide plan panel" : "Show plan panel"}
          >
            {planPanelOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            <DropdownMenuLabel>Idea</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setEditingTitle(true)}>
              Edit title
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditingDescription(true)}>
              Edit description
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void setStatus("draft")}>
              Mark draft
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void setStatus("refining")}>
              Mark refining
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void setStatus("validated")}>
              <CheckCircle2 /> Validate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void onArchive()}>
              Archive
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void onDelete()}
              className="text-red-700 focus:text-red-700 dark:text-red-300 dark:focus:text-red-300"
            >
              <Trash2 /> Delete idea
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageTopbar>

      {/* Sub-strip — minimal meta, mirrors TaskDetail's branch/repo row */}
      <div className="flex h-9 items-center gap-3 px-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0 overflow-x-auto">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 shrink-0">
          {project.name}
        </span>
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 shrink-0">
          saved {formatTs(idea.savedAt)}
        </span>
        {idea.lastMessageAt && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 shrink-0">
              last reply {formatTs(idea.lastMessageAt)}
            </span>
          </>
        )}
        {idea.planDraft && (
          <span className="shrink-0 inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-amber-500/10 text-amber-700 dark:text-amber-300">
            plan ready
          </span>
        )}
      </div>

      {editingTitle && (
        <div className="px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 mb-1.5">
            Edit title
          </div>
          <Input
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveTitle();
              }
              if (e.key === "Escape") {
                setTitleDraft(idea.text);
                setEditingTitle(false);
              }
            }}
            className="text-[13px]"
          />
        </div>
      )}
      {editingDescription && (
        <div className="px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 mb-1.5">
            Edit description · context for the agent
          </div>
          <Textarea
            value={descriptionDraft}
            autoFocus
            onChange={(e) => setDescriptionDraft(e.target.value)}
            onBlur={() => void saveDescription()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDescriptionDraft(idea.description ?? "");
                setEditingDescription(false);
              }
            }}
            rows={3}
            placeholder="Add a longer description / context for the agent…"
            className="text-[12.5px] resize-none"
          />
        </div>
      )}
      {/* Body — chat (left) + plan panel (right). On mobile the panel
          stacks below the chat as a collapsible drawer. */}
      <div className="flex-1 min-h-0">
        {isWide && planPanelOpen ? (
          <PanelGroup direction="horizontal" className="h-full">
            <Panel id="workshop-chat" defaultSize={55} minSize={40}>
              <ChatColumn
                threadRef={threadRef}
                allMessages={allMessages}
                streaming={streaming}
                streamingMode={streamingMode}
                streamingTools={streamingTools}
                streamingReply={streamingReply}
                elapsedMs={elapsedMs}
                draft={draft}
                setDraft={setDraft}
                onSend={send}
                onStop={() => abortRef.current?.abort()}
                hasPlan={!!idea.planDraft}
              />
            </Panel>
            <PanelResizeHandle className="w-px bg-ink-900/10 hover:bg-ember-500/40 transition-colors dark:bg-ink-50/10" />
            <Panel id="workshop-plan" defaultSize={45} minSize={28}>
              <PlanColumn
                planDraft={idea.planDraft}
                streaming={streaming}
                streamingMode={streamingMode}
                streamingReply={streamingReply}
                streamingPlan={streamingPlan}
                streamingTools={streamingTools}
                elapsedMs={elapsedMs}
                editingPlan={editingPlan}
                planDraftEditor={planDraftEditor}
                setPlanDraftEditor={setPlanDraftEditor}
                onStartEdit={() => {
                  setPlanDraftEditor(idea.planDraft ?? "");
                  setEditingPlan(true);
                }}
                onCancelEdit={() => {
                  setPlanDraftEditor(idea.planDraft ?? "");
                  setEditingPlan(false);
                }}
                onSaveEdit={() => void savePlan()}
                onPlan={() => void send("plan")}
                onClose={() => setPlanPanelOpen(false)}
                planScrollRef={planScrollRef}
                onSpawn={() => setSpawnOpen(true)}
                spawned={!!idea.spawnedTaskId}
              />
            </Panel>
          </PanelGroup>
        ) : (
          <div className="grid h-full grid-rows-[1fr_auto]">
            <ChatColumn
              threadRef={threadRef}
              allMessages={allMessages}
              streaming={streaming}
              streamingMode={streamingMode}
              streamingTools={streamingTools}
              streamingReply={streamingReply}
              elapsedMs={elapsedMs}
              draft={draft}
              setDraft={setDraft}
              onSend={send}
              onStop={() => abortRef.current?.abort()}
              hasPlan={!!idea.planDraft}
              embedded
            />
            {!isWide && idea.planDraft && (
              <details className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900">
                <summary className="cursor-pointer select-none px-5 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                  Plan ready · tap to view
                </summary>
                <div className="px-5 py-3 border-t border-amber-500/15 max-h-[60vh] overflow-y-auto">
                  <Markdown text={idea.planDraft} />
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      <SpawnDialog
        open={spawnOpen}
        onOpenChange={setSpawnOpen}
        idea={idea}
        onSpawn={async ({ agent, model, thinkingLevel }) => {
          if (!id) return;
          const prompt =
            (idea.planDraft?.trim() ||
              idea.description?.trim() ||
              idea.text.trim());
          try {
            if (idea.suggestionId && idea.optionIndex != null) {
              const r = await resolve.mutateAsync({
                id: idea.suggestionId,
                pick: {
                  index: idea.optionIndex,
                  text: prompt,
                  title: idea.text.split("\n")[0]!.slice(0, 80),
                  agent,
                  ...(model ? { model } : {}),
                  ...(thinkingLevel ? { thinkingLevel } : {}),
                },
              });
              await update.mutateAsync({ id, status: "spawned" });
              toast(`spawned ${r.task.id.slice(-8)}`);
              setSpawnOpen(false);
              navigate(`/tasks/${r.task.id}`);
            } else {
              const r = await client.spawnFromSavedIdea(id, {
                prompt,
                title: idea.text.split("\n")[0]!.slice(0, 80),
                agent,
                ...(model ? { model } : {}),
                ...(thinkingLevel ? { thinkingLevel } : {}),
              });
              toast(`spawned ${r.task.id.slice(-8)}`);
              setSpawnOpen(false);
              navigate(`/tasks/${r.task.id}`);
            }
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      />
    </div>
  );
}

function StatusPill({ status }: { status: IdeaStatus }) {
  const tone: Record<IdeaStatus, string> = {
    draft:
      "bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.05] dark:text-ink-400",
    refining: "bg-ember-500/15 text-ember-700 dark:text-ember-300",
    validated: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    spawned: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    archived:
      "bg-ink-900/[0.04] text-ink-400 dark:bg-ink-50/[0.04] dark:text-ink-500",
  };
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em]",
        tone[status],
      )}
    >
      {status}
    </span>
  );
}

/**
 * Timeline item — same vertical-spine layout the task page uses.
 *
 * - `system` rows are a thin divider with caption (status changes,
 *   "operator asked for a plan" markers).
 * - `user` and `agent` rows render as flat content next to a small
 *   avatar circle anchored on the spine. No bubble, no background.
 *   Markdown for agent replies; whitespace-pre-wrap for operator text.
 * - Persisted tool-call activity renders inline ABOVE the agent's
 *   reply text using <ToolLine>, identical to how the task timeline
 *   shows tool rows.
 */
function TimelineItem({
  message,
}: {
  message: IdeaMessage & { live?: boolean };
}) {
  if (message.role === "system") {
    // System rows carry plan-mode tool activity — render those rows
    // ABOVE the marker so the operator can scroll back through what
    // the agent did during a plan draft / refine even after it ends.
    const sysEvents = (message.events ?? []) as IdeaChatEvent[];
    const sysToolPairs = pairToolEvents(sysEvents);
    return (
      <li className="my-2">
        {sysToolPairs.length > 0 && (
          <WorkCard pairs={sysToolPairs} className="mb-3" />
        )}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] text-ink-400 dark:text-ink-500 leading-none select-none">
            ·
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
            {message.content}
          </span>
        </div>
      </li>
    );
  }

  const isUser = message.role === "user";
  const body = isUser
    ? message.content
    : message.content
        .replace(
          /^(?:[\*]{0,2}(?:agent|assistant)[\*]{0,2}\s*[:>—-]\s*)/i,
          "",
        )
        .replace(/^(?:\[(?:agent|assistant)\]\s*)/i, "")
        .trim();

  // Agent's tool calls during this turn — replays the activity with
  // claude-code-style tool rows + output previews.
  const events = (message.events ?? []) as IdeaChatEvent[];
  const toolPairs = pairToolEvents(events);

  return (
    <li>
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none select-none",
            isUser
              ? "text-sky-700 dark:text-sky-300"
              : "text-ember-700 dark:text-ember-300",
            message.live && "animate-blink",
          )}
        >
          {isUser ? "›" : "λ"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-2">
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.1em]",
                isUser
                  ? "text-sky-700 dark:text-sky-300"
                  : "text-ember-700 dark:text-ember-300",
              )}
            >
              {isUser ? "you" : "agent"}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600">
              {formatTs(message.createdAt)}
            </span>
            {message.live && (
              <span className="font-mono text-[10px] text-ember-600 dark:text-ember-400 animate-blink">
                ●
              </span>
            )}
          </div>
          {!isUser && toolPairs.length > 0 && (
            <WorkCard pairs={toolPairs} className="mb-4" />
          )}
          {isUser ? (
            <div className="font-mono whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-800 dark:text-ink-100">
              {body}
            </div>
          ) : (
            <Markdown text={body} />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * In-flight indicator while the agent is still streaming. Shows the
 * tool-call rows live (so the operator can see what the agent's
 * actually doing) plus a shimmer label tuned to the current mode.
 *
 * If the agent is already writing its reply (`showReply` true), the
 * streaming bubble is rendered separately by the caller — we just show
 * any new tool calls happening in the background.
 */
function ThinkingItem({
  events,
  showReply,
  mode,
  elapsedMs,
  hasPlan,
}: {
  events: IdeaChatEvent[];
  showReply: boolean;
  mode: "chat" | "challenge" | "plan" | null;
  elapsedMs: number;
  hasPlan: boolean;
}) {
  const toolPairs = pairToolEvents(events);

  // Once the agent starts streaming text, the live message bubble
  // already renders the tool rows above its body (via TimelineItem).
  // Suppress this thinking row to avoid duplicates.
  if (showReply) return null;

  // Pick the rotating-label phase based on what the agent's actually
  // doing right now, not just the operator's button choice.
  const phase: ThinkingPhase =
    toolPairs.length === 0
      ? "scouting"
      : mode === "plan"
        ? hasPlan
          ? "planRefining"
          : "planDrafting"
        : mode === "challenge"
          ? "challenging"
          : "chatting";
  const label = useRotatingLabel(phase);

  return (
    <li>
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none text-ember-500 animate-blink select-none">
          λ
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-2 flex-wrap">
            <ShimmerText className="text-[12.5px] font-medium">
              <TransitioningText>{label}</TransitioningText>
            </ShimmerText>
            <span className="font-mono text-[10px] tabular-nums text-ember-700/80 dark:text-ember-300/80">
              {formatElapsed(elapsedMs)}
            </span>
            {toolPairs.length > 0 && (
              <>
                <span className="text-ink-300 dark:text-ink-600 font-mono text-[10px]">
                  ·
                </span>
                <span className="font-mono text-[10px] tabular-nums text-ember-700/80 dark:text-ember-300/80">
                  {toolPairs.length} step{toolPairs.length === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
          {toolPairs.length > 0 && (
            <WorkCard
              pairs={toolPairs}
              liveTrailing={!showReply}
              className="border-ember-500/30 bg-ember-500/[0.04] dark:bg-ember-500/[0.06]"
            />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Left column — the conversation thread plus the composer. Lives next
 * to the plan panel in the split layout. Same TaskTimeline-style spine
 * we used before: tool calls inline above each agent reply, no bubble
 * borders, persisted activity replays on reload.
 */
function ChatColumn({
  threadRef,
  allMessages,
  streaming,
  streamingMode,
  streamingTools,
  streamingReply,
  elapsedMs,
  draft,
  setDraft,
  onSend,
  onStop,
  hasPlan,
  embedded = false,
}: {
  threadRef: React.RefObject<HTMLDivElement>;
  allMessages: (IdeaMessage & { live?: boolean })[];
  streaming: boolean;
  streamingMode: "chat" | "challenge" | "plan" | null;
  streamingTools: IdeaChatEvent[];
  streamingReply: string;
  elapsedMs: number;
  draft: string;
  setDraft: (v: string) => void;
  onSend: (mode: "chat" | "challenge" | "plan") => Promise<void>;
  onStop: () => void;
  hasPlan: boolean;
  embedded?: boolean;
}) {
  return (
    <div className={cn("grid h-full grid-rows-[1fr_auto]", embedded && "h-full")}>
      <div ref={threadRef} className="overflow-y-auto">
        <div className="px-6 py-6 lg:py-8">
          {allMessages.length === 0 && !streaming && (
            <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-4 py-10 text-center">
              <Sparkles className="h-4 w-4 mx-auto mb-2 text-ink-400 dark:text-ink-500" />
              <p className="text-[12.5px] text-ink-600 dark:text-ink-300">
                No conversation yet. Ask the agent a question, hit{" "}
                <span className="font-mono text-ember-700 dark:text-ember-300">
                  Plan
                </span>{" "}
                to draft an executable spec on the right, or{" "}
                <span className="font-mono text-ember-700 dark:text-ember-300">
                  Challenge
                </span>{" "}
                for self-critique.
              </p>
            </div>
          )}
          {(allMessages.length > 0 || streaming) && (
            <ol className="space-y-6">
              {allMessages.map((m) => (
                <TimelineItem key={m.id} message={m} />
              ))}
              {streaming && (
                <ThinkingItem
                  events={streamingTools}
                  showReply={!!streamingReply && streamingMode !== "plan"}
                  mode={streamingMode}
                  elapsedMs={elapsedMs}
                  hasPlan={hasPlan}
                />
              )}
            </ol>
          )}
        </div>
      </div>

      <footer className="px-5 py-3 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] space-y-2 bg-paper-50 dark:bg-ink-900">
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "shrink-0 mt-1.5 font-mono text-[14px] font-semibold leading-none transition-colors select-none",
              streaming
                ? "text-ember-500 animate-blink"
                : "text-sky-700 dark:text-sky-300",
            )}
          >
            ›
          </span>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void onSend("chat");
              }
            }}
            rows={2}
            disabled={streaming}
            placeholder={
              streaming
                ? "agent is thinking…"
                : hasPlan
                  ? "talk to the agent — the plan updates as you discuss"
                  : "ask risks, alternatives, scope, or anything else"
            }
            className="flex-1 resize-none border-none shadow-none bg-transparent focus-visible:ring-0 px-0 py-1 font-mono text-[13px] leading-snug placeholder:text-ink-400/60 dark:placeholder:text-ink-500/60"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap pl-5">
          {!hasPlan && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void onSend("plan")}
              disabled={streaming}
              title="Have the agent draft a full plan in the right panel"
            >
              <ClipboardList className="h-3 w-3" />
              Plan
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void onSend("challenge")}
            disabled={streaming}
            title="Have the agent critique this idea"
          >
            <Shuffle className="h-3 w-3" />
            Challenge
          </Button>
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden md:inline ml-1">
            ⌘↵ to send
          </span>
          <span className="ml-auto" />
          {streaming ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onStop}
              title="Stop the agent"
            >
              <X className="h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void onSend("chat")}
              disabled={!draft.trim()}
            >
              <Send className="h-3 w-3" />
              Send
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * Right column — the plan workspace. Three states:
 *   - empty: prompt the operator to draft a plan, with a one-click
 *     button that fires plan mode.
 *   - streaming (plan mode): the agent's reply lands here token-by-token
 *     so the operator watches the spec materialize. The chat thread
 *     shows the tool-call activity that's powering it.
 *   - settled: the persisted plan draft renders as full markdown with
 *     Refine / Edit by hand / Spawn task actions.
 */
function PlanColumn({
  planDraft,
  streaming,
  streamingMode,
  streamingReply,
  streamingPlan,
  streamingTools,
  elapsedMs,
  editingPlan,
  planDraftEditor,
  setPlanDraftEditor,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onPlan,
  onClose,
  planScrollRef,
  onSpawn,
  spawned,
}: {
  planDraft: string | null;
  streaming: boolean;
  streamingMode: "chat" | "challenge" | "plan" | null;
  streamingReply: string;
  streamingPlan: string;
  streamingTools: IdeaChatEvent[];
  elapsedMs: number;
  editingPlan: boolean;
  planDraftEditor: string;
  setPlanDraftEditor: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onPlan: () => void;
  onClose: () => void;
  planScrollRef: React.RefObject<HTMLDivElement>;
  onSpawn: () => void;
  spawned: boolean;
}) {
  // What to show in the body, in priority order:
  //   1. The agent is mid-stream and has emitted plan content → show
  //      that live, with a typing caret. Plan mode uses streamingReply
  //      (whole body is the plan); chat mode uses streamingPlan (only
  //      the <plan-update> block content).
  //   2. The persisted plan draft if one exists.
  //   3. Empty-state CTA.
  const liveBody =
    streamingMode === "plan"
      ? streamingReply
      : streamingPlan;
  const isLive = streaming && liveBody.length > 0;
  const isPlanning = streaming && streamingMode === "plan" && !isLive;
  const statusLabel =
    streamingMode === "plan"
      ? planDraft
        ? "redrafting"
        : "drafting"
      : streamingPlan.length > 0
        ? planDraft
          ? "updating"
          : "drafting"
        : null;
  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-ink-900/40">
      <header className="flex items-center gap-2 px-4 h-9 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] shrink-0">
        <ClipboardList className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] font-semibold text-amber-700 dark:text-amber-300">
          Plan
        </span>
        {statusLabel && (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-ember-500 animate-blink" />
            <ShimmerText className="font-mono text-[10px] uppercase tracking-[0.14em]">
              {statusLabel}
            </ShimmerText>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {planDraft && !editingPlan && !streaming && (
            <>
              <Button
                size="xs"
                variant="ghost"
                onClick={onStartEdit}
                title="Edit the plan by hand"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </Button>
              {!spawned && (
                <Button
                  size="xs"
                  onClick={onSpawn}
                  title="Spawn a task using this plan as the prompt"
                >
                  <Zap className="h-3 w-3" />
                  Spawn
                </Button>
              )}
            </>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Hide plan panel"
            title="Hide plan panel"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </span>
      </header>

      {editingPlan ? (
        <div className="flex flex-col flex-1 min-h-0 px-5 py-4 gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
            Editing by hand · saved as the spawned task's prompt
          </div>
          <Textarea
            value={planDraftEditor}
            autoFocus
            onChange={(e) => setPlanDraftEditor(e.target.value)}
            placeholder="Write the plan markdown by hand. Goal / Approach / Files / Steps / Edge cases / Acceptance / Test plan."
            className="flex-1 text-[12px] font-mono leading-relaxed resize-none"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onSaveEdit}>
              Save plan
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          ref={planScrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-5 py-4"
        >
          {isLive ? (
            <div>
              <Markdown text={liveBody} />
              <span className="inline-block w-1.5 h-4 align-text-bottom bg-ember-500/70 ml-0.5 animate-blink" />
            </div>
          ) : isPlanning ? (
            <PlanWaitingFeed
              events={streamingTools}
              hasPlan={!!planDraft}
              elapsedMs={elapsedMs}
            />
          ) : planDraft ? (
            <Markdown text={planDraft} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4 max-w-sm mx-auto">
              <ClipboardList className="h-6 w-6 text-amber-700/50 dark:text-amber-300/50" />
              <p className="text-[12.5px] text-ink-600 dark:text-ink-300">
                No plan yet. Talk to the agent in the chat — point at
                files, suggest approaches, ask questions — and it'll
                update this panel as the plan takes shape. Or hit{" "}
                <span className="font-mono text-amber-700 dark:text-amber-300">
                  Plan
                </span>{" "}
                in the composer to ask for a full structured spec right
                away (Goal · Approach · Files · Steps · Edge cases ·
                Acceptance · Test plan).
              </p>
              <div className="flex items-center gap-2">
                <Button size="xs" onClick={onPlan} disabled={streaming}>
                  <ClipboardList className="h-3 w-3" />
                  Draft a plan
                </Button>
                <Button size="xs" variant="ghost" onClick={onStartEdit}>
                  <Pencil className="h-3 w-3" />
                  Write by hand
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Status-only feed for the plan panel — no actual tool rows (those
 * stream into the chat thread, where they belong). Just the rotating
 * label, an elapsed counter, and a step counter, so the operator can
 * tell at a glance: how long, how busy, what flavor of work.
 */
function PlanWaitingFeed({
  events,
  hasPlan,
  elapsedMs,
}: {
  events: IdeaChatEvent[];
  hasPlan: boolean;
  elapsedMs: number;
}) {
  const tools = events.filter((e) => e.kind === "tool_use") as Array<
    Extract<IdeaChatEvent, { kind: "tool_use" }>
  >;
  const lastTool = tools[tools.length - 1];
  const phase: ThinkingPhase =
    tools.length === 0
      ? "scouting"
      : hasPlan
        ? "planRefining"
        : "planDrafting";
  const label = useRotatingLabel(phase);
  return (
    <div className="space-y-4 max-w-md">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="relative inline-flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-ember-500 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-ember-500" />
        </span>
        <ShimmerText className="text-[12.5px] font-medium">
          <TransitioningText>{label}</TransitioningText>
        </ShimmerText>
      </div>
      <div className="flex items-center gap-3 font-mono text-[10.5px] tabular-nums text-ink-500 dark:text-ink-400 pl-4">
        <span>{formatElapsed(elapsedMs)}</span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span>
          {tools.length} step{tools.length === 1 ? "" : "s"}
        </span>
        {lastTool && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="truncate min-w-0">
              {summariseTool(lastTool)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Concise one-liner for a tool_use event — used as the "what's the
 * agent doing right this second" hint in the plan panel.
 */
function summariseTool(
  ev: Extract<IdeaChatEvent, { kind: "tool_use" }>,
): string {
  const inp = (ev.input ?? {}) as Record<string, unknown>;
  const get = (k: string) =>
    typeof inp[k] === "string" ? (inp[k] as string) : "";
  if (ev.name === "Read" || ev.name === "Write" || ev.name === "Edit") {
    return `${ev.name} ${get("file_path") || get("path")}`;
  }
  if (ev.name === "Glob") return `Glob ${get("pattern")}`;
  if (ev.name === "Grep") {
    const path = get("path");
    return `Grep ${get("pattern")}${path ? ` in ${path}` : ""}`;
  }
  if (ev.name === "Bash") {
    const cmd = get("command");
    return `Bash ${cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}`;
  }
  if (ev.name === "WebFetch") return `WebFetch ${get("url")}`;
  return ev.name;
}

/**
 * Tiny "where did this model list come from" hint that sits next to
 * the Model label. The list itself stays fresh automatically — the
 * daemon watches `~/.codex/models_cache.json` and `~/.agentd/config.json`,
 * pushes a `models_changed` WS event when either changes, and the
 * realtime handler invalidates the cached query. So no refresh
 * button — the picker is always up-to-date by the time it opens.
 */
function ModelSourceHint({
  agent,
  sources,
}: {
  agent: AgentKind;
  sources:
    | { codex?: { available: boolean; fetchedAt: number | null } }
    | undefined;
}) {
  const codex = sources?.codex;
  const text =
    agent === "claude"
      ? "claude family aliases · always latest"
      : codex && codex.fetchedAt
        ? `~/.codex/models_cache.json · ${formatRelativeAge(codex.fetchedAt)}`
        : "~/.codex/models_cache.json";
  return (
    <span className="ml-auto font-mono text-[10px] text-ink-400 dark:text-ink-500">
      {text}
    </span>
  );
}

function formatRelativeAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Spawn dialog — picks the coding agent + model + thinking level for
 * the spawned task. The plan draft (or description, or title) becomes
 * the task prompt. We don't surface workspace mode / branch knobs here —
 * the operator can tune those on the task page once it's running.
 */
function SpawnDialog({
  open,
  onOpenChange,
  idea,
  onSpawn,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  idea: { planDraft: string | null; description: string | null; text: string };
  onSpawn: (opts: {
    agent: AgentKind;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }) => Promise<void>;
}) {
  const modelsQ = useModels();
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [model, setModel] = useState<string>("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("");
  const [submitting, setSubmitting] = useState(false);

  const models = modelsQ.data?.models;
  const defaults = modelsQ.data?.defaults;
  const agentModels = models ? models[agent] : [];

  // When the agent selection changes, snap the model to either the
  // server-side default for that agent, or the first model available.
  useEffect(() => {
    if (!agentModels) return;
    if (model && agentModels.some((m) => m.id === model)) return;
    const def = defaults?.[agent];
    setModel(
      def && agentModels.some((m) => m.id === def)
        ? def
        : agentModels[0]?.id ?? "",
    );
  }, [agent, agentModels?.length]);

  // Snap the thinking level off `max` (claude-only) or `minimal`
  // (codex-only) when the operator switches agents — leave the empty
  // sentinel ("") alone so the dialog still lets the server default
  // win.
  useEffect(() => {
    setThinkingLevel((cur) => {
      if (cur === "") return cur;
      if (agent === "claude" && cur === "minimal") return "low";
      if (agent === "codex" && cur === "max") return "xhigh";
      return cur;
    });
  }, [agent]);

  const promptPreview =
    idea.planDraft?.trim() || idea.description?.trim() || idea.text.trim();

  const summary = useMemo(() => {
    if (idea.planDraft) return "uses the plan draft as the task prompt";
    if (idea.description) return "uses the description (no plan drafted yet)";
    return "uses the idea title (consider drafting a plan first)";
  }, [idea.planDraft, idea.description]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Spawn task from idea</DialogTitle>
          <p className="text-[12px] text-ink-500 dark:text-ink-400">
            {summary}
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-[0.1em] font-mono text-ink-500 dark:text-ink-400">
              Coding agent
            </Label>
            <div className="flex gap-2">
              {(["claude", "codex"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setAgent(k)}
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                    agent === k
                      ? "border-ember-500/60 bg-ember-500/10"
                      : "border-ink-900/15 hover:bg-ink-900/[0.03] dark:border-ink-50/15 dark:hover:bg-ink-50/[0.03]",
                  )}
                >
                  <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500 dark:text-ink-400">
                    {k}
                  </div>
                  <div className="text-[12.5px] font-medium text-ink-900 dark:text-ink-50">
                    {k === "claude" ? "Claude Code" : "Codex CLI"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <Label
                htmlFor="spawn-model"
                className="text-[11px] uppercase tracking-[0.1em] font-mono text-ink-500 dark:text-ink-400"
              >
                Model
              </Label>
              <ModelSourceHint
                agent={agent}
                sources={modelsQ.data?.sources}
              />
            </div>
            <Select
              value={
                model && agentModels?.some((m) => m.id === model)
                  ? model
                  : model
                    ? "__custom"
                    : ""
              }
              onValueChange={(v) => {
                if (v === "__custom") {
                  // Switch to free-text mode — keep whatever's there.
                  setModel(model || "");
                } else {
                  setModel(v);
                }
              }}
            >
              <SelectTrigger id="spawn-model" className="text-[12.5px]">
                <SelectValue placeholder="pick a model" />
              </SelectTrigger>
              <SelectContent>
                {(agentModels ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex items-baseline gap-2">
                      <span className="font-medium">{m.label}</span>
                      <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                        {m.id}
                      </span>
                      {m.tier && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ember-700 dark:text-ember-300">
                          {m.tier}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value="__custom">
                  <span className="flex items-baseline gap-2">
                    <span className="font-medium">Custom…</span>
                    <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                      type any model id below
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {model && !agentModels?.some((m) => m.id === model) && (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model id (e.g. gpt-5.5, claude-sonnet-4-7)"
                className="text-[12.5px] font-mono"
              />
            )}
            {agent === "codex" &&
              modelsQ.data?.sources?.codex?.available === false && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  No codex models found at{" "}
                  <code className="font-mono">~/.codex/models_cache.json</code>.
                  Run any <code className="font-mono">codex</code> command once
                  to populate the cache, then hit refresh.
                </p>
              )}
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="spawn-thinking"
              className="text-[11px] uppercase tracking-[0.1em] font-mono text-ink-500 dark:text-ink-400"
            >
              Thinking effort
              <span className="ml-1 text-ink-400 dark:text-ink-500">
                · optional
              </span>
            </Label>
            <Select
              value={thinkingLevel || "default"}
              onValueChange={(v) =>
                setThinkingLevel(v === "default" ? "" : (v as ThinkingLevel))
              }
            >
              <SelectTrigger id="spawn-thinking" className="text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">use server default</SelectItem>
                {agent === "codex" && (
                  <SelectItem value="minimal">minimal (codex-only)</SelectItem>
                )}
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="xhigh">xhigh</SelectItem>
                {agent === "claude" && (
                  <SelectItem value="max">max (claude-only)</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-[0.1em] font-mono text-ink-500 dark:text-ink-400">
              Prompt preview
            </Label>
            <pre className="max-h-44 overflow-y-auto rounded-md border border-ink-900/10 bg-paper-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-700 whitespace-pre-wrap dark:border-ink-50/10 dark:bg-ink-900 dark:text-ink-200">
              {promptPreview}
            </pre>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSpawn({
                  agent,
                  ...(model ? { model } : {}),
                  ...(thinkingLevel
                    ? { thinkingLevel: thinkingLevel as ThinkingLevel }
                    : {}),
                });
              } finally {
                setSubmitting(false);
              }
            }}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            Spawn task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
