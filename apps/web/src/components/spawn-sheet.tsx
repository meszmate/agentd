import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookText, Loader2, Rocket, X } from "lucide-react";
import type { PlanSlice } from "@agentd/contracts";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateCouncil,
  useCreateTask,
  useModels,
  usePatchPrefs,
  usePrefs,
  useProjectBranches,
  useSkills,
  useSpawnTasksMulti,
} from "@/queries";
import { useApp, useClient } from "@/AppContext";
import { ProjectPicker } from "@/components/project-picker";
import { PlanSlicesEditor } from "@/components/plan-slices-editor";
import {
  defaultWorkspaceSetup,
  type WorkspaceSetupValue,
} from "@/components/workspace-setup";
import {
  ToolbarPick,
  commitModeLabel,
  parseCommitMode,
} from "@/components/toolbar-pick";
import { cn } from "@/lib/utils";

type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan";
type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
type SpawnMode = "solo" | "council" | "phase";

const THINKING_LEVELS_BY_AGENT: Record<
  "claude" | "codex",
  ReadonlyArray<ThinkingLevel>
> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

function clampThinkingLevel(
  agent: "claude" | "codex",
  level: ThinkingLevel,
): ThinkingLevel {
  if (THINKING_LEVELS_BY_AGENT[agent].includes(level)) return level;
  if (agent === "claude" && level === "minimal") return "low";
  if (agent === "codex" && level === "max") return "xhigh";
  return "high";
}

const PERMISSION_OPTIONS = [
  { value: "bypassPermissions", label: "bypass · auto-allow" },
  { value: "acceptEdits", label: "accept-edits · edits only" },
  { value: "plan", label: "plan · read-only" },
];

function permissionLabel(m: PermissionMode): string {
  if (m === "bypassPermissions") return "bypass";
  if (m === "acceptEdits") return "accept-edits";
  return "plan";
}

const MODE_OPTIONS = [
  { value: "solo", label: "solo · single task" },
  { value: "council", label: "council · all models in parallel" },
  { value: "phase", label: "phase · sequential slices" },
];

const COMMIT_OPTIONS = [
  { value: "none", label: "no commit" },
  { value: "commit", label: "commit only" },
  { value: "commit+push", label: "commit + push (default)" },
];

