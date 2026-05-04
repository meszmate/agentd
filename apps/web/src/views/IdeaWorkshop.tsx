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
import type {
  AgentKind,
  IdeaMessage,
  IdeaStatus,
  PlanSlice,
  ThinkingLevel,
} from "@agentd/contracts";
import { stripPlanSlicesBlock } from "@agentd/contracts";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PlanSlicesEditor } from "@/components/plan-slices-editor";
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
  useSpawnMultiFromSavedIdea,
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
  const spawnMulti = useSpawnMultiFromSavedIdea();
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

  // Defensive client-side strip: if the daemon hasn't yet been
  // restarted with the new core build (or somehow returns a plan
  // with the raw fence still in it), normalise on the client so the
  // UI never shows the json-slices block in the plan textarea and
  // the spawn dialog gets seeded with the recovered slices.
  const idea = useMemo(() => {
    const raw = ideaQ.data?.idea ?? null;
    if (!raw) return null;
    const stripped = raw.planDraft
      ? stripPlanSlicesBlock(raw.planDraft)
      : { plan: "", slices: [] as PlanSlice[] };
    const cleanedDraft = raw.planDraft ? stripped.plan || null : raw.planDraft;
    const colSlices = raw.planSlices ?? [];
    const merged = colSlices.length > 0 ? colSlices : stripped.slices;
    return {
      ...raw,
      planDraft: cleanedDraft,
      ...(merged.length > 0 ? { planSlices: merged } : {}),
    };
  }, [ideaQ.data?.idea]);
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
        onSpawnSingle={async ({ agent, model, thinkingLevel }) => {
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
        onSpawnSlices={async ({ slices, shareWorktree }) => {
          if (!id) return;
          try {
            const r = await spawnMulti.mutateAsync({
              id,
              slices,
              shareWorktree,
              title: idea.text.split("\n")[0]!.slice(0, 80),
            });
            const first = r.tasks[0];
            toast(`spawned ${r.tasks.length} slices`);
            setSpawnOpen(false);
            if (first) navigate(`/tasks/${first.id}`);
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
  onSpawnSingle,
  onSpawnSlices,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  idea: {
    planDraft: string | null;
    description: string | null;
    text: string;
    planSlices?: PlanSlice[];
  };
  onSpawnSingle: (opts: {
    agent: AgentKind;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }) => Promise<void>;
  onSpawnSlices: (opts: {
    slices: PlanSlice[];
    shareWorktree: boolean;
  }) => Promise<void>;
}) {
  const modelsQ = useModels();
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [model, setModel] = useState<string>("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("");
  const [submitting, setSubmitting] = useState(false);

  // Slice editor state — seeded from the idea's persisted slices when
  // the dialog opens. Operator can edit per-slice agent/model/think,
  // add new slices, remove, reorder. When non-empty, hitting "Spawn"
  // fans out via the multi endpoint instead of a single task.
  const [slices, setSlices] = useState<PlanSlice[]>(idea.planSlices ?? []);
  const [shareWorktree, setShareWorktree] = useState<boolean>(true);
  const [forceSingle, setForceSingle] = useState<boolean>(false);
  useEffect(() => {
    if (open) {
      setSlices(idea.planSlices ?? []);
      setForceSingle(false);
    }
  }, [open, idea.planSlices]);

  const useSlices = !forceSingle && slices.length > 0;

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
    if (useSlices)
      return `${slices.length} slice${slices.length === 1 ? "" : "s"} on a shared branch — pick agent / model per slice below`;
    if (idea.planDraft) return "uses the plan draft as the task prompt";
    if (idea.description) return "uses the description (no plan drafted yet)";
    return "uses the idea title (consider drafting a plan first)";
  }, [idea.planDraft, idea.description, useSlices, slices.length]);

  const modelSuggestions = useMemo(
    () => ({
      claude: (modelsQ.data?.models?.claude ?? []).map((m) => m.id),
      codex: (modelsQ.data?.models?.codex ?? []).map((m) => m.id),
    }),
    [modelsQ.data?.models],
  );

  const wordCount = promptPreview.split(/\s+/).filter(Boolean).length;
  const hasSlices = slices.length > 0 || (idea.planSlices?.length ?? 0) > 0;

  const launch = async () => {
    setSubmitting(true);
    try {
      if (useSlices) {
        await onSpawnSlices({ slices, shareWorktree });
      } else {
        await onSpawnSingle({
          agent,
          ...(model ? { model } : {}),
          ...(thinkingLevel
            ? { thinkingLevel: thinkingLevel as ThinkingLevel }
            : {}),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Custom DialogPrimitive frame — same backdrop / animation pattern as
  // the InstructionsWorkshop dialog so the two feel like siblings, but
  // a single-column launch console rather than a two-pane workshop.
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[96vw] max-w-[820px] max-h-[88vh] flex flex-col",
            "rounded-2xl border border-ink-900/10 bg-paper-50 shadow-deep dark:border-ink-50/10 dark:bg-ink-900",
            "overflow-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Launch {idea.text}
          </DialogPrimitive.Title>

          {/* ── HERO ─────────────────────────────────────────────
              Ambient gradient header — no card, no border below it.
              The mode pill toggle floats over the hero gradient so the
              transition into the body feels seamless. */}
          <div className="relative shrink-0 px-7 pt-6 pb-4 overflow-hidden">
            {/* Soft ember orb behind the title — adds depth without a box */}
            <div
              aria-hidden
              className="pointer-events-none absolute -top-20 -left-20 h-60 w-60 rounded-full bg-ember-500/[0.12] blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -top-16 right-0 h-40 w-40 rounded-full bg-violet-500/[0.10] blur-3xl"
            />
            <div className="relative flex items-start gap-3">
              <span
                className="inline-flex shrink-0 items-center justify-center h-10 w-10 rounded-full font-mono text-[20px] font-semibold text-ember-600 bg-ember-500/10 ring-1 ring-ember-500/20 dark:text-ember-300 dark:bg-ember-500/15"
                aria-hidden
              >
                λ
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember-700 dark:text-ember-300">
                    Launching
                  </span>
                  <span className="text-ink-300 dark:text-ink-600 font-mono text-[10px]">
                    ·
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-ink-500 dark:text-ink-400">
                    {wordCount.toLocaleString()} words
                  </span>
                </div>
                <h2 className="mt-1 text-[19px] leading-tight font-semibold text-ink-900 dark:text-ink-50 truncate">
                  {idea.text}
                </h2>
                <p className="mt-1 text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
                  {summary}
                </p>
              </div>
              <DialogPrimitive.Close
                className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-full text-ink-400 hover:bg-ink-900/[0.05] hover:text-ink-700 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-200"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </DialogPrimitive.Close>
            </div>

            {/* Mode pill toggle — segmented control for Single vs Slices */}
            {hasSlices && (
              <div className="relative mt-4 flex items-center gap-2 flex-wrap">
                <ModePill
                  active={!useSlices}
                  onClick={() => setForceSingle(true)}
                  label="Single task"
                  hint="one runner, one prompt"
                />
                <ModePill
                  active={useSlices}
                  onClick={() => setForceSingle(false)}
                  label={`Slices · ${slices.length}`}
                  hint="sequential on a shared branch"
                  tint="ember"
                />
                {useSlices && slices.length > 1 && (
                  <label className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10.5px] text-ink-600 dark:text-ink-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shareWorktree}
                      onChange={(e) => setShareWorktree(e.target.checked)}
                      className="h-3 w-3 accent-ember-500"
                    />
                    share branch
                  </label>
                )}
              </div>
            )}
          </div>

          {/* Hairline gradient divider rather than a hard border line */}
          <div className="shrink-0 h-px bg-gradient-to-r from-transparent via-ink-900/[0.08] to-transparent dark:via-ink-50/[0.08]" />

          {/* ── BODY ─────────────────────────────────────────── */}
          <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6">
            {useSlices ? (
              /* Slice timeline — bare; no outer card. The PlanSlicesEditor
                 already draws the spine + numbered chips, so we let the
                 hero whitespace do the framing. */
              <PlanSlicesEditor
                slices={slices}
                onChange={setSlices}
                modelSuggestions={modelSuggestions}
                disabled={submitting}
              />
            ) : (
              <div className="space-y-7">
                <ConfigSection label="Engine" hint="who's driving this slice">
                  <AgentToggle agent={agent} setAgent={setAgent} />
                </ConfigSection>

                <ConfigSection
                  label="Model"
                  hint={
                    <ModelSourceHint
                      agent={agent}
                      sources={modelsQ.data?.sources}
                    />
                  }
                >
                  <Select
                    value={
                      model && agentModels?.some((m) => m.id === model)
                        ? model
                        : model
                          ? "__custom"
                          : ""
                    }
                    onValueChange={(v) => {
                      if (v === "__custom") setModel(model || "");
                      else setModel(v);
                    }}
                  >
                    <SelectTrigger
                      id="spawn-model"
                      className="text-[12.5px] h-9 rounded-lg"
                    >
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
                      className="mt-1.5 text-[12.5px] font-mono h-9"
                    />
                  )}
                  {agent === "codex" &&
                    modelsQ.data?.sources?.codex?.available === false && (
                      <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                        No codex models found at{" "}
                        <code className="font-mono">
                          ~/.codex/models_cache.json
                        </code>
                        . Run any <code className="font-mono">codex</code>{" "}
                        command once to populate the cache.
                      </p>
                    )}
                </ConfigSection>

                <ConfigSection
                  label="Thinking"
                  hint={thinkingLevel || "server default"}
                >
                  <ThinkingLadder
                    agent={agent}
                    value={thinkingLevel}
                    onChange={setThinkingLevel}
                  />
                </ConfigSection>

                <ConfigSection
                  label="Prompt"
                  hint={`${wordCount.toLocaleString()}w · ${promptPreview.length.toLocaleString()}c`}
                >
                  <div className="relative -mx-1">
                    <pre className="max-h-52 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink-700 dark:text-ink-200 whitespace-pre-wrap rounded-lg bg-paper-100/50 dark:bg-ink-800/50">
                      {promptPreview}
                    </pre>
                  </div>
                </ConfigSection>
              </div>
            )}
          </div>

          {/* ── FOOTER ───────────────────────────────────────── */}
          <div className="shrink-0 h-px bg-gradient-to-r from-transparent via-ink-900/[0.08] to-transparent dark:via-ink-50/[0.08]" />
          <div className="shrink-0 px-7 py-4 flex items-center gap-3">
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
              {useSlices
                ? `${slices.length} task${slices.length === 1 ? "" : "s"} ready`
                : `${agent} · ${model || "default"} · ${thinkingLevel || "default think"}`}
            </span>
            <span className="ml-auto" />
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="inline-flex items-center h-9 px-3 rounded-lg font-mono text-[11px] uppercase tracking-[0.06em] text-ink-500 hover:text-ink-900 dark:hover:text-ink-50 disabled:opacity-50"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => void launch()}
              disabled={submitting || (useSlices && slices.length === 0)}
              className={cn(
                "group relative inline-flex items-center gap-2 h-9 pl-3.5 pr-4 rounded-full font-medium text-[12.5px]",
                "bg-gradient-to-r from-ember-500 via-ember-500 to-amber-500 text-white",
                "shadow-[0_0_0_1px_rgba(245,158,11,0.4),0_8px_20px_-8px_rgba(245,158,11,0.6)]",
                "hover:shadow-[0_0_0_1px_rgba(245,158,11,0.6),0_12px_28px_-8px_rgba(245,158,11,0.8)]",
                "active:scale-[0.98] transition-all",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:from-ink-400 disabled:to-ink-500",
              )}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5 group-hover:rotate-12 transition-transform" />
              )}
              <span>
                {useSlices
                  ? `Launch ${slices.length} slice${slices.length === 1 ? "" : "s"}`
                  : "Launch task"}
              </span>
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Section block used inside the dialog body. Inline label + hint + the
 * actual control. No box around the section — the typography hierarchy
 * (uppercase mono kicker + thin top divider on hover) does the framing.
 */
function ConfigSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-500 dark:text-ink-400">
          {label}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-400 dark:text-ink-500">
          {hint}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Pill-style mode toggle for "Single task" vs "Slices · N". Active pill
 * lights up with the chosen tint; inactive is a soft ghost. Kept floating
 * above the body so the mode switch reads as the dialog's main verb.
 */
function ModePill({
  active,
  onClick,
  label,
  hint,
  tint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  tint?: "ember";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group inline-flex flex-col items-start px-3 py-1.5 rounded-full transition-all",
        active
          ? tint === "ember"
            ? "bg-ember-500/15 ring-1 ring-ember-500/40 shadow-[0_0_0_3px_rgba(245,158,11,0.08)]"
            : "bg-ink-900/[0.06] ring-1 ring-ink-900/15 dark:bg-ink-50/[0.06] dark:ring-ink-50/15"
          : "ring-1 ring-transparent hover:bg-ink-900/[0.03] dark:hover:bg-ink-50/[0.03]",
      )}
    >
      <span
        className={cn(
          "font-mono text-[10.5px] uppercase tracking-[0.12em] leading-none",
          active
            ? tint === "ember"
              ? "text-ember-700 dark:text-ember-300"
              : "text-ink-700 dark:text-ink-200"
            : "text-ink-500 dark:text-ink-400",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[9px] mt-0.5 leading-none",
          active
            ? "text-ink-500 dark:text-ink-400"
            : "text-ink-400 dark:text-ink-500",
        )}
      >
        {hint}
      </span>
    </button>
  );
}

