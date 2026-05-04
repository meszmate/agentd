import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  GitFork,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Rocket,
} from "lucide-react";
import type {
  GithubIssue,
  GithubPr,
  GithubSpawnRequest,
} from "@agentd/contracts";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useGithubIssues,
  useGithubPrs,
  useGithubStatus,
  useProject,
  useRefreshGithub,
  useSpawnGithubTask,
} from "@/queries";
import { useApp } from "@/AppContext";
import { cn, formatTs } from "@/lib/utils";

type Tab = "issues" | "prs";

/**
 * Project's GitHub view — issue + PR triage. Lists open issues / PRs
 * via `gh`, lets the operator spawn a task from any row (each PR task
 * lands in its own worktree on the PR's branch via `gh pr checkout`),
 * and surfaces PR management on the resulting task. Lives at
 * `/projects/:slug/github`; the project landing page links to it
 * when the repo has a GitHub remote.
 */
export function ProjectGithub() {
  const { slug } = useParams<{ slug: string }>();
  const projectQ = useProject(slug);
  const project = projectQ.data?.project ?? null;
  const projectId = project?.id ?? null;

  const statusQ = useGithubStatus();
  const issuesQ = useGithubIssues(projectId);
  const prsQ = useGithubPrs(projectId);
  const refresh = useRefreshGithub();
  const { toast } = useApp();

  const [tab, setTab] = useState<Tab>("prs");
  const [spawnFor, setSpawnFor] = useState<
    | { kind: "issue"; row: GithubIssue }
    | { kind: "pr"; row: GithubPr }
    | null
  >(null);

  const repo =
    issuesQ.data?.repo ?? prsQ.data?.repo ?? project?.githubRepo ?? null;

  const onRefresh = async () => {
    if (!projectId) return;
    try {
      await refresh.mutateAsync(projectId);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  if (projectQ.isLoading || !project) {
    return (
      <div className="flex h-full flex-col">
        <PageTopbar>
          <Skeleton className="h-3.5 w-32" />
        </PageTopbar>
        <div className="px-5 py-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const status = statusQ.data;
  const blocked = status && !status.ok;

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Link
          to={`/projects/${project.slug}`}
          className="inline-flex items-center gap-1 text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
        >
          <ArrowLeft className="h-3 w-3" />
          {project.name}
        </Link>
        <VRule />
        <Kicker>github</Kicker>
        <GitFork className="h-3.5 w-3.5 text-ink-500 dark:text-ink-400" />
        {repo ? (
          <a
            href={`https://github.com/${repo}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-ink-700 hover:text-ember-700 dark:text-ink-200 dark:hover:text-ember-300 truncate"
          >
            {repo}
          </a>
        ) : (
          <span className="font-mono text-[11px] text-ink-400 dark:text-ink-500">
            (no remote)
          </span>
        )}
        <Spacer />
        <Button
          size="xs"
          variant="outline"
          onClick={onRefresh}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </Button>
      </PageTopbar>

      {blocked && <GhSetupCard reason={status.reason ?? "gh unavailable"} />}

      {!blocked && !repo && (
        <div className="px-5 py-6">
          <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-6 py-10 text-center text-[12px] text-ink-500 dark:text-ink-400">
            No GitHub remote on <code className="font-mono">{project.path}</code>.{" "}
            Add one with <code className="font-mono">gh repo create</code> or{" "}
            <code className="font-mono">git remote add origin …</code>, then
            click Refresh.
          </div>
        </div>
      )}

      {!blocked && repo && (
        <>
          <div className="flex items-center gap-1 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-4 py-1.5 shrink-0">
            <TabPill
              active={tab === "prs"}
              onClick={() => setTab("prs")}
              label="Pull requests"
              count={prsQ.data?.prs.length}
            />
            <TabPill
              active={tab === "issues"}
              onClick={() => setTab("issues")}
              label="Issues"
              count={issuesQ.data?.issues.length}
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            {tab === "prs" ? (
              <PrList
                q={prsQ}
                onSpawn={(row) => setSpawnFor({ kind: "pr", row })}
              />
            ) : (
              <IssueList
                q={issuesQ}
                onSpawn={(row) => setSpawnFor({ kind: "issue", row })}
              />
            )}
          </div>
        </>
      )}

      {spawnFor && project && (
        <SpawnDialog
          target={spawnFor}
          projectIdOrSlug={project.slug}
          onClose={() => setSpawnFor(null)}
        />
      )}
    </div>
  );
}

function TabPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[11.5px] transition-colors",
        active
          ? "bg-ember-500/10 text-ember-700 dark:text-ember-300"
          : "text-ink-500 hover:text-ink-900 hover:bg-paper-100 dark:hover:bg-ink-700 dark:text-ink-400 dark:hover:text-ink-50",
      )}
    >
      {label}
      {typeof count === "number" && (
        <span className="font-mono text-[10px] tabular-nums opacity-70">
          {count}
        </span>
      )}
    </button>
  );
}

function GhSetupCard({ reason }: { reason: string }) {
  return (
    <div className="px-5 py-6">
      <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-5 py-5 max-w-2xl">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">
              GitHub CLI isn't ready
            </h3>
            <p className="mt-1 text-[11.5px] text-ink-600 dark:text-ink-300 leading-relaxed">
              {reason}
            </p>
            <div className="mt-3 space-y-1.5 font-mono text-[11px] text-ink-700 dark:text-ink-200">
              <div className="text-ink-400 dark:text-ink-500"># install</div>
              <code className="block bg-paper-100 dark:bg-ink-900/60 rounded px-2 py-1">
                brew install gh   # or your distro's package manager
              </code>
              <div className="text-ink-400 dark:text-ink-500 pt-2"># sign in</div>
              <code className="block bg-paper-100 dark:bg-ink-900/60 rounded px-2 py-1">
                gh auth login
              </code>
            </div>
            <p className="mt-3 text-[11px] text-ink-500 dark:text-ink-400">
              Once `gh auth status` is happy, click Refresh.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function PrList({
  q,
  onSpawn,
}: {
  q: ReturnType<typeof useGithubPrs>;
  onSpawn: (row: GithubPr) => void;
}) {
  if (q.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (!q.data?.ok) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700 dark:text-red-300">
        {q.data?.error ?? "gh pr list failed"}
      </div>
    );
  }
  if (q.data.prs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-6 py-10 text-center text-[12px] text-ink-500 dark:text-ink-400">
        No open pull requests.
      </div>
    );
  }
  return (
    <ul className="rounded-md border border-ink-900/10 bg-paper-50 divide-y divide-ink-900/[0.06] overflow-hidden dark:border-ink-50/10 dark:bg-ink-800 dark:divide-ink-50/[0.06]">
      {q.data.prs.map((pr) => (
        <PrRow key={pr.number} pr={pr} onSpawn={() => onSpawn(pr)} />
      ))}
    </ul>
  );
}

function PrRow({
  pr,
  onSpawn,
}: {
  pr: GithubPr;
  onSpawn: () => void;
}) {
  return (
    <li className="px-4 py-3 flex items-start gap-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors">
      <GitPullRequest
        className={cn(
          "h-4 w-4 shrink-0 mt-0.5",
          pr.isDraft
            ? "text-ink-400 dark:text-ink-500"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-medium text-ink-900 dark:text-ink-50 hover:text-ember-700 dark:hover:text-ember-300 truncate"
          >
            {pr.title}
          </a>
          <span className="font-mono text-[10.5px] text-ink-400 dark:text-ink-500 shrink-0">
            #{pr.number}
          </span>
          {pr.isDraft && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] px-1 rounded bg-ink-900/[0.05] dark:bg-ink-50/[0.05] text-ink-500 dark:text-ink-400">
              draft
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-ink-500 dark:text-ink-400">
          {pr.author?.login && <span>@{pr.author.login}</span>}
          <span>{pr.headRefName} → {pr.baseRefName}</span>
          <span className="ml-auto">{formatTs(new Date(pr.updatedAt).getTime())}</span>
        </div>
        {pr.labels.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {pr.labels.map((l) => (
              <LabelChip key={l.name} name={l.name} color={l.color} />
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="h-7 inline-flex items-center px-1.5 rounded text-ink-400 hover:text-ink-900 dark:hover:text-ink-50 transition-colors"
          title="open on github"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
        <Button size="xs" variant="outline" onClick={onSpawn}>
          <Rocket className="h-3 w-3" />
          Spawn task
        </Button>
      </div>
    </li>
  );
}

function IssueList({
  q,
  onSpawn,
}: {
  q: ReturnType<typeof useGithubIssues>;
  onSpawn: (row: GithubIssue) => void;
}) {
  if (q.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (!q.data?.ok) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700 dark:text-red-300">
        {q.data?.error ?? "gh issue list failed"}
      </div>
    );
  }
  if (q.data.issues.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-6 py-10 text-center text-[12px] text-ink-500 dark:text-ink-400">
        No open issues.
      </div>
    );
  }
  return (
    <ul className="rounded-md border border-ink-900/10 bg-paper-50 divide-y divide-ink-900/[0.06] overflow-hidden dark:border-ink-50/10 dark:bg-ink-800 dark:divide-ink-50/[0.06]">
      {q.data.issues.map((issue) => (
        <IssueRow
          key={issue.number}
          issue={issue}
          onSpawn={() => onSpawn(issue)}
        />
      ))}
    </ul>
  );
}

function IssueRow({
  issue,
  onSpawn,
}: {
  issue: GithubIssue;
  onSpawn: () => void;
}) {
  return (
    <li className="px-4 py-3 flex items-start gap-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors">
      <CircleDot className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-medium text-ink-900 dark:text-ink-50 hover:text-ember-700 dark:hover:text-ember-300 truncate"
          >
            {issue.title}
          </a>
          <span className="font-mono text-[10.5px] text-ink-400 dark:text-ink-500 shrink-0">
            #{issue.number}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-ink-500 dark:text-ink-400">
          {issue.author?.login && <span>@{issue.author.login}</span>}
          <span className="ml-auto">{formatTs(new Date(issue.updatedAt).getTime())}</span>
        </div>
        {issue.labels.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {issue.labels.map((l) => (
              <LabelChip key={l.name} name={l.name} color={l.color} />
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="h-7 inline-flex items-center px-1.5 rounded text-ink-400 hover:text-ink-900 dark:hover:text-ink-50 transition-colors"
          title="open on github"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
        <Button size="xs" variant="outline" onClick={onSpawn}>
          <Rocket className="h-3 w-3" />
          Spawn task
        </Button>
      </div>
    </li>
  );
}

function LabelChip({
  name,
  color,
}: {
  name: string;
  color?: string | null;
}) {
  // gh returns hex without `#`. Use it for the dot only — don't tint
  // text since some labels ship light colors that vanish in light mode.
  const dot = color ? `#${color}` : null;
  return (
    <span className="inline-flex items-center gap-1 h-4 px-1.5 rounded text-[9.5px] uppercase tracking-[0.08em] text-ink-600 dark:text-ink-300 bg-paper-100 dark:bg-ink-900/60 border border-ink-900/[0.06] dark:border-ink-50/[0.06]">
      {dot && (
        <span
          aria-hidden
          className="size-1.5 rounded-full inline-block"
          style={{ background: dot }}
        />
      )}
      {name}
    </span>
  );
}

function SpawnDialog({
  target,
  projectIdOrSlug,
  onClose,
}: {
  target:
    | { kind: "issue"; row: GithubIssue }
    | { kind: "pr"; row: GithubPr };
  projectIdOrSlug: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const spawn = useSpawnGithubTask();
  const { toast } = useApp();
  const [preset, setPreset] = useState<GithubSpawnRequest["preset"]>(
    target.kind === "pr" ? "review-pr" : "fix-issue",
  );
  const [prompt, setPrompt] = useState("");

  const presetOptions = useMemo<{ value: NonNullable<GithubSpawnRequest["preset"]>; label: string }[]>(
    () =>
      target.kind === "pr"
        ? [
            { value: "review-pr", label: "Review PR" },
            { value: "freeform", label: "Freeform" },
          ]
        : [
            { value: "fix-issue", label: "Fix issue" },
            { value: "freeform", label: "Freeform" },
          ],
    [target.kind],
  );

  const submit = async () => {
    try {
      const res = await spawn.mutateAsync({
        idOrSlug: projectIdOrSlug,
        req: {
          kind: target.kind,
          number: target.row.number,
          preset,
          ...(preset === "freeform" && prompt.trim()
            ? { prompt: prompt.trim() }
            : {}),
        },
      });
      onClose();
      navigate(`/tasks/${res.task.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            Spawn task from{" "}
            {target.kind === "pr" ? "PR" : "issue"} #{target.row.number}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-ink-900/10 dark:border-ink-50/10 px-3 py-2.5 bg-paper-100/40 dark:bg-ink-900/30">
            <div className="text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
              {target.row.title}
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-400 dark:text-ink-500 truncate">
              {target.row.url}
            </div>
          </div>

          <div>
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
              preset
            </div>
            <div className="flex gap-1.5">
              {presetOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPreset(opt.value)}
                  className={cn(
                    "h-7 px-2.5 rounded text-[11.5px] border transition-colors",
                    preset === opt.value
                      ? "border-ember-500/50 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                      : "border-ink-900/10 dark:border-ink-50/10 text-ink-600 hover:bg-paper-100 dark:text-ink-300 dark:hover:bg-ink-700",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {preset === "freeform" && (
            <div>
              <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
                prompt
              </div>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                placeholder="Tell the agent what to do… (the issue/PR body is added as context automatically)"
                className="text-[12.5px]"
              />
            </div>
          )}

          {target.kind === "pr" && (
            <p className="text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
              The new worktree will be checked out onto{" "}
              <code className="font-mono text-[10.5px]">
                {(target.row as GithubPr).headRefName}
              </code>{" "}
              via <code className="font-mono text-[10.5px]">gh pr checkout</code>.
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={
              spawn.isPending ||
              (preset === "freeform" && !prompt.trim())
            }
          >
            {spawn.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            Spawn
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

void CheckCircle2;
