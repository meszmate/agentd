import { useEffect, useState } from "react";
import {
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequestCreate,
  Loader2,
  Send,
  Ship as ShipIcon,
  Sparkles,
  Upload,
} from "lucide-react";
import type { Task } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp, useClient } from "@/AppContext";
import { cn } from "@/lib/utils";

const COMMIT_PREFIXES = [
  "feat",
  "fix",
  "refactor",
  "docs",
  "chore",
  "style",
  "test",
  "perf",
  "ci",
  "build",
] as const;

type Prefix = (typeof COMMIT_PREFIXES)[number];

/**
 * "Ship" menu — commit + push + open-PR for the task's worktree, in the
 * user's preferred style: single-line `feat: <short>` commits, PRs with
 * a tight bullet body and no Test plan / no AI attribution.
 */
export function ShipMenu({ task }: { task: Task }) {
  const [open, setOpen] = useState<"commit" | "pr" | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" title="Ship the work">
            <ShipIcon className="h-3 w-3" />
            Ship
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Ship</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpen("commit")}>
            <GitCommit className="h-3.5 w-3.5" />
            Commit changes
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setOpen("pr")}>
            <GitPullRequestCreate className="h-3.5 w-3.5" />
            Open pull request
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CommitDialog
        task={task}
        open={open === "commit"}
        onClose={() => setOpen(null)}
      />
      <PrDialog
        task={task}
        open={open === "pr"}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

/* ── Commit dialog ─────────────────────────────────────────────────── */

