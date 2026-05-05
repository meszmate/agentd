import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookText, Loader2, Rocket, X } from "lucide-react";
import type { PlanSlice } from "@agentd/contracts";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  useCreateCouncil,
  useCreateTask,
  useModels,
  usePatchPrefs,
  usePrefs,
  useSkills,
  useSpawnTasksMulti,
} from "@/queries";
import { useApp } from "@/AppContext";
import { ProjectPicker } from "@/components/project-picker";
import { PlanSlicesEditor } from "@/components/plan-slices-editor";
import {
  WorkspaceSetup,
  defaultWorkspaceSetup,
  type WorkspaceSetupValue,
} from "@/components/workspace-setup";
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

// Per-agent thinking-level choices. Claude's CLI takes `--effort` and
// accepts low|medium|high|xhigh|max (no `minimal`). Codex's CLI takes
// `-c model_reasoning_effort=` and accepts minimal|low|medium|high|xhigh
// (no `max`). The UI hides values that aren't valid for the selected
// agent so the operator doesn't pick something the runner has to clamp.
const THINKING_LEVEL_META: Record<
  ThinkingLevel,
  { label: string; hint: string }
> = {
  minimal: {
    label: "minimal",
    hint: "codex-only — lightest reasoning tier; near-zero think time",
  },
  low: { label: "low", hint: "fastest — quick edits / small refactors" },
  medium: { label: "medium", hint: "balanced — most everyday tasks" },
  high: { label: "high", hint: "default — solid for multi-step engineering" },
  xhigh: {
    label: "xhigh",
    hint: "deepest tier — gnarly debugging / architecture",
  },
  max: {
    label: "max",
    hint: "claude-only — extended thinking budget; slower, deeper",
  },
};

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

const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  {
    value: "bypassPermissions",
    label: "bypass",
    hint: "auto-allow every tool — fastest, default for unattended runs",
  },
  {
    value: "acceptEdits",
    label: "accept-edits",
    hint: "auto-allow file edits, refuse other tools (Bash, web, …)",
  },
  {
    value: "plan",
    label: "plan",
    hint: "read-only — agent produces a plan but doesn't change files",
  },
];

