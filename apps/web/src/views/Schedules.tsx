import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarClock,
  Loader2,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import type { Schedule, Task, Template } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useSchedules,
  useTasks,
  useTemplates,
  useToggleSchedule,
} from "@/queries";
import { useApp } from "@/AppContext";
import {
  cn,
  formatTs,
  formatTsAbsolute,
  shortId,
} from "@/lib/utils";

export function Schedules() {
  const { toast } = useApp();
  const schQ = useSchedules();
  const tplQ = useTemplates({ refetchInterval: 30_000 });
  const tasksQ = useTasks();
  const toggle = useToggleSchedule();
  const del = useDeleteSchedule();
  const [createOpen, setCreateOpen] = useState(false);

  const items = schQ.data?.schedules ?? [];
  const templates = (tplQ.data?.templates as Template[]) ?? [];
  const tasks = tasksQ.data?.tasks ?? [];

  const tplById = useMemo(() => {
    const map = new Map<string, Template>();
    for (const t of templates) map.set(t.id, t);
    return map;
  }, [templates]);

  const runsBySchedule = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const s of items) map.set(s.id, []);
    for (const t of tasks) {
      if (!t.scheduleId) continue;
      const arr = map.get(t.scheduleId);
      if (!arr) continue;
      arr.push(t);
    }
    for (const [, arr] of map.entries()) {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    }
    return map;
  }, [items, tasks]);

  const flip = async (s: Schedule) => {
    try {
      await toggle.mutateAsync({ id: s.id, enabled: !s.enabled });
      toast(`${s.name} ${s.enabled ? "disabled" : "enabled"}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const rm = async (s: Schedule) => {
    if (!confirm(`Delete schedule '${s.name}'?`)) return;
    try {
      await del.mutateAsync(s.id);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 lg:px-10 py-8 lg:py-10">
        {/* Header */}
        <header className="rise rise-1 flex items-end justify-between gap-4 mb-8">
          <div>
            <div className="label-section mb-2">Cadence</div>
            <h1 className="display text-4xl sm:text-5xl text-ink-900 dark:text-ink-50">
              Schedules
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
              5-field cron. Daemon ticks once per minute, dedupes by minute
              floor.
            </p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            disabled={templates.length === 0}
          >
            <Plus className="h-3.5 w-3.5" /> New schedule
          </Button>
        </header>

        {/* Calendar strip */}
        {items.length > 0 && <CalendarStrip schedules={items} />}

        {/* Schedule cards */}
        {schQ.isLoading ? (
          <div className="text-center py-16 text-sm text-ink-500 dark:text-ink-400">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <EmptyState noTemplates={templates.length === 0} />
        ) : (
          <div className="rise rise-3 mt-10 grid gap-5 lg:grid-cols-2">
            {items.map((s) => (
              <ScheduleCard
                key={s.id}
                schedule={s}
                template={tplById.get(s.templateId) ?? null}
                runs={(runsBySchedule.get(s.id) ?? []).slice(0, 5)}
                onToggle={() => void flip(s)}
                onDelete={() => void rm(s)}
                pending={toggle.isPending}
              />
            ))}
          </div>
        )}
      </div>

      <CreateScheduleSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        templates={templates}
      />
    </div>
  );
}

function CalendarStrip({ schedules }: { schedules: Schedule[] }) {
  const now = Date.now();
  const start = now;
  const end = now + 24 * 60 * 60 * 1000;

  const fires = useMemo(
    () =>
      schedules
        .filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= end)
        .map((s) => ({
          id: s.id,
          name: s.name,
          ts: s.nextRunAt!,
          pos: ((s.nextRunAt! - start) / (end - start)) * 100,
        })),
    [schedules, start, end],
  );

  const hours: number[] = [];
  for (let h = 0; h <= 24; h += 3) hours.push(h);

  return (
    <section className="rise rise-2 mb-10">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="display text-xl text-ink-900 dark:text-ink-50">
          Next 24 hours
        </h2>
        <span className="font-mono text-2xs uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
          {fires.length} {fires.length === 1 ? "fire" : "fires"}
        </span>
      </div>

      <div className="rounded-2xl border border-ink-900/10 bg-cream-50 p-5 dark:border-ink-50/10 dark:bg-ink-800">
        <div className="relative h-12">
          {/* Track */}
          <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-ink-900/10 dark:bg-ink-50/10" />

          {/* Now marker */}
          <div className="absolute left-0 top-0 bottom-0 w-px bg-vermilion-500" />
          <div className="absolute left-0 top-0 -translate-x-1/2 -translate-y-full pb-1 font-mono text-2xs uppercase tracking-[0.12em] text-vermilion-600 dark:text-vermilion-400">
            now
          </div>

          {/* Fires */}
          <TooltipProvider>
            {fires.map((f) => (
              <Tooltip key={`${f.id}-${f.ts}`}>
                <TooltipTrigger asChild>
                  <button
                    style={{ left: `${Math.min(99, Math.max(1, f.pos))}%` }}
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full bg-vermilion-500 ring-4 ring-cream-50 hover:ring-vermilion-500/30 transition-colors dark:ring-ink-800"
                    aria-label={`${f.name} at ${formatTsAbsolute(f.ts)}`}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <span className="font-medium">{f.name}</span>
                  <span className="ml-1 font-mono text-2xs opacity-70">
                    {new Date(f.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        </div>

        {/* Hour labels */}
        <div className="mt-2 relative h-3">
          {hours.map((h) => (
            <span
              key={h}
              className="absolute -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500"
              style={{ left: `${(h / 24) * 100}%` }}
            >
              {h === 0 ? "now" : `+${h}h`}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScheduleCard({
  schedule: s,
  template,
  runs,
  onToggle,
  onDelete,
  pending,
}: {
  schedule: Schedule;
  template: Template | null;
  runs: Task[];
  onToggle: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  return (
    <article className="rounded-2xl border border-ink-900/10 bg-cream-50 p-5 shadow-edit dark:border-ink-50/10 dark:bg-ink-800">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="display text-xl text-ink-900 dark:text-ink-50 leading-tight truncate">
            {s.name}
          </h3>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="rounded-md border border-ink-900/10 bg-ink-900/[0.04] px-1.5 py-0.5 font-mono text-2xs dark:border-ink-50/10 dark:bg-ink-50/[0.04]">
              {s.cron}
            </code>
            <span className="font-mono text-2xs text-ink-500 dark:text-ink-400">
              {humanizeCron(s.cron)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Switch
            checked={s.enabled}
            onCheckedChange={onToggle}
            disabled={pending}
            aria-label={`Toggle ${s.name}`}
          />
        </div>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Stat
          label="Next"
          value={s.nextRunAt ? formatTs(s.nextRunAt) : "—"}
          accent={s.enabled && !!s.nextRunAt}
        />
        <Stat
          label="Last"
          value={s.lastRunAt ? formatTs(s.lastRunAt) : "—"}
        />
      </div>

      {template && (
        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono text-2xs uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
            Template
          </span>
          <Badge variant="secondary">{template.name}</Badge>
        </div>
      )}

      {/* Run history */}
      {runs.length > 0 && (
        <div className="mt-4">
          <div className="label-section mb-2">Recent runs</div>
          <ul className="space-y-1">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 font-mono text-2xs"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    r.status === "done" && "bg-emerald-500",
                    r.status === "failed" && "bg-red-500",
                    r.status === "stopped" && "bg-ink-400",
                    (r.status === "running" ||
                      r.status === "pending" ||
                      r.status === "waiting_input" ||
                      r.status === "waiting_perm") &&
                      "bg-vermilion-500 animate-blink",
                  )}
                />
                <Link
                  to={`/tasks/${r.id}`}
                  className="flex-1 min-w-0 truncate text-ink-700 hover:text-vermilion-600 dark:text-ink-200 dark:hover:text-vermilion-400"
                >
                  {r.title}
                </Link>
                <span className="text-ink-400 dark:text-ink-500">
                  {formatTs(r.createdAt)}
                </span>
                <span className="text-ink-300 dark:text-ink-600">
                  {shortId(r.id)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 pt-3 border-t border-ink-900/10 dark:border-ink-50/10">
        <Button
          size="sm"
          variant="outline"
          onClick={onToggle}
          disabled={pending}
        >
          {s.enabled ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {s.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </article>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="label-section mb-1">{label}</div>
      <div
        className={cn(
          "num text-xl",
          accent
            ? "text-vermilion-600 dark:text-vermilion-400"
            : "text-ink-900 dark:text-ink-50",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyState({ noTemplates }: { noTemplates: boolean }) {
  return (
    <div className="rounded-3xl border border-dashed border-ink-900/10 p-16 text-center dark:border-ink-50/10">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-vermilion-500/10 text-vermilion-600 dark:text-vermilion-400">
        <CalendarClock className="h-5 w-5" />
      </div>
      <h2 className="mt-5 display text-2xl text-ink-900 dark:text-ink-50">
        {noTemplates ? "Templates first" : "No schedules"}
      </h2>
      <p className="mt-2 max-w-sm mx-auto text-sm text-ink-500 dark:text-ink-400">
        {noTemplates
          ? "Schedules need a template to fire. Create one and you can wire it to a cron expression here."
          : "Schedules fire any template on a 5-field cron expression."}
      </p>
    </div>
  );
}

function CreateScheduleSheet({
  open,
  onClose,
  templates,
}: {
  open: boolean;
  onClose: () => void;
  templates: Template[];
}) {
  const create = useCreateSchedule();
  const { toast } = useApp();

  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? "");
  const [args, setArgs] = useState("");
  const [enabled, setEnabled] = useState(true);

  const submit = async () => {
    if (!templateId) {
      toast("Pick a template first", true);
      return;
    }
    const argMap: Record<string, string> = {};
    for (const part of args.split(/\s+/).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq > 0) argMap[part.slice(0, eq)] = part.slice(eq + 1);
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        cron: cron.trim(),
        templateId,
        templateArgs: argMap,
        enabled,
      });
      toast(`Created ${name}`);
      onClose();
      setName("");
      setArgs("");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>New schedule</SheetTitle>
          <SheetDescription>
            Fire a template on a 5-field cron expression.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4 space-y-4">
          <Field>
            <Label htmlFor="sch-name">Name</Label>
            <Input
              id="sch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. nightly-tests"
              autoFocus
            />
          </Field>
          <Field>
            <Label htmlFor="sch-cron">Cron</Label>
            <Input
              id="sch-cron"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-2xs text-ink-500 dark:text-ink-400">
              {humanizeCron(cron)}
            </p>
          </Field>
          <Field>
            <Label htmlFor="sch-tpl">Template</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id="sch-tpl">
                <SelectValue placeholder="Pick a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}{" "}
                    <span className="text-ink-400 ml-2 text-xs">
                      ({t.agent})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <Label htmlFor="sch-args">Args</Label>
            <Input
              id="sch-args"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="key=value space-separated"
              className="font-mono text-xs"
            />
          </Field>
          <ToggleRow
            label="Enabled"
            hint="Will start firing on the next matching minute."
            checked={enabled}
            onChange={setEnabled}
          />
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

function humanizeCron(c: string): string {
  const parts = c.trim().split(/\s+/);
  if (parts.length !== 5) return "Custom expression";
  const [m, h, dom, mon, dow] = parts;
  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every minute";
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every hour";
  if (m === "0" && h !== "*" && dom === "*" && mon === "*" && dow === "*")
    return `Daily at ${h}:00`;
  if (m === "0" && h !== "*" && dom === "*" && mon === "*" && dow !== "*")
    return `Each ${dowName(dow!)} at ${h}:00`;
  return `min:${m} hr:${h} dom:${dom} mon:${mon} dow:${dow}`;
}

function dowName(s: string): string {
  const map: Record<string, string> = {
    "0": "Sunday",
    "1": "Monday",
    "2": "Tuesday",
    "3": "Wednesday",
    "4": "Thursday",
    "5": "Friday",
    "6": "Saturday",
    "7": "Sunday",
  };
  return map[s] ?? `dow=${s}`;
}