export function SpawnSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateTask();
  const createCouncil = useCreateCouncil();
  const spawnMulti = useSpawnTasksMulti();
  const modelsQ = useModels();
  const [spawnMode, setSpawnMode] = useState<SpawnMode>("solo");
  const councilMode = spawnMode === "council";
  const phaseMode = spawnMode === "phase";
  const [slices, setSlices] = useState<PlanSlice[]>([]);
  const navigate = useNavigate();
  const { toast } = useApp();
  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();

  const [projectId, setProjectId] = useState<string>("");
  const [repoPath, setRepoPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [autoCommit, setAutoCommit] = useState(true);
  const [autoPush, setAutoPush] = useState(true);
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("bypassPermissions");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("high");
  const [model, setModel] = useState<string>("");
  const [workspace, setWorkspace] = useState<WorkspaceSetupValue>(() =>
    defaultWorkspaceSetup(""),
  );
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [autoFilledForPath, setAutoFilledForPath] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    const p = prefsQ.data?.prefs;
    if (!p) return;
    setProjectId(p.lastProjectId);
    setRepoPath(p.lastRepo);
    setBaseBranch(p.lastBase || "");
    setAgent(p.lastAgent);
    setAutoCommit(p.lastAutoCommit);
    setAutoPush(p.lastAutoPush);
    setPermissionMode(p.lastPermissionMode);
    setThinkingLevel(clampThinkingLevel(p.lastAgent, p.lastThinkingLevel));
    setModel(
      p.lastAgent === "claude" ? p.lastModelClaude : p.lastModelCodex,
    );
    setWorkspace({
      workspaceMode: p.workspaceMode,
      branchMode: p.branchMode,
      branchName: "",
      baseBranch: p.lastBase || "",
      pullLatest: p.pullLatest,
    });
    setHydrated(true);
  }, [prefsQ.data, hydrated]);

  // Pre-fill the base field with the project's actual default branch
  // (`main`/`master`/`trunk`/...) once we know which project we're
  // targeting. The operator can still type any branch they want; we
  // never overwrite a non-empty value.
  const branchesQ = useProjectBranches(projectId || null);
  useEffect(() => {
    const detected = branchesQ.data?.default;
    if (!detected) return;
    setBaseBranch((cur) => (cur.trim() ? cur : detected));
    setWorkspace((cur) =>
      cur.baseBranch.trim() ? cur : { ...cur, baseBranch: detected },
    );
  }, [branchesQ.data?.default, projectId]);

  useEffect(() => {
    if (!hydrated || !prefsQ.data) return;
    setModel(
      agent === "claude"
        ? prefsQ.data.prefs.lastModelClaude
        : prefsQ.data.prefs.lastModelCodex,
    );
  }, [agent, hydrated, prefsQ.data]);

  useEffect(() => {
    setThinkingLevel((cur) => clampThinkingLevel(agent, cur));
  }, [agent]);

  const skillsQ = useSkills(repoPath || undefined);
  const availableSkills = skillsQ.data?.skills ?? [];

  useEffect(() => {
    if (!skillsQ.data) return;
    if (!repoPath) return;
    if (autoFilledForPath === repoPath) return;
    const localIds = availableSkills
      .filter((s) => s.scope === "local" && s.enabled)
      .map((s) => `${s.scope}:${s.slug}`);
    setActiveSkills(localIds);
    setAutoFilledForPath(repoPath);
  }, [skillsQ.data, availableSkills, repoPath, autoFilledForPath]);

  useEffect(() => {
    if (open) {
      setPrompt("");
      setTitle("");
      setSpawnMode("solo");
      setSlices([]);
    }
  }, [open]);

  const setMode = (mode: SpawnMode) => {
    setSpawnMode(mode);
    if (mode === "phase") {
      setSlices((cur) =>
        cur.length > 0
          ? cur
          : [
              { title: "backend", agent: "codex", prompt: "" },
              { title: "frontend", agent: "claude", prompt: "" },
            ],
      );
    }
  };

  const submit = async () => {
    if (!repoPath.trim()) {
      toast("Repo path is required", true);
      return;
    }
    if (!phaseMode && !prompt.trim()) {
      toast("Prompt is required", true);
      return;
    }
    try {
      // Empty = let the daemon detect the repo's default branch.
      const finalBase = (workspace.baseBranch || baseBranch).trim();

      if (phaseMode) {
        if (slices.length === 0) {
          toast("Add at least one slice", true);
          return;
        }
        const blanks = slices.findIndex((s) => !s.prompt.trim());
        if (blanks !== -1) {
          toast(`Slice ${blanks + 1} needs a prompt`, true);
          return;
        }
        const res = await spawnMulti.mutateAsync({
          repoPath: repoPath.trim(),
          baseBranch: finalBase,
          slices,
          autoPush,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(workspace.branchName.trim()
            ? { branchName: workspace.branchName.trim() }
            : {}),
        });
        toast(`Spawned ${res.tasks.length} slices`);
        onClose();
        const first = res.tasks[0];
        if (first) navigate(`/tasks/${first.id}`);
        return;
      }

      if (councilMode) {
        const registry = modelsQ.data?.models[agent] ?? [];
        const members = registry.slice(0, 5).map((m) => ({
          agent: agent as "claude" | "codex",
          model: m.id,
          thinkingLevel,
          label: m.label || m.id,
        }));
        if (members.length < 2) {
          toast(
            `Council mode needs at least 2 ${agent} models in cfg.models. Add one in Settings or ~/.agentd/config.json.`,
            true,
          );
          return;
        }
        const res = await createCouncil.mutateAsync({
          repoPath: repoPath.trim(),
          baseBranch: finalBase,
          prompt: prompt.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(projectId ? { projectId } : {}),
          members,
        });
        toast(`Council spawned · ${members.length} members`);
        onClose();
        navigate(`/councils/${res.council.id}`);
        return;
      }
      const res = await create.mutateAsync({
        agent,
        repoPath: repoPath.trim(),
        baseBranch: finalBase,
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        autoCommit,
        autoPush,
        permissionMode,
        thinkingLevel,
        ...(model.trim() ? { model: model.trim() } : {}),
        workspaceMode: workspace.workspaceMode,
        branchMode: workspace.branchMode,
        ...(workspace.branchName.trim()
          ? { branchName: workspace.branchName.trim() }
          : {}),
        ...(workspace.pullLatest ? { pullLatest: true } : {}),
        ...(activeSkills.length ? { skills: activeSkills } : {}),
      });
      void patchPrefs.mutateAsync({
        lastRepo: repoPath.trim(),
        lastProjectId: projectId,
        lastBase: finalBase,
        lastAgent: agent,
        lastAutoCommit: autoCommit,
        lastAutoPush: autoPush,
        lastPermissionMode: permissionMode,
        lastThinkingLevel: thinkingLevel,
        ...(agent === "claude"
          ? { lastModelClaude: model.trim() }
          : { lastModelCodex: model.trim() }),
        workspaceMode: workspace.workspaceMode,
        branchMode: workspace.branchMode,
        pullLatest: workspace.pullLatest,
      });
      toast("Task spawned");
      onClose();
      navigate(`/tasks/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
  };

  const isPending =
    create.isPending || spawnMulti.isPending || createCouncil.isPending;
  const spawnLabel = phaseMode
    ? `spawn ${slices.length} slice${slices.length === 1 ? "" : "s"}`
    : councilMode
      ? "spawn council"
      : "spawn task";

  const modelOptions = [
    { value: "", label: "(default)" },
    ...((modelsQ.data?.models[agent] ?? []).map((m) => ({
      value: m.id,
      label: m.label || m.id,
    }))),
  ];

  const councilMembers = (modelsQ.data?.models[agent] ?? [])
    .slice(0, 5)
    .map((m) => m.label || m.id)
    .join(" / ");

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
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
            "w-[96vw] max-w-[1080px] h-[88vh] max-h-[760px]",
            "flex flex-col",
            "border border-ink-900/10 bg-paper-50 shadow-deep dark:border-ink-50/10 dark:bg-ink-800",
            "sm:rounded-xl overflow-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            New task
          </DialogPrimitive.Title>

          <header className="flex items-center gap-2 px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] shrink-0">
            <Rocket className="h-3.5 w-3.5 text-ember-500" />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
              new task
            </span>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="text-[12px] text-ink-500 dark:text-ink-400">
              spawn an agent in a fresh git worktree
            </span>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto h-6 w-6 inline-flex items-center justify-center rounded text-ink-400 hover:bg-ink-900/[0.04] hover:text-ink-900 dark:text-ink-500 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-50"
              aria-label="close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>

          <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px]">
            {/* Left pane — composer. Project + title up top, prompt fills the rest. */}
            <section className="flex flex-col min-h-0 border-r border-ink-900/[0.06] dark:border-ink-50/[0.06]">
              <div className="px-6 pt-5 space-y-3 shrink-0">
                <ProjectPicker
                  value={projectId}
                  onChange={(p) => {
                    setProjectId(p.id);
                    setRepoPath(p.path);
                  }}
                  autoFocus
                />
                <Input
                  placeholder="Title (optional, auto-derived from prompt)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="flex-1 min-h-0 flex flex-col px-6 pt-3 pb-5">
                {!phaseMode && (
                  <Textarea
                    placeholder="Tell the agent what to do…"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        (e.metaKey || e.ctrlKey) &&
                        e.key === "Enter" &&
                        !isPending
                      ) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                    className="flex-1 min-h-0 resize-none font-mono text-[13px] leading-relaxed"
                  />
                )}
                {phaseMode && (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <PlanSlicesEditor
                      slices={slices}
                      onChange={setSlices}
                      modelSuggestions={{
                        claude: (modelsQ.data?.models.claude ?? []).map(
                          (m) => m.id,
                        ),
                        codex: (modelsQ.data?.models.codex ?? []).map(
                          (m) => m.id,
                        ),
                      }}
                      disabled={spawnMulti.isPending}
                    />
                  </div>
                )}
              </div>
            </section>

            {/* Right pane — settings. Three sections (run / workspace / skills)
              separated by hairline rules. */}
            <section className="flex flex-col min-h-0 bg-paper-100/40 dark:bg-ink-900/40">
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
                <SettingsGroup title="run">
                  <SettingRow label="mode">
                    <ToolbarPick
                      label={spawnMode}
                      options={MODE_OPTIONS}
                      align="end"
                      onSelect={(v) => setMode(v as SpawnMode)}
                    />
                  </SettingRow>
                  <SettingRow label="agent">
                    <ToolbarPick
                      label={agent}
                      options={[
                        { value: "claude", label: "claude" },
                        { value: "codex", label: "codex" },
                      ]}
                      align="end"
                      onSelect={(v) => setAgent(v as "claude" | "codex")}
                    />
                  </SettingRow>
                  {councilMode && (
                    <p className="font-mono text-[10px] text-ink-400 dark:text-ink-500 leading-relaxed">
                      members: {councilMembers || "(no models configured)"}
                    </p>
                  )}
                  {!phaseMode && !councilMode && (
                    <>
                      <SettingRow label="permissions">
                        <ToolbarPick
                          label={permissionLabel(permissionMode)}
                          options={PERMISSION_OPTIONS}
                          align="end"
                          onSelect={(v) =>
                            setPermissionMode(v as PermissionMode)
                          }
                        />
                      </SettingRow>
                      <SettingRow label="thinking">
                        <ToolbarPick
                          label={thinkingLevel}
                          options={THINKING_LEVELS_BY_AGENT[agent].map(
                            (v) => ({ value: v, label: v }),
                          )}
                          align="end"
                          onSelect={(v) =>
                            setThinkingLevel(v as ThinkingLevel)
                          }
                        />
                      </SettingRow>
                      <SettingRow label="model">
                        <ToolbarPick
                          label={model || "default"}
                          options={modelOptions}
                          align="end"
                          onSelect={setModel}
                        />
                      </SettingRow>
                    </>
                  )}
                  {!phaseMode && (
                    <SettingRow label="commit">
                      <ToolbarPick
                        label={commitModeLabel(autoCommit, autoPush)}
                        options={COMMIT_OPTIONS}
                        align="end"
                        onSelect={(v) => {
                          const next = parseCommitMode(v);
                          setAutoCommit(next.autoCommit);
                          setAutoPush(next.autoPush);
                        }}
                      />
                    </SettingRow>
                  )}
                </SettingsGroup>

                <SettingsGroup title="workspace">
                  <WorkspaceRows
                    value={workspace}
                    onChange={(next) => {
                      setWorkspace(next);
                      setBaseBranch(next.baseBranch);
                    }}
                    projectIdOrSlug={projectId || null}
                  />
                </SettingsGroup>

                {availableSkills.length > 0 && (
                  <SettingsGroup
                    title="skills"
                    badge={`${activeSkills.length} active`}
                  >
                    <div className="flex flex-wrap gap-1.5">
                      {availableSkills.map((s) => {
                        const id = `${s.scope}:${s.slug}`;
                        const on = activeSkills.includes(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() =>
                              setActiveSkills((cur) =>
                                cur.includes(id)
                                  ? cur.filter((x) => x !== id)
                                  : [...cur, id],
                              )
                            }
                            title={s.description ?? s.name}
                            className={cn(
                              "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border font-mono text-[11px] transition-colors",
                              on
                                ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                                : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
                            )}
                          >
                            <BookText className="h-3 w-3" />
                            <span>{s.displayName ?? s.name}</span>
                            <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
                              {s.scope}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </SettingsGroup>
                )}
              </div>
            </section>
          </div>

          <footer className="flex items-center gap-1.5 px-5 py-3 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center h-7 px-2.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:hover:text-ink-50"
            >
              cancel
            </button>
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 ml-auto inline-flex items-center gap-1.5">
              <kbd className="px-1 py-0.5 rounded border border-ink-900/10 dark:border-ink-50/10 font-mono text-[9px]">
                ⌘↵
              </kbd>
              to spawn
            </span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 hover:bg-ember-500/15 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPending ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Rocket className="h-2.5 w-2.5" />
              )}
              {spawnLabel}
            </button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SettingsGroup({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0 space-y-2.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-600 dark:text-ink-300">
          {title}
        </span>
        {badge && (
          <span className="font-mono text-[10px] tracking-[0.04em] text-ink-400 dark:text-ink-500">
            {badge}
          </span>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-[28px]">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Compact workspace block for the spawn sheet's right pane. Branch
 * names are auto-generated server-side from the prompt, so this UI
 * exposes only the high-level shape: worktree vs in-place, base
 * branch, optional pull-latest, and an "existing branch" override
 * for re-runs. No manual branch-name input.
 */
function WorkspaceRows({
  value,
  onChange,
  projectIdOrSlug,
}: {
  value: WorkspaceSetupValue;
  onChange: (next: WorkspaceSetupValue) => void;
  projectIdOrSlug: string | null;
}) {
  const client = useClient();
  const branchesQ = useQuery({
    queryKey: ["project", projectIdOrSlug ?? "_none", "branches"] as const,
    queryFn: () => client.listProjectBranches(projectIdOrSlug!),
    enabled: !!projectIdOrSlug && value.branchMode === "existing",
    staleTime: 30_000,
  });

  const branchOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const b of branchesQ.data?.local ?? []) {
      if (!seen.has(b)) {
        seen.add(b);
        out.push({ value: b, label: b });
      }
    }
    for (const r of branchesQ.data?.remote ?? []) {
      if (r.ref && !seen.has(r.ref)) {
        seen.add(r.ref);
        out.push({ value: r.ref, label: r.ref });
      }
    }
    return out;
  }, [branchesQ.data]);

  const update = (patch: Partial<WorkspaceSetupValue>): void => {
    onChange({ ...value, ...patch });
  };

  const branchLabel =
    value.branchMode === "existing"
      ? value.branchName || (branchesQ.isLoading ? "loading…" : "pick existing")
      : "auto";

  return (
    <>
      <SettingRow label="mode">
        <ToolbarPick
          label={value.workspaceMode === "in_place" ? "in-place" : "worktree"}
          options={[
            { value: "worktree", label: "worktree · isolated copy" },
            { value: "in_place", label: "in-place · your real branch" },
          ]}
          align="end"
          onSelect={(v) =>
            update({ workspaceMode: v as WorkspaceSetupValue["workspaceMode"] })
          }
        />
      </SettingRow>
      <SettingRow label="base">
        <input
          value={value.baseBranch}
          onChange={(e) => update({ baseBranch: e.target.value })}
          placeholder="main"
          spellCheck={false}
          className="font-mono text-[11px] h-7 px-2 rounded border border-ink-900/10 bg-paper-50 text-ink-700 placeholder:text-ink-400 outline-none transition-colors hover:border-ink-900/25 focus:border-ember-500/40 focus:bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:placeholder:text-ink-500 dark:hover:border-ink-50/25 w-28 text-right"
        />
      </SettingRow>
      <SettingRow label="branch">
        <ToolbarPick
          label={branchLabel}
          options={[
            { value: "__auto__", label: "auto · generated from prompt" },
            ...(branchOptions.length > 0
              ? branchOptions
              : [{ value: "__none__", label: branchesQ.isLoading ? "loading branches…" : "no existing branches" }]),
          ]}
          align="end"
          onSelect={(v) => {
            if (v === "__auto__")
              update({ branchMode: "new", branchName: "" });
            else if (v !== "__none__")
              update({ branchMode: "existing", branchName: v });
          }}
        />
      </SettingRow>
      <SettingRow label="pull latest">
        <Switch
          checked={value.pullLatest}
          onChange={() => update({ pullLatest: !value.pullLatest })}
        />
      </SettingRow>
      {value.workspaceMode === "in_place" && (
        <p className="text-[10px] text-amber-700 dark:text-amber-300 font-mono leading-relaxed">
          ⚠ in-place commits land on your real branch. Refused if the worktree has uncommitted changes.
        </p>
      )}
    </>
  );
}

/**
 * Pill switch. Track w-9 (36px) with `p-0.5` (4px total inner padding)
 * leaves 32px of inner room. Thumb w-4 (16px) so travel is exactly
 * 16px = `translate-x-4`. The previous toggle used absolute positioning
 * with mismatched offsets and the thumb sat asymmetrically in both states.
 */
function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
        checked
          ? "bg-ember-500"
          : "bg-ink-900/15 hover:bg-ink-900/25 dark:bg-ink-50/15 dark:hover:bg-ink-50/25",
      )}
    >
      <span
        className={cn(
          "h-4 w-4 rounded-full bg-paper-50 shadow-sm transition-transform dark:bg-ink-50",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