/**
 * Two-up agent toggle. No bordered tiles — the active agent has a soft
 * gradient bloom and a bold label, the inactive one is a flat
 * monospaced label. Keeps the launch console reading as one immersive
 * surface instead of a grid of cards.
 */
function AgentToggle({
  agent,
  setAgent,
}: {
  agent: AgentKind;
  setAgent: (k: AgentKind) => void;
}) {
  return (
    <div className="relative grid grid-cols-2 rounded-xl bg-paper-100/60 p-1 dark:bg-ink-800/60">
      {/* Sliding glow indicator behind the active agent */}
      <span
        aria-hidden
        className={cn(
          "absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg transition-all",
          agent === "claude"
            ? "left-1 bg-gradient-to-br from-ember-500/20 via-ember-500/[0.08] to-transparent shadow-[0_0_0_1px_rgba(245,158,11,0.25)]"
            : "left-[calc(50%+1px)] bg-gradient-to-br from-violet-500/20 via-violet-500/[0.08] to-transparent shadow-[0_0_0_1px_rgba(139,92,246,0.25)]",
        )}
      />
      {(["claude", "codex"] as const).map((k) => {
        const active = agent === k;
        const tint = k === "claude" ? "ember" : "violet";
        return (
          <button
            key={k}
            type="button"
            onClick={() => setAgent(k)}
            className="relative z-10 flex items-center justify-center gap-2 py-2.5"
          >
            <Sparkles
              className={cn(
                "h-3.5 w-3.5 transition-colors",
                active
                  ? tint === "ember"
                    ? "text-ember-600 dark:text-ember-300"
                    : "text-violet-600 dark:text-violet-300"
                  : "text-ink-400 dark:text-ink-500",
              )}
            />
            <span
              className={cn(
                "font-mono text-[12px] tracking-[0.04em] transition-colors",
                active
                  ? "text-ink-900 dark:text-ink-50 font-semibold"
                  : "text-ink-500 dark:text-ink-400",
              )}
            >
              {k === "claude" ? "Claude Code" : "Codex CLI"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Visual ladder for thinking effort. Five dots fill in left→right as
 * the level rises (minimal → max). Click a dot to set the level; click
 * the leftmost label to revert to "server default". Mirrors the agent
 * picker's branding so the dialog has a unified feel.
 */
function ThinkingLadder({
  agent,
  value,
  onChange,
}: {
  agent: AgentKind;
  value: ThinkingLevel | "";
  onChange: (v: ThinkingLevel | "") => void;
}) {
  // Only show levels valid for the current agent; codex gets `minimal`,
  // claude gets `max`. The ladder always has 5 cells so the visual
  // never jumps when the operator switches agent.
  const levels: ThinkingLevel[] =
    agent === "claude"
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["minimal", "low", "medium", "high", "xhigh"];
  const idx = value ? levels.indexOf(value as ThinkingLevel) : -1;
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange("")}
        className={cn(
          "shrink-0 h-7 px-2 rounded-md font-mono text-[10px] uppercase tracking-[0.06em] transition-colors",
          value === ""
            ? "bg-ink-900/[0.08] text-ink-700 dark:bg-ink-50/[0.08] dark:text-ink-200"
            : "text-ink-400 hover:bg-ink-900/[0.05] dark:text-ink-500 dark:hover:bg-ink-50/[0.05]",
        )}
        title="Use the server default thinking level"
      >
        default
      </button>
      <span className="text-ink-300 dark:text-ink-600 font-mono text-[10px]">
        ·
      </span>
      <div className="flex-1 grid grid-cols-5 gap-1">
          {levels.map((lvl, i) => {
            const active = i <= idx;
            const isCurrent = i === idx;
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => onChange(lvl)}
                className={cn(
                  "group relative flex flex-col items-center gap-1.5 py-1.5 rounded-md transition-colors",
                  isCurrent
                    ? "bg-ember-500/[0.08]"
                    : "hover:bg-ink-900/[0.03] dark:hover:bg-ink-50/[0.03]",
                )}
                title={lvl}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full transition-all",
                    active
                      ? "bg-ember-500 ring-2 ring-ember-500/20"
                      : "bg-ink-300 dark:bg-ink-700",
                    isCurrent && "scale-125",
                  )}
                />
                <span
                  className={cn(
                    "font-mono text-[9px] tabular-nums tracking-[0.04em]",
                    isCurrent
                      ? "text-ember-700 dark:text-ember-300 font-semibold"
                      : "text-ink-400 dark:text-ink-500",
                  )}
                >
                  {lvl}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
