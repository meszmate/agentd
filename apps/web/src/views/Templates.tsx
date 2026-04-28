import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FileTerminal,
  Loader2,
  Play,
  Plus,
  Rocket,
  Trash2,
} from "lucide-react";
import type { Task, Template } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useCreateTemplate,
  useDeleteTemplate,
  useRunTemplate,
  useTasks,
  useTemplates,
} from "@/queries";
import { useApp } from "@/AppContext";
import {
  formatCost,
  formatTs,
  shortId,
} from "@/lib/utils";

export function Templates() {
  const { toast } = useApp();
  const tplQ = useTemplates();
  const tasksQ = useTasks();
  const del = useDeleteTemplate();
  const [createOpen, setCreateOpen] = useState(false);
  const [runFor, setRunFor] = useState<Template | null>(null);

  const items = tplQ.data?.templates ?? [];
  const tasks = tasksQ.data?.tasks ?? [];

  const statsByTemplate = useMemo(() => {
    const map = new Map<
      string,
      { runs: number; lastRunTs: number; avgCost: number }
    >();
    for (const t of items) {
      map.set(t.id, { runs: 0, lastRunTs: 0, avgCost: 0 });
    }
    let costAcc = new Map<string, { sum: number; n: number }>();
    for (const task of tasks) {
      if (!task.templateId) continue;
      const entry = map.get(task.templateId);
      if (!entry) continue;
      entry.runs += 1;
      if (task.createdAt > entry.lastRunTs) entry.lastRunTs = task.createdAt;
      if (task.totalCostUsd != null) {
        const ca = costAcc.get(task.templateId) ?? { sum: 0, n: 0 };
        ca.sum += task.totalCostUsd;
        ca.n += 1;
        costAcc.set(task.templateId, ca);
      }
    }
    for (const [id, ca] of costAcc.entries()) {
      const e = map.get(id);
      if (e) e.avgCost = ca.n > 0 ? ca.sum / ca.n : 0;
    }
    return map;
  }, [items, tasks]);

  const recentRunsByTemplate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of items) map.set(t.id, []);
    for (const task of tasks) {
      if (!task.templateId) continue;
      const arr = map.get(task.templateId);
      if (!arr) continue;
      arr.push(task);
    }
    for (const [, arr] of map.entries()) {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    }
    return map;
  }, [items, tasks]);

  const rm = async (t: Template) => {
    if (!confirm(`Delete template '${t.name}'?`)) return;
    try {
      await del.mutateAsync(t.name);
      toast(`Deleted ${t.name}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 lg:px-10 py-8 lg:py-10">
        <header className="rise rise-1 flex items-end justify-between gap-4 mb-8">
          <div>
            <div className="label-section mb-2">Library</div>
            <h1 className="display text-4xl sm:text-5xl text-ink-900 dark:text-ink-50">
              Templates
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
              Reusable prompts with{" "}
              <span className="font-mono">{"{placeholders}"}</span>. Run on
              demand or wire to a schedule.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New template
          </Button>
        </header>

        {tplQ.isLoading ? (
          <div className="text-center py-16 text-sm text-ink-500 dark:text-ink-400">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="rise rise-2 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                stats={statsByTemplate.get(t.id) ?? { runs: 0, lastRunTs: 0, avgCost: 0 }}
                recentRuns={(recentRunsByTemplate.get(t.id) ?? []).slice(0, 3)}
                onRun={() => setRunFor(t)}
                onDelete={() => void rm(t)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateTemplateSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <RunTemplateSheet template={runFor} onClose={() => setRunFor(null)} />
    </div>
  );
}

function TemplateCard({
  template: t,
  stats,
  recentRuns,
  onRun,
  onDelete,
}: {
  template: Template;
  stats: { runs: number; lastRunTs: number; avgCost: number };
  recentRuns: Task[];
  onRun: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="group relative flex flex-col rounded-2xl border border-ink-900/10 bg-cream-50 p-5 shadow-edit transition-all hover:-translate-y-0.5 hover:shadow-deep dark:border-ink-50/10 dark:bg-ink-800">
      <header className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="display text-xl text-ink-900 dark:text-ink-50 leading-tight truncate">
            {t.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{t.agent}</Badge>
            {t.autoPush && <Badge variant="outline">push</Badge>}
            {t.autoPr && <Badge variant="vermilion">pr</Badge>}
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${t.name}`}
          className="shrink-0 rounded-md p-1.5 text-ink-400 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 dark:text-ink-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      <p className="font-mono text-xs text-ink-500 dark:text-ink-400 line-clamp-3 mb-3 min-h-[3.6em]">
        {t.promptTemplate}
      </p>

      <code className="mb-3 truncate font-mono text-2xs text-ink-400 dark:text-ink-500">
        {t.repoPath} ← {t.baseBranch}
      </code>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 border-t border-ink-900/10 pt-3 dark:border-ink-50/10">
        <Stat label="Runs" value={String(stats.runs)} />
        <Stat
          label="Last"
          value={stats.lastRunTs ? formatTs(stats.lastRunTs) : "—"}
        />
        <Stat
          label="Avg cost"
          value={stats.runs > 0 ? formatCost(stats.avgCost) : "—"}
        />
      </div>

      {/* Recent runs */}
      {recentRuns.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {recentRuns.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 font-mono text-2xs text-ink-500 dark:text-ink-400"
            >
              <span
                className={
                  r.status === "done"
                    ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                    : r.status === "failed" || r.status === "stopped"
                    ? "h-1.5 w-1.5 rounded-full bg-red-500"
                    : "h-1.5 w-1.5 rounded-full bg-vermilion-500"
                }
              />
              <span className="truncate flex-1">{shortId(r.id)}</span>
              <span>{formatTs(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center gap-2 pt-3 border-t border-ink-900/10 dark:border-ink-50/10">
        <Button size="sm" className="flex-1" onClick={onRun}>
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
        {label}
      </div>
      <div className="mt-0.5 num text-base text-ink-900 dark:text-ink-50">
        {value}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-3xl border border-dashed border-ink-900/10 p-16 text-center dark:border-ink-50/10">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-vermilion-500/10 text-vermilion-600 dark:text-vermilion-400">
        <FileTerminal className="h-5 w-5" />
      </div>
      <h2 className="mt-5 display text-2xl text-ink-900 dark:text-ink-50">
        No templates yet
      </h2>
      <p className="mt-2 max-w-sm mx-auto text-sm text-ink-500 dark:text-ink-400">
        Save a reusable prompt with{" "}
        <span className="font-mono">{"{placeholders}"}</span> to substitute
        args at run time. Schedules need a template too.
      </p>
      <Button className="mt-5" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" /> New template
      </Button>
    </div>
  );
}

function CreateTemplateSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateTemplate();
  const { toast } = useApp();
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [repoPath, setRepoPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [autoPush, setAutoPush] = useState(false);
  const [autoPr, setAutoPr] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState("");

  const submit = async () => {
    if (!name.trim() || !repoPath.trim() || !promptTemplate.trim()) {
      toast("Name, repo path, and prompt are required", true);
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        agent,
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        promptTemplate,
        autoPush: autoPush || autoPr,
        autoPr,
      });
      toast(`Created ${name}`);
      setName("");
      setRepoPath("");
      setPromptTemplate("");
      setAutoPush(false);
      setAutoPr(false);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle>New template</SheetTitle>
          <SheetDescription>
            Use <span className="font-mono">{"{name}"}</span> placeholders for
            run-time arguments.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4 space-y-4">
          <Field>
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. review-pr"
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <Label htmlFor="tpl-agent">Agent</Label>
              <Select
                value={agent}
                onValueChange={(v) => setAgent(v as "claude" | "codex")}
              >
                <SelectTrigger id="tpl-agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">claude</SelectItem>
                  <SelectItem value="codex">codex</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <Label htmlFor="tpl-base">Base branch</Label>
              <Input
                id="tpl-base"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="font-mono"
                spellCheck={false}
              />
            </Field>
          </div>
          <Field>
            <Label htmlFor="tpl-repo">Repo path</Label>
            <Input
              id="tpl-repo"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/path/to/repo"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field>
            <Label htmlFor="tpl-prompt">Prompt template</Label>
            <Textarea
              id="tpl-prompt"
              rows={6}
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              placeholder={"Review PR #{pr_number}. Suggest fixes."}
              className="font-mono text-xs"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <ToggleRow
              label="Auto-push"
              hint="Push branch on completion."
              checked={autoPush}
              onChange={setAutoPush}
            />
            <ToggleRow
              label="Auto-PR"
              hint="Open PR via gh."
              checked={autoPr}
              onChange={(v) => {
                setAutoPr(v);
                if (v) setAutoPush(true);
              }}
            />
          </div>
        </div>

        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RunTemplateSheet({
  template,
  onClose,
}: {
  template: Template | null;
  onClose: () => void;
}) {
  const run = useRunTemplate();
  const { toast } = useApp();
  const navigate = useNavigate();
  const [argInput, setArgInput] = useState("");

  const placeholders = extractPlaceholders(template?.promptTemplate ?? "");

  const submit = async () => {
    if (!template) return;
    try {
      const args = parseArgs(argInput);
      const { task } = await run.mutateAsync({ name: template.name, args });
      toast(`Ran ${template.name} → ${shortId(task.id)}`);
      setArgInput("");
      onClose();
      navigate(`/tasks/${task.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Sheet open={!!template} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>Run {template?.name}</SheetTitle>
          <SheetDescription>
            Provide values for any placeholders, then fire.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4 space-y-4">
          {placeholders.length > 0 && (
            <div className="rounded-xl border border-ink-900/10 bg-ink-900/[0.02] p-3 dark:border-ink-50/10 dark:bg-ink-50/[0.02]">
              <div className="label-section mb-1.5">Placeholders</div>
              <div className="flex flex-wrap gap-1">
                {placeholders.map((p) => (
                  <Badge key={p} variant="outline" className="font-mono">
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <Field>
            <Label htmlFor="run-args">Arguments</Label>
            <Textarea
              id="run-args"
              rows={3}
              value={argInput}
              onChange={(e) => setArgInput(e.target.value)}
              placeholder={
                placeholders.map((p) => `${p}=value`).join(" ") ||
                "key=value other=value"
              }
              className="font-mono text-xs"
              autoFocus
            />
            <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1">
              Space- or newline-separated{" "}
              <span className="font-mono">key=value</span> pairs.
            </p>
          </Field>

          {template && (
            <Field>
              <Label>Prompt preview</Label>
              <pre className="rounded-lg border border-ink-900/10 bg-ink-900/[0.02] p-3 font-mono text-xs whitespace-pre-wrap break-words leading-relaxed text-ink-700 dark:text-ink-300 dark:border-ink-50/10 dark:bg-ink-50/[0.02]">
                {template.promptTemplate}
              </pre>
            </Field>
          )}
        </div>

        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={run.isPending}>
            {run.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Run
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ToggleRow({
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
    <label className="flex items-center justify-between gap-3 rounded-lg border border-ink-900/10 bg-ink-900/[0.02] p-2.5 cursor-pointer dark:border-ink-50/10 dark:bg-ink-50/[0.02]">
      <div>
        <div className="text-xs font-medium">{label}</div>
        <div className="text-2xs text-ink-500 dark:text-ink-400">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function parseArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function extractPlaceholders(s: string): string[] {
  const set = new Set<string>();
  for (const m of s.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
    set.add(m[1]!);
  }
  return [...set];
}

