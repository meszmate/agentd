import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  GitCommit,
  GitFork,
  GitPullRequest,
  HelpCircle,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  X,
} from "lucide-react";
import type {
  GithubIssue,
  GithubListQuery,
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FilterPills } from "@/components/ui/filter-pills";
import { Markdown } from "@/components/markdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useGithubIssue,
  useGithubIssues,
  useGithubPr,
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
 * Per-tab filter state. Search is the killer feature — accepts the
 * full github.com search syntax (`is:open author:foo label:bug
 * in:title,body`) and is debounced before driving the daemon. The
 * structured filters (state, author, assignee, labels, draft) layer on
 * top of the search query so operators can mix the two ways of
 * narrowing the list.
 */
interface Filters {
  state: "open" | "closed" | "merged" | "all";
  search: string;
  author: string;
  assignee: string;
  labels: string;
  draft: boolean;
  limit: number;
}

const DEFAULT_LIMIT = 50;

const defaultIssueFilters: Filters = {
  state: "open",
  search: "",
  author: "",
  assignee: "",
  labels: "",
  draft: false,
  limit: DEFAULT_LIMIT,
};

const defaultPrFilters: Filters = {
  state: "open",
  search: "",
  author: "",
  assignee: "",
  labels: "",
  draft: false,
  limit: DEFAULT_LIMIT,
};

/**
 * Project's GitHub view — issue + PR triage with full github.com-style
 * search and filtering. Lists are driven by `gh issue/pr list` and
 * accept the same filter vocabulary github.com uses (state, author,
 * assignee, labels, search query). Clicking a row opens a detail panel
 * with the full conversation (body, comments, reviews, commits) so the
 * operator can read everything before spawning a task. The spawn flow
 * injects the same conversation into the agent's prompt so it lands
 * knowing what reviewers already said.
 */
export function ProjectGithub() {
  const { slug } = useParams<{ slug: string }>();
  const projectQ = useProject(slug);
  const project = projectQ.data?.project ?? null;
  const projectId = project?.id ?? null;

  const statusQ = useGithubStatus();
  const refresh = useRefreshGithub();
  const { toast } = useApp();

  const [tab, setTab] = useState<Tab>("prs");
  const [issueFilters, setIssueFilters] = useState<Filters>(defaultIssueFilters);
  const [prFilters, setPrFilters] = useState<Filters>(defaultPrFilters);
  const [spawnFor, setSpawnFor] = useState<
    | { kind: "issue"; row: GithubIssue }
    | { kind: "pr"; row: GithubPr }
    | null
  >(null);
  const [detailFor, setDetailFor] = useState<
    | { kind: "issue"; number: number; preview: GithubIssue }
    | { kind: "pr"; number: number; preview: GithubPr }
    | null
  >(null);

  // Debounce the search input so each keystroke doesn't shell out.
  const debouncedIssueOpts = useDebouncedFilters(issueFilters, "issue");
  const debouncedPrOpts = useDebouncedFilters(prFilters, "pr");

  const issuesQ = useGithubIssues(projectId, debouncedIssueOpts);
  const prsQ = useGithubPrs(projectId, debouncedPrOpts);

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

          <div className="flex-1 min-h-0 overflow-y-auto">
            {tab === "prs" ? (
              <>
                <FiltersBar
                  kind="pr"
                  filters={prFilters}
                  onChange={setPrFilters}
                  loading={prsQ.isFetching}
                />
                <div className="px-5 py-3">
                  <PrList
                    q={prsQ}
                    onSpawn={(row) => setSpawnFor({ kind: "pr", row })}
                    onView={(row) =>
                      setDetailFor({ kind: "pr", number: row.number, preview: row })
                    }
                  />
                  {prsQ.data?.ok && prsQ.data.prs.length >= prFilters.limit && (
                    <LoadMore
                      onClick={() =>
                        setPrFilters((f) => ({ ...f, limit: f.limit + DEFAULT_LIMIT }))
                      }
                      total={prsQ.data.prs.length}
                    />
                  )}
                </div>
              </>
            ) : (
              <>
                <FiltersBar
                  kind="issue"
                  filters={issueFilters}
                  onChange={setIssueFilters}
                  loading={issuesQ.isFetching}
                />
                <div className="px-5 py-3">
                  <IssueList
                    q={issuesQ}
                    onSpawn={(row) => setSpawnFor({ kind: "issue", row })}
                    onView={(row) =>
                      setDetailFor({ kind: "issue", number: row.number, preview: row })
                    }
                  />
                  {issuesQ.data?.ok &&
                    issuesQ.data.issues.length >= issueFilters.limit && (
                      <LoadMore
                        onClick={() =>
                          setIssueFilters((f) => ({
                            ...f,
                            limit: f.limit + DEFAULT_LIMIT,
                          }))
                        }
                        total={issuesQ.data.issues.length}
                      />
                    )}
                </div>
              </>
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

      {detailFor && projectId && (
        <DetailDialog
          target={detailFor}
          projectId={projectId}
          repo={repo}
          onClose={() => setDetailFor(null)}
          onSpawn={() => {
            const t = detailFor;
            setDetailFor(null);
            if (t.kind === "pr") setSpawnFor({ kind: "pr", row: t.preview });
            else setSpawnFor({ kind: "issue", row: t.preview });
          }}
        />
      )}
    </div>
  );
}

/**
 * Debounce the search-driven filters into a `GithubListQuery` shape
 * suitable for `useGithubIssues` / `useGithubPrs`. Search debounces by
 * 300ms; structured filters apply immediately (a pill click should
 * feel instant).
 */
function useDebouncedFilters(filters: Filters, kind: "issue" | "pr"): GithubListQuery {
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(id);
  }, [filters.search]);
  return useMemo(() => {
    const labels = filters.labels
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const opts: GithubListQuery = {
      state: filters.state,
      limit: filters.limit,
    };
    if (debouncedSearch.trim()) opts.search = debouncedSearch.trim();
    if (filters.author.trim()) opts.author = filters.author.trim();
    if (filters.assignee.trim()) opts.assignee = filters.assignee.trim();
    if (labels.length > 0) opts.labels = labels;
    if (kind === "pr" && filters.draft) opts.draft = true;
    return opts;
  }, [
    filters.state,
    filters.author,
    filters.assignee,
    filters.labels,
    filters.draft,
    filters.limit,
    debouncedSearch,
    kind,
  ]);
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

