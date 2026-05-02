import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowUpRight,
  Bookmark,
  CheckCircle2,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Send,
  Shuffle,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import type { IdeaMessage, IdeaStatus } from "@agentd/contracts";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp, useClient } from "@/AppContext";
import {
  qk,
  useDeleteSavedIdea,
  useIdea,
  useProject,
  useResolveSuggestion,
  useUpdateIdea,
} from "@/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatTs } from "@/lib/utils";

/**
 * `/projects/:slug/ideas/:id` — single-page workshop for one idea.
 *
 * Mirrors the TaskDetail layout: PageTopbar with title + status pill
 * + actions, sub-strip with meta (status, tags, plan-ready, message
 * count, timestamps), then a full-height conversation thread with a
 * composer at the bottom. The agent reads the project repo and
 * answers questions; "Challenge" makes it self-critique.
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
  const [streamingReply, setStreamingReply] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [planDraftEditor, setPlanDraftEditor] = useState("");
  const [showPlan, setShowPlan] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const idea = ideaQ.data?.idea ?? null;
  const messages = ideaQ.data?.messages ?? [];
  const project = projectQ.data?.project ?? null;

  // Sync local editor state with the server's truth on idea load /
  // refresh — keeps the workshop coherent if a different surface
  // (chat plugin) updated the idea.
  useEffect(() => {
    if (idea) {
      setTitleDraft(idea.text);
      setDescriptionDraft(idea.description ?? "");
      setPlanDraftEditor(idea.planDraft ?? "");
    }
  }, [idea?.id, idea?.text, idea?.description, idea?.planDraft]);

  // Auto-scroll the thread to the bottom on new messages / streaming
  // updates so the operator always sees the latest reply.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingReply]);

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

  const send = async (mode: "chat" | "challenge") => {
    if (!id) return;
    if (mode === "chat" && !draft.trim()) return;
    setStreaming(true);
    setStreamingReply("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const userText = draft.trim();
    try {
      const r = await client.streamIdeaChat(
        id,
        {
          mode,
          ...(mode === "chat" ? { text: userText } : {}),
        },
        (chunk) => setStreamingReply((p) => p + chunk),
        ctrl.signal,
      );
      if (r.ok === false) {
        toast(r.error || "agent didn't respond", true);
      } else {
        setDraft("");
      }
      void qc.invalidateQueries({ queryKey: qk.idea(id) });
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        toast((e as Error).message, true);
      }
    } finally {
      setStreaming(false);
      setStreamingReply("");
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
    if (t === (idea.planDraft ?? null)) return;
    try {
      await update.mutateAsync({ id, planDraft: t });
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

  const onSpawn = async () => {
    if (!id) return;
    const prompt =
      planDraftEditor.trim() ||
      idea.description?.trim() ||
      idea.text.trim();
    try {
      if (idea.suggestionId && idea.optionIndex != null) {
        const r = await resolve.mutateAsync({
          id: idea.suggestionId,
          pick: {
            index: idea.optionIndex,
            text: prompt,
            title: idea.text.split("\n")[0]!.slice(0, 80),
          },
        });
        await update.mutateAsync({ id, status: "spawned" });
        toast(`spawned ${r.task.id.slice(-8)}`);
        navigate(`/tasks/${r.task.id}`);
      } else {
        const r = await client.spawnFromSavedIdea(id, {
          prompt,
          title: idea.text.split("\n")[0]!.slice(0, 80),
        });
        toast(`spawned ${r.task.id.slice(-8)}`);
        navigate(`/tasks/${r.task.id}`);
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const allMessages: (IdeaMessage & { live?: boolean })[] =
    streaming && streamingReply
      ? [
          ...messages,
          {
            id: "live",
            ideaId: id ?? "",
            role: "agent",
            content: streamingReply,
            createdAt: Date.now(),
            live: true,
          },
        ]
      : messages;

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
        {editingTitle ? (
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
            className="h-7 text-[13px] font-medium"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate max-w-[44ch] text-left hover:underline decoration-dotted underline-offset-2"
            title="Click to edit"
          >
            {idea.text}
          </button>
        )}
        <StatusPill status={idea.status} />
        {(idea.messageCount ?? messages.length) > 0 && (
          <span className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium tabular-nums bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.05] dark:text-ink-400">
            <MessageSquare className="h-2.5 w-2.5" />
            {messages.length}
          </span>
        )}
        <Spacer />

        <Button
          size="xs"
          variant="outline"
          onClick={() => setShowPlan((v) => !v)}
        >
          <Bookmark className="h-3 w-3" />
          Plan
          {idea.planDraft && (
            <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-amber-700 dark:text-amber-300">
              ready
            </span>
          )}
        </Button>
        {idea.status !== "validated" && idea.status !== "spawned" && idea.status !== "archived" && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void setStatus("validated")}
          >
            <CheckCircle2 className="h-3 w-3" />
            Validate
          </Button>
        )}
        {idea.spawnedTaskId ? (
          <Button asChild size="xs" variant="outline">
            <Link to={`/tasks/${idea.spawnedTaskId}`}>
              <ArrowUpRight className="h-3 w-3" />
              Open task
            </Link>
          </Button>
        ) : (
          <Button size="xs" onClick={() => void onSpawn()}>
            <Zap className="h-3 w-3" />
            Spawn task
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
            <DropdownMenuItem onClick={() => void setStatus("draft")}>
              Mark draft
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void setStatus("refining")}>
              Mark refining
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void setStatus("validated")}>
              Mark validated
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

      {/* Sub-strip: meta (matches TaskDetail's branch/repo strip) */}
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
        {idea.tags.length > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <div className="flex items-center gap-1 shrink-0">
              {idea.tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-ember-500/10 text-ember-700 dark:text-ember-300 border border-ember-500/20"
                >
                  ◆ {t}
                </span>
              ))}
            </div>
          </>
        )}
        {idea.suggestionId != null && idea.optionIndex != null && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
              from brainstorm option {idea.optionIndex + 1}
            </span>
          </>
        )}
      </div>

      {/* Plan drawer (collapsed by default) */}
      {showPlan && (
        <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 px-5 py-3 shrink-0">
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
              Plan draft
            </span>
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
              · becomes the spawned task's prompt
            </span>
          </div>
          <Textarea
            value={planDraftEditor}
            onChange={(e) => setPlanDraftEditor(e.target.value)}
            onBlur={() => void savePlan()}
            rows={6}
            placeholder="Hand-drafted plan, or paste one from the planner."
            className="text-[12px] font-mono leading-relaxed resize-y"
          />
        </div>
      )}

      {/* Body — description (editable) + conversation thread */}
      <div className="flex-1 min-h-0 grid grid-rows-[auto_1fr_auto]">
        <div className="px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50/40 dark:bg-ink-900/40">
          {editingDescription ? (
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
          ) : (
            <button
              type="button"
              onClick={() => setEditingDescription(true)}
              className={cn(
                "block w-full text-left text-[12.5px] leading-relaxed rounded -mx-1 px-1 hover:bg-ink-900/[0.02] dark:hover:bg-ink-50/[0.02]",
                idea.description
                  ? "text-ink-700 dark:text-ink-200"
                  : "text-ink-400 dark:text-ink-500 italic",
              )}
              title="Click to edit"
            >
              {idea.description?.trim() ||
                "Add a description for context — the agent reads it when refining."}
            </button>
          )}
        </div>

        <div ref={threadRef} className="overflow-y-auto px-5 py-4 space-y-3">
          {allMessages.length === 0 && (
            <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-4 py-8 text-center">
              <Sparkles className="h-4 w-4 mx-auto mb-2 text-ink-400 dark:text-ink-500" />
              <p className="text-[12px] text-ink-600 dark:text-ink-300">
                No messages yet. Ask a question, or hit{" "}
                <span className="font-mono text-ember-700 dark:text-ember-300">
                  Challenge
                </span>{" "}
                to have the agent critique its own idea.
              </p>
            </div>
          )}
          {allMessages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && !streamingReply && (
            <div className="flex items-center gap-2 text-[11.5px] text-ember-700 dark:text-ember-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              agent is reading the repo…
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] space-y-2 bg-paper-50 dark:bg-ink-900">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void send("chat");
              }
            }}
            rows={2}
            disabled={streaming}
            placeholder="Ask the agent — risks? alternatives? scope? edge cases?"
            className="text-[13px] leading-relaxed resize-none"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => void send("challenge")}
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
            <Button
              size="sm"
              onClick={() => void send("chat")}
              disabled={streaming || !draft.trim()}
            >
              {streaming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Send
            </Button>
          </div>
        </footer>
      </div>
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

function MessageBubble({
  message,
}: {
  message: IdeaMessage & { live?: boolean };
}) {
  const role = message.role;
  if (role === "system") {
    return (
      <div className="flex items-center gap-2 my-1">
        <span className="flex-1 h-px bg-ink-900/[0.06] dark:bg-ink-50/[0.06]" />
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500">
          {message.content}
        </span>
        <span className="flex-1 h-px bg-ink-900/[0.06] dark:bg-ink-50/[0.06]" />
      </div>
    );
  }
  const isUser = role === "user";
  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap",
          isUser
            ? "bg-ember-500/10 text-ink-900 dark:text-ink-50"
            : "bg-paper-100 dark:bg-ink-900/40 text-ink-700 dark:text-ink-200 border border-ink-900/[0.06] dark:border-ink-50/[0.06]",
          message.live && "border-l-2 border-ember-500",
        )}
      >
        {!isUser && (
          <div className="mb-1 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
            <Sparkles className="h-2.5 w-2.5" />
            agent
          </div>
        )}
        {message.content}
      </div>
    </div>
  );
}
