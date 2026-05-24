import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  FolderGit2,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type {
  AgentKind,
  BranchMode,
  ThinkingLevel,
  WorkspaceMode,
} from "@agentd/contracts";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useClient } from "@/AppContext";
import { cn } from "@/lib/utils";

export interface WorkspaceSetupValue {
  workspaceMode: WorkspaceMode;
  branchMode: BranchMode;
  /** Custom branch name. Empty = auto-name (worktree+new only). */
  branchName: string;
  baseBranch: string;
  pullLatest: boolean;
}

/**
 * Defaults used when no server prefs are loaded yet. Real defaults come
 * from `usePrefs()` and are applied by the parent form on hydration.
 * `baseFallback` is empty by default — the parent form fills it in with
 * the project's actual default branch (`main`/`master`/`trunk`/...) once
 * the project is known.
 */
export function defaultWorkspaceSetup(baseFallback = ""): WorkspaceSetupValue {
  return {
    workspaceMode: "worktree",
    branchMode: "new",
    branchName: "",
    baseBranch: baseFallback,
    pullLatest: false,
  };
}

/**
 * Compact workspace-setup panel used inside the spawn sheet, the home
 * composer's "branch?" expand, and the project composer. Lets the user
 * pick worktree vs in-place, new vs existing branch, optional pull-latest.
 *
 * `projectIdOrSlug` is required for the existing-branch picker — without
 * it we still let them type a branch name freely but can't show a list.
 */