/**
 * Search + structured filter bar. Mirrors github.com's filter UI: a
 * full-text search box that accepts github search syntax, a state
 * picker (open/closed/merged/all), author/assignee/labels free-text
 * inputs, and a PR-only draft toggle.
 */
function FiltersBar({
  kind,
  filters,
  onChange,
  loading,
}: {
  kind: "issue" | "pr";
  filters: Filters;
  onChange: (next: Filters) => void;
  loading: boolean;
}) {
  const [showSyntaxHelp, setShowSyntaxHelp] = useState(false);
  const stateOptions =
    kind === "pr"
      ? ([
          { key: "open", label: "Open" },
          { key: "closed", label: "Closed" },
          { key: "merged", label: "Merged" },
          { key: "all", label: "All" },
        ] as const)
      : ([
          { key: "open", label: "Open" },
          { key: "closed", label: "Closed" },
          { key: "all", label: "All" },
        ] as const);

  const reset = () =>
    onChange(kind === "pr" ? defaultPrFilters : defaultIssueFilters);
  const isModified =
    filters.search.trim() !== "" ||
    filters.author.trim() !== "" ||
    filters.assignee.trim() !== "" ||
    filters.labels.trim() !== "" ||
    filters.draft ||
    filters.state !== "open" ||
    filters.limit !== DEFAULT_LIMIT;

  return (
    <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-5 py-3 space-y-2.5">
      {/* Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-400 dark:text-ink-500 pointer-events-none" />
          <Input
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            placeholder={
              kind === "pr"
                ? "Search PRs… (e.g. is:open author:foo label:bug in:title,body)"
                : "Search issues… (e.g. is:open no:assignee sort:created-asc)"
            }
            className="h-8 pl-8 pr-8 text-[12.5px]"
          />
          {filters.search && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, search: "" })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-900 dark:hover:text-ink-50"
              title="clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowSyntaxHelp((v) => !v)}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md text-ink-400 hover:text-ink-900 hover:bg-paper-100 dark:hover:bg-ink-700 dark:hover:text-ink-50 transition-colors"
          title="search syntax help"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
        {loading && (
          <Loader2 className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 animate-spin shrink-0" />
        )}
        {isModified && (
          <Button size="xs" variant="ghost" onClick={reset}>
            Reset
          </Button>
        )}
      </div>

      {showSyntaxHelp && (
        <div className="rounded-md border border-ink-900/10 dark:border-ink-50/10 bg-paper-100/40 dark:bg-ink-900/30 px-3 py-2.5 text-[11px] text-ink-600 dark:text-ink-300 leading-relaxed">
          <div className="font-medium text-ink-900 dark:text-ink-50 mb-1">
            GitHub search syntax
          </div>
          <p className="mb-1.5">
            Mix any qualifiers github.com supports —{" "}
            <code className="font-mono">is:open</code>,{" "}
            <code className="font-mono">author:foo</code>,{" "}
            <code className="font-mono">assignee:@me</code>,{" "}
            <code className="font-mono">label:bug</code>,{" "}
            <code className="font-mono">in:title,body</code>,{" "}
            <code className="font-mono">no:assignee</code>,{" "}
            <code className="font-mono">sort:created-asc</code>,{" "}
            <code className="font-mono">created:&gt;2024-01-01</code>.
          </p>
          <p>
            Plain words search title + body. Combine with the structured
            filters below — they layer on top of the search query.
          </p>
        </div>
      )}

      {/* Structured filters */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterPills
          options={stateOptions as unknown as { key: string; label: string }[]}
          value={filters.state}
          onChange={(v) =>
            onChange({ ...filters, state: v as Filters["state"] })
          }
        />
        <FilterTextInput
          icon="@"
          placeholder="author"
          value={filters.author}
          onChange={(v) => onChange({ ...filters, author: v })}
        />
        <FilterTextInput
          icon="◎"
          placeholder="assignee (or @me)"
          value={filters.assignee}
          onChange={(v) => onChange({ ...filters, assignee: v })}
        />
        <FilterTextInput
          icon="▣"
          placeholder="labels (comma-separated)"
          value={filters.labels}
          onChange={(v) => onChange({ ...filters, labels: v })}
          width="w-52"
        />
        {kind === "pr" && (
          <label className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-600 dark:text-ink-300 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={filters.draft}
              onChange={(e) =>
                onChange({ ...filters, draft: e.target.checked })
              }
              className="h-3.5 w-3.5 accent-ember-500 cursor-pointer"
            />
            Draft only
          </label>
        )}
      </div>
    </div>
  );
}

function FilterTextInput({
  icon,
  placeholder,
  value,
  onChange,
  width = "w-36",
}: {
  icon: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  width?: string;
}) {
  return (
    <div className={cn("relative", width)}>
      <span className="absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] text-ink-400 dark:text-ink-500 pointer-events-none">
        {icon}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 pl-6 pr-6 text-[11.5px]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-900 dark:hover:text-ink-50"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function LoadMore({ onClick, total }: { onClick: () => void; total: number }) {
  return (
    <div className="mt-4 flex justify-center">
      <Button size="xs" variant="outline" onClick={onClick}>
        <Plus className="h-3 w-3" />
        Load more (showing {total})
      </Button>
    </div>
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
  onView,
}: {
  q: ReturnType<typeof useGithubPrs>;
  onSpawn: (row: GithubPr) => void;
  onView: (row: GithubPr) => void;
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
        No pull requests match your filters.
      </div>
    );
  }
  return (
    <ul className="rounded-md border border-ink-900/10 bg-paper-50 divide-y divide-ink-900/[0.06] overflow-hidden dark:border-ink-50/10 dark:bg-ink-800 dark:divide-ink-50/[0.06]">
      {q.data.prs.map((pr) => (
        <PrRow
          key={pr.number}
          pr={pr}
          onSpawn={() => onSpawn(pr)}
          onView={() => onView(pr)}
        />
      ))}
    </ul>
  );
}

function PrStateIcon({ pr }: { pr: GithubPr }) {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") {
    return (
      <GitPullRequest className="h-4 w-4 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
    );
  }
  if (state === "CLOSED") {
    return (
      <GitPullRequest className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
    );
  }
  return (
    <GitPullRequest
      className={cn(
        "h-4 w-4 shrink-0 mt-0.5",
        pr.isDraft
          ? "text-ink-400 dark:text-ink-500"
          : "text-emerald-600 dark:text-emerald-400",
      )}
    />
  );
}

