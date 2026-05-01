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
import { useCreateTask, useSkills } from "@/queries";
import { useApp } from "@/AppContext";
import { ProjectPicker } from "@/components/project-picker";
import { BookText } from "lucide-react";
import { cn } from "@/lib/utils";

const REPO_KEY = "agentd.lastRepo";
const PROJECT_KEY = "agentd.lastProjectId";
const BASE_KEY = "agentd.lastBase";
const AGENT_KEY = "agentd.lastAgent";
const AUTOPUSH_KEY = "agentd.lastAutoPush";
const AUTOPR_KEY = "agentd.lastAutoPr";
const PERMS_KEY = "agentd.lastPermissionMode";

type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan";

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

function loadBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === "1") return true;
  if (v === "0") return false;
  return fallback;
}

function loadPermissionMode(): PermissionMode {
  const v = localStorage.getItem(PERMS_KEY);
  if (v === "acceptEdits" || v === "plan" || v === "bypassPermissions") return v;
  return "bypassPermissions";
}

export function SpawnSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateTask();
  const navigate = useNavigate();
  const { toast } = useApp();

  const [projectId, setProjectId] = useState<string>(
    () => localStorage.getItem(PROJECT_KEY) ?? "",
  );
  const [repoPath, setRepoPath] = useState(
    () => localStorage.getItem(REPO_KEY) ?? "",
  );
  const [baseBranch, setBaseBranch] = useState(
    () => localStorage.getItem(BASE_KEY) ?? "main",
  );
  const [agent, setAgent] = useState<"claude" | "codex">(
    () =>
      (localStorage.getItem(AGENT_KEY) as "claude" | "codex" | null) ?? "claude",
  );
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [autoPush, setAutoPush] = useState(() => loadBool(AUTOPUSH_KEY, false));
  const [autoPr, setAutoPr] = useState(() => loadBool(AUTOPR_KEY, false));
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => loadPermissionMode(),
  );
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [autoFilledForPath, setAutoFilledForPath] = useState<string>("");

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
      const res = await create.mutateAsync({
        agent,
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        autoPush,
        autoPr,
        permissionMode,
        ...(activeSkills.length ? { skills: activeSkills } : {}),
      });
      localStorage.setItem(REPO_KEY, repoPath.trim());
      if (projectId) localStorage.setItem(PROJECT_KEY, projectId);
      localStorage.setItem(BASE_KEY, baseBranch.trim() || "main");
      localStorage.setItem(AGENT_KEY, agent);
      localStorage.setItem(AUTOPUSH_KEY, autoPush ? "1" : "0");
      localStorage.setItem(AUTOPR_KEY, autoPr ? "1" : "0");
      localStorage.setItem(PERMS_KEY, permissionMode);
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

            <div className="grid grid-cols-2 gap-3">
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
              <Field>
                <Label htmlFor="spawn-base">Base branch</Label>
                <Input
                  id="spawn-base"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  placeholder="main"
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
            </div>

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

            <div className="flex items-center justify-between rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 p-3">
              <div>
                <Label className="text-xs normal-case tracking-normal text-foreground">
                  Auto-PR
                </Label>
                <p className="text-2xs text-muted-foreground">
                  Open a pull request via <span className="font-mono">gh</span>{" "}
                  when complete.
                </p>
              </div>
              <Switch
                checked={autoPr}
                onCheckedChange={(v) => {
                  setAutoPr(v);
                  if (v) setAutoPush(true);
                }}
              />
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
