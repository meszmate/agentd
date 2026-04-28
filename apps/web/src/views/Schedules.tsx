import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Plus, Rocket } from "lucide-react";
import type { Schedule, Task, Template } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
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

  const enabledCount = items.filter((s) => s.enabled).length;
  const upcoming = useMemo(() => {
    const now = Date.now();
    const soon = now + 24 * 60 * 60 * 1000;
    return items.filter(
      (s) => s.enabled && s.nextRunAt && s.nextRunAt <= soon,
    ).length;
  }, [items]);

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
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>cadence</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Schedules
        </span>
        <Count>{items.length}</Count>
        {enabledCount !== items.length && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[11px] tabular-nums text-ink-500 dark:text-ink-400">
              {enabledCount} enabled
            </span>
          </>
        )}
        {upcoming > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[11px] tabular-nums text-vermilion-700 dark:text-vermilion-300">
              {upcoming} firing today
            </span>
          </>
        )}
        <Spacer />
        <Button
          size="xs"
          onClick={() => setCreateOpen(true)}
          disabled={templates.length === 0}
        >
          <Plus className="h-3 w-3" /> New
        </Button>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState noTemplates={templates.length === 0} />
        ) : (
          <>
            <CalendarStrip schedules={items} />
            <SectionHeader
              label="Schedules"
              hint="cron · last · next · runs"
              right={
                <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
                  {items.length}
                </span>
              }
              sticky={false}
            />
            <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
              {items.map((s) => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  template={tplById.get(s.templateId) ?? null}
                  runs={(runsBySchedule.get(s.id) ?? []).slice(0, 3)}
                  onToggle={() => void flip(s)}
                  onDelete={() => void rm(s)}
                  pending={toggle.isPending}
                />
              ))}
            </ul>
          </>
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
  const start = Date.now();
  const end = start + 24 * 60 * 60 * 1000;

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

  const hours: number[] = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  return (
    <div className="border-b border-ink-900/10 dark:border-ink-50/10">
      <SectionHeader
        label="Next 24 hours"
        hint={`${fires.length} ${fires.length === 1 ? "fire" : "fires"}`}
        sticky={false}
      />
      <div className="px-5 py-5">
        <div className="relative h-10">
          {/* Track */}
          <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-ink-900/10 dark:bg-ink-50/10" />

          {/* Hour ticks (taller every 6h) */}
          {hours.map((h) => (
            <span
              key={h}
              style={{ left: `${(h / 24) * 100}%` }}
              className={cn(
                "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-px bg-ink-900/15 dark:bg-ink-50/15",
                h % 6 === 0 ? "h-3" : "h-2",
              )}
              aria-hidden
            />
          ))}

          {/* Now line */}
          <div className="absolute left-0 top-0 bottom-0 w-px bg-vermilion-500" />
          <div className="absolute left-0 top-0 -translate-x-1/2 -translate-y-full pb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-vermilion-600 dark:text-vermilion-400">
            now
          </div>

          {/* Fires */}
          <TooltipProvider>
            {fires.map((f) => (
              <Tooltip key={`${f.id}-${f.ts}`}>
                <TooltipTrigger asChild>
                  <button
                    style={{
                      left: `${Math.min(99, Math.max(1, f.pos))}%`,
                    }}
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-vermilion-500 ring-4 ring-cream-100 hover:ring-vermilion-500/30 transition-colors dark:ring-ink-900"
                    aria-label={`${f.name} at ${formatTsAbsolute(f.ts)}`}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <span className="font-medium">{f.name}</span>
                  <span className="ml-1.5 font-mono text-[10px] opacity-70">
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
    </div>
  );
}

function ScheduleRow({
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
    <li className="group h-auto px-5 py-3 flex items-start gap-4 hover:bg-cream-100/40 transition-colors dark:hover:bg-ink-50/[0.02]">
      <span className="font-mono text-[12px] text-ink-300 dark:text-ink-600 group-hover:text-vermilion-500 mt-0.5 transition-colors">
        ◇
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {s.name}
          </span>
          <code className="rounded border border-ink-900/10 bg-ink-900/[0.04] px-1.5 py-0 font-mono text-[10px] text-ink-700 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-200">
            {s.cron}
          </code>
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
            {humanizeCron(s.cron)}
          </span>
          {template && (
            <>
              <span className="text-ink-300 dark:text-ink-600">·</span>
              <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400">
                {template.name}
              </span>
            </>
          )}
        </div>

        {runs.length > 0 && (
          <ul className="mt-1.5 flex items-center gap-3 font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center gap-1">
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    r.status === "done" && "bg-emerald-500",
                    r.status === "failed" && "bg-red-500",
                    r.status === "stopped" && "bg-ink-400 dark:bg-ink-500",
                    (r.status === "running" ||
                      r.status === "pending" ||
                      r.status === "waiting_input" ||
                      r.status === "waiting_perm") &&
                      "bg-vermilion-500 animate-blink",
                  )}
                />
                <Link
                  to={`/tasks/${r.id}`}
                  className="hover:text-ink-900 dark:hover:text-ink-50 transition-colors"
                >
                  {shortId(r.id)} · {formatTs(r.createdAt)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Right: next/last + actions */}
      <div className="hidden md:flex flex-col items-end gap-0.5 shrink-0 font-mono text-[11px] tabular-nums">
        {s.nextRunAt && s.enabled ? (
          <span className="text-vermilion-700 dark:text-vermilion-300">
            next {formatTs(s.nextRunAt)}
          </span>
        ) : (
          <span className="text-ink-400 dark:text-ink-500">paused</span>
        )}
        <span className="text-ink-400 dark:text-ink-500">
          {s.lastRunAt ? `last ${formatTs(s.lastRunAt)}` : "no runs"}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Switch
          checked={s.enabled}
          onCheckedChange={onToggle}
          disabled={pending}
          aria-label={`Toggle ${s.name}`}
        />
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${s.name}`}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 size-7 rounded-md text-ink-400 hover:bg-red-500/10 hover:text-red-600 transition-all flex items-center justify-center font-mono text-[14px] dark:text-ink-500"
        >
          ×
        </button>
      </div>
    </li>
  );
}

function EmptyState({ noTemplates }: { noTemplates: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16">
      <span className="font-mono text-[24px] text-ink-300 dark:text-ink-600">
        ◇
      </span>
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        {noTemplates ? "Templates first" : "No schedules"}
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        {noTemplates
          ? "Schedules need a template to fire. Create one and you can wire it to a cron expression here."
          : "Schedules fire any template on a 5-field cron expression. Daemon ticks once per minute."}
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
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New schedule</SheetTitle>
          <SheetDescription>
            Fire a template on a 5-field cron expression.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sch-name">Name</Label>
            <Input
              id="sch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. nightly-tests"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sch-cron">Cron</Label>
            <Input
              id="sch-cron"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-[10px] text-ink-500 dark:text-ink-400">
              {humanizeCron(cron)}
            </p>
          </div>
          <div className="space-y-1.5">
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sch-args">Args</Label>
            <Input
              id="sch-args"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="key=value space-separated"
              className="font-mono text-xs"
            />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border border-ink-900/10 bg-ink-900/[0.02] p-2.5 cursor-pointer dark:border-ink-50/10 dark:bg-ink-50/[0.02]">
            <div>
              <div className="text-xs font-medium">Enabled</div>
              <div className="text-[10px] text-ink-500 dark:text-ink-400">
                Will start firing on the next matching minute.
              </div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
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

function humanizeCron(c: string): string {
  const parts = c.trim().split(/\s+/);
  if (parts.length !== 5) return "custom expression";
  const [m, h, dom, mon, dow] = parts;
  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return "every minute";
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return "hourly";
  if (m === "0" && h !== "*" && dom === "*" && mon === "*" && dow === "*")
    return `daily at ${h}:00`;
  if (m === "0" && h !== "*" && dom === "*" && mon === "*" && dow !== "*")
    return `each ${dowName(dow!)} at ${h}:00`;
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

void Rocket;
