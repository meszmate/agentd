import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Rocket } from "lucide-react";
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
} from "@/queries";
import { useApp } from "@/AppContext";
import { ProjectPicker } from "@/components/project-picker";
import {
  WorkspaceSetup,
  defaultWorkspaceSetup,
  type WorkspaceSetupValue,
} from "@/components/workspace-setup";
import { BookText } from "lucide-react";
import { cn } from "@/lib/utils";

type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan";
type ThinkingLevel = "low" | "medium" | "high" | "max" | "xhigh";

const THINKING_LEVELS: { value: ThinkingLevel; label: string; hint: string }[] = [
  { value: "low", label: "low", hint: "fastest, minimal reasoning — quick edits" },
  { value: "medium", label: "medium", hint: "balanced — most everyday tasks" },
  { value: "high", label: "high", hint: "default — solid for multi-step engineering" },
  { value: "max", label: "max", hint: "extended thinking budget — slower, deeper" },
  { value: "xhigh", label: "xhigh", hint: "deepest tier — gnarly debugging / architecture" },
];

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
  const modelsQ = useModels();
  const [councilMode, setCouncilMode] = useState(false);
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
  // Default ON: the agent is told to commit + push when done. Opening
  // a PR is always manual via the Ship menu — never automatic.
  const [autoPush, setAutoPush] = useState(true);
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
    setAutoPush(p.lastAutoPush);
    setPermissionMode(p.lastPermissionMode);
    setThinkingLevel(p.lastThinkingLevel);
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
    }
  }, [open]);

  const submit = async () => {
    if (!repoPath.trim() || !prompt.trim()) {
      toast("Repo path and prompt are required", true);
      return;
    }
    try {
      const finalBase = (workspace.baseBranch || baseBranch).trim() || "main";

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
      // Persist the form's values to server-side prefs so other devices
      // pick up the same defaults. Ignore failure — the spawn already
      // succeeded and prefs are pure UX state.
      void patchPrefs.mutateAsync({
        lastRepo: repoPath.trim(),
        lastProjectId: projectId,
        lastBase: finalBase,
        lastAgent: agent,
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
                onCheckedChange={setCouncilMode}
              />
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

            <div className="flex items-center justify-between rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 p-3">
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
                {THINKING_LEVELS.map((m) => {
                  const on = thinkingLevel === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setThinkingLevel(m.value)}
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
                {THINKING_LEVELS.find((m) => m.value === thinkingLevel)?.hint}
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
          </div>
        </div>

        <SheetFooter className="border-t border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Spawn task
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}
