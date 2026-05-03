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
import {
  Dialog,
  DialogContent,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Textarea } from "@/components/ui/textarea";
import { useApp, useClient } from "@/AppContext";
import { useUpdateProject } from "@/queries";
import { cn } from "@/lib/utils";
import { WorkCard, pairToolEvents } from "@/components/tool-line";

interface ChatTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  /** Tool events bundled with this agent turn — only set on agent rows. */
  events?: InstructionsChatEvent[];
}

/**
 * Two-pane modal for editing project instructions conversationally.
 * Left = agentic chat (with live tool activity rendered via WorkCard),
 * right = the instructions draft, updated live as the agent emits
 * `<instructions>` blocks. The agent has codebase access (Read/Glob/
 * Grep/Bash) so it can actually look at the project before suggesting
 * rules.
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

  // Live in-flight state — events + text + instructions deltas for the
  // current turn that hasn't completed yet. Once the envelope arrives,
  // we collapse these into a final ChatTurn.
  const [liveText, setLiveText] = useState("");
  const [liveInstructions, setLiveInstructions] = useState<string | null>(null);
  const liveEvents = useRef<InstructionsChatEvent[]>([]);
  const [liveEventCount, bumpLiveEventCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Resync when the project changes (different project, or external
  // edit while the dialog was closed).
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

  // Diff vs the on-disk snapshot. Cheap line-by-line set diff so the
  // operator can see what the agent actually changed.
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

  const send = async () => {
    const message = input.trim();
    if (!message || streaming) return;

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      text: message,
    };
    setTurns((cur) => [...cur, userTurn]);
    setInput("");
    setStreaming(true);
    setLiveText("");
    setLiveInstructions(null);
    liveEvents.current = [];
    bumpLiveEventCount(0);

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
            // Accumulate the in-flight instructions buffer AND mirror
            // it into the right-pane preview so the operator watches
            // the agent type the new draft live. The agent's contract
            // is to emit the FULL revised text inside the tag, so the
            // accumulating buffer IS the next draft.
            setLiveInstructions((cur) => {
              const next = (cur ?? "") + ev.delta;
              setDraft(next);
              return next;
            });
          } else if (ev.kind === "tool_use" || ev.kind === "tool_result") {
            liveEvents.current.push(ev);
            bumpLiveEventCount((c) => c + 1);
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
          : (liveInstructions ?? null);
      const agentTurn: ChatTurn = {
        id: `a-${Date.now()}`,
        role: "agent",
        text: replyText,
        events: liveEvents.current.slice(),
      };
      setTurns((cur) => [...cur, agentTurn]);
      if (finalDraft) {
        // Snap to the cleaned final to avoid any partial-tag artefact
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
      setLiveInstructions(null);
      liveEvents.current = [];
      bumpLiveEventCount(0);
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

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          if (streaming) abortRef.current?.abort();
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          className="max-w-[1280px] w-[96vw] h-[88vh] p-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0 sm:rounded-xl overflow-hidden"
          onInteractOutside={(e) => {
            // Don't accidentally dismiss while streaming.
            if (streaming) e.preventDefault();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Instructions workshop · {project.name}
          </DialogPrimitive.Title>

          {/* ── LEFT: chat ────────────────────────────────────────── */}
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
              <span className="ml-auto" />
              <DialogPrimitive.Close
                className="text-ink-400 hover:text-ink-900 dark:hover:text-ink-50"
                title="close"
              >
                <X className="h-3.5 w-3.5" />
              </DialogPrimitive.Close>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
              {turns.length === 0 && !streaming && (
                <EmptyChat projectName={project.name} />
              )}
              {turns.map((t) => (
                <ChatTurnRow key={t.id} turn={t} />
              ))}
              {streaming && (
                <LiveTurn
                  text={liveText}
                  events={liveEvents.current}
                  eventBump={liveEventCount}
                />
              )}
            </div>

            {/* Composer */}
            <div className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 px-4 py-3 shrink-0">
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "font-mono text-[14px] mt-1.5 select-none",
                    streaming
                      ? "text-ember-500 animate-pulse"
                      : "text-sky-500",
                  )}
                >
                  ›
                </span>
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    turns.length === 0
                      ? "Tell me about this project, or ask me to look around. e.g. 'check what package manager and test runner this uses'"
                      : "Tweak the rules — 'make it tighter', 'add one about migrations', 'remove the comment one'"
                  }
                  rows={2}
                  disabled={streaming}
                  className="text-[12px] font-mono leading-relaxed resize-none border-0 bg-transparent focus-visible:ring-0 px-0 py-1 min-h-[2.5rem] max-h-[10rem]"
                />
                <div className="flex flex-col gap-1.5 shrink-0">
                  {streaming ? (
                    <button
                      type="button"
                      onClick={stop}
                      className="inline-flex items-center justify-center h-7 w-7 rounded border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20"
                      title="stop"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={!input.trim()}
                      className="inline-flex items-center justify-center h-7 w-7 rounded border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 hover:bg-ember-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="send (⌘/Ctrl+Enter)"
                    >
                      <Send className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-1.5 ml-5 font-mono text-[9.5px] text-ink-400 dark:text-ink-500">
                <Sparkles className="h-2.5 w-2.5" />
                agent has read access to {project.name} — it'll explore the repo
                before suggesting rules
                <kbd className="ml-auto px-1 py-0.5 rounded border border-ink-900/10 dark:border-ink-50/10 text-[9px]">
                  ⌘↵
                </kbd>
              </div>
            </div>
          </section>

          {/* ── RIGHT: instructions preview ───────────────────────── */}
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
              <div className="ml-auto flex items-center gap-1.5">
                {dirty && (
                  <button
                    type="button"
                    onClick={discardChanges}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:hover:text-ink-50"
                    title="revert to saved + clear chat"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    revert
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void save(false)}
                  disabled={!dirty || update.isPending}
                  className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 disabled:opacity-40"
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
                  className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ink-900/10 dark:border-ink-50/10 hover:border-ember-500/40 hover:text-ember-700 dark:hover:text-ember-300"
                >
                  save & close
                </button>
              </div>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {/* Editable rendered preview */}
              {renderedRules.length === 0 ? (
                <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/10 px-4 py-8 text-center font-mono text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
                  no rules yet — chat with the agent on the left to draft
                  some, or write your own below.
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
                            isNew
                              ? "text-emerald-500"
                              : "text-ember-500",
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

              {/* Raw textarea so the operator can hand-tweak too */}
              <div className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
                    raw
                  </span>
                  <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
                    edit directly — preview above updates as you type
                  </span>
                </div>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={8}
                  className="text-[11.5px] font-mono leading-relaxed resize-y min-h-[8rem]"
                  placeholder="One rule per line. Use `- ` to bullet."
                />
              </div>
            </div>
          </section>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function EmptyChat({ projectName }: { projectName: string }) {
  return (
    <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/10 px-4 py-6 space-y-3">
      <div className="flex items-baseline gap-2">
        <Sparkles className="h-3 w-3 text-ember-500 self-center" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
          how this works
        </span>
      </div>
      <ul className="space-y-1.5 text-[11.5px] text-ink-600 dark:text-ink-300 leading-relaxed">
        <li className="flex gap-1.5">
          <span className="text-sky-500 shrink-0">›</span>
          <span>
            Chat with the agent. It can <code className="font-mono text-[10.5px] text-ember-700 dark:text-ember-300">Read</code>,{" "}
            <code className="font-mono text-[10.5px] text-ember-700 dark:text-ember-300">Grep</code>,{" "}
            <code className="font-mono text-[10.5px] text-ember-700 dark:text-ember-300">Bash</code>{" "}
            inside <span className="font-mono">{projectName}</span> to see
            what's actually there.
          </span>
        </li>
        <li className="flex gap-1.5">
          <span className="text-sky-500 shrink-0">›</span>
          <span>
            When the agent suggests a revision, it streams into the right pane
            live — you can hand-edit before saving.
          </span>
        </li>
        <li className="flex gap-1.5">
          <span className="text-sky-500 shrink-0">›</span>
          <span>
            Try: <em>"look at package.json and tell me what tooling rules
            agents should follow"</em> or <em>"I want to add a rule about
            never modifying X"</em>.
          </span>
        </li>
      </ul>
    </div>
  );
}

function ChatTurnRow({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex gap-2">
        <span className="font-mono text-sky-500 select-none mt-0.5">›</span>
        <p className="text-[12px] leading-relaxed text-ink-800 dark:text-ink-100 whitespace-pre-wrap font-mono">
          {turn.text}
        </p>
      </div>
    );
  }
  const pairs = pairToolEvents(turn.events ?? []);
  return (
    <div className="space-y-2">
      {pairs.length > 0 && <WorkCard pairs={pairs} />}
      <div className="flex gap-2">
        <span className="font-mono text-ember-500 select-none mt-0.5">λ</span>
        <p className="text-[12px] leading-relaxed text-ink-800 dark:text-ink-100 whitespace-pre-wrap">
          {turn.text}
        </p>
      </div>
    </div>
  );
}

function LiveTurn({
  text,
  events,
  eventBump: _eventBump,
}: {
  text: string;
  events: InstructionsChatEvent[];
  /** Re-render trigger — incrementing this forces pairToolEvents to re-run. */
  eventBump: number;
}) {
  const pairs = pairToolEvents(events);
  return (
    <div className="space-y-2">
      {pairs.length > 0 && <WorkCard pairs={pairs} liveTrailing />}
      <div className="flex gap-2">
        <span className="font-mono text-ember-500 select-none mt-0.5 animate-pulse">
          λ
        </span>
        <p className="text-[12px] leading-relaxed text-ink-800 dark:text-ink-100 whitespace-pre-wrap min-h-[1rem]">
          {text || (
            <span className="font-mono text-[11px] text-ink-400 dark:text-ink-500 italic">
              thinking…
            </span>
          )}
          {text && (
            <span className="inline-block w-1.5 h-3 bg-ember-500/70 animate-pulse ml-0.5 align-baseline" />
          )}
        </p>
      </div>
    </div>
  );
}