function CommitDialog({
  task,
  open,
  onClose,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
}) {
  const client = useClient();
  const { toast } = useApp();
  const [shape, setShape] = useState({
    includeScope: false,
    includeBody: false,
    wip: false,
  });
  const [hint, setHint] = useState("");
  const [message, setMessage] = useState("");
  const [pushAfter, setPushAfter] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pending, setPending] = useState(false);
  const [source, setSource] = useState<string | null>(null);

  // Auto-generate when the dialog opens or shape changes.
  useEffect(() => {
    if (!open) return;
    void regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shape.includeScope, shape.includeBody, shape.wip]);

  useEffect(() => {
    if (!open) {
      setMessage("");
      setHint("");
      setShape({ includeScope: false, includeBody: false, wip: false });
      setPushAfter(false);
      setSource(null);
    }
  }, [open]);

  const regenerate = async () => {
    setGenerating(true);
    setMessage("");
    setSource(null);
    try {
      const r = await client.streamCommitMessage(
        task.id,
        {
          ...shape,
          hint: hint.trim() || undefined,
        },
        (chunk) => {
          // Append each token as it arrives — the textarea fills like the
          // model is typing.
          setMessage((cur) => cur + chunk);
        },
      );
      // Stream ended; replace with the cleaned final message.
      setMessage(r.message);
      setSource(r.source);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    setPending(true);
    try {
      const r = await client.commitTask(task.id, message.trim());
      if (!r.committed) {
        toast("Nothing to commit", true);
        return;
      }
      toast(`Committed ${r.sha?.slice(0, 7)}`);
      if (pushAfter) {
        try {
          await client.pushTask(task.id);
          toast("Pushed");
        } catch (e) {
          toast(`push: ${(e as Error).message}`, true);
        }
      }
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setPending(false);
    }
  };

  const valid = !!message.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCommit className="h-4 w-4 text-ember-500" />
            Commit changes
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-baseline gap-2">
              <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
                Message
              </Label>
              <span className="text-[10px] text-ink-400 dark:text-ink-500 inline-flex items-center gap-1">
                {generating ? (
                  <>
                    <Loader2 className="h-2.5 w-2.5 text-ember-500 animate-spin" />
                    <span className="text-ember-700 dark:text-ember-300">
                      claude is writing
                    </span>
                  </>
                ) : source === "claude" ? (
                  "claude generated · edit freely"
                ) : source ? (
                  `fallback (${source.replace("fallback-", "")})`
                ) : (
                  ""
                )}
              </span>
              <button
                type="button"
                onClick={regenerate}
                disabled={generating}
                className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ember-700 hover:underline disabled:opacity-50 dark:text-ember-300"
              >
                <Sparkles className="h-3 w-3" />
                regenerate
              </button>
            </div>
            <div className="relative">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={shape.includeBody ? 6 : 2}
                spellCheck={false}
                className={cn(
                  "font-mono text-[12px] transition",
                  generating && "ring-1 ring-ember-500/40",
                )}
                placeholder={generating ? "" : "feat: …"}
              />
              {generating && (
                <>
                  {/* Top progress bar — animated stripes give "something is
                      happening" energy even before any token has arrived. */}
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t">
                    <div className="h-full w-full bg-gradient-to-r from-transparent via-ember-500 to-transparent bg-[length:200%_100%] animate-shimmer" />
                  </div>
                  {/* Skeleton lines while the textarea is empty, replaced
                      seamlessly by tokens as they arrive. */}
                  {message.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex flex-col gap-1.5 px-3 py-2">
                      <div className="h-2.5 w-2/3 animate-pulse rounded bg-ember-500/15" />
                      {shape.includeBody && (
                        <>
                          <div className="h-2.5 w-1/2 animate-pulse rounded bg-ember-500/10" />
                          <div className="h-2.5 w-3/4 animate-pulse rounded bg-ember-500/10" />
                        </>
                      )}
                    </div>
                  )}
                  {/* Caret drifting behind the last character once tokens
                      start flowing — keeps the "typing" feel honest. */}
                  {message.length > 0 && (
                    <span className="pointer-events-none absolute bottom-2 right-3 inline-block h-3 w-1 bg-ember-500 animate-blink" />
                  )}
                </>
              )}
            </div>
            <div className="mt-1 flex items-baseline justify-between font-mono text-[10px] text-ink-400 dark:text-ink-500">
              <span>
                {message.split("\n")[0]?.length ?? 0} chars on subject line
              </span>
              <span className="tabular-nums">
                {(message.split("\n")[0]?.length ?? 0) > 72 ? "long ⚠" : ""}
              </span>
            </div>
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Shape
            </Label>
            <div className="mt-1 flex flex-wrap gap-2">
              <ShapeCheck
                label="add scope"
                hint="feat(api): …"
                value={shape.includeScope}
                onChange={(v) => setShape({ ...shape, includeScope: v })}
              />
              <ShapeCheck
                label="include body"
                hint="bullet list under the subject"
                value={shape.includeBody}
                onChange={(v) => setShape({ ...shape, includeBody: v })}
              />
              <ShapeCheck
                label="wip"
                hint="prefix the message with `wip:`"
                value={shape.wip}
                onChange={(v) => setShape({ ...shape, wip: v })}
              />
              <ShapeCheck
                label="push after"
                hint="git push -u origin <branch>"
                value={pushAfter}
                onChange={setPushAfter}
              />
            </div>
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Hint (optional)
            </Label>
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void regenerate();
                }
              }}
              placeholder="e.g. focus on the streaming change"
              className="font-mono text-[12px]"
            />
            <p className="mt-1 font-mono text-[10px] text-ink-400 dark:text-ink-500">
              Press enter to regenerate with this hint.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || pending || generating}>
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitCommit className="h-3.5 w-3.5" />
            )}
            Commit{pushAfter ? " + push" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShapeCheck({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      title={hint}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
        value
          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
      )}
    >
      <span
        className={cn(
          "h-3 w-3 rounded-sm border flex items-center justify-center",
          value
            ? "border-ember-500 bg-ember-500"
            : "border-ink-900/30 bg-transparent dark:border-ink-50/30",
        )}
      >
        {value && (
          <svg viewBox="0 0 12 12" className="h-2 w-2 text-white" fill="none">
            <path d="M2.5 6L5 8.5L9.5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="font-mono">{label}</span>
    </button>
  );
}

/* ── PR dialog ─────────────────────────────────────────────────────── */

function PrDialog({
  task,
  open,
  onClose,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
}) {
  const client = useClient();
  const { toast } = useApp();
  const [prefix, setPrefix] = useState<Prefix>("feat");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [pending, setPending] = useState<"push" | "pr" | null>(null);
  const [hint, setHint] = useState("");
  const [includeBullets, setIncludeBullets] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [source, setSource] = useState<string | null>(null);

  const regenerate = async () => {
    setGenerating(true);
    setSubject("");
    setBody("");
    setSource(null);
    let buffer = "";
    try {
      const r = await client.streamPrMessage(
        task.id,
        {
          ...(hint.trim() ? { hint: hint.trim() } : {}),
          includeBullets,
        },
        (chunk) => {
          buffer += chunk;
          // Split on first blank line: subject above, body below.
          const idx = buffer.indexOf("\n\n");
          if (idx < 0) {
            setSubject(stripPrefix(buffer.trim()));
          } else {
            setSubject(stripPrefix(buffer.slice(0, idx).trim()));
            setBody(buffer.slice(idx + 2));
          }
        },
      );
      setSubject(stripPrefix(r.title));
      setBody(r.body);
      setSource(r.source);
      // If the model embedded a known prefix in the title, sync the chip.
      const m = r.title.match(/^([a-z]+):/);
      if (m && (COMMIT_PREFIXES as readonly string[]).includes(m[1]!)) {
        setPrefix(m[1] as Prefix);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setSource(null);
      setHint("");
      setIncludeBullets(true);
      setSubject("");
      setBody("");
      return;
    }
    setPrefix("feat");
    setDraft(false);
    // Seed deterministic content immediately, then kick off AI generation.
    setSubject(deriveSubject(task.title));
    setBody(deriveBody(task));
    void regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task]);

  const title = `${prefix}: ${subject.trim()}`;

  const submit = async () => {
    setPending("push");
    try {
      try {
        await client.pushTask(task.id);
      } catch (e) {
        // Push can fail if there are no commits yet — surface clearly.
        toast(`push: ${(e as Error).message}`, true);
        setPending(null);
        return;
      }
      setPending("pr");
      const r = await client.openPrForTask(task.id, {
        title,
        body,
        draft,
      });
      if (r.url) {
        toast(`Opened ${r.url}`);
        window.open(r.url, "_blank", "noopener");
      } else {
        toast("PR opened (no URL parsed)");
      }
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setPending(null);
    }
  };

  const valid = !!subject.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequestCreate className="h-4 w-4 text-ember-500" />
            Open pull request
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Title
            </Label>
            <div className="mt-1 flex items-center gap-2">
              <select
                value={prefix}
                onChange={(e) => setPrefix(e.target.value as Prefix)}
                className="h-9 rounded-md border border-ink-900/15 bg-paper-50 px-2 font-mono text-[12px] text-ink-700 dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-200"
              >
                {COMMIT_PREFIXES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <span className="font-mono text-[12px] text-ink-400 dark:text-ink-500">
                :
              </span>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="short description"
                className="font-mono text-[12px]"
                autoFocus
              />
            </div>
            <div className="mt-1 font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
              {title}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-baseline gap-2">
              <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
                What changed
              </Label>
              <span className="text-[10px] text-ink-400 dark:text-ink-500 inline-flex items-center gap-1">
                {generating ? (
                  <>
                    <Loader2 className="h-2.5 w-2.5 text-ember-500 animate-spin" />
                    <span className="text-ember-700 dark:text-ember-300">
                      claude is writing
                    </span>
                  </>
                ) : source === "claude" ? (
                  "claude generated · edit freely"
                ) : source ? (
                  `fallback (${source.replace("fallback-", "")})`
                ) : (
                  "· bullets, no Test plan, no boilerplate"
                )}
              </span>
              <button
                type="button"
                onClick={regenerate}
                disabled={generating}
                className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ember-700 hover:underline disabled:opacity-50 dark:text-ember-300"
              >
                <Sparkles className="h-3 w-3" />
                regenerate
              </button>
            </div>
            <div className="relative">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                spellCheck={false}
                className={cn(
                  "font-mono text-[12px] transition",
                  generating && "ring-1 ring-ember-500/40",
                )}
              />
              {generating && (
                <>
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t">
                    <div className="h-full w-full bg-gradient-to-r from-transparent via-ember-500 to-transparent bg-[length:200%_100%] animate-shimmer" />
                  </div>
                  {body.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex flex-col gap-1.5 px-3 py-2">
                      <div className="h-2.5 w-2/3 animate-pulse rounded bg-ember-500/15" />
                      <div className="h-2.5 w-1/2 animate-pulse rounded bg-ember-500/10" />
                      <div className="h-2.5 w-3/4 animate-pulse rounded bg-ember-500/10" />
                    </div>
                  )}
                  {body.length > 0 && (
                    <span className="pointer-events-none absolute bottom-2 right-3 inline-block h-3 w-1 bg-ember-500 animate-blink" />
                  )}
                </>
              )}
            </div>
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Hint (optional)
            </Label>
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void regenerate();
                }
              }}
              placeholder="e.g. focus on the streaming refactor"
              className="font-mono text-[12px]"
            />
            <p className="mt-1 font-mono text-[10px] text-ink-400 dark:text-ink-500">
              Press enter to regenerate.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <label className="flex items-center gap-2 text-ink-700 dark:text-ink-200">
              <input
                type="checkbox"
                checked={includeBullets}
                onChange={(e) => setIncludeBullets(e.target.checked)}
                className="accent-ember-500"
              />
              include bullets
            </label>
            <label className="flex items-center gap-2 text-ink-700 dark:text-ink-200">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="accent-ember-500"
              />
              draft
            </label>
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
              base: {task.baseBranch} ← {task.branch}
            </span>
          </div>

          <p className="font-mono text-[10px] text-ink-400 dark:text-ink-500 leading-relaxed">
            Pushes the branch first, then runs `gh pr create`. Title goes
            verbatim; body is your bullets, untouched. Pushed URL gets stored
            on the task so it shows up in the topbar next time.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending != null}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || pending != null}>
            {pending != null ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {pending === "push"
              ? "Pushing…"
              : pending === "pr"
                ? "Opening PR…"
                : draft
                  ? "Open draft PR"
                  : "Open PR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function deriveSubject(title: string): string {
  // Strip leading conventional-commit prefix if the user already used one
  // when naming the task, then trim down.
  const stripped = title.replace(/^([a-z]+)(\([^)]+\))?:\s*/i, "");
  return stripped.length > 60 ? stripped.slice(0, 57) + "…" : stripped;
}

function stripPrefix(s: string): string {
  // Drop the conventional-commit prefix from streamed model output so the
  // subject input shows just the description (the prefix dropdown handles
  // the rest of the title).
  return s.replace(/^([a-z]+)(\([^)]+\))?:\s*/i, "").trim();
}

function deriveBody(task: Task): string {
  const lines: string[] = [];
  lines.push("- " + (task.title || "what changed"));
  if (task.skills && task.skills.length > 0) {
    lines.push(`- skills used: ${task.skills.join(", ")}`);
  }
  if (task.permissionMode && task.permissionMode !== "bypassPermissions") {
    lines.push(`- permission mode: ${task.permissionMode}`);
  }
  return lines.join("\n");
}

void Upload;
void GitBranch;