function ReviewBadge({ decision }: { decision: string | null | undefined }) {
  if (!decision) return null;
  const tone =
    decision === "APPROVED"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : decision === "CHANGES_REQUESTED"
        ? "bg-red-500/10 text-red-700 dark:text-red-300"
        : "bg-ink-900/[0.05] dark:bg-ink-50/[0.05] text-ink-500 dark:text-ink-400";
  const label =
    decision === "APPROVED"
      ? "approved"
      : decision === "CHANGES_REQUESTED"
        ? "changes requested"
        : decision === "REVIEW_REQUIRED"
          ? "review required"
          : decision.toLowerCase();
  return (
    <span
      className={cn(
        "font-mono text-[9.5px] uppercase tracking-[0.12em] px-1 rounded",
        tone,
      )}
    >
      {label}
    </span>
  );
}

function PrRow({
  pr,
  onSpawn,
  onView,
}: {
  pr: GithubPr;
  onSpawn: () => void;
  onView: () => void;
}) {
  return (
    <li
      className="px-4 py-3 flex items-start gap-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors cursor-pointer"
      onClick={onView}
    >
      <PrStateIcon pr={pr} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {pr.title}
          </span>
          <span className="font-mono text-[10.5px] text-ink-400 dark:text-ink-500 shrink-0">
            #{pr.number}
          </span>
          {pr.isDraft && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] px-1 rounded bg-ink-900/[0.05] dark:bg-ink-50/[0.05] text-ink-500 dark:text-ink-400">
              draft
            </span>
          )}
          <ReviewBadge decision={pr.reviewDecision} />
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-ink-500 dark:text-ink-400 flex-wrap">
          {pr.author?.login && <span>@{pr.author.login}</span>}
          <span>{pr.headRefName} → {pr.baseRefName}</span>
          {typeof pr.changedFiles === "number" && (
            <span>
              {pr.changedFiles}f +{pr.additions ?? 0}/-{pr.deletions ?? 0}
            </span>
          )}
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
      <div
        className="flex items-center gap-1.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
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
  onView,
}: {
  q: ReturnType<typeof useGithubIssues>;
  onSpawn: (row: GithubIssue) => void;
  onView: (row: GithubIssue) => void;
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
        No issues match your filters.
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
          onView={() => onView(issue)}
        />
      ))}
    </ul>
  );
}