export function WorkspaceSetup({
  value,
  onChange,
  projectIdOrSlug,
  /** Compact = used inside the inline composer; default = full size. */
  compact = false,
  /**
   * Live prompt text. When provided, the new-branch input gets a
   * `✨ generate` button that asks the AI helper for a kebab-case slug.
   * The button is disabled when the prompt is empty.
   */
  prompt,
  agent,
  model,
  thinkingLevel,
}: {
  value: WorkspaceSetupValue;
  onChange: (next: WorkspaceSetupValue) => void;
  projectIdOrSlug?: string | null;
  compact?: boolean;
  prompt?: string;
  agent?: AgentKind;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}) {
  const branchesQ = useQuery({
    queryKey: ["project", projectIdOrSlug ?? "_none", "branches"] as const,
    queryFn: () =>
      useClient()
        ? // dummy; replaced in the resolver below
          Promise.resolve({ current: null, local: [], remote: [] })
        : Promise.resolve({ current: null, local: [], remote: [] }),
    enabled: false,
  });

  // Couldn't use useClient inside the queryFn above (rules of hooks); do
  // a real query with the client now that we have a stable id.
  const client = useClient();
  const realQ = useQuery({
    queryKey: ["project", projectIdOrSlug ?? "_none", "branches"] as const,
    queryFn: () => client.listProjectBranches(projectIdOrSlug!),
    enabled: !!projectIdOrSlug && value.branchMode === "existing",
    staleTime: 30_000,
  });
  void branchesQ;

  const update = (patch: Partial<WorkspaceSetupValue>): void => {
    onChange({ ...value, ...patch });
  };

  const localBranches = realQ.data?.local ?? [];
  const remoteBranches = realQ.data?.remote ?? [];
  const allBranches = useMemo<BranchOption[]>(() => {
    const localSet = new Set(localBranches);
    const seen = new Set<string>();
    const out: BranchOption[] = [];
    for (const b of localBranches) {
      if (!seen.has(b)) {
        seen.add(b);
        out.push({ name: b, scope: "local" });
      }
    }
    for (const r of remoteBranches) {
      if (!r.ref || seen.has(r.ref)) continue;
      seen.add(r.ref);
      out.push({
        name: r.ref,
        scope: localSet.has(r.ref) ? "local" : "remote",
        remote: r.remote || undefined,
      });
    }
    return out;
  }, [localBranches, remoteBranches]);

  return (
    <div
      className={cn(
        "space-y-2",
        compact && "rounded-md border border-ink-900/[0.06] bg-paper-100/40 p-2.5 dark:border-ink-50/[0.06] dark:bg-ink-900/30",
      )}
    >
      {/* Workspace mode + base + pull */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 shrink-0">
          workspace
        </span>
        <SegPills<WorkspaceMode>
          options={[
            { value: "worktree", label: "worktree", hint: "isolated copy" },
            { value: "in_place", label: "in-place", hint: "your actual checkout" },
          ]}
          value={value.workspaceMode}
          onChange={(v) => update({ workspaceMode: v })}
        />
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 shrink-0">
          base
        </span>
        <input
          value={value.baseBranch}
          onChange={(e) => update({ baseBranch: e.target.value })}
          placeholder="auto"
          spellCheck={false}
          className="font-mono text-[11px] bg-transparent border-0 outline-none focus:ring-0 text-ink-900 dark:text-ink-50 placeholder:text-ink-400 w-20"
        />
        <ToggleChip
          active={value.pullLatest}
          onClick={() => update({ pullLatest: !value.pullLatest })}
          icon={<RefreshCw className="h-3 w-3" />}
          label="pull latest"
          title="git fetch + ff-only pull on the base/branch before starting"
        />
      </div>

      {/* Branch row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 shrink-0">
          branch
        </span>
        <SegPills<BranchMode>
          options={[
            { value: "new", label: "new", hint: "create a fresh branch" },
            { value: "existing", label: "existing", hint: "switch to a branch you already have" },
          ]}
          value={value.branchMode}
          onChange={(v) => update({ branchMode: v })}
        />
        {value.branchMode === "existing" ? (
          <BranchPicker
            value={value.branchName}
            onChange={(b) => update({ branchName: b })}
            options={allBranches}
            loading={realQ.isLoading}
            currentBranch={realQ.data?.current ?? null}
          />
        ) : (
          <NewBranchInput
            value={value.branchName}
            onChange={(b) => update({ branchName: b })}
            prompt={prompt}
            agent={agent}
            model={model}
            thinkingLevel={thinkingLevel}
          />
        )}
      </div>

      {value.workspaceMode === "in_place" && (
        <p className="text-[10px] text-amber-700 dark:text-amber-300 font-mono leading-relaxed">
          ⚠ in-place commits land on your real branch. Refused if the
          worktree has uncommitted changes.
        </p>
      )}
    </div>
  );
}

function SegPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-7 items-center rounded-md border border-ink-900/10 bg-paper-50 p-0.5 dark:border-ink-50/10 dark:bg-ink-800">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            title={o.hint}
            className={cn(
              "h-6 px-2 rounded font-mono text-[11px] transition-colors",
              active
                ? "bg-ember-500/15 text-ember-700 dark:text-ember-300"
                : "text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  label,
  title,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 h-7 px-2 rounded-md border font-mono text-[11px] transition-colors",
        active
          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

const BRANCH_PREFIXES = [
  "feature",
  "fix",
  "refactor",
  "chore",
  "wip",
] as const;

/**
 * Branch-name input with quick prefix chips. Tapping a prefix sets the
 * input to `<prefix>/` so the user just has to type the slug. Free-form
 * input is honored — if the user types `feature/foo` directly, no chip
 * is auto-selected. Empty input defers to TaskManager's auto-name.
 */
function NewBranchInput({
  value,
  onChange,
  prompt,
  agent,
  model,
  thinkingLevel,
}: {
  value: string;
  onChange: (v: string) => void;
  prompt?: string;
  agent?: AgentKind;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}) {
  const client = useClient();
  const [generating, setGenerating] = useState(false);
  const detected = useMemo(() => {
    const slash = value.indexOf("/");
    if (slash <= 0) return null;
    const prefix = value.slice(0, slash);
    if ((BRANCH_PREFIXES as readonly string[]).includes(prefix)) return prefix;
    return null;
  }, [value]);

  const generate = async () => {
    const p = (prompt ?? "").trim();
    if (!p) return;
    setGenerating(true);
    try {
      const r = await client.suggestBranchName(p, {
        ...(agent ? { agent } : {}),
        ...(model?.trim() ? { model: model.trim() } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
      // Preserve whatever prefix the user already chose; otherwise take
      // the AI's inferred one (fix/refactor/chore/feature) so a "fix the
      // X bug" prompt doesn't get jammed under feature/.
      const prefix = detected ?? r.prefix;
      onChange(`${prefix}/${r.slug}`);
    } catch {
      // best-effort — leave field as-is
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
      <div className="flex items-center gap-0.5">
        {BRANCH_PREFIXES.map((p) => {
          const active = detected === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => {
                // If already on this prefix, keep just the slug part
                // (drop everything before the slash).
                if (detected === p) return;
                const slash = value.indexOf("/");
                const slug = slash > 0 ? value.slice(slash + 1) : value;
                onChange(`${p}/${slug}`);
              }}
              className={cn(
                "h-6 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] transition-colors",
                active
                  ? "bg-ember-500/15 text-ember-700 dark:text-ember-300"
                  : "text-ink-500 hover:text-ink-900 hover:bg-paper-100 dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-700",
              )}
              title={`prefix the branch with ${p}/`}
            >
              {p}
            </button>
          );
        })}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="auto · e.g. feature/streaming-chat"
        className="font-mono text-[11px] h-7 px-2 min-w-[180px] flex-1"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => void generate()}
        disabled={generating || !(prompt ?? "").trim()}
        title={
          (prompt ?? "").trim()
            ? "Generate a kebab-case branch name from the prompt"
            : "Type a prompt first to enable AI suggestions"
        }
        className={cn(
          "inline-flex items-center gap-1 h-7 px-2 rounded-md border font-mono text-[10px] uppercase tracking-[0.08em] transition-colors",
          generating
            ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
            : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
          !(prompt ?? "").trim() && "opacity-40 cursor-not-allowed",
        )}
      >
        {generating ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="h-3 w-3" />
        )}
        generate
      </button>
    </div>
  );
}

export interface BranchOption {
  name: string;
  scope: "local" | "remote";
  remote?: string;
}

function BranchPicker({
  value,
  onChange,
  options,
  loading,
  currentBranch,
}: {
  value: string;
  onChange: (b: string) => void;
  options: BranchOption[];
  loading: boolean;
  currentBranch: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, filter]);

  const grouped = useMemo(() => {
    const local = filtered.filter((o) => o.scope === "local");
    const remote = filtered.filter((o) => o.scope === "remote");
    return { local, remote };
  }, [filtered]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-ink-900/15 bg-paper-50 font-mono text-[11px] text-ink-700 hover:border-ink-900/30 hover:bg-paper-100 dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors min-w-[160px] justify-between"
        >
          <GitBranch className="h-3 w-3 text-ink-400 dark:text-ink-500 shrink-0" />
          <span className="truncate">
            {value || (loading ? "loading…" : "pick branch")}
          </span>
          {loading && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
          <ChevronDown className="h-3 w-3 opacity-60 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px] p-0">
        <div className="border-b border-ink-900/[0.06] px-2 py-1 dark:border-ink-50/[0.06]">
          <Input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter branches…"
            className="h-6 px-1 border-0 text-[11px] focus-visible:ring-0 bg-transparent shadow-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-center text-[11px] text-ink-500 dark:text-ink-400">
              {loading ? "loading…" : "no branches match"}
            </div>
          ) : (
            <>
              {grouped.local.length > 0 && (
                <BranchGroup
                  label="local"
                  items={grouped.local}
                  value={value}
                  currentBranch={currentBranch}
                  onPick={onChange}
                />
              )}
              {grouped.remote.length > 0 && (
                <BranchGroup
                  label="remote"
                  items={grouped.remote}
                  value={value}
                  currentBranch={currentBranch}
                  onPick={onChange}
                />
              )}
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchGroup({
  label,
  items,
  value,
  currentBranch,
  onPick,
}: {
  label: string;
  items: BranchOption[];
  value: string;
  currentBranch: string | null;
  onPick: (name: string) => void;
}) {
  return (
    <>
      <div className="px-3 pt-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
        {label}
      </div>
      {items.map((b) => (
        <DropdownMenuItem key={`${b.scope}:${b.name}`} onClick={() => onPick(b.name)}>
          <GitBranch className="h-3 w-3 text-ink-400 dark:text-ink-500" />
          <span className="font-mono text-[11px] flex-1 truncate">{b.name}</span>
          {b.scope === "remote" && b.remote && (
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
              {b.remote}
            </span>
          )}
          {b.name === currentBranch && (
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
              current
            </span>
          )}
          {b.name === value && (
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
              ✓
            </span>
          )}
        </DropdownMenuItem>
      ))}
    </>
  );
}

void Copy;
void FolderGit2;
