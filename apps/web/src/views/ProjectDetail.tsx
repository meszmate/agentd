import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  BookText,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Copy,
  CornerDownLeft,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  Hash,
  Lightbulb,
  Loader2,
  MessageCircle,
  Plus,
  Rocket,
  Settings2,
  Send,
  Sparkles,
  TerminalSquare,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  THINKING_LEVELS_BY_AGENT,
  clampThinkingLevel,
  type PermissionMode,
  type Project,
  type Task,
  type TaskStatus,
  type ThinkingLevel,
} from "@agentd/contracts";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { InstructionsWorkshopDialog } from "@/components/instructions-workshop";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useBridgeSummary,
  useCreateTask,
  useDeleteProject,
  useDiscordChannels,
  useModels,
  usePatchPrefs,
  usePrefs,
  useProject,
  useProjectGitState,
  usePullProject,
  useSkills,
  useTasks,
  useUpdateProject,
} from "@/queries";
import {
  ChatConnectSheet,
  type ChatPlatform,
} from "@/components/chat-connect-sheet";
import { BrainstormHero } from "@/views/ProjectBrainstorm";
import { useApp, useClient } from "@/AppContext";
import { useStore } from "@/store";
import {
  cn,
  formatCost,
  formatTokens,
  formatTs,
} from "@/lib/utils";
import { useRecentPulse } from "@/realtime";

const ACTIVE_STATUSES: TaskStatus[] = [
  "running",
  "waiting_input",
  "waiting_perm",
  "pending",
];

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const projectQ = useProject(slug);
  const tasksQ = useTasks();
  const setCurrentProjectId = useStore((s) => s.setCurrentProjectId);
  const clearUnread = useStore((s) => s.clearUnread);

  const project = projectQ.data?.project ?? null;

  useEffect(() => {
    if (project) {
      setCurrentProjectId(project.id);
      clearUnread(project.id);
    }
    return () => setCurrentProjectId(null);
  }, [project, setCurrentProjectId, clearUnread]);

  const tasksForProject = useMemo(() => {
    const all = tasksQ.data?.tasks ?? [];
    if (!project) return [];
    return all.filter(
      (t) => t.projectId === project.id || t.repoPath === project.path,
    );
  }, [tasksQ.data, project]);

  const stats = useMemo(() => {
    const startOfDay = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const startOfWeek = startOfDay - 6 * 24 * 60 * 60 * 1000;
    let active = 0;
    let doneTotal = 0;
    let doneToday = 0;
    let failed = 0;
    let costWeek = 0;
    let totalCost = 0;
    let totalTok = 0;
    for (const t of tasksForProject) {
      if (ACTIVE_STATUSES.includes(t.status)) active += 1;
      if (t.status === "done") {
        doneTotal += 1;
        if (t.updatedAt >= startOfDay) doneToday += 1;
      }
      if (t.status === "failed") failed += 1;
      if (t.updatedAt >= startOfWeek) costWeek += t.totalCostUsd ?? 0;
      totalCost += t.totalCostUsd ?? 0;
      totalTok += (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0);
    }
    return {
      active,
      doneTotal,
      doneToday,
      failed,
      costWeek,
      totalCost,
      totalTok,
    };
  }, [tasksForProject]);

  const lanes = useMemo(() => {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const active: Task[] = [];
    const recent: Task[] = [];
    const archive: Task[] = [];
    for (const t of tasksForProject) {
      if (ACTIVE_STATUSES.includes(t.status)) active.push(t);
      else if (t.updatedAt >= dayAgo) recent.push(t);
      else archive.push(t);
    }
    return { active, recent, archive };
  }, [tasksForProject]);

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
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
        >
          <ArrowLeft className="h-3 w-3" />
          Projects
        </Link>
        <VRule />
        <Kicker>project</Kicker>
        <span
          className="size-3 rounded-md shrink-0"
          style={{ background: project.color || "#DC2626" }}
        />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate">
          {project.name}
        </span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums text-ink-500 dark:text-ink-400">
          {tasksForProject.length} tasks
        </span>
        {stats.active > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums text-ember-700 dark:text-ember-300">
              {stats.active} live
            </span>
          </>
        )}
        <Spacer />
        <ProjectActions project={project} onDeleted={() => navigate("/projects")} />
      </PageTopbar>

      {/* Header strip — full path + meta */}
      <div className="flex items-center gap-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 px-5 py-2 shrink-0">
        <FolderGit2 className="h-3 w-3 text-ink-400 dark:text-ink-500 shrink-0" />
        <code className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate flex-1">
          {project.path}
        </code>
        <RepoStatusChip slug={project.slug} />
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
          last active {formatTs(project.lastActiveAt)}
        </span>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0">
        <StatCell
          label="active"
          value={stats.active}
          tone={stats.active > 0 ? "ember" : "muted"}
        />
        <StatCell
          label="done"
          value={stats.doneTotal}
          sub={stats.doneToday > 0 ? `+${stats.doneToday} today` : undefined}
          tone="emerald"
        />
        <StatCell
          label="failed"
          value={stats.failed}
          tone={stats.failed > 0 ? "red" : "muted"}
        />
        <StatCell
          label="$ this week"
          value={formatCost(stats.costWeek)}
          sub={`${formatCost(stats.totalCost)} total`}
        />
        <StatCell
          label="tokens"
          value={formatTokens(stats.totalTok)}
          sub="all time"
          last
        />
      </div>

      {/* Two-column body */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <main className="overflow-y-auto px-5 py-5 space-y-5 min-w-0 border-r border-ink-900/[0.06] dark:border-ink-50/[0.06]">
          <BrainstormHero
            projectId={project.id}
            projectSlug={project.slug}
            projectName={project.name}
          />
          <QuickTaskRow project={project} />

          {tasksForProject.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink-900/15 px-6 py-10 text-center text-[12px] text-ink-500 dark:border-ink-50/15 dark:text-ink-400">
              No tasks here yet. Brainstorm above to pick from real ideas, or
              "+ Quick task" for a one-shot prompt.
            </div>
          ) : (
            <>
              {lanes.active.length > 0 && (
                <Lane heading="Active" tasks={lanes.active} accent />
              )}
              {lanes.recent.length > 0 && (
                <Lane heading="Recent" hint="last 24 hours" tasks={lanes.recent} />
              )}
              {lanes.archive.length > 0 && (
                <Lane heading="Archive" tasks={lanes.archive} muted />
              )}
            </>
          )}
        </main>

        <aside className="hidden lg:flex flex-col overflow-y-auto bg-paper-100/40 dark:bg-ink-900/30">
          <ProjectInstructionsPanel project={project} />
          <ConnectChatPanel project={project} />
          <AutoContextPanel projectPath={project.path} />
          <RecentChatter tasks={tasksForProject} />
          <PathReference path={project.path} />
        </aside>
      </div>
    </div>
  );
}

