import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, Rocket } from "lucide-react";
import type { Task, Template } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
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
  useModels,
  useRunTemplate,
  useTasks,
  useTemplates,
} from "@/queries";
import { useApp } from "@/AppContext";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectPicker } from "@/components/project-picker";
import {
  cn,
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
  const [search, setSearch] = useState("");

  const items = tplQ.data?.templates ?? [];
  const tasks = tasksQ.data?.tasks ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.repoPath.toLowerCase().includes(q) ||
        t.promptTemplate.toLowerCase().includes(q),
    );
  }, [items, search]);

  const statsByTemplate = useMemo(() => {
    const map = new Map<
      string,
      { runs: number; lastRunTs: number; totalCost: number }
    >();
    for (const t of items) {
      map.set(t.id, { runs: 0, lastRunTs: 0, totalCost: 0 });
    }
    for (const task of tasks) {
      if (!task.templateId) continue;
      const entry = map.get(task.templateId);
      if (!entry) continue;
      entry.runs += 1;
      if (task.createdAt > entry.lastRunTs) entry.lastRunTs = task.createdAt;
      if (task.totalCostUsd != null) entry.totalCost += task.totalCostUsd;
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
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>library</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Templates
        </span>
        <Count>{items.length}</Count>
        <Spacer />
        <div className="relative w-[220px]">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
            ⌕
          </span>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search…"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        <Button size="xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3" /> New
        </Button>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tplQ.isLoading ? (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-5 py-3 flex items-start gap-4">
                <Skeleton className="h-3 w-3 rounded-sm mt-1" />
                <div className="flex-1">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-72 mt-2" />
                  <Skeleton className="h-2.5 w-56 mt-1.5" />
                </div>
                <Skeleton className="h-3 w-12 mt-1 hidden md:block" />
                <Skeleton className="h-7 w-14" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-[12px] text-ink-500 dark:text-ink-400">
            No templates match search.
          </div>
        ) : (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {filtered.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                stats={
                  statsByTemplate.get(t.id) ?? {
                    runs: 0,
                    lastRunTs: 0,
                    totalCost: 0,
                  }
                }
                onRun={() => setRunFor(t)}
                onDelete={() => void rm(t)}
              />
            ))}
          </ul>
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

function TemplateRow({
  template: t,
  stats,
  onRun,
  onDelete,
}: {
  template: Template;
  stats: { runs: number; lastRunTs: number; totalCost: number };
  onRun: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group h-auto min-h-12 px-5 py-3 flex items-start gap-4 hover:bg-paper-100 transition-colors dark:hover:bg-ink-700">
      {/* Glyph column */}
      <div className="w-3 shrink-0 mt-0.5">
        <span className="font-mono text-[12px] text-ink-300 dark:text-ink-600 group-hover:text-ember-500 transition-colors">
          ▤
        </span>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {t.name}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
            {t.agent}
          </span>
          {t.autoPush && (
            <span className="inline-flex items-center h-4 px-1 rounded text-[9px] font-medium uppercase tracking-[0.08em] bg-ink-900/[0.05] text-ink-600 dark:bg-ink-50/[0.05] dark:text-ink-300">
              push
            </span>
          )}
          {t.autoPr && (
            <span className="inline-flex items-center h-4 px-1 rounded text-[9px] font-medium uppercase tracking-[0.08em] bg-ember-500/10 text-ember-700 dark:text-ember-300">
              pr
            </span>
          )}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-ink-500 dark:text-ink-400 line-clamp-2 leading-relaxed">
          {t.promptTemplate}
        </p>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
          <span className="truncate max-w-[40ch]">{t.repoPath}</span>
          <span className="text-ink-300 dark:text-ink-600">·</span>
          <span>{t.baseBranch}</span>
        </div>
      </div>

      {/* Stats column */}
      <div className="hidden md:flex items-baseline gap-4 shrink-0 font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500 mt-0.5">
        <span title="runs">
          <span
            className={cn(
              "tabular-nums",
              stats.runs > 0 && "text-ink-700 dark:text-ink-200 font-medium",
            )}
          >
            {stats.runs}
          </span>{" "}
          runs
        </span>
        <span title="last run">
          {stats.lastRunTs ? formatTs(stats.lastRunTs) : "—"}
        </span>
        <span title="total cost">
          {stats.runs > 0 ? formatCost(stats.totalCost) : "—"}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0 ml-auto md:ml-0">
        <Button size="xs" onClick={onRun}>
          <Rocket className="h-3 w-3" /> Run
        </Button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${t.name}`}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 size-7 rounded-md text-ink-400 hover:bg-red-500/10 hover:text-red-600 transition-all flex items-center justify-center font-mono text-[14px] dark:text-ink-500"
        >
          ×
        </button>
      </div>
    </li>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16">
      <span className="font-mono text-[24px] text-ink-300 dark:text-ink-600">
        ▤
      </span>
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        No templates yet
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        Save a reusable prompt with{" "}
        <span className="font-mono">{"{placeholders}"}</span> to substitute
        args at run time. Schedules need a template too.
      </p>
      <Button size="sm" className="mt-2" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" /> New template
      </Button>
    </div>
  );
}

/* ── Sheets ────────────────────────────────────────────────────────── */

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function CreateTemplateSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateTemplate();
  const modelsQ = useModels();
  const { toast } = useApp();
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [projectId, setProjectId] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [autoPush, setAutoPush] = useState(false);
  const [autoPr, setAutoPr] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState("");
  const [permissionMode, setPermissionMode] = useState<
    "bypassPermissions" | "acceptEdits" | "plan"
  >("bypassPermissions");
  const [thinkingLevel, setThinkingLevel] = useState<
    "low" | "medium" | "high" | "max" | "xhigh"
  >("high");
  const [model, setModel] = useState("");
  const [kind, setKind] = useState<"task" | "ideation">("task");

  const submit = async () => {
    if (!name.trim() || !projectId || !promptTemplate.trim()) {
      toast("Name, project, and prompt are required", true);
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        agent,
        kind,
        projectId,
        baseBranch: baseBranch.trim() || "main",
        promptTemplate,
        // Ideation templates never spawn an agent task themselves —
        // they propose options. Auto flags don't apply to them.
        autoPush: kind === "ideation" ? false : autoPush || autoPr,
        autoPr: kind === "ideation" ? false : autoPr,
        permissionMode,
        thinkingLevel,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      toast(`Created ${name}`);
      setName("");
      setProjectId("");
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
            Reusable prompt + spawn config. Schedule it later to run on a
            cron, or fire ad-hoc with{" "}
            <span className="font-mono">/run</span>.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-3 pt-4 space-y-5">
          {/* Kind toggle — biggest decision, drive it first. */}
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
              Kind
            </Label>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <KindCard
                active={kind === "task"}
                onClick={() => setKind("task")}
                title="Task"
                hint="Fires → spawns an agent task in a fresh worktree. The agent does the work."
              />
              <KindCard
                active={kind === "ideation"}
                onClick={() => setKind("ideation")}
                title="Ideation"
                hint="Fires → AI proposes options. You pick one (or write your own) → that becomes a task."
              />
            </div>
          </div>

          {/* ── Basics ────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
              Basics
            </h3>
            <Field>
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  kind === "ideation"
                    ? "e.g. daily-ideas"
                    : "e.g. review-pr"
                }
                autoFocus
              />
            </Field>
            <Field>
              <Label htmlFor="tpl-repo">Project</Label>
              <ProjectPicker
                value={projectId}
                onChange={(p) => setProjectId(p.id)}
              />
            </Field>
            <Field>
              <Label htmlFor="tpl-prompt">
                {kind === "ideation" ? "Ideation brief" : "Prompt"}
              </Label>
              <Textarea
                id="tpl-prompt"
                rows={6}
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                placeholder={
                  kind === "ideation"
                    ? "What should the AI propose? e.g. 'Suggest small improvements: missing tests, naming, dead code, doc gaps.'"
                    : "Review PR #{pr_number}. Suggest fixes."
                }
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[10px] text-ink-500 dark:text-ink-400">
                {kind === "ideation"
                  ? "The AI reads the project and returns up to 5 actionable lines. You pick one to spawn a task."
                  : (
                    <>
                      <span className="font-mono">{"{placeholders}"}</span>{" "}
                      substitute from runtime args.
                    </>
                  )}
              </p>
            </Field>
          </section>

          {/* ── Behavior ──────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
              Behavior
            </h3>
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
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <Label htmlFor="tpl-perm">Permissions</Label>
                <Select
                  value={permissionMode}
                  onValueChange={(v) =>
                    setPermissionMode(v as typeof permissionMode)
                  }
                >
                  <SelectTrigger id="tpl-perm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bypassPermissions">bypass</SelectItem>
                    <SelectItem value="acceptEdits">accept-edits</SelectItem>
                    <SelectItem value="plan">plan (read-only)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label htmlFor="tpl-think">Thinking</Label>
                <Select
                  value={thinkingLevel}
                  onValueChange={(v) =>
                    setThinkingLevel(v as typeof thinkingLevel)
                  }
                >
                  <SelectTrigger id="tpl-think">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">low</SelectItem>
                    <SelectItem value="medium">medium</SelectItem>
                    <SelectItem value="high">high</SelectItem>
                    <SelectItem value="max">max</SelectItem>
                    <SelectItem value="xhigh">xhigh</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <Label htmlFor="tpl-model">Model (optional)</Label>
              <Input
                id="tpl-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={(() => {
                  const first = modelsQ.data?.models[agent]?.[0];
                  return first
                    ? `(default) e.g. ${first.id}`
                    : "(default)";
                })()}
                className="font-mono text-xs"
              />
            </Field>
          </section>

          {/* Auto flags only matter for task-kind templates. */}
          {kind === "task" && (
            <section className="space-y-3">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                After the agent finishes
              </h3>
              <p className="text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
                Auto-commit always runs. Push is opt-in; pull request stays
                manual.
              </p>
              <div className="flex gap-2">
                <Toggle
                  label="Auto-push"
                  checked={autoPush}
                  onChange={setAutoPush}
                />
                <Toggle
                  label="Auto-PR"
                  checked={autoPr}
                  onChange={(v) => {
                    setAutoPr(v);
                    if (v) setAutoPush(true);
                  }}
                />
              </div>
            </section>
          )}
        </div>

        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function KindCard({
  active,
  onClick,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border p-3 text-left transition-colors",
        active
          ? "border-ember-500/40 bg-ember-500/[0.06]"
          : "border-ink-900/10 bg-paper-50 hover:border-ink-900/25 dark:border-ink-50/10 dark:bg-ink-800 dark:hover:border-ink-50/25",
      )}
    >
      <div
        className={cn(
          "text-[12px] font-medium",
          active
            ? "text-ember-700 dark:text-ember-300"
            : "text-ink-900 dark:text-ink-50",
        )}
      >
        {title}
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-ink-500 dark:text-ink-400">
        {hint}
      </div>
    </button>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={cn(
        "flex flex-1 items-center justify-between gap-3 rounded-md border px-3 h-8 transition-colors",
        checked
          ? "border-ember-500/30 bg-ember-500/[0.06] text-ink-900 dark:text-ink-50"
          : "border-ink-900/10 bg-ink-900/[0.02] text-ink-500 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400",
      )}
    >
      <span className="text-[12px] font-medium">{label}</span>
      <span
        className={cn(
          "inline-flex h-4 w-7 rounded-full transition-colors relative shrink-0",
          checked ? "bg-ember-500" : "bg-ink-900/15 dark:bg-ink-50/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-paper-50 transition-transform",
            checked && "translate-x-3",
          )}
        />
      </span>
    </button>
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
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Run {template?.name}</SheetTitle>
          <SheetDescription>
            Provide values for any placeholders, then fire.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4 space-y-4">
          {placeholders.length > 0 && (
            <div className="rounded-lg border border-ink-900/10 bg-ink-900/[0.02] p-3 dark:border-ink-50/10 dark:bg-ink-800">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-1.5">
                Placeholders
              </div>
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
            <p className="text-[10px] text-ink-500 dark:text-ink-400 mt-1">
              Space- or newline-separated{" "}
              <span className="font-mono">key=value</span> pairs.
            </p>
          </Field>

          {template && (
            <Field>
              <Label>Prompt preview</Label>
              <pre className="rounded-lg border border-ink-900/10 bg-ink-900/[0.02] p-3 font-mono text-[11px] whitespace-pre-wrap break-words leading-relaxed text-ink-700 dark:text-ink-300 dark:border-ink-50/10 dark:bg-ink-800">
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
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            Run
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
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
