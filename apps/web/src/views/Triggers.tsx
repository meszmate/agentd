import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Loader2, Plus, Zap } from "lucide-react";
import type {
  CreateTriggerRequest,
  Task,
  Template,
  Trigger,
  TriggerPredicateConfig,
  TriggerPredicateKind,
} from "@agentd/contracts";
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
  useCreateTrigger,
  useDeleteTrigger,
  useTasks,
  useTemplates,
  useTestTrigger,
  useToggleTrigger,
  useTriggers,
} from "@/queries";
import { useApp } from "@/AppContext";
import { cn, formatTs } from "@/lib/utils";

const PREDICATE_OPTIONS: { value: TriggerPredicateKind; label: string; hint: string }[] = [
  {
    value: "github_pr_merged",
    label: "GitHub PR merged",
    hint: "Polls `gh pr view` until state=MERGED",
  },
  {
    value: "github_issue_closed",
    label: "GitHub issue closed",
    hint: "Polls `gh issue view` until state=CLOSED",
  },
  {
    value: "datetime",
    label: "At a specific time",
    hint: "Fires once when the wall clock passes the chosen instant",
  },
  {
    value: "webhook",
    label: "Inbound webhook",
    hint: "Fires when a signed POST hits /api/webhooks/<id>",
  },
];