/* ── Repo sync chip ─────────────────────────────────────────────── */

/**
 * Compact summary of where the project's working tree sits relative to
 * its origin remote. Shows current branch, ahead/behind counts, and a
 * dirty-files badge. Click → triggers a fresh `git fetch` so the user
 * gets a manual refresh on demand without waiting for the 60s tick.
 */
function RepoStatusChip({ slug }: { slug: string }) {
  const stateQ = useProjectGitState(slug);
  const pull = usePullProject();
  const { toast } = useApp();
  const s = stateQ.data;

  if (stateQ.isLoading || !s) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
        <Loader2 className="h-3 w-3 animate-spin" />
        syncing
      </span>
    );
  }

  const synced =
    s.hasUpstream && s.ahead === 0 && s.behind === 0 && s.dirty === 0;
  // Show the pull affordance whenever origin has commits we don't.
  // Dirty trees can't fast-forward — keep the button visible but
  // disable it with an explanation so the operator knows what's
  // blocking.
  const showPull = s.hasUpstream && s.behind > 0;
  const pullBlocked = s.dirty > 0;

  return (
    <span className="inline-flex items-center gap-2 font-mono text-[10px] shrink-0">
      <span className="inline-flex items-center gap-1 text-ink-500 dark:text-ink-400">
        <GitBranch className="h-3 w-3" />
        {s.branch || "(detached)"}
      </span>
      {!s.hasUpstream ? (
        <span className="inline-flex items-center gap-1 px-1 rounded text-amber-700 dark:text-amber-400 bg-amber-500/10">
          no upstream
        </span>
      ) : synced ? (
        <span className="inline-flex items-center gap-1 px-1 rounded text-emerald-700 dark:text-emerald-400 bg-emerald-500/10">
          <Check className="h-3 w-3" />
          synced
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          {s.ahead > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1 rounded text-sky-700 dark:text-sky-400 bg-sky-500/10"
              title={`${s.ahead} commit(s) not pushed to origin/${s.branch}`}
            >
              <ArrowUp className="h-3 w-3" />
              {s.ahead}
            </span>
          )}
          {s.behind > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1 rounded text-ember-700 dark:text-ember-300 bg-ember-500/10"
              title={`origin/${s.branch} is ${s.behind} commit(s) ahead — pull to catch up`}
            >
              <ArrowDown className="h-3 w-3" />
              {s.behind}
            </span>
          )}
          {s.dirty > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1 rounded text-amber-700 dark:text-amber-400 bg-amber-500/10"
              title={`${s.dirty} uncommitted file(s) in the worktree`}
            >
              <CircleDot className="h-3 w-3" />
              {s.dirty} dirty
            </span>
          )}
        </span>
      )}
      {showPull && (
        <button
          type="button"
          disabled={pull.isPending || pullBlocked}
          title={
            pullBlocked
              ? `commit or stash ${s.dirty} dirty file(s) before pulling`
              : `git pull --ff-only origin ${s.branch}`
          }
          onClick={async () => {
            try {
              const r = await pull.mutateAsync(slug);
              if (r.error) toast(r.error, true);
              else if (r.ok) toast(`pulled ${s.behind} commit(s)`);
              else if (r.message) toast(r.message);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
          className="inline-flex items-center gap-1 px-1.5 h-4 rounded text-[10px] uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pull.isPending ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <ArrowDown className="h-2.5 w-2.5" />
          )}
          {pull.isPending ? "pulling" : "pull"}
        </button>
      )}
    </span>
  );
}