const SPAWN_MODE_META: Record<SpawnMode, { label: string; hint: string }> = {
  solo: {
    label: "solo",
    hint: "single task on a fresh worktree — the default",
  },
  council: {
    label: "council",
    hint: "run the same prompt across all configured models in parallel; a judge picks the best diff",
  },
  phase: {
    label: "phase",
    hint: "split work into N sequential slices on a shared branch — each slice picks its own agent / model",
  },
};

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

  // Form state — initialized to safe defaults, then hydrated from the
  // server-stored prefs once they arrive. Subsequent edits stay local
  // until the user hits Spawn, at which point we patch prefs.
  const [projectId, setProjectId] = useState<string>("");
  const [repoPath, setRepoPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
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
    defaultWorkspaceSetup("main"),
  );
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [autoFilledForPath, setAutoFilledForPath] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);

  // One-shot hydration from server prefs. Subsequent edits stay local.
  useEffect(() => {
    if (hydrated) return;
    const p = prefsQ.data?.prefs;
    if (!p) return;
    setProjectId(p.lastProjectId);
    setRepoPath(p.lastRepo);
    setBaseBranch(p.lastBase || "main");
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
      baseBranch: p.lastBase || "main",
      pullLatest: p.pullLatest,
    });
    setHydrated(true);
  }, [prefsQ.data, hydrated]);

  // Whenever the agent flips after hydration, swap model to that
  // agent's last-picked value from prefs.
  useEffect(() => {
    if (!hydrated || !prefsQ.data) return;
    setModel(
      agent === "claude"
        ? prefsQ.data.prefs.lastModelClaude
        : prefsQ.data.prefs.lastModelCodex,
    );
  }, [agent, hydrated, prefsQ.data]);

  // Clamp thinking level whenever the operator switches agents so an
  // inapplicable choice (e.g. `max` on codex, `minimal` on claude)
  // doesn't get persisted or sent to the runner.
  useEffect(() => {
    setThinkingLevel((cur) => clampThinkingLevel(agent, cur));
  }, [agent]);

  const skillsQ = useSkills(repoPath || undefined);
  const availableSkills = skillsQ.data?.skills ?? [];

  // Auto-pre-fill local skills when repo path changes — they're
  // per-project, the user almost certainly wants them on. The user can
  // deselect any of them before spawning.
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
      const finalBase = (workspace.baseBranch || baseBranch).trim() || "main";

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
            "w-[96vw] h-[88vh] max-w-[1100px]",
            "flex flex-col",
            "border border-ink-900/10 bg-paper-50 shadow-deep dark:border-ink-50/10 dark:bg-ink-800",
            "sm:rounded-xl overflow-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            New task
          </DialogPrimitive.Title>

          {/* Top header bar */}
          <header className="flex items-center gap-2 px-4 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
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

          {/* Body — two pane */}
          <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {/* ── LEFT: intent ──────────────────────────────── */}
            <section className="flex flex-col min-w-0 border-r border-ink-900/[0.06] dark:border-ink-50/[0.06] overflow-hidden">
              <header className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                  intent
                </span>
              </header>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
                <Field>
                  <FieldLabel>project</FieldLabel>
                  <ProjectPicker
                    value={projectId}
                    onChange={(p) => {
                      setProjectId(p.id);
                      setRepoPath(p.path);
                    }}
                    autoFocus
                  />
                  <FieldHint>
                    Pick a saved project or hit "Add project" to register a new one.
                  </FieldHint>
                </Field>

                <Field>
                  <FieldLabel>title (optional)</FieldLabel>
                  <Input
                    placeholder="auto-derived from prompt"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>

                {!phaseMode && (
                  <Field>
                    <FieldLabel>prompt</FieldLabel>
                    <Textarea
                      rows={14}
                      placeholder="Describe what the agent should do…"
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
                      className="resize-none font-mono text-[12.5px] leading-relaxed"
                    />
                    <p className="text-[10px] font-mono text-ink-400 dark:text-ink-500 mt-1 inline-flex items-center gap-1.5">
                      <kbd className="px-1 py-0.5 rounded border border-ink-900/10 dark:border-ink-50/10 font-mono text-[9px]">
                        ⌘↵
                      </kbd>
                      to spawn
                    </p>
                  </Field>
                )}

                {phaseMode && (
                  <Field>
                    <FieldLabel>
                      slices · {slices.length}
                    </FieldLabel>
                    <PlanSlicesEditor
                      slices={slices}
                      onChange={setSlices}
                      modelSuggestions={{
                        claude: (modelsQ.data?.models.claude ?? []).map(
                          (m) => m.id,
                        ),
                        codex: (modelsQ.data?.models.codex ?? []).map((m) => m.id),
                      }}
                      disabled={spawnMulti.isPending}
                    />
                    <FieldHint>
                      Slices run in order on a shared branch. Each lands its own
                      commit; per-slice agent / model / thinking override the
                      spawn defaults.
                    </FieldHint>
                  </Field>
                )}
              </div>
            </section>

            {/* ── RIGHT: configuration ──────────────────────── */}
            <section className="flex flex-col min-w-0 bg-paper-100/40 dark:bg-ink-900/40 overflow-hidden">
              <header className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                  configuration
                </span>
              </header>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
                <Field>
                  <FieldLabel>mode</FieldLabel>
                  <ChipGroup>
                    {(["solo", "council", "phase"] as SpawnMode[]).map((m) => (
                      <Chip
                        key={m}
                        on={spawnMode === m}
                        onClick={() => setMode(m)}
                        title={SPAWN_MODE_META[m].hint}
                      >
                        {SPAWN_MODE_META[m].label}
                      </Chip>
                    ))}
                  </ChipGroup>
                  <FieldHint>{SPAWN_MODE_META[spawnMode].hint}</FieldHint>
                </Field>

                <Field>
                  <FieldLabel>agent</FieldLabel>
                  <ChipGroup>
                    {(["claude", "codex"] as const).map((a) => (
                      <Chip
                        key={a}
                        on={agent === a}
                        onClick={() => setAgent(a)}
                      >
                        {a}
                      </Chip>
                    ))}
                  </ChipGroup>
                  {councilMode && (
                    <FieldHint>
                      Council members:{" "}
                      <span className="font-mono">
                        {(modelsQ.data?.models[agent] ?? [])
                          .slice(0, 5)
                          .map((m) => m.label || m.id)
                          .join(" / ") || "(no models configured)"}
                      </span>
                    </FieldHint>
                  )}
                </Field>

                <Field>
                  <FieldLabel>workspace</FieldLabel>
                  <WorkspaceSetup
                    value={workspace}
                    onChange={(next) => {
                      setWorkspace(next);
                      setBaseBranch(next.baseBranch);
                    }}
                    projectIdOrSlug={projectId || null}
                    prompt={prompt}
                    agent={agent}
                    model={model}
                    thinkingLevel={thinkingLevel}
                  />
                </Field>

                {!phaseMode && (
                  <>
                    <Field>
                      <FieldLabel>permissions</FieldLabel>
                      <ChipGroup>
                        {PERMISSION_MODES.map((m) => (
                          <Chip
                            key={m.value}
                            on={permissionMode === m.value}
                            onClick={() => setPermissionMode(m.value)}
                            title={m.hint}
                          >
                            {m.label}
                          </Chip>
                        ))}
                      </ChipGroup>
                      <FieldHint>
                        {
                          PERMISSION_MODES.find((m) => m.value === permissionMode)
                            ?.hint
                        }
                      </FieldHint>
                    </Field>

                    <Field>
                      <FieldLabel>thinking</FieldLabel>
                      <ChipGroup>
                        {THINKING_LEVELS_BY_AGENT[agent].map((value) => {
                          const meta = THINKING_LEVEL_META[value];
                          return (
                            <Chip
                              key={value}
                              on={thinkingLevel === value}
                              onClick={() => setThinkingLevel(value)}
                              title={meta.hint}
                            >
                              {meta.label}
                            </Chip>
                          );
                        })}
                      </ChipGroup>
                      <FieldHint>
                        {THINKING_LEVEL_META[thinkingLevel].hint}
                      </FieldHint>
                    </Field>

                    <Field>
                      <FieldLabel>model</FieldLabel>
                      <Input
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={(() => {
                          const first = modelsQ.data?.models[agent]?.[0];
                          return first
                            ? `(default) e.g. ${first.id}`
                            : "(default)";
                        })()}
                        spellCheck={false}
                        className="font-mono text-xs"
                      />
                      <FieldHint>
                        Empty falls back to your Settings → Models default.
                        Per-task override only.
                      </FieldHint>
                    </Field>
                  </>
                )}

                {availableSkills.length > 0 && (
                  <Field>
                    <FieldLabel>
                      skills · {activeSkills.length} active
                    </FieldLabel>
                    <ChipGroup>
                      {availableSkills.map((s) => {
                        const id = `${s.scope}:${s.slug}`;
                        const on = activeSkills.includes(id);
                        const auto = s.scope === "local";
                        return (
                          <Chip
                            key={id}
                            on={on}
                            onClick={() =>
                              setActiveSkills((cur) =>
                                cur.includes(id)
                                  ? cur.filter((x) => x !== id)
                                  : [...cur, id],
                              )
                            }
                            title={s.description ?? s.name}
                          >
                            <BookText className="h-3 w-3" />
                            <span>{s.displayName ?? s.name}</span>
                            <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
                              {s.scope}
                            </span>
                            {auto && on && (
                              <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-ember-700 dark:text-ember-300">
                                auto
                              </span>
                            )}
                          </Chip>
                        );
                      })}
                    </ChipGroup>
                    <FieldHint>
                      Selected skills get appended to the agent's system prompt.
                    </FieldHint>
                  </Field>
                )}

                <div className="rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
                  <SwitchRow
                    label="auto-commit"
                    hint="Commit any leftover changes when the agent finishes."
                    checked={autoCommit}
                    onChange={setAutoCommit}
                  />
                  <SwitchRow
                    label="auto-push"
                    hint="Push the branch when the agent completes."
                    checked={autoPush}
                    onChange={setAutoPush}
                  />
                </div>
              </div>
            </section>
          </div>

          {/* Footer */}
          <footer className="flex items-center gap-1.5 px-4 py-3 border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center h-7 px-2.5 rounded font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 dark:hover:text-ink-50"
            >
              cancel
            </button>
            <span className="ml-auto" />
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

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 block">
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] text-ink-400 dark:text-ink-500 leading-relaxed">
      {children}
    </p>
  );
}

function ChipGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function Chip({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border font-mono text-[11px] transition-colors",
        on
          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
      )}
    >
      {children}
    </button>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-3">
      <div className="pr-3">
        <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200">
          {label}
        </span>
        <p className="text-[10px] text-ink-400 dark:text-ink-500 leading-relaxed mt-0.5">
          {hint}
        </p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
