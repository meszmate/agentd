import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  Power,
  PowerOff,
  Save,
} from "lucide-react";
import type { PluginStatus } from "@agentd/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  usePatchDiscord,
  usePatchTelegram,
  usePluginsStatus,
} from "@/queries";
import { useApp } from "@/AppContext";
import { cn, formatTs } from "@/lib/utils";

interface PluginConfigRaw {
  enabled: boolean;
  botToken: string;
  defaultRepo: string | null;
  allowedUserIds: Array<number | string>;
  allowedChatIds?: number[];
  allowedChannelIds?: string[];
}

export function Plugins() {
  const q = usePluginsStatus();

  if (q.isLoading || !q.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-500 dark:text-ink-400">
        Loading plugins…
      </div>
    );
  }

  const status = q.data.plugins;
  const config = q.data.config as unknown as Record<string, PluginConfigRaw>;
  const tg = config.telegram;
  const dc = config.discord;
  if (!tg || !dc) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-500 dark:text-ink-400">
        Loading plugins…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 lg:px-10 py-8 lg:py-10">
        <header className="rise rise-1 mb-8">
          <div className="label-section mb-2">Bridges</div>
          <h1 className="display text-4xl sm:text-5xl text-ink-900 dark:text-ink-50">
            Plugins
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
            Bots dial out — the daemon never accepts inbound chat connections.
            Two-axis allowlist (user × chat/channel) gates every interaction.
          </p>
        </header>

        <div className="rise rise-2 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <PluginPanel
            name="telegram"
            cfg={tg}
            status={status.find((s) => s.name === "telegram")}
            idsLabel="Allowed chat IDs"
            idsKey="allowedChatIds"
            idsParse={(s) =>
              s
                .split(",")
                .map((x) => Number(x.trim()))
                .filter((n) => Number.isFinite(n))
            }
            userIdsParse={(s) =>
              s
                .split(",")
                .map((x) => Number(x.trim()))
                .filter((n) => Number.isFinite(n))
            }
            description="grammY bridge."
          />
          <PluginPanel
            name="discord"
            cfg={dc}
            status={status.find((s) => s.name === "discord")}
            idsLabel="Allowed channel IDs"
            idsKey="allowedChannelIds"
            idsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
            userIdsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
            description="discord.js bridge."
          />
        </div>

        {/* Future: incoming events log. */}
        <section className="mt-10 rise rise-3 rounded-2xl border border-dashed border-ink-900/10 dark:border-ink-50/10 p-6">
          <h2 className="display text-xl text-ink-900 dark:text-ink-50">
            Incoming events
          </h2>
          <p className="mt-1 text-2xs text-ink-500 dark:text-ink-400 max-w-xl">
            Per-bridge events (allowlist verdicts, denied messages, command
            history) will surface here once the daemon exposes a plugin
            event-log endpoint. Until then, check the daemon stdout.
          </p>
        </section>
      </div>
    </div>
  );
}

