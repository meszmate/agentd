import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Rocket } from "lucide-react";
import type { PlanSlice } from "@agentd/contracts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { BookText } from "lucide-react";
import { cn } from "@/lib/utils";

type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan";
type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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
  const [councilMode, setCouncilMode] = useState(false);
  const [phaseMode, setPhaseMode] = useState(false);
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
  // Defaults: commit + push ON, PR OFF (PRs were historically opened
  // manually from the Ship menu — keep that as the default but let the
  // operator opt in per task). All three persist to prefs on submit so
  // the same selections come back on the next spawn.
  const [autoCommit, setAutoCommit] = useState(true);
  const [autoPush, setAutoPush] = useState(true);
  const [autoPr, setAutoPr] = useState(false);
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("bypassPermissions");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("high");
  // Per-agent model preference, hydrated from prefs on mount and on
  // agent switch (so flipping Claude → Codex restores the right pick).
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
    setAutoPr(p.lastAutoPr);
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

  // Clamp the thinking level whenever the operator switches agents so
  // an inapplicable choice (e.g. `max` on codex, `minimal` on claude)
  // doesn't get persisted or sent to the runner.
  useEffect(() => {
    setThinkingLevel((cur) => clampThinkingLevel(agent, cur));
  }, [agent]);

  const skillsQ = useSkills(repoPath || undefined);
  const availableSkills = skillsQ.data?.skills ?? [];

  // Auto-pre-fill local skills (from <repo>/.agents/skills/) when the
  // repo path changes — they're per-project, the user almost certainly
  // wants them on. The user can deselect any of them before spawning.
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
      setPhaseMode(false);
      setSlices([]);
    }
  }, [open]);

  // Phase mode and council mode are mutually exclusive — flipping one
  // on flips the other off so the spawn button knows exactly which
  // path to take. Seeding the slices on first enter gives the operator
  // a working backend/frontend split they can edit instead of staring
  // at an empty editor.
  const togglePhaseMode = (on: boolean) => {
    setPhaseMode(on);
    if (on) {
      setCouncilMode(false);
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
  const toggleCouncilMode = (on: boolean) => {
    setCouncilMode(on);
    if (on) setPhaseMode(false);
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

      // Phase mode: each slice spawns as its own sibling task on a
      // shared branch, chained via dependsOnTaskId. Per-slice agent /
      // model / thinking overrides come from the editor; everything
      // else (workspace, base branch, auto-push) is global.
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

      // Council mode pulls members straight from the registry. Whatever
      // models the user has configured for this agent become parallel
      // candidates — adding a model to config.json grows the council
      // automatically. Capped at 5 members (the council schema limit).
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
        autoPr,
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
      // Persist the form's values to server-side prefs so other devices
      // pick up the same defaults. Ignore failure — the spawn already
      // succeeded and prefs are pure UX state.
      void patchPrefs.mutateAsync({
        lastRepo: repoPath.trim(),
        lastProjectId: projectId,
        lastBase: finalBase,
        lastAgent: agent,
        lastAutoCommit: autoCommit,
        lastAutoPush: autoPush,
        lastAutoPr: autoPr,
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

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" /> New task
          </SheetTitle>
          <SheetDescription>
            Spawn an agent in a fresh git worktree.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2">
          <div className="space-y-4">
            <Field>
              <Label htmlFor="spawn-repo">Project</Label>
              <ProjectPicker
                value={projectId}
                onChange={(p) => {
                  setProjectId(p.id);
                  setRepoPath(p.path);
                }}
                autoFocus
              />
              <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1">
                Pick a saved project or hit "Add project" to register a new one.
              </p>
            </Field>

            <Field>
              <Label htmlFor="spawn-agent">Agent</Label>
              <Select
                value={agent}
                onValueChange={(v) => setAgent(v as "claude" | "codex")}
              >
                <SelectTrigger id="spawn-agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">claude</SelectItem>
                  <SelectItem value="codex">codex</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div
              className={cn(
                "flex items-center justify-between rounded-md border p-3 transition-colors",
                councilMode
                  ? "border-violet-500/30 bg-violet-500/[0.06]"
                  : "border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800",
              )}
            >
              <div>
                <Label className="text-xs normal-case tracking-normal text-foreground">
                  Council mode
                </Label>
                <p className="text-2xs text-muted-foreground">
                  Run the same prompt against{" "}
                  <span className="font-mono">
                    {(modelsQ.data?.models[agent] ?? [])
                      .slice(0, 5)
                      .map((m) => m.label || m.id)
                      .join(" / ") || "(no models configured)"}
                  </span>{" "}
                  in parallel. The judge picks the best diff when they all
                  finish — overrideable from the council page.
                </p>
              </div>
              <Switch
                checked={councilMode}
                onCheckedChange={toggleCouncilMode}
              />
            </div>

            <div
              className={cn(
                "flex items-center justify-between rounded-md border p-3 transition-colors",
                phaseMode
                  ? "border-ember-500/30 bg-ember-500/[0.06]"
                  : "border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800",
              )}
            >
              <div className="pr-3">
                <Label className="text-xs normal-case tracking-normal text-foreground">
                  Multi-agent (phase)
                </Label>
                <p className="text-2xs text-muted-foreground">
                  Split the work into N slices that run sequentially on a
                  shared branch — e.g. backend on codex, frontend on claude.
                  Each slice gets its own prompt, agent and model.
                </p>
              </div>
              <Switch checked={phaseMode} onCheckedChange={togglePhaseMode} />
            </div>

            <Field>
              <Label>Workspace</Label>
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

            <Field>
              <Label htmlFor="spawn-title">Title (optional)</Label>
              <Input
                id="spawn-title"
                placeholder="auto-derived from prompt"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>

            {!phaseMode && (
              <Field>
                <Label htmlFor="spawn-prompt">Prompt</Label>
                <Textarea
                  id="spawn-prompt"
                  rows={6}
                  placeholder="Describe what the agent should do…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      (e.metaKey || e.ctrlKey) &&
                      e.key === "Enter" &&
                      !create.isPending
                    ) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <p className="text-2xs text-muted-foreground">
                  <span className="font-mono">⌘↵</span> to submit
                </p>
              </Field>
            )}

            {phaseMode && (
              <Field>
                <Label>Slices ({slices.length})</Label>
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
                <p className="text-2xs text-muted-foreground mt-1">
                  Slices run in order on a shared branch. Each lands its own
                  commit; per-slice agent / model / thinking override the
                  spawn defaults.
                </p>
              </Field>
            )}

            {availableSkills.length > 0 && (
              <Field>
                <Label>Skills ({activeSkills.length} active)</Label>
                <div className="flex flex-wrap gap-1.5">
                  {availableSkills.map((s) => {
                    const id = `${s.scope}:${s.slug}`;
                    const on = activeSkills.includes(id);
                    const auto = s.scope === "local";
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
                        className={cn(
                          "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-[11px] transition-colors",
                          on
                            ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                            : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
                        )}
                        title={s.description ?? s.name}
                      >
                        <BookText className="h-3 w-3" />
                        <span className="font-medium">
                          {s.displayName ?? s.name}
                        </span>
                        <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
                          {s.scope}
                        </span>
                        {auto && on && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-ember-700 dark:text-ember-300">
                            auto
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="text-2xs text-muted-foreground mt-1">
                  Selected skills get appended to the agent's system prompt.
                </p>
              </Field>
            )}

            <div className="rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 divide-y divide-ink-900/10 dark:divide-ink-50/10">
              <div className="flex items-center justify-between p-3">
                <div>
                  <Label className="text-xs normal-case tracking-normal text-foreground">
                    Auto-commit
                  </Label>
                  <p className="text-2xs text-muted-foreground">
                    Commit any leftover changes when the agent finishes.
                  </p>
                </div>
                <Switch
                  checked={autoCommit}
                  onCheckedChange={setAutoCommit}
                />
              </div>
              <div className="flex items-center justify-between p-3">
                <div>
                  <Label className="text-xs normal-case tracking-normal text-foreground">
                    Auto-push
                  </Label>
                  <p className="text-2xs text-muted-foreground">
                    Push the branch when the agent completes.
                  </p>
                </div>
                <Switch checked={autoPush} onCheckedChange={setAutoPush} />
              </div>
              <div className="flex items-center justify-between p-3">
                <div>
                  <Label className="text-xs normal-case tracking-normal text-foreground">
                    Auto-PR
                  </Label>
                  <p className="text-2xs text-muted-foreground">
                    Open a pull request after the first push (default off).
                  </p>
                </div>
                <Switch checked={autoPr} onCheckedChange={setAutoPr} />
              </div>
            </div>

            {!phaseMode && (
            <>
            <Field>
              <Label>Permissions</Label>
              <div className="flex flex-wrap gap-1.5">
                {PERMISSION_MODES.map((m) => {
                  const on = permissionMode === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setPermissionMode(m.value)}
                      title={m.hint}
                      className={cn(
                        "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-[11px] transition-colors",
                        on
                          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
                      )}
                    >
                      <span className="font-mono">{m.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-2xs text-muted-foreground mt-1">
                {PERMISSION_MODES.find((m) => m.value === permissionMode)?.hint}
              </p>
            </Field>

            <Field>
              <Label>Thinking</Label>
              <div className="flex flex-wrap gap-1.5">
                {THINKING_LEVELS_BY_AGENT[agent].map((value) => {
                  const meta = THINKING_LEVEL_META[value];
                  const on = thinkingLevel === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setThinkingLevel(value)}
                      title={meta.hint}
                      className={cn(
                        "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-[11px] transition-colors",
                        on
                          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
                      )}
                    >
                      <span className="font-mono">{meta.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-2xs text-muted-foreground mt-1">
                {THINKING_LEVEL_META[thinkingLevel].hint}
              </p>
            </Field>

            <Field>
              <Label>Model</Label>
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
              <p className="text-2xs text-muted-foreground mt-1">
                Empty falls back to your Settings → Models default. Per-task
                override only — flips back via the chip on the task header.
              </p>
            </Field>
            </>
            )}
          </div>
        </div>

        <SheetFooter className="border-t border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending || spawnMulti.isPending}
          >
            {create.isPending || spawnMulti.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {phaseMode
              ? `Spawn ${slices.length} slice${slices.length === 1 ? "" : "s"}`
              : councilMode
                ? "Spawn council"
                : "Spawn task"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}