/* ── Header actions ─────────────────────────────────────────────── */

function ProjectActions({
  project,
  onDeleted,
}: {
  project: { id: string; slug: string; path: string; name: string };
  onDeleted: () => void;
}) {
  const { toast } = useApp();
  const client = useClient();
  const del = useDeleteProject();

  const onCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(project.path);
      toast(`copied ${project.path}`);
    } catch {
      toast("clipboard unavailable", true);
    }
  };

  const onOpenShell = async () => {
    const name = `proj-${project.slug}`;
    try {
      await client.createTerminalSession({ name, cwd: project.path });
    } catch {
      // already exists is fine
    }
    window.location.assign(`/terminal/${encodeURIComponent(name)}`);
  };

  const onDelete = async () => {
    if (
      !confirm(
        `Remove project "${project.name}"? This drops the agentd record only — your repo on disk is untouched.`,
      )
    )
      return;
    try {
      await del.mutateAsync(project.slug);
      toast(`removed ${project.name}`);
      onDeleted();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button size="xs" variant="outline" onClick={onCopyPath}>
        <Copy className="h-3 w-3" />
        Copy path
      </Button>
      <Button size="xs" variant="outline" onClick={onOpenShell}>
        <TerminalSquare className="h-3 w-3" />
        Shell
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" title="more">
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="text-red-700 dark:text-red-300"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
            Remove project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/* ── Stat cell ─────────────────────────────────────────────────── */

function StatCell({
  label,
  value,
  sub,
  tone,
  last,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "ember" | "emerald" | "red" | "muted";
  last?: boolean;
}) {
  const valueClass =
    tone === "ember"
      ? "text-ember-700 dark:text-ember-300"
      : tone === "emerald"
        ? "text-emerald-700 dark:text-emerald-300"
        : tone === "red"
          ? "text-red-700 dark:text-red-300"
          : tone === "muted"
            ? "text-ink-400 dark:text-ink-500"
            : "text-ink-900 dark:text-ink-50";
  return (
    <div
      className={cn(
        "px-5 py-3",
        !last && "border-r border-ink-900/[0.06] dark:border-ink-50/[0.06]",
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 font-medium">
        {label}
      </div>
      <div className={cn("mt-1 text-[20px] font-semibold tabular-nums", valueClass)}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 font-mono text-[10px] text-ink-400 dark:text-ink-500">
          {sub}
        </div>
      )}
    </div>
  );
}

/* ── Quick-task affordance ──────────────────────────────────────── */

/**
 * "Spawn a task" surface for one-shot prompts that skip the
 * brainstorm-and-plan flow. Brainstorm lives on its own page now,
 * so this composer doesn't fight any other AI input on the project
 * landing page — it's just the regular composer, inline.
 */
function QuickTaskRow({ project }: { project: Project }) {
  return <ProjectComposer project={project} />;
}


/* ── Inline composer rooted at this project ────────────────────── */

function ProjectComposer({
  project,
  onSpawned,
}: {
  project: { id: string; path: string; name: string };
  onSpawned?: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateTask();
  const { toast } = useApp();

  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();
  const modelsQ = useModels();

  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("bypassPermissions");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("high");
  const [model, setModel] = useState<string>("");
  const [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // One-shot hydration from server-side prefs.
  useEffect(() => {
    if (hydrated) return;
    const p = prefsQ.data?.prefs;
    if (!p) return;
    setAgent(p.lastAgent);
    setPermissionMode(p.lastPermissionMode);
    setThinkingLevel(p.lastThinkingLevel);
    setModel(
      p.lastAgent === "claude" ? p.lastModelClaude : p.lastModelCodex,
    );
    setBase(p.lastBase || "main");
    setHydrated(true);
  }, [prefsQ.data, hydrated]);

  // Swap model whenever the agent changes after hydration.
  useEffect(() => {
    if (!hydrated || !prefsQ.data) return;
    setModel(
      agent === "claude"
        ? prefsQ.data.prefs.lastModelClaude
        : prefsQ.data.prefs.lastModelCodex,
    );
  }, [agent, hydrated, prefsQ.data]);

  // Clamp the thinking level whenever the agent changes so the runner
  // never receives a value the chosen CLI rejects.
  useEffect(() => {
    setThinkingLevel((cur) => clampThinkingLevel(agent, cur));
  }, [agent]);

  const submit = async () => {
    const p = prompt.trim();
    if (!p) {
      toast("Type a prompt first", true);
      return;
    }
    setBusy(true);
    try {
      const res = await create.mutateAsync({
        agent,
        repoPath: project.path,
        baseBranch: base.trim() || "main",
        prompt: p,
        permissionMode,
        thinkingLevel,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      void patchPrefs.mutateAsync({
        lastProjectId: project.id,
        lastAgent: agent,
        lastPermissionMode: permissionMode,
        lastThinkingLevel: thinkingLevel,
        ...(agent === "claude"
          ? { lastModelClaude: model.trim() }
          : { lastModelCodex: model.trim() }),
        lastBase: base.trim() || "main",
      });
      setPrompt("");
      onSpawned?.();
      navigate(`/tasks/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-900/[0.06] bg-paper-100/40 px-4 py-2 dark:border-ink-50/[0.06] dark:bg-ink-900/30">
        <Rocket className="h-3.5 w-3.5 text-ember-500 shrink-0" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          Spawn in {project.name}
        </span>
        <Spacer />
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          ⌘↵
        </span>
      </div>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        rows={3}
        placeholder="Tell the agent what to do here…"
        className="border-0 rounded-none focus-visible:ring-0 resize-none bg-transparent text-[14px] leading-relaxed px-4 py-3 shadow-none"
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-ink-900/[0.06] bg-paper-100/40 px-3 py-2 dark:border-ink-50/[0.06] dark:bg-ink-900/30">
        <ToolbarPick
          label={agent}
          options={[
            { value: "claude", label: "claude" },
            { value: "codex", label: "codex" },
          ]}
          onSelect={(v) => setAgent(v as "claude" | "codex")}
        />
        <ToolbarPick
          label={
            permissionMode === "bypassPermissions"
              ? "bypass"
              : permissionMode === "acceptEdits"
                ? "accept-edits"
                : "plan"
          }
          options={[
            { value: "bypassPermissions", label: "bypass · auto-allow" },
            { value: "acceptEdits", label: "accept-edits · edits only" },
            { value: "plan", label: "plan · read-only" },
          ]}
          onSelect={(v) => setPermissionMode(v as PermissionMode)}
        />
        <ToolbarPick
          label={`think:${thinkingLevel}`}
          options={THINKING_LEVELS_BY_AGENT[agent].map((v) => ({
            value: v,
            label: v,
          }))}
          onSelect={(v) => setThinkingLevel(v as ThinkingLevel)}
        />
        <ToolbarPick
          label={`model:${model || "default"}`}
          options={[
            { value: "", label: "(default)" },
            ...((modelsQ.data?.models[agent] ?? []).map((m) => ({
              value: m.id,
              label: m.label || m.id,
            }))),
          ]}
          onSelect={setModel}
        />
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          base
        </span>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          spellCheck={false}
          className="font-mono text-[11px] bg-transparent border-0 outline-none focus:ring-0 text-ink-900 dark:text-ink-50 placeholder:text-ink-400 w-24"
        />
        <Spacer />
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || !prompt.trim()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CornerDownLeft className="h-3.5 w-3.5" />
          )}
          Spawn
        </Button>
      </div>
    </section>
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
          className="inline-flex items-center gap-1 h-7 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[11px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors"
        >
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <span className="font-mono text-[12px]">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Lanes & rows ─────────────────────────────────────────────── */

function Lane({
  heading,
  hint,
  tasks,
  accent,
  muted,
}: {
  heading: string;
  hint?: string;
  tasks: Task[];
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <section className={muted ? "opacity-80" : undefined}>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.14em]",
            accent
              ? "text-ember-700 dark:text-ember-300"
              : "text-ink-500 dark:text-ink-400",
          )}
        >
          {heading}
        </span>
        {hint && (
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
            · {hint}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {tasks.length}
        </span>
      </div>
      <ul className="rounded-md border border-ink-900/10 bg-paper-50 divide-y divide-ink-900/[0.06] overflow-hidden dark:border-ink-50/10 dark:bg-ink-800 dark:divide-ink-50/[0.06]">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({ task }: { task: Task }) {
  const totalTok =
    (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);
  const hot = useRecentPulse(task.id, 1500);
  return (
    <li>
      <Link
        to={`/tasks/${task.id}`}
        className={cn(
          "group h-12 px-4 flex items-center gap-3 hover:bg-paper-100 transition-colors dark:hover:bg-ink-700 relative",
          hot && "bg-ember-500/[0.06] dark:bg-ember-500/[0.1]",
        )}
      >
        {hot && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-0.5 bg-ember-500 animate-blink"
          />
        )}
        <StatusGlyph status={task.status} />
        <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate flex-1">
          {task.title}
        </span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
          {task.agent}
        </span>
        <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 truncate hidden md:inline max-w-[24ch]">
          {task.branch}
        </span>
        <span className="hidden md:flex items-baseline gap-3 shrink-0 font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          <span>{formatTokens(totalTok)}</span>
          <span>{formatCost(task.totalCostUsd)}</span>
        </span>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[10px] text-ember-700 hover:underline dark:text-ember-300 shrink-0"
            title="open PR"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600 w-14 text-right shrink-0">
          {formatTs(task.updatedAt)}
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
      </Link>
    </li>
  );
}

function StatusGlyph({ status }: { status: TaskStatus }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300 shrink-0" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-red-700 dark:text-red-300 shrink-0" />;
  }
  const tone =
    status === "running"
      ? "bg-ember-500 animate-blink"
      : status === "waiting_input" || status === "waiting_perm"
        ? "bg-amber-500 animate-blink"
        : "bg-ink-300 dark:bg-ink-600";
  return <span className={cn("inline-block size-1.5 rounded-full shrink-0 mx-1", tone)} />;
}

/* ── Right rail panels ─────────────────────────────────────────── */

/**
 * Free-text guidance prepended to every task spawn for this project.
 * Stored in the daemon DB (never committed). The operator can leave
 * it off entirely (it's optional), turn it off temporarily without
 * losing the draft, draft a new one with AI from a one-line project
 * description, or improve an existing draft. The agent can also
 * self-modify via `agentd-instructions write`.
 */
const PRESET_RULES: Array<{ label: string; line: string }> = [
  {
    label: "Typecheck before done",
    line: "Run the project's typecheck (and tests, if fast) before declaring a task done.",
  },
  {
    label: "Match existing patterns",
    line: "Match the codebase's existing patterns; don't refactor or introduce new abstractions unless asked.",
  },
  {
    label: "No DB migrations without asking",
    line: "Never run, write, or apply DB migrations without explicit confirmation.",
  },
  {
    label: "Small diffs, one concern",
    line: "Keep diffs small and focused — one concern per PR; split unrelated changes.",
  },
  {
    label: "No spurious comments",
    line: "Don't add comments unless the why is non-obvious. Identifiers should carry the meaning.",
  },
  {
    label: "Ask before destructive ops",
    line: "Confirm before destructive shell or git ops (rm -rf, force-push, reset --hard, branch delete).",
  },
];

function ProjectInstructionsPanel({ project }: { project: Project }) {
  const update = useUpdateProject();
  // Agentic workshop modal — full two-pane editor with codebase access.
  // This is the ONLY way to edit the instructions; presets in the
  // empty state are quick-adds, not editing.
  const [workshopOpen, setWorkshopOpen] = useState(false);

  const draft = project.instructions ?? "";
  const enabled = project.instructionsEnabled !== false;
  const isEmpty = !draft.trim();
  const ruleCount = draft
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;

  const setEnabled = (next: boolean) => {
    void update.mutateAsync({
      idOrSlug: project.id,
      patch: { instructionsEnabled: next },
    });
  };

  const addPreset = (line: string) => {
    const sep = draft.trim() ? "\n" : "";
    const next = `${draft.trimEnd()}${sep}- ${line}`;
    void update.mutateAsync({
      idOrSlug: project.id,
      patch: { instructions: next },
    });
  };

  // Render lines starting with `- ` as bullets, others as plain
  // paragraphs.
  const renderedRules = draft
    .split("\n")
    .map((line, i) => ({ raw: line, i }))
    .filter(({ raw }) => raw.trim().length > 0);

  return (
    <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-4 py-4">
      {/* Header */}
      <div className="flex items-start gap-2 mb-3">
        <BookText
          className={cn(
            "h-3.5 w-3.5 shrink-0 mt-0.5 transition-colors",
            enabled ? "text-ember-500" : "text-ink-400 dark:text-ink-600",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50">
              Instructions
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
              optional
            </span>
            {enabled && ruleCount > 0 && (
              <span className="font-mono text-[9px] tabular-nums text-emerald-700 dark:text-emerald-400">
                {ruleCount} rule{ruleCount === 1 ? "" : "s"} active
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
            Short rules prepended to every task spawn — like a tiny CLAUDE.md
            just for this project. Lives in the daemon DB.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={update.isPending}
          title={enabled ? "Disable for this project (keeps the draft)" : "Enable"}
        />
      </div>

      {/* Disabled state — show a dim preview if there's a draft, otherwise nothing. */}
      {!enabled ? (
        <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/10 bg-ink-900/[0.02] dark:bg-ink-50/[0.02] px-3 py-2.5">
          <p className="font-mono text-[10.5px] text-ink-500 dark:text-ink-400 leading-relaxed">
            instructions are off — agents won't see this guidance. Flip the
            switch above to re-enable.
            {ruleCount > 0 && (
              <span className="text-ink-400 dark:text-ink-500">
                {" "}
                ({ruleCount} rule{ruleCount === 1 ? "" : "s"} kept)
              </span>
            )}
          </p>
        </div>
      ) : isEmpty ? (
        /* Empty state — preset chips + workshop launcher */
        <div className="space-y-3">
          <div className="rounded-md border border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-800/50 px-3 py-2.5">
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
                quick adds
              </span>
              <span className="font-mono text-[9.5px] text-ink-400 dark:text-ink-500">
                tap to append
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_RULES.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => addPreset(p.line)}
                  disabled={update.isPending}
                  title={p.line}
                  className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] border border-ink-900/10 dark:border-ink-50/10 bg-paper-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:border-ember-500/40 hover:bg-ember-500/5 dark:hover:bg-ember-500/10 hover:text-ember-700 dark:hover:text-ember-300 transition-colors disabled:opacity-40"
                >
                  <Plus className="h-2.5 w-2.5" />
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setWorkshopOpen(true)}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[11px] font-medium border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 hover:bg-ember-500/15 transition-colors"
              title="agent reads your repo and chats with you to craft the rules"
            >
              <Sparkles className="h-3 w-3" />
              Open workshop
            </button>
            <span className="ml-auto font-mono text-[9.5px] text-ink-400 dark:text-ink-500">
              skip — agents do fine without
            </span>
          </div>
        </div>
      ) : (
        /* Read mode — formatted bullet preview + workshop launcher */
        <div className="space-y-2">
          <ul className="rounded-md border border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-800/40 px-3 py-2 space-y-1 max-h-72 overflow-y-auto">
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
              return (
                <li
                  key={i}
                  className="flex gap-1.5 text-[11.5px] leading-relaxed text-ink-700 dark:text-ink-200"
                >
                  <span className="text-ember-500 shrink-0 select-none">›</span>
                  <span className="font-mono">{trimmed}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWorkshopOpen(true)}
              className="inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 hover:bg-ember-500/15 transition-colors"
              title="Open the agentic workshop — two-pane chat with codebase access"
            >
              <Sparkles className="h-2.5 w-2.5" />
              workshop
            </button>
            <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-2.5 w-2.5" />
              applied
            </span>
          </div>
        </div>
      )}
      <InstructionsWorkshopDialog
        open={workshopOpen}
        onClose={() => setWorkshopOpen(false)}
        project={project}
      />
    </div>
  );
}

/**
 * Polished "Connect chat" experience. Replaces three raw token / id
 * inputs with brand tiles → guided sheet that validates the token
 * via Telegram's `getMe`, lists Discord channels, lets the operator
 * test-send before saving, and shows live delivery counters once
 * connected.
 */
function ConnectChatPanel({ project }: { project: Project }) {
  const summaryQ = useBridgeSummary();
  const channelsQ = useDiscordChannels();
  const [openFor, setOpenFor] = useState<ChatPlatform | null>(null);

  const summary = (summaryQ.data?.projects ?? []).find(
    (p) => p.projectId === project.id,
  );
  const tg = summary?.telegram ?? null;
  const dc = summary?.discord ?? null;

  // Discord channel name fallback: even if bridge-summary hasn't
  // recomputed yet, look up the live channel cache so we can show a
  // real `#channel` label immediately after save.
  const dcLiveName = useMemo(() => {
    if (!project.discordChannelId) return null;
    for (const g of channelsQ.data?.guilds ?? []) {
      for (const c of g.channels) {
        if (c.id === project.discordChannelId) {
          return { guild: g.name, channel: c.name };
        }
      }
    }
    return null;
  }, [project.discordChannelId, channelsQ.data]);

  const connectedCount =
    (project.telegramBotToken && project.telegramChatId ? 1 : 0) +
    (project.discordChannelId ? 1 : 0);

  const tgMirrored = !!project.telegramChatId;
  const dcMirrored = !!project.discordChannelId;
  const anyMirror = tgMirrored || dcMirrored;

  return (
    <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-4 py-4">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          Brainstorm mirror
        </span>
        <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
          per project
        </span>
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px]">
          {anyMirror ? (
            <>
              <span className="size-1.5 rounded-full bg-emerald-500 inline-block animate-blink" />
              <span className="text-emerald-700 dark:text-emerald-400">
                live
              </span>
            </>
          ) : (
            <span className="text-ink-400 dark:text-ink-500">not mirrored</span>
          )}
        </span>
      </div>
      <p className="text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed mb-3">
        Connect a chat target and brainstorm flows there bidirectionally —
        suggestions land in chat, your replies (number, text, "skip") feed back
        into the same thread. Same for tasks: progress notes, asks, shares.
      </p>

      <div className="grid grid-cols-1 gap-2">
        <BridgeCard
          platform="telegram"
          connected={!!project.telegramBotToken && !!project.telegramChatId}
          headline={
            tg?.botFirstName ||
            (project.telegramBotToken ? "Telegram bot" : "Telegram")
          }
          subline={
            tg?.botUsername
              ? `@${tg.botUsername}` +
                (tg.chatLabel ? ` → ${tg.chatLabel}` : "")
              : project.telegramBotToken
                ? "fetching identity…"
                : "DM / group via your own bot"
          }
          stats={tg?.stats ?? null}
          onClick={() => setOpenFor("telegram")}
        />
        <BridgeCard
          platform="discord"
          connected={!!project.discordChannelId}
          headline={
            dc?.channelName
              ? `#${dc.channelName}`
              : dcLiveName
                ? `#${dcLiveName.channel}`
                : project.discordChannelId
                  ? "channel id saved"
                  : "Discord"
          }
          subline={
            dc?.guildName
              ? dc.guildName
              : dcLiveName
                ? dcLiveName.guild
                : project.discordChannelId
                  ? "looking up server…"
                  : "channel via the global Discord bot"
          }
          stats={dc?.stats ?? null}
          onClick={() => setOpenFor("discord")}
        />
      </div>

      {project.discordChannelId && (
        <AutoTaskThreadToggle project={project} />
      )}

      <p className="mt-3 font-mono text-[9.5px] text-ink-400 dark:text-ink-500 leading-relaxed">
        Empty falls back to the global plugin. Saved here, the project's
        events route to its own bot / channel.
      </p>

      {openFor && (
        <ChatConnectSheet
          project={project}
          platform={openFor}
          onClose={() => setOpenFor(null)}
        />
      )}
    </div>
  );
}

function AutoTaskThreadToggle({ project }: { project: Project }) {
  const update = useUpdateProject();
  const enabled = !!project.autoTaskThread;
  const toggle = () => {
    void update.mutateAsync({
      idOrSlug: project.id,
      patch: { autoTaskThread: !enabled },
    });
  };
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={update.isPending}
      className={cn(
        "mt-2 w-full flex items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
        enabled
          ? "border-ember-500/40 bg-ember-500/5 hover:bg-ember-500/10"
          : "border-ink-900/10 bg-paper-50 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:hover:bg-ink-700",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-3.5 w-6 shrink-0 rounded-full border transition-colors items-center px-0.5",
          enabled
            ? "bg-ember-500 border-ember-500 justify-end"
            : "bg-paper-100 border-ink-900/15 dark:bg-ink-900 dark:border-ink-50/15",
        )}
      >
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full transition-colors",
            enabled ? "bg-white" : "bg-ink-300 dark:bg-ink-600",
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-ink-900 dark:text-ink-50">
          Spawn a thread per task
        </div>
        <p className="mt-0.5 text-[10.5px] text-ink-500 dark:text-ink-400 leading-relaxed">
          New tasks open a fresh Discord thread under this channel. The
          thread auto-archives when the task closes.
        </p>
      </div>
    </button>
  );
}

function BridgeCard({
  platform,
  connected,
  headline,
  subline,
  stats,
  onClick,
}: {
  platform: ChatPlatform;
  connected: boolean;
  headline: string;
  subline: string;
  stats: { lastDeliveredAt: number | null; count24h: number } | null;
  onClick: () => void;
}) {
  const brand = platform === "telegram" ? "#229ED9" : "#5865F2";
  const Icon = platform === "telegram" ? Send : Hash;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors",
        connected
          ? "border-ink-900/10 bg-paper-50 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:hover:bg-ink-700"
          : "border-dashed border-ink-900/15 bg-transparent hover:bg-paper-100 dark:border-ink-50/15 dark:hover:bg-ink-800",
      )}
    >
      <span
        className={cn(
          "h-8 w-8 shrink-0 rounded-md grid place-items-center font-mono text-[11px] font-semibold",
          connected ? "text-white" : "text-ink-400 dark:text-ink-500",
        )}
        style={{
          background: connected ? brand : "transparent",
          border: connected ? "none" : "1px dashed currentColor",
        }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-[12px] font-medium truncate",
              connected
                ? "text-ink-900 dark:text-ink-50"
                : "text-ink-700 dark:text-ink-200",
            )}
          >
            {headline}
          </span>
          {connected && (
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
              live
            </span>
          )}
        </div>
        <div className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
          {subline}
        </div>
        {connected && stats && (
          <div className="mt-1 flex items-center gap-2 font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
            <span>{stats.count24h} sent · 24h</span>
            <span>·</span>
            <span>
              {stats.lastDeliveredAt
                ? `last ${formatTs(stats.lastDeliveredAt)}`
                : "no deliveries yet"}
            </span>
          </div>
        )}
      </div>
      <Settings2 className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

function AutoContextPanel({ projectPath }: { projectPath: string }) {
  const skillsQ = useSkills(projectPath);
  const localSkills = (skillsQ.data?.skills ?? []).filter(
    (s) => s.scope === "local",
  );
  return (
    <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-4 py-3">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          Auto context
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {localSkills.length}
        </span>
      </div>
      {localSkills.length === 0 ? (
        <p className="text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
          Drop a SKILL.md into{" "}
          <code className="font-mono text-[10px]">
            {projectPath}/.agents/skills/&lt;name&gt;/
          </code>{" "}
          and it'll auto-attach to every task spawned here.
        </p>
      ) : (
        <ul className="space-y-1">
          {localSkills.map((s) => (
            <li
              key={`${s.scope}:${s.slug}`}
              className="flex items-center gap-2 text-[11px]"
            >
              <BookText className="h-3 w-3 text-ember-500 shrink-0" />
              <span className="flex-1 min-w-0 truncate text-ink-700 dark:text-ink-200">
                {s.displayName ?? s.name}
              </span>
              <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500 shrink-0">
                {s.slug}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecentChatter({ tasks }: { tasks: Task[] }) {
  // 5 most recent tasks regardless of status — quick "what was I doing here".
  const recent = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
    [tasks],
  );
  if (recent.length === 0) return null;
  return (
    <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 mb-2">
        Latest
      </div>
      <ul className="space-y-1.5">
        {recent.map((t) => (
          <li key={t.id}>
            <Link
              to={`/tasks/${t.id}`}
              className="group block"
            >
              <div className="flex items-baseline gap-2">
                <StatusGlyph status={t.status} />
                <span className="text-[12px] truncate flex-1 text-ink-700 dark:text-ink-200 group-hover:text-ink-900 dark:group-hover:text-ink-50 transition-colors">
                  {t.title}
                </span>
              </div>
              <div className="ml-5 mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
                <span>{t.agent}</span>
                <span>·</span>
                <span>{t.branch}</span>
                <span className="ml-auto">{formatTs(t.updatedAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PathReference({ path }: { path: string }) {
  return (
    <div className="px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 mb-2">
        Reference
      </div>
      <ul className="space-y-1.5 font-mono text-[11px]">
        <li className="flex items-baseline gap-2">
          <span className="text-ink-400 dark:text-ink-500 shrink-0">repo</span>
          <code className="text-ember-700 dark:text-ember-300 truncate">
            {path}
          </code>
        </li>
        <li className="flex items-baseline gap-2">
          <span className="text-ink-400 dark:text-ink-500 shrink-0">skills</span>
          <code className="text-ink-500 dark:text-ink-400 truncate">
            {path}/.agents/skills/
          </code>
        </li>
        <li className="flex items-baseline gap-2">
          <span className="text-ink-400 dark:text-ink-500 shrink-0">claude</span>
          <code className="text-ink-500 dark:text-ink-400 truncate">
            {path}/CLAUDE.md
          </code>
        </li>
      </ul>
      <p className="mt-3 text-[10px] text-ink-400 dark:text-ink-500 leading-relaxed">
        Worktrees for spawned tasks land at{" "}
        <code className="font-mono">~/.agentd/worktrees/&lt;task-id&gt;/</code>.
        The repo above stays untouched.
      </p>
    </div>
  );
}

void Plus;
void FileText;