function PluginPanel<S extends number | string>({
  name,
  cfg,
  status,
  idsLabel,
  idsKey,
  idsParse,
  userIdsParse,
  description,
}: {
  name: "telegram" | "discord";
  cfg: PluginConfigRaw;
  status: PluginStatus | undefined;
  idsLabel: string;
  idsKey: "allowedChatIds" | "allowedChannelIds";
  idsParse: (raw: string) => S[];
  userIdsParse: (raw: string) => S[];
  description: string;
}) {
  const { toast } = useApp();
  const [token, setToken] = useState(cfg.botToken);
  const [revealToken, setRevealToken] = useState(false);
  const [users, setUsers] = useState((cfg.allowedUserIds ?? []).join(","));
  const [scopes, setScopes] = useState(
    ((cfg[idsKey] as Array<S> | undefined) ?? []).join(","),
  );
  const [repo, setRepo] = useState(cfg.defaultRepo ?? "");

  const patchTg = usePatchTelegram();
  const patchDc = usePatchDiscord();
  const mutate = name === "telegram" ? patchTg : patchDc;

  const apply = async (enabled: boolean) => {
    try {
      const patch: Record<string, unknown> = { enabled };
      if (enabled) {
        if (token) patch.botToken = token;
        patch.allowedUserIds = userIdsParse(users);
        patch[idsKey] = idsParse(scopes);
        patch.defaultRepo = repo || null;
      }
      await mutate.mutateAsync(patch as never);
      toast(`${name} ${enabled ? "saved" : "disabled"}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const running = !!status?.running;
  const enabled = !!cfg.enabled;

  return (
    <article className="rounded-2xl border border-ink-900/10 bg-cream-50 shadow-edit dark:border-ink-50/10 dark:bg-ink-800 overflow-hidden">
      <header className="flex items-start gap-3 p-5 border-b border-ink-900/10 dark:border-ink-50/10">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            enabled
              ? "bg-vermilion-500/15 text-vermilion-600 dark:text-vermilion-400"
              : "bg-ink-900/[0.04] text-ink-400 dark:bg-ink-50/[0.04] dark:text-ink-500",
          )}
        >
          <Plug className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="display text-2xl text-ink-900 dark:text-ink-50 leading-tight capitalize">
            {name}
          </h3>
          <p className="text-2xs text-ink-500 dark:text-ink-400">
            {description} Managed by the daemon.
          </p>
        </div>
        <PluginStatusPill enabled={enabled} status={status} />
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply(true);
        }}
        className="p-5 space-y-4"
      >
        <Field>
          <Label htmlFor={`${name}-token`}>Bot token</Label>
          <div className="relative">
            <Input
              id={`${name}-token`}
              type={revealToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••"
              spellCheck={false}
              autoComplete="off"
              className="font-mono pr-9"
            />
            <button
              type="button"
              onClick={() => setRevealToken((v) => !v)}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink-400 hover:bg-ink-900/[0.04] hover:text-ink-700 dark:text-ink-500 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-200"
              aria-label={revealToken ? "Hide token" : "Show token"}
            >
              {revealToken ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field>
            <Label htmlFor={`${name}-users`}>User IDs</Label>
            <Input
              id={`${name}-users`}
              value={users}
              onChange={(e) => setUsers(e.target.value)}
              placeholder="comma-separated"
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
          <Field>
            <Label htmlFor={`${name}-scopes`}>{idsLabel}</Label>
            <Input
              id={`${name}-scopes`}
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              placeholder="comma-separated"
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field>
          <Label htmlFor={`${name}-repo`}>Default repo</Label>
          <Input
            id={`${name}-repo`}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="/path/to/repo"
            className="font-mono"
            spellCheck={false}
          />
        </Field>

        {status?.lastError && enabled && (
          <div className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] p-3 text-xs">
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium text-red-700 dark:text-red-300">
                Last error
              </div>
              <div className="font-mono text-2xs text-ink-700 dark:text-ink-300 break-all mt-0.5">
                {status.lastError}
              </div>
            </div>
          </div>
        )}

        {status?.startedAt && running && (
          <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2 font-mono text-2xs">
            <span className="text-emerald-700 dark:text-emerald-300">
              pid {status.pid}
            </span>
            <span className="text-ink-500 dark:text-ink-400">
              up since {formatTs(status.startedAt)}
            </span>
            {status.restarts > 0 && (
              <span className="text-amber-700 dark:text-amber-300">
                {status.restarts} restarts
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-900/10 dark:border-ink-50/10">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={mutate.isPending || !enabled}
            onClick={() => void apply(false)}
          >
            <PowerOff className="h-3.5 w-3.5" />
            Disable
          </Button>
          <Button type="submit" size="sm" disabled={mutate.isPending}>
            {mutate.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : enabled ? (
              <Save className="h-3.5 w-3.5" />
            ) : (
              <Power className="h-3.5 w-3.5" />
            )}
            {enabled ? "Save" : "Enable + save"}
          </Button>
        </div>
      </form>
    </article>
  );
}

function PluginStatusPill({
  enabled,
  status,
}: {
  enabled: boolean;
  status: PluginStatus | undefined;
}) {
  if (!enabled) {
    return <Badge variant="mute">disabled</Badge>;
  }
  if (status?.running) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="success" className="cursor-help">
              <CheckCircle2 className="h-3 w-3" /> running
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono text-2xs">
              pid {status.pid}
              {status.startedAt
                ? ` · started ${formatTs(status.startedAt)}`
                : ""}
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <Badge variant="destructive">
      <AlertCircle className="h-3 w-3" /> stopped
    </Badge>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}
