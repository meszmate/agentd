import { useState } from "react";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Power,
  PowerOff,
  Save,
} from "lucide-react";
import type { PluginStatus } from "@agentd/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
import { InfoRow } from "@/components/ui/info-row";
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
      <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
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
      <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
        Loading plugins…
      </div>
    );
  }

  const tgStatus = status.find((s) => s.name === "telegram");
  const dcStatus = status.find((s) => s.name === "discord");

  const runningCount = [tgStatus, dcStatus].filter((s) => s?.running).length;
  const enabledCount = (tg.enabled ? 1 : 0) + (dc.enabled ? 1 : 0);

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>bridges</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Plugins
        </span>
        <Count>2</Count>
        {enabledCount > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span
              className={cn(
                "font-mono text-[11px] tabular-nums",
                runningCount === enabledCount
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-amber-700 dark:text-amber-300",
              )}
            >
              {runningCount} / {enabledCount} running
            </span>
          </>
        )}
        <Spacer />
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate hidden md:inline">
          managed by daemon · dial-out only
        </span>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <PluginPanel
          name="telegram"
          glyph="∷"
          cfg={tg}
          status={tgStatus}
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
        />
        <PluginPanel
          name="discord"
          glyph="◆"
          cfg={dc}
          status={dcStatus}
          idsLabel="Allowed channel IDs"
          idsKey="allowedChannelIds"
          idsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
          userIdsParse={(s) =>
            s.split(",").map((x) => x.trim()).filter(Boolean)
          }
        />

        {/* Future events log */}
        <SectionHeader
          label="Incoming events"
          hint="not yet exposed by the daemon"
          sticky={false}
        />
        <div className="px-5 py-6 text-[11px] text-ink-500 dark:text-ink-400 max-w-2xl">
          Per-bridge events (allowlist verdicts, denied messages, command
          history) will appear here once the daemon exposes a plugin event-log
          endpoint. Until then, check the daemon stdout.
        </div>
      </div>
    </div>
  );
}

function PluginPanel<S extends number | string>({
  name,
  glyph,
  cfg,
  status,
  idsLabel,
  idsKey,
  idsParse,
  userIdsParse,
}: {
  name: "telegram" | "discord";
  glyph: string;
  cfg: PluginConfigRaw;
  status: PluginStatus | undefined;
  idsLabel: string;
  idsKey: "allowedChatIds" | "allowedChannelIds";
  idsParse: (raw: string) => S[];
  userIdsParse: (raw: string) => S[];
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void apply(true);
      }}
    >
      <SectionHeader
        label={
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-vermilion-500">
              {glyph}
            </span>
            <span>{name}</span>
          </span>
        }
        hint={
          name === "telegram" ? "grammY bridge" : "discord.js bridge"
        }
        right={<PluginStatusPill enabled={enabled} status={status} />}
        sticky={false}
      />

      <InfoRow
        label="Bot token"
        hint={`Get one from ${name === "telegram" ? "@BotFather" : "the Discord developer portal"}.`}
        top
      >
        <div className="relative w-full">
          <Input
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
      </InfoRow>

      <InfoRow label="Allowed user IDs" hint="comma-separated">
        <Input
          value={users}
          onChange={(e) => setUsers(e.target.value)}
          placeholder="123, 456, 789"
          className="font-mono text-xs"
          spellCheck={false}
        />
      </InfoRow>

      <InfoRow label={idsLabel} hint="comma-separated">
        <Input
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          placeholder="123, 456"
          className="font-mono text-xs"
          spellCheck={false}
        />
      </InfoRow>

      <InfoRow label="Default repo" hint="used when no repo is given inline">
        <Input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="/path/to/repo"
          className="font-mono"
          spellCheck={false}
        />
      </InfoRow>

      {status?.lastError && enabled && (
        <div className="px-5 py-3 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
          <div className="flex gap-2 rounded-md border border-red-500/25 bg-red-500/[0.06] p-2.5 text-[12px]">
            <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium text-red-700 dark:text-red-300">
                Last error
              </div>
              <div className="font-mono text-[10px] text-ink-700 dark:text-ink-300 break-all mt-0.5">
                {status.lastError}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer save bar */}
      <div className="flex h-9 items-center gap-3 border-b border-ink-900/10 px-5 bg-cream-100/40 dark:border-ink-50/10 dark:bg-ink-50/[0.02]">
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          {name}
        </span>
        {running && status?.startedAt && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
              pid {status.pid} · up {formatTs(status.startedAt)}
            </span>
          </>
        )}
        <span className="ml-auto" />
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={mutate.isPending || !enabled}
          onClick={() => void apply(false)}
        >
          <PowerOff className="h-3 w-3" />
          Disable
        </Button>
        <Button type="submit" size="xs" disabled={mutate.isPending}>
          {mutate.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : enabled ? (
            <Save className="h-3 w-3" />
          ) : (
            <Power className="h-3 w-3" />
          )}
          {enabled ? "Save" : "Enable"}
        </Button>
      </div>
    </form>
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
    return (
      <span className="inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em] bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.05] dark:text-ink-400">
        disabled
      </span>
    );
  }
  if (status?.running) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em] bg-emerald-500/10 text-emerald-700 cursor-help dark:text-emerald-300">
              <span className="text-[9px]">◆</span> running
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono text-[10px]">
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
    <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em] border border-red-500/30 text-red-700 bg-red-500/[0.06] dark:text-red-300">
      <span className="text-[9px]">○</span> stopped
    </span>
  );
}
