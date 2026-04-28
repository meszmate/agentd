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
import { useCreateTask } from "@/queries";
import { useApp } from "@/AppContext";

const REPO_KEY = "agentd.lastRepo";
const BASE_KEY = "agentd.lastBase";

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

  const [repoPath, setRepoPath] = useState(
    () => localStorage.getItem(REPO_KEY) ?? "",
  );
  const [baseBranch, setBaseBranch] = useState(
    () => localStorage.getItem(BASE_KEY) ?? "main",
  );
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [autoPush, setAutoPush] = useState(false);
  const [autoPr, setAutoPr] = useState(false);

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
      });
      localStorage.setItem(REPO_KEY, repoPath.trim());
      localStorage.setItem(BASE_KEY, baseBranch.trim() || "main");
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
              <Label htmlFor="spawn-repo">Repository path</Label>
              <Input
                id="spawn-repo"
                placeholder="/path/to/git/repo"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                autoFocus
                spellCheck={false}
                className="font-mono"
              />
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

            <div className="flex items-center justify-between rounded-md border border-ink-900/10 bg-cream-50 dark:border-ink-50/10 dark:bg-ink-900/40 p-3">
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

            <div className="flex items-center justify-between rounded-md border border-ink-900/10 bg-cream-50 dark:border-ink-50/10 dark:bg-ink-900/40 p-3">
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
          </div>
        </div>

        <SheetFooter className="border-t border-ink-900/10 bg-cream-50 dark:border-ink-50/10 dark:bg-ink-900/40">
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
