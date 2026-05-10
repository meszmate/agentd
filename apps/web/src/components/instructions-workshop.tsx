import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type { Project } from "@agentd/contracts";
import type { InstructionsChatEvent } from "@agentd/client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Textarea } from "@/components/ui/textarea";
import { useApp, useClient } from "@/AppContext";
import { useUpdateProject } from "@/queries";
import { cn } from "@/lib/utils";
import { WorkCard, pairToolEvents } from "@/components/tool-line";
import { Markdown } from "@/components/markdown";
import {
  ShimmerText,
  formatElapsed,
  useElapsedMs,
} from "@/components/thinking";

interface ChatTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  /** Tool events bundled with this agent turn — only set on agent rows. */
  events?: InstructionsChatEvent[];
  createdAt: number;
}

/**
 * Two-pane modal for editing project instructions conversationally.
 * Left = agentic chat, exact same primitives the IdeaWorkshop uses
 * (TimelineItem-style rows, WorkCard tool activity, ShimmerText
 * thinking, Markdown body). Right = live preview of the draft, which
 * the agent rewrites as it streams `<instructions>` blocks.
 *
 * The right pane is read-only by design — the user requested the
 * workshop be the only editing surface. Save / save & close at the
 * footer; revert returns to the on-disk snapshot.
 */