export function Triggers() {
  const { toast, server } = useApp();
  const trgQ = useTriggers();
  const tplQ = useTemplates({ refetchInterval: 30_000 });
  const tasksQ = useTasks();
  const toggle = useToggleTrigger();
  const del = useDeleteTrigger();
  const test = useTestTrigger();
  const [createOpen, setCreateOpen] = useState(false);

  const items = trgQ.data?.triggers ?? [];
  const templates = (tplQ.data?.templates as Template[]) ?? [];
  const tasks = tasksQ.data?.tasks ?? [];

  const tplById = useMemo(() => {
    const map = new Map<string, Template>();
    for (const t of templates) map.set(t.id, t);
    return map;
  }, [templates]);

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const enabledCount = items.filter((t) => t.enabled).length;
  const errorCount = items.filter((t) => t.lastError).length;

  const flip = async (t: Trigger) => {
    try {
      await toggle.mutateAsync({ id: t.id, enabled: !t.enabled });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const rm = async (t: Trigger) => {
    if (!confirm(`Delete trigger '${t.name}'?`)) return;
    try {
      await del.mutateAsync(t.id);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const fire = async (t: Trigger) => {
    if (!confirm(`Force-fire '${t.name}' now? This spawns a real task.`)) return;
    try {
      const r = await test.mutateAsync(t.id);
      toast(`Fired → ${r.taskId}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>conditional</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Triggers
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
        {errorCount > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[11px] tabular-nums text-red-600 dark:text-red-400">
              {errorCount} erroring
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
            <SectionHeader
              label="Triggers"
              hint="predicate · template · status"
              right={
                <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
                  {items.length}
                </span>
              }
              sticky={false}
            />
            <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
              {items.map((t) => (
                <TriggerRow
                  key={t.id}
                  trigger={t}
                  template={tplById.get(t.templateId) ?? null}
                  spawnedTask={
                    t.lastFiredTaskId
                      ? taskById.get(t.lastFiredTaskId) ?? null
                      : null
                  }
                  serverUrl={server}
                  onToggle={() => void flip(t)}
                  onDelete={() => void rm(t)}
                  onFire={() => void fire(t)}
                  pending={toggle.isPending || test.isPending}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <CreateTriggerSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        templates={templates}
      />
    </div>
  );
}

function TriggerRow({
  trigger: t,
  template,
  spawnedTask,
  serverUrl,
  onToggle,
  onDelete,
  onFire,
  pending,
}: {
  trigger: Trigger;
  template: Template | null;
  spawnedTask: Task | null;
  serverUrl: string;
  onToggle: () => void;
  onDelete: () => void;
  onFire: () => void;
  pending: boolean;
}) {
  const status = derivedStatus(t);
  const cfg = t.predicateConfig;
  const summary = predicateSummary(cfg);
  const webhookUrl =
    cfg.kind === "webhook" && serverUrl
      ? `${serverUrl.replace(/\/$/, "")}/api/webhooks/${t.id}`
      : null;

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  return (
    <li className="group h-auto px-5 py-3 flex items-start gap-4 hover:bg-paper-100 transition-colors dark:hover:bg-ink-700">
      <span
        className={cn(
          "font-mono text-[12px] mt-0.5 transition-colors",
          status === "fired" && "text-emerald-500",
          status === "error" && "text-red-500",
          status === "waiting" && "text-ember-500",
          status === "paused" && "text-ink-300 dark:text-ink-600",
        )}
      >
        ◆
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {t.name}
          </span>
          <code className="rounded border border-ink-900/10 bg-ink-900/[0.04] px-1.5 py-0 font-mono text-[10px] text-ink-700 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-200">
            {t.predicateKind}
          </code>
          <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 truncate">
            {summary}
          </span>
          {template && (
            <>
              <span className="text-ink-300 dark:text-ink-600">·</span>
              <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400">
                {template.name}
              </span>
            </>
          )}
          {t.repeat && (
            <span className="rounded border border-ember-500/30 bg-ember-500/10 px-1.5 py-0 font-mono text-[10px] text-ember-700 dark:text-ember-300">
              repeat
            </span>
          )}
        </div>

        {webhookUrl && (
          <div className="mt-1.5 flex items-center gap-2">
            <code className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
              {webhookUrl}
            </code>
            <button
              onClick={() => copy(webhookUrl)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-ink-500 hover:bg-ink-900/[0.04] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-50"
            >
              <Copy className="h-2.5 w-2.5" /> copy
            </button>
            <button
              onClick={() =>
                copy(curlSnippetFor(webhookUrl, secretFor(t) ?? ""))
              }
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-ink-500 hover:bg-ink-900/[0.04] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-50"
            >
              <Copy className="h-2.5 w-2.5" /> curl
            </button>
          </div>
        )}

        {t.lastError && (
          <div className="mt-1.5 font-mono text-[10px] text-red-600 dark:text-red-400 truncate">
            error · {t.lastError}
          </div>
        )}

        {spawnedTask && (
          <div className="mt-1.5 font-mono text-[10px] text-ink-400 dark:text-ink-500">
            last →{" "}
            <Link
              to={`/tasks/${spawnedTask.id}`}
              className="hover:text-ink-900 dark:hover:text-ink-50 transition-colors"
            >
              {spawnedTask.title}
            </Link>{" "}
            · {formatTs(spawnedTask.createdAt)}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-col items-end gap-0.5 shrink-0 font-mono text-[11px] tabular-nums">
        <span
          className={cn(
            status === "fired" && "text-emerald-700 dark:text-emerald-300",
            status === "error" && "text-red-600 dark:text-red-400",
            status === "waiting" && "text-ember-700 dark:text-ember-300",
            status === "paused" && "text-ink-400 dark:text-ink-500",
          )}
        >
          {status}
        </span>
        <span className="text-ink-400 dark:text-ink-500">
          {t.lastFiredAt ? `last ${formatTs(t.lastFiredAt)}` : "no fires"}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onFire}
          aria-label={`Force-fire ${t.name}`}
          disabled={pending}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 size-7 rounded-md text-ink-400 hover:bg-ember-500/10 hover:text-ember-600 transition-all flex items-center justify-center dark:text-ink-500"
        >
          <Zap className="h-3.5 w-3.5" />
        </button>
        <Switch
          checked={t.enabled}
          onCheckedChange={onToggle}
          disabled={pending}
          aria-label={`Toggle ${t.name}`}
        />
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

type TriggerStatus = "waiting" | "fired" | "error" | "paused";
function derivedStatus(t: Trigger): TriggerStatus {
  if (!t.enabled) {
    return t.lastFiredAt ? "fired" : "paused";
  }
  if (t.lastError) return "error";
  return "waiting";
}

function predicateSummary(cfg: TriggerPredicateConfig): string {
  switch (cfg.kind) {
    case "github_pr_merged":
      return `${cfg.owner}/${cfg.repo}#${cfg.number} merged`;
    case "github_issue_closed":
      return `${cfg.owner}/${cfg.repo}#${cfg.number} closed`;
    case "datetime":
      return `at ${new Date(cfg.fireAt).toLocaleString()}`;
    case "webhook":
      return cfg.readyAt ? "webhook ready" : "awaiting POST";
  }
}

function secretFor(t: Trigger): string | null {
  return t.predicateConfig.kind === "webhook"
    ? t.predicateConfig.secret
    : null;
}

function curlSnippetFor(url: string, secret: string): string {
  return [
    `TS=$(date +%s)000`,
    `BODY='{}'`,
    `SIG=$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "${secret}" | awk '{print $2}')`,
    `curl -X POST "${url}" \\`,
    `  -H "X-Agentd-Signature: sha256=$SIG" \\`,
    `  -H "X-Agentd-Timestamp: $TS" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "$BODY"`,
  ].join("\n");
}

function EmptyState({ noTemplates }: { noTemplates: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16">
      <span className="font-mono text-[24px] text-ink-300 dark:text-ink-600">
        ◆
      </span>
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        {noTemplates ? "Templates first" : "No triggers"}
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        {noTemplates
          ? "Triggers fire a template when an external condition flips true. Create one and you can wire it to a PR merge, an issue close, a wall-clock instant, or an inbound webhook."
          : "Triggers fire a template when an external condition flips true: a PR merge, an issue close, a wall-clock time, or a signed inbound webhook."}
      </p>
    </div>
  );
}

function CreateTriggerSheet({
  open,
  onClose,
  templates,
}: {
  open: boolean;
  onClose: () => void;
  templates: Template[];
}) {
  const create = useCreateTrigger();
  const { toast } = useApp();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<TriggerPredicateKind>("datetime");
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? "");
  const [args, setArgs] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [repeat, setRepeat] = useState(false);

  // Per-kind config fields
  const [ghOwner, setGhOwner] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghNumber, setGhNumber] = useState("");
  const [fireAtLocal, setFireAtLocal] = useState(() => {
    const d = new Date(Date.now() + 60_000);
    d.setSeconds(0, 0);
    return localIsoNoZ(d);
  });
  const [secret, setSecret] = useState(() => randomSecret());

  const submit = async () => {
    if (!templateId) {
      toast("Pick a template first", true);
      return;
    }
    let predicateConfig: TriggerPredicateConfig;
    try {
      predicateConfig = buildPredicate(kind, {
        ghOwner,
        ghRepo,
        ghNumber,
        fireAtLocal,
        secret,
      });
    } catch (e) {
      toast((e as Error).message, true);
      return;
    }
    const argMap: Record<string, string> = {};
    for (const part of args.split(/\s+/).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq > 0) argMap[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const req: CreateTriggerRequest = {
      name: name.trim(),
      predicateKind: kind,
      predicateConfig,
      templateId,
      templateArgs: argMap,
      enabled,
      repeat,
    };
    try {
      await create.mutateAsync(req);
      toast(`Created ${name}`);
      onClose();
      setName("");
      setArgs("");
      setGhOwner("");
      setGhRepo("");
      setGhNumber("");
      setSecret(randomSecret());
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New trigger</SheetTitle>
          <SheetDescription>
            Fire a template when an external condition flips true.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="trg-name">Name</Label>
            <Input
              id="trg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. on-pr-42-merge"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="trg-kind">Predicate</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as TriggerPredicateKind)}
            >
              <SelectTrigger id="trg-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PREDICATE_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-ink-500 dark:text-ink-400">
              {PREDICATE_OPTIONS.find((p) => p.value === kind)?.hint}
            </p>
          </div>

          {(kind === "github_pr_merged" || kind === "github_issue_closed") && (
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="gh-owner">Owner</Label>
                <Input
                  id="gh-owner"
                  value={ghOwner}
                  onChange={(e) => setGhOwner(e.target.value)}
                  placeholder="anthropics"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gh-repo">Repo</Label>
                <Input
                  id="gh-repo"
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="claude-code"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gh-num">#</Label>
                <Input
                  id="gh-num"
                  value={ghNumber}
                  onChange={(e) => setGhNumber(e.target.value)}
                  placeholder="42"
                  inputMode="numeric"
                />
              </div>
            </div>
          )}

          {kind === "datetime" && (
            <div className="space-y-1.5">
              <Label htmlFor="trg-fireat">Fire at</Label>
              <Input
                id="trg-fireat"
                type="datetime-local"
                value={fireAtLocal}
                onChange={(e) => setFireAtLocal(e.target.value)}
              />
            </div>
          )}

          {kind === "webhook" && (
            <div className="space-y-1.5">
              <Label htmlFor="trg-secret">Secret (HMAC-SHA256)</Label>
              <Input
                id="trg-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-ink-500 dark:text-ink-400">
                Stays on the trigger row. Senders use this to sign the
                <code className="mx-1 font-mono">X-Agentd-Signature</code>
                header. The webhook URL is shown on the row after creation.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="trg-tpl">Template</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id="trg-tpl">
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
            <Label htmlFor="trg-args">Args</Label>
            <Input
              id="trg-args"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="key=value space-separated"
              className="font-mono text-xs"
            />
          </div>

          <label className="flex items-center justify-between gap-3 rounded-md border border-ink-900/10 bg-ink-900/[0.02] p-2.5 cursor-pointer dark:border-ink-50/10 dark:bg-ink-800">
            <div>
              <div className="text-xs font-medium">Enabled</div>
              <div className="text-[10px] text-ink-500 dark:text-ink-400">
                Off = stays in the list but the evaluator skips it.
              </div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>

          <label className="flex items-center justify-between gap-3 rounded-md border border-ink-900/10 bg-ink-900/[0.02] p-2.5 cursor-pointer dark:border-ink-50/10 dark:bg-ink-800">
            <div>
              <div className="text-xs font-medium">Repeat</div>
              <div className="text-[10px] text-ink-500 dark:text-ink-400">
                Off (default) auto-disables after one fire. On = keep
                firing on every match.
              </div>
            </div>
            <Switch checked={repeat} onCheckedChange={setRepeat} />
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

interface PredicateInputs {
  ghOwner: string;
  ghRepo: string;
  ghNumber: string;
  fireAtLocal: string;
  secret: string;
}

function buildPredicate(
  kind: TriggerPredicateKind,
  inputs: PredicateInputs,
): TriggerPredicateConfig {
  if (kind === "github_pr_merged" || kind === "github_issue_closed") {
    const owner = inputs.ghOwner.trim();
    const repo = inputs.ghRepo.trim();
    const number = Number(inputs.ghNumber.trim());
    if (!owner || !repo || !Number.isFinite(number) || number <= 0) {
      throw new Error("owner, repo, and number are required");
    }
    return { kind, owner, repo, number };
  }
  if (kind === "datetime") {
    const ts = new Date(inputs.fireAtLocal).getTime();
    if (!Number.isFinite(ts)) throw new Error("invalid datetime");
    return { kind, fireAt: ts };
  }
  // webhook
  const secret = inputs.secret.trim();
  if (secret.length < 8) throw new Error("secret must be at least 8 chars");
  return { kind: "webhook", secret };
}

function localIsoNoZ(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function randomSecret(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