function IssueStateIcon({ issue }: { issue: GithubIssue }) {
  const state = issue.state.toUpperCase();
  if (state === "CLOSED") {
    return (
      <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
    );
  }
  return (
    <CircleDot className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
  );
}

function IssueRow({
  issue,
  onSpawn,
  onView,
}: {
  issue: GithubIssue;
  onSpawn: () => void;
  onView: () => void;
}) {
  return (
    <li
      className="px-4 py-3 flex items-start gap-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors cursor-pointer"
      onClick={onView}
    >
      <IssueStateIcon issue={issue} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {issue.title}
          </span>
          <span className="font-mono text-[10.5px] text-ink-400 dark:text-ink-500 shrink-0">
            #{issue.number}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-ink-500 dark:text-ink-400 flex-wrap">
          {issue.author?.login && <span>@{issue.author.login}</span>}
          {issue.assignees && issue.assignees.length > 0 && (
            <span>
              ◎ {issue.assignees.map((a) => "@" + a.login).join(", ")}
            </span>
          )}
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
      <div
        className="flex items-center gap-1.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
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

/**
 * Per-row detail panel — pulls the full conversation (body, commits,
 * reviews, comments) so the operator can read everything that
 * happened on the item before they decide to spawn a task. Same data
 * the spawn flow injects into the agent's prompt.
 */
function DetailDialog({
  target,
  projectId,
  repo,
  onClose,
  onSpawn,
}: {
  target:
    | { kind: "issue"; number: number; preview: GithubIssue }
    | { kind: "pr"; number: number; preview: GithubPr };
  projectId: string;
  repo: string | null;
  onClose: () => void;
  onSpawn: () => void;
}) {
  const issueQ = useGithubIssue(
    target.kind === "issue" ? projectId : null,
    target.kind === "issue" ? target.number : null,
  );
  const prQ = useGithubPr(
    target.kind === "pr" ? projectId : null,
    target.kind === "pr" ? target.number : null,
  );

  const detail =
    target.kind === "issue"
      ? (issueQ.data?.issue ?? target.preview)
      : (prQ.data?.pr ?? target.preview);
  const loading = target.kind === "issue" ? issueQ.isLoading : prQ.isLoading;
  const errored =
    target.kind === "issue"
      ? issueQ.data?.ok === false
      : prQ.data?.ok === false;
  const errorText =
    target.kind === "issue"
      ? (issueQ.data?.error ?? "")
      : (prQ.data?.error ?? "");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-ink-400 dark:text-ink-500">
              {target.kind === "pr" ? "PR" : "Issue"} #{target.number}
            </span>
            <span className="truncate">{detail.title}</span>
          </DialogTitle>
          <div className="mt-1 flex items-center gap-3 font-mono text-[10.5px] text-ink-500 dark:text-ink-400 flex-wrap">
            {repo && <span>{repo}</span>}
            {detail.author?.login && <span>@{detail.author.login}</span>}
            <span>{detail.state.toLowerCase()}</span>
            {target.kind === "pr" && (
              <span>
                {(detail as GithubPr).headRefName} →{" "}
                {(detail as GithubPr).baseRefName}
              </span>
            )}
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-ink-400 hover:text-ember-700 dark:hover:text-ember-300 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              github.com
            </a>
          </div>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-4">
          {target.kind === "pr" ? (
            <PrDetailBody pr={detail as GithubPr} loading={loading} />
          ) : (
            <IssueDetailBody issue={detail as GithubIssue} loading={loading} />
          )}
          {errored && (
            <div className="rounded-md border border-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[11.5px] text-red-700 dark:text-red-300">
              {errorText || "gh view failed"}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06]">
          <p className="text-[10.5px] text-ink-400 dark:text-ink-500">
            The agent receives this entire conversation when you spawn.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={onSpawn}>
              <Rocket className="h-3.5 w-3.5" />
              Spawn task
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConversationSection({
  icon,
  title,
  count,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
        {icon}
        <span>{title}</span>
        {typeof count === "number" && (
          <span className="text-ink-400 dark:text-ink-500">· {count}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function CommentBlock({
  author,
  when,
  body,
  state,
}: {
  author?: string | null;
  when?: string;
  body: string;
  state?: string;
}) {
  const tone =
    state === "APPROVED"
      ? "border-emerald-500/30"
      : state === "CHANGES_REQUESTED"
        ? "border-red-500/30"
        : "border-ink-900/10 dark:border-ink-50/10";
  return (
    <div className={cn("rounded-md border bg-paper-50 dark:bg-ink-800 px-3 py-2", tone)}>
      <div className="flex items-center gap-2 mb-1 font-mono text-[10.5px] text-ink-500 dark:text-ink-400">
        <span>{author ? `@${author}` : "(unknown)"}</span>
        {state && (
          <span className="uppercase tracking-[0.1em] text-[9.5px]">
            {state.toLowerCase()}
          </span>
        )}
        {when && <span className="ml-auto">{when}</span>}
      </div>
      {body.trim() ? (
        <Markdown text={body} />
      ) : (
        <span className="text-[11.5px] italic text-ink-400 dark:text-ink-500">
          (no body)
        </span>
      )}
    </div>
  );
}

function IssueDetailBody({
  issue,
  loading,
}: {
  issue: GithubIssue;
  loading: boolean;
}) {
  const comments = issue.comments ?? [];
  return (
    <div className="space-y-4 pt-1">
      <ConversationSection title="Description">
        <div className="rounded-md border border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-800 px-3 py-2">
          {issue.body?.trim() ? (
            <Markdown text={issue.body} />
          ) : (
            <span className="text-[11.5px] italic text-ink-400 dark:text-ink-500">
              (no description)
            </span>
          )}
        </div>
      </ConversationSection>

      {issue.labels.length > 0 && (
        <ConversationSection title="Labels">
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((l) => (
              <LabelChip key={l.name} name={l.name} color={l.color} />
            ))}
          </div>
        </ConversationSection>
      )}

      {loading && comments.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <ConversationSection
          icon={<MessageSquare className="h-3 w-3" />}
          title="Comments"
          count={comments.length}
        >
          {comments.length === 0 ? (
            <div className="text-[11.5px] italic text-ink-400 dark:text-ink-500">
              No comments yet.
            </div>
          ) : (
            <div className="space-y-2">
              {comments.map((c, i) => (
                <CommentBlock
                  key={i}
                  author={c.author?.login}
                  when={c.createdAt}
                  body={c.body}
                />
              ))}
            </div>
          )}
        </ConversationSection>
      )}
    </div>
  );
}

function PrDetailBody({ pr, loading }: { pr: GithubPr; loading: boolean }) {
  const reviews = pr.reviews ?? [];
  const comments = pr.comments ?? [];
  const commits = pr.commits ?? [];
  return (
    <div className="space-y-4 pt-1">
      <ConversationSection title="Description">
        <div className="rounded-md border border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-800 px-3 py-2">
          {pr.body?.trim() ? (
            <Markdown text={pr.body} />
          ) : (
            <span className="text-[11.5px] italic text-ink-400 dark:text-ink-500">
              (no description)
            </span>
          )}
        </div>
      </ConversationSection>

      {(pr.labels.length > 0 || pr.reviewDecision || pr.mergeStateStatus) && (
        <ConversationSection title="Status">
          <div className="flex flex-wrap gap-1.5 items-center">
            <ReviewBadge decision={pr.reviewDecision} />
            {pr.mergeStateStatus && (
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] px-1 rounded bg-ink-900/[0.05] dark:bg-ink-50/[0.05] text-ink-500 dark:text-ink-400">
                merge: {pr.mergeStateStatus.toLowerCase()}
              </span>
            )}
            {pr.labels.map((l) => (
              <LabelChip key={l.name} name={l.name} color={l.color} />
            ))}
          </div>
        </ConversationSection>
      )}

      {loading && commits.length === 0 ? (
        <Skeleton className="h-20 w-full" />
      ) : commits.length > 0 ? (
        <ConversationSection
          icon={<GitCommit className="h-3 w-3" />}
          title="Commits"
          count={commits.length}
        >
          <ul className="rounded-md border border-ink-900/10 dark:border-ink-50/10 divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06] bg-paper-50 dark:bg-ink-800 overflow-hidden">
            {commits.slice(0, 30).map((c) => (
              <li
                key={c.oid}
                className="px-3 py-1.5 flex items-center gap-2 text-[11.5px]"
              >
                <code className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
                  {c.oid.slice(0, 7)}
                </code>
                <span className="truncate text-ink-700 dark:text-ink-200">
                  {c.messageHeadline}
                </span>
              </li>
            ))}
            {commits.length > 30 && (
              <li className="px-3 py-1.5 text-[11px] text-ink-400 dark:text-ink-500">
                … and {commits.length - 30} more
              </li>
            )}
          </ul>
        </ConversationSection>
      ) : null}

      {loading && reviews.length === 0 ? (
        <Skeleton className="h-20 w-full" />
      ) : reviews.length > 0 ? (
        <ConversationSection title="Reviews" count={reviews.length}>
          <div className="space-y-2">
            {reviews.map((r, i) => (
              <div key={i} className="space-y-1">
                <CommentBlock
                  author={r.author?.login}
                  when={r.submittedAt}
                  body={r.body}
                  state={r.state}
                />
                {r.comments && r.comments.length > 0 && (
                  <ul className="ml-3 pl-3 border-l border-ink-900/10 dark:border-ink-50/10 space-y-1">
                    {r.comments.map((ic, j) => (
                      <li
                        key={j}
                        className="text-[11px] text-ink-600 dark:text-ink-300"
                      >
                        {ic.path && (
                          <code className="font-mono text-[10px] text-ink-400 dark:text-ink-500 mr-1">
                            {ic.path}
                          </code>
                        )}
                        {ic.body}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </ConversationSection>
      ) : null}

      {loading && comments.length === 0 ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <ConversationSection
          icon={<MessageSquare className="h-3 w-3" />}
          title="Conversation"
          count={comments.length}
        >
          {comments.length === 0 ? (
            <div className="text-[11.5px] italic text-ink-400 dark:text-ink-500">
              No comments yet.
            </div>
          ) : (
            <div className="space-y-2">
              {comments.map((c, i) => (
                <CommentBlock
                  key={i}
                  author={c.author?.login}
                  when={c.createdAt}
                  body={c.body}
                />
              ))}
            </div>
          )}
        </ConversationSection>
      )}
    </div>
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
                placeholder="Tell the agent what to do… (the full issue/PR conversation — body, comments, reviews — is added as context automatically)"
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