export function InstructionsWorkshopDialog({
  open,
  onClose,
  project,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
}) {
  const client = useClient();
  const update = useUpdateProject();
  const { toast } = useApp();

  // Local draft starts from the project's saved instructions; agent
  // edits replace it as they stream in. Save button persists this back.
  const [draft, setDraft] = useState<string>(project.instructions ?? "");
  const [savedSnapshot, setSavedSnapshot] = useState<string>(
    project.instructions ?? "",
  );
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  // Live in-flight state for the current turn.
  const [liveText, setLiveText] = useState("");
  const liveInstructionsRef = useRef<string>("");
  const liveEvents = useRef<InstructionsChatEvent[]>([]);
  // Force a re-render when live tool events change without re-creating
  // the array (we mutate it in place to avoid array churn).
  const [, bumpTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const elapsedMs = useElapsedMs(streaming);

  // Resync when the project changes or the dialog re-opens.
  useEffect(() => {
    if (open) {
      setDraft(project.instructions ?? "");
      setSavedSnapshot(project.instructions ?? "");
    }
  }, [open, project.instructions]);

  const dirty = draft !== savedSnapshot;
  const ruleCount = useMemo(
    () =>
      draft
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0).length,
    [draft],
  );

  const renderedRules = useMemo(
    () =>
      draft
        .split("\n")
        .map((raw, i) => ({ raw, i }))
        .filter(({ raw }) => raw.trim().length > 0),
    [draft],
  );

  // Diff vs the on-disk snapshot — line-set diff, unordered. Cheap and
  // accurate for bulleted rule lists.
  const diff = useMemo(() => {
    const before = new Set(
      savedSnapshot
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const after = new Set(
      draft
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    let added = 0;
    let removed = 0;
    for (const l of after) if (!before.has(l)) added += 1;
    for (const l of before) if (!after.has(l)) removed += 1;
    return { added, removed };
  }, [draft, savedSnapshot]);

  // Auto-scroll the chat thread to the bottom while streaming.
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!streaming) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streaming, liveText, turns.length]);

  const send = async () => {
    const message = input.trim();
    if (!message || streaming) return;

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      text: message,
      createdAt: Date.now(),
    };
    setTurns((cur) => [...cur, userTurn]);
    setInput("");
    setStreaming(true);
    setTurnStartedAt(Date.now());
    setLiveText("");
    liveInstructionsRef.current = "";
    liveEvents.current = [];
    bumpTick((t) => t + 1);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const result = await client.streamInstructionsChat(
        project.id,
        {
          message,
          currentDraft: draft,
          history: turns.map((t) => ({ role: t.role, content: t.text })),
        },
        (ev) => {
          if (ev.kind === "text") {
            setLiveText((cur) => cur + ev.delta);
          } else if (ev.kind === "instructions_delta") {
            // Accumulate the in-flight buffer AND mirror to the right
            // pane so the operator watches the agent type the new
            // draft live. Agent's contract: emit the FULL revised
            // text inside the tag, so the buffer IS the next draft.
            liveInstructionsRef.current += ev.delta;
            setDraft(liveInstructionsRef.current);
          } else if (ev.kind === "tool_use" || ev.kind === "tool_result") {
            liveEvents.current.push(ev);
            bumpTick((t) => t + 1);
          }
        },
        ctrl.signal,
      );
      const replyText =
        (result.ok ? result.reply : `_${result.source}: ${result.error}_`) ||
        liveText ||
        "(no reply)";
      const finalDraft =
        result.ok && result.instructions
          ? result.instructions
          : liveInstructionsRef.current.trim() || null;
      const agentTurn: ChatTurn = {
        id: `a-${Date.now()}`,
        role: "agent",
        text: replyText,
        events: liveEvents.current.slice(),
        createdAt: Date.now(),
      };
      setTurns((cur) => [...cur, agentTurn]);
      if (finalDraft) {
        // Snap to the cleaned final to drop any partial-tag artefact
        // from the streaming delta accumulation.
        setDraft(finalDraft);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        toast("stopped", false);
      } else {
        toast((e as Error).message, true);
      }
    } finally {
      setStreaming(false);
      setLiveText("");
      liveInstructionsRef.current = "";
      liveEvents.current = [];
      setTurnStartedAt(null);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const save = async (closeAfter: boolean) => {
    if (!dirty && !closeAfter) return;
    if (dirty) {
      try {
        await update.mutateAsync({
          idOrSlug: project.id,
          patch: { instructions: draft.trim() ? draft : null },
        });
        setSavedSnapshot(draft);
        toast("instructions saved");
      } catch (e) {
        toast((e as Error).message, true);
        return;
      }
    }
    if (closeAfter) onClose();
  };

  const discardChanges = () => {
    setDraft(savedSnapshot);
    setTurns([]);
  };

  // Build a "live agent turn" pseudo-message so the in-flight reply
  // renders through the same TimelineItem path (›/λ glyphs, role meta,
  // markdown body). Keeps the chat layout consistent.
  const liveAgent: ChatTurn | null = streaming
    ? {
        id: "live-agent",
        role: "agent",
        text: liveText,
        events: liveEvents.current,
        createdAt: turnStartedAt ?? Date.now(),
      }
    : null;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          if (streaming) abortRef.current?.abort();
          onClose();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-ink-900/30 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[96vw] h-[88vh] max-w-[1280px]",
            "grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
            "border border-ink-900/10 bg-paper-50 shadow-deep dark:border-ink-50/10 dark:bg-ink-800",
            "sm:rounded-xl overflow-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
          onInteractOutside={(e) => {
            if (streaming) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (streaming) e.preventDefault();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Instructions workshop · {project.name}
          </DialogPrimitive.Title>

          {/* ── LEFT: agentic chat ──────────────────────────────── */}
          <section className="flex flex-col min-w-0 border-r border-ink-900/[0.06] dark:border-ink-50/[0.06]">
            <header className="flex items-center gap-2 px-4 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
              <Bot className="h-3.5 w-3.5 text-ember-500" />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                instructions workshop
              </span>
              <span className="text-ink-300 dark:text-ink-600">·</span>
              <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
                {project.name}
              </span>
            </header>

            <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
              {turns.length === 0 && !streaming ? (
                <EmptyChat projectName={project.name} />
              ) : (
                <ol className="space-y-6">
                  {turns.map((t) => (
                    <ChatTurnRow key={t.id} turn={t} />
                  ))}
                  {liveAgent && (
                    <LiveAgentRow
                      turn={liveAgent}
                      elapsedMs={elapsedMs}
                    />
                  )}
                </ol>
              )}
            </div>

            {/* Composer — same shape as IdeaWorkshop */}
            <footer className="px-5 py-3 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] space-y-2 bg-paper-50 dark:bg-ink-900 shrink-0">
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
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  disabled={streaming}
                  placeholder={
                    streaming
                      ? "agent is thinking…"
                      : turns.length === 0
                        ? "tell me about this project, or ask me to look around — e.g. 'check what package manager + test runner this uses and propose rules'"
                        : "tweak the rules — 'tighten this', 'add one about migrations', 'remove the comment one'"
                  }
                  className="flex-1 resize-none border-none shadow-none bg-transparent focus-visible:ring-0 px-0 py-1 font-mono text-[13px] leading-snug placeholder:text-ink-400/60 dark:placeholder:text-ink-500/60"
                />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap pl-5">
                <span className="font-mono text-[9.5px] text-ink-400 dark:text-ink-500 inline-flex items-center gap-1">
                  <Sparkles className="h-2.5 w-2.5" />
                  agent has Read / Glob / Grep / Bash on this project
                </span>
                <span className="ml-auto inline-flex items-center gap-2">
                  <kbd className="px-1 py-0.5 rounded border border-ink-900/10 dark:border-ink-50/10 font-mono text-[9px] text-ink-400 dark:text-ink-500">
                    ⌘↵
                  </kbd>
                  {streaming ? (
                    <button
                      type="button"
                      onClick={stop}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20 font-mono text-[10px] uppercase tracking-[0.08em]"
                    >
                      <X className="h-2.5 w-2.5" />
                      stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={!input.trim()}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 hover:bg-ember-500/20 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-[10px] uppercase tracking-[0.08em]"
                    >
                      <Send className="h-2.5 w-2.5" />
                      send
                    </button>
                  )}
                </span>
              </div>
            </footer>
          </section>

          {/* ── RIGHT: instructions preview (read-only) ─────────── */}
          <section className="flex flex-col min-w-0 bg-paper-100/40 dark:bg-ink-900/40">
            <header className="flex items-center gap-2 px-4 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                draft
              </span>
              <span className="text-ink-300 dark:text-ink-600">·</span>
              <span className="font-mono text-[10px] tabular-nums text-ink-500 dark:text-ink-400">
                {ruleCount} rule{ruleCount === 1 ? "" : "s"}
              </span>
              {(diff.added > 0 || diff.removed > 0) && (
                <>
                  <span className="text-ink-300 dark:text-ink-600">·</span>
                  {diff.added > 0 && (
                    <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400 tabular-nums">
                      +{diff.added}
                    </span>
                  )}
                  {diff.removed > 0 && (
                    <span className="font-mono text-[10px] text-red-600 dark:text-red-400 tabular-nums">
                      −{diff.removed}
                    </span>
                  )}
                </>
              )}
              {dirty && (
                <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300 bg-ember-500/10 px-1 rounded ml-1">
                  unsaved
                </span>
              )}
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {renderedRules.length === 0 ? (
                <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/10 px-4 py-8 text-center font-mono text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
                  no rules yet — chat with the agent on the left to draft some
                </div>
              ) : (
                <ul className="rounded-md border border-ink-900/[0.08] dark:border-ink-50/[0.08] bg-paper-50 dark:bg-ink-800/40 px-3 py-2 space-y-1">
                  {renderedRules.map(({ raw, i }) => {
                    const trimmed = raw.replace(/^[-*•]\s*/, "").trim();
                    const isHeading = /^#{1,6}\s/.test(raw);
                    if (isHeading) {
                      return (
                        <li
                          key={i}
                          className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400 pt-1.5 first:pt-0"
                        >
                          {raw.replace(/^#{1,6}\s/, "")}
                        </li>
                      );
                    }
                    const isNew =
                      !savedSnapshot
                        .split("\n")
                        .map((l) => l.trim())
                        .includes(raw.trim());
                    return (
                      <li
                        key={i}
                        className={cn(
                          "flex gap-1.5 text-[11.5px] leading-relaxed",
                          isNew
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-ink-700 dark:text-ink-200",
                        )}
                      >
                        <span
                          className={cn(
                            "shrink-0 select-none",
                            isNew ? "text-emerald-500" : "text-ember-500",
                          )}
                        >
                          ›
                        </span>
                        <span className="font-mono">{trimmed}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Footer actions — keeping them out of the header
                avoids the previous overlap with the dialog X. */}
            <footer className="flex items-center gap-1.5 px-4 py-3 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
              {dirty && (
                <button
                  type="button"
                  onClick={discardChanges}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:hover:text-ink-50"
                  title="revert to saved + clear chat"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  revert
                </button>
              )}
              <span className="ml-auto" />
              <button
                type="button"
                onClick={() => onClose()}
                className="inline-flex items-center h-7 px-2.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:hover:text-ink-50"
              >
                close
              </button>
              <button
                type="button"
                onClick={() => void save(false)}
                disabled={!dirty || update.isPending}
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ink-900/10 dark:border-ink-50/10 hover:border-ember-500/40 hover:text-ember-700 dark:hover:text-ember-300 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {update.isPending ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-2.5 w-2.5" />
                )}
                save
              </button>
              <button
                type="button"
                onClick={() => void save(true)}
                disabled={update.isPending}
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 hover:bg-ember-500/15 disabled:opacity-40"
              >
                save &amp; close
              </button>
            </footer>
          </section>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function EmptyChat({ projectName }: { projectName: string }) {
  return (
    <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-4 py-10 text-center">
      <Sparkles className="h-4 w-4 mx-auto mb-2 text-ink-400 dark:text-ink-500" />
      <p className="text-[12.5px] text-ink-600 dark:text-ink-300 leading-relaxed">
        Chat with the agent. It can{" "}
        <code className="font-mono text-[11.5px] text-ember-700 dark:text-ember-300">
          Read
        </code>
        ,{" "}
        <code className="font-mono text-[11.5px] text-ember-700 dark:text-ember-300">
          Grep
        </code>
        ,{" "}
        <code className="font-mono text-[11.5px] text-ember-700 dark:text-ember-300">
          Bash
        </code>{" "}
        inside <span className="font-mono">{projectName}</span> to see what's
        actually there. As it proposes rules, they'll appear live in the
        right panel.
      </p>
    </div>
  );
}

/**
 * Single chat row. Same `›` / `λ` prefix language + role+timestamp
 * meta as IdeaWorkshop's `TimelineItem`, with `WorkCard` for any tool
 * activity bundled into the agent turn.
 */
function ChatTurnRow({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  const events = (turn.events ?? []) as InstructionsChatEvent[];
  const toolPairs = pairToolEvents(events);
  const body = isUser
    ? turn.text
    : turn.text
        .replace(/^(?:[\*]{0,2}(?:agent|assistant)[\*]{0,2}\s*[:>—-]\s*)/i, "")
        .replace(/^(?:\[(?:agent|assistant)\]\s*)/i, "")
        .trim();

  return (
    <li>
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none select-none",
            isUser
              ? "text-sky-700 dark:text-sky-300"
              : "text-ember-700 dark:text-ember-300",
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
              {formatTime(turn.createdAt)}
            </span>
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
 * Live agent row — split: if the reply text has started streaming
 * we render a TimelineItem-style bubble with the text + tool card and
 * the blinking ● live marker. If we don't have text yet (the agent is
 * just running tools), we fall back to the ShimmerText "thinking" row
 * with a rotating phase label, the elapsed timer, and a live tool
 * card with the trailing spinner.
 */
function LiveAgentRow({
  turn,
  elapsedMs,
}: {
  turn: ChatTurn;
  elapsedMs: number;
}) {
  const events = (turn.events ?? []) as InstructionsChatEvent[];
  const toolPairs = pairToolEvents(events);
  const showReply = !!turn.text.trim();

  if (showReply) {
    return (
      <li>
        <div className="flex items-start gap-2.5">
          <span className="shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none select-none animate-blink text-ember-700 dark:text-ember-300">
            λ
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ember-700 dark:text-ember-300">
                agent
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ember-700/80 dark:text-ember-300/80">
                {formatElapsed(elapsedMs)}
              </span>
              <span className="font-mono text-[10px] text-ember-600 dark:text-ember-400 animate-blink">
                ●
              </span>
            </div>
            {toolPairs.length > 0 && (
              <WorkCard pairs={toolPairs} liveTrailing className="mb-4" />
            )}
            <Markdown text={turn.text} />
          </div>
        </div>
      </li>
    );
  }

  return (
    <li>
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none text-ember-500 animate-blink select-none">
          λ
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-2 flex-wrap">
            <ShimmerText className="text-[12.5px] font-medium">
              agent is thinking
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
              liveTrailing
              className="border-ember-500/30 bg-ember-500/[0.04] dark:bg-ember-500/[0.06]"
            />
          )}
        </div>
      </div>
    </li>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
