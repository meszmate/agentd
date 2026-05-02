import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Hash,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import type { PluginStatus } from "@agentd/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import {
  useBridgeSummary,
  useDiscordChannels,
  usePatchDiscord,
  usePatchTelegram,
  usePluginsStatus,
  useRestartPlugin,
  useValidateTelegramToken,
} from "@/queries";
import { useApp } from "@/AppContext";
import { cn, formatTs } from "@/lib/utils";

interface PluginConfigRaw {
  enabled: boolean;
  botToken: string;
  defaultRepo: string | null;
  allowedUserIds: Array<number | string>;
}

type BridgeName = "telegram" | "discord";

interface BridgeMeta {
  name: BridgeName;
  display: string;
  initials: string;
  brandHex: string;
  helpLink: string;
  helpSteps: string[];
  /** Where the user finds their numeric user ID for the allowlist. */
  userIdHelp: { label: string; href: string; tip: string };
}

const BRIDGES: BridgeMeta[] = [
  {
    name: "telegram",
    display: "Telegram",
    initials: "TG",
    brandHex: "#229ED9",
    helpLink: "https://t.me/BotFather",
    helpSteps: [
      "DM @BotFather and send /newbot.",
      "Pick a name + a username ending in 'bot'.",
      "BotFather replies with a token — paste it in step 1.",
    ],
    userIdHelp: {
      label: "@userinfobot",
      href: "https://t.me/userinfobot",
      tip: "DM @userinfobot — it replies with your numeric user id.",
    },
  },
  {
    name: "discord",
    display: "Discord",
    initials: "DC",
    brandHex: "#5865F2",
    helpLink: "https://discord.com/developers/applications",
    helpSteps: [
      "discord.com/developers/applications → New Application → Bot.",
      "Copy the bot token (Discord shows it once — paste it before navigating away).",
      "Use the OAuth2 URL Generator with the `bot` scope to invite the bot to your server.",
    ],
    userIdHelp: {
      label: "Developer Mode",
      href: "https://discord.com/developers/docs/reference",
      tip: "Settings → Advanced → Developer Mode on, then right-click yourself → Copy User ID.",
    },
  },
];

export function Plugins() {
  const q = usePluginsStatus();
  const summaryQ = useBridgeSummary();
  const channelsQ = useDiscordChannels();
  const [open, setOpen] = useState<BridgeName | null>(null);

  if (q.isLoading || !q.data) {
    return (
      <div className="flex h-full flex-col">
        <PageTopbar>
          <Kicker>bridges</Kicker>
          <VRule />
          <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
            Plugins
          </span>
        </PageTopbar>
        <div className="flex-1 grid place-items-center text-[12px] text-ink-500 dark:text-ink-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      </div>
    );
  }

  const status = q.data.plugins;
  const config = q.data.config as unknown as Record<string, PluginConfigRaw>;
  const tg = config.telegram;
  const dc = config.discord;
  if (!tg || !dc) {
    return (
      <div className="flex-1 grid place-items-center text-[12px] text-ink-500 dark:text-ink-400">
        Missing plugin config.
      </div>
    );
  }
  const cfgs: Record<BridgeName, PluginConfigRaw> = { telegram: tg, discord: dc };

  const tgStatus = status.find((s) => s.name === "telegram");
  const dcStatus = status.find((s) => s.name === "discord");
  const statuses: Record<BridgeName, PluginStatus | undefined> = {
    telegram: tgStatus,
    discord: dcStatus,
  };
  const runningCount = [tgStatus, dcStatus].filter((s) => s?.running).length;
  const configuredCount = [tg, dc].filter((c) => !!c.botToken).length;
  const projectBridges = summaryQ.data?.projects ?? [];
  const projectBotCount = projectBridges.reduce(
    (acc, p) => acc + (p.telegram ? 1 : 0) + (p.discord ? 1 : 0),
    0,
  );
  const totalBots = runningCount + projectBotCount;
  const totals = summaryQ.data?.totals;
  const totalToday =
    (totals?.telegram.count24h ?? 0) + (totals?.discord.count24h ?? 0);

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>bridges</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Plugins
        </span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums",
            totalBots > 0
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-ink-400 dark:text-ink-500",
          )}
        >
          {totalBots} bot{totalBots === 1 ? "" : "s"}
        </span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums text-ink-500 dark:text-ink-400">
          {totalToday} sent today
        </span>
        <Spacer />
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden md:inline">
          dial-out only · daemon supervises
        </span>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] h-full">
          <div className="px-6 pt-6 pb-10 min-w-0">
            <p className="mb-4 max-w-prose text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
              Bridges let you talk to your agents from chat. The daemon
              connects out to Telegram or Discord — neither service ever
              calls back into your network. Set up a bot, paste its token,
              and lock it down to your user ID.
            </p>

            <ul className="rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
              {BRIDGES.map((meta) => (
                <BridgeRow
                  key={meta.name}
                  meta={meta}
                  cfg={cfgs[meta.name]}
                  status={statuses[meta.name]}
                  onOpen={() => setOpen(meta.name)}
                />
              ))}
            </ul>

            <ProjectRoutingSection
              bridges={projectBridges}
              discordChannelsKnown={!!summaryQ.data?.discordChannelsKnown}
              hasGuilds={(channelsQ.data?.guilds.length ?? 0) > 0}
            />
          </div>

          <aside className="hidden lg:flex flex-col border-l border-ink-900/10 bg-paper-100/40 dark:border-ink-50/10 dark:bg-ink-900/30">
            <SideRail
              statuses={statuses}
              cfgs={cfgs}
              configuredCount={configuredCount}
              runningCount={runningCount}
            />
          </aside>
        </div>
      </div>

      {BRIDGES.map((meta) => (
        <BridgeSheet
          key={meta.name}
          meta={meta}
          cfg={cfgs[meta.name]}
          status={statuses[meta.name]}
          open={open === meta.name}
          onClose={() => setOpen(null)}
        />
      ))}
    </div>
  );
}

/* ── Side rail ─────────────────────────────────────────────────────── */

function SideRail({
  statuses,
  cfgs,
  configuredCount,
  runningCount,
}: {
  statuses: Record<BridgeName, PluginStatus | undefined>;
  cfgs: Record<BridgeName, PluginConfigRaw>;
  configuredCount: number;
  runningCount: number;
}) {
  const totalRestarts =
    (statuses.telegram?.restarts ?? 0) + (statuses.discord?.restarts ?? 0);
  return (
    <div className="flex-1 flex flex-col">
      <div className="px-5 py-4 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-2">
          At a glance
        </div>
        <ul className="space-y-1.5 text-[12px]">
          <li className="flex items-baseline justify-between">
            <span className="text-ink-500 dark:text-ink-400">configured</span>
            <span className="font-mono tabular-nums text-ink-900 dark:text-ink-50">
              {configuredCount} / {BRIDGES.length}
            </span>
          </li>
          <li className="flex items-baseline justify-between">
            <span className="text-ink-500 dark:text-ink-400">running</span>
            <span
              className={cn(
                "font-mono tabular-nums",
                runningCount > 0
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-ink-500 dark:text-ink-400",
              )}
            >
              {runningCount} / {BRIDGES.length}
            </span>
          </li>
          {totalRestarts > 0 && (
            <li className="flex items-baseline justify-between">
              <span className="text-ink-500 dark:text-ink-400">restarts</span>
              <span className="font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {totalRestarts}
              </span>
            </li>
          )}
        </ul>
      </div>

      <div className="px-5 py-4 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-2">
          How it works
        </div>
        <ul className="space-y-2 text-[11px] text-ink-700 dark:text-ink-200 leading-relaxed">
          <li className="flex gap-2">
            <span className="font-mono text-ember-500 shrink-0">·</span>
            <span>
              The daemon dials <em>out</em> to Telegram / Discord. Your
              network never opens an inbound port.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-ember-500 shrink-0">·</span>
            <span>
              Allowlists (user IDs + chat / channel IDs) gate every command
              — no public access by default.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-ember-500 shrink-0">·</span>
            <span>
              Each bridge runs as a supervised subprocess. Crashes auto-restart
              with backoff.
            </span>
          </li>
        </ul>
      </div>

      <div className="px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-2">
          From any chat
        </div>
        <ul className="space-y-1.5 text-[11px] text-ink-700 dark:text-ink-200 leading-relaxed">
          {[
            ["new", "spawn an agent in a repo"],
            ["use", "focus a task to chat with"],
            ["in", "send input to the focused task"],
            ["diff", "show the agent's changes"],
          ].map(([cmd, body]) => (
            <li key={cmd} className="flex gap-2">
              <code className="font-mono text-[10px] text-ember-700 dark:text-ember-300 shrink-0 w-9">
                /{cmd}
              </code>
              <span className="text-ink-500 dark:text-ink-400">{body}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[10px] text-ink-400 dark:text-ink-500">
          Open a bridge → "Bot commands" for the full list.
        </p>
      </div>
    </div>
  );
}

/* ── Directory row ─────────────────────────────────────────────────── */

function BridgeRow({
  meta,
  cfg,
  status,
  onOpen,
}: {
  meta: BridgeMeta;
  cfg: PluginConfigRaw;
  status: PluginStatus | undefined;
  onOpen: () => void;
}) {
  const configured = !!cfg.botToken;
  const enabled = !!cfg.enabled;
  const running = !!status?.running;

  const userCount = (cfg.allowedUserIds ?? []).length;

  let stateLabel: string;
  let stateClass: string;
  let dotClass: string;
  if (!configured) {
    stateLabel = "not set up";
    stateClass = "text-ink-400 dark:text-ink-500";
    dotClass = "bg-ink-300 dark:bg-ink-600";
  } else if (running) {
    stateLabel = "live";
    stateClass = "text-emerald-700 dark:text-emerald-300";
    dotClass = "bg-emerald-500";
  } else if (enabled) {
    stateLabel = "down";
    stateClass = "text-red-700 dark:text-red-300";
    dotClass = "bg-red-500 animate-blink";
  } else {
    stateLabel = "disabled";
    stateClass = "text-ink-500 dark:text-ink-400";
    dotClass = "bg-ink-300 dark:bg-ink-600";
  }

  let detail: string;
  if (!configured) {
    detail = `paste a token from ${meta.name === "telegram" ? "@BotFather" : "the developer portal"}`;
  } else if (running) {
    const since = status?.startedAt ? `up ${formatTs(status.startedAt)}` : "running";
    const pid = status?.pid != null ? ` · pid ${status.pid}` : "";
    detail = `${since}${pid}`;
  } else if (enabled) {
    detail = status?.lastError ?? "enabled but not running";
  } else {
    detail = "ready to enable";
  }

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors"
      >
        <div
          className="h-9 w-9 shrink-0 rounded-md grid place-items-center font-mono text-[12px] font-semibold text-white"
          style={{
            background: configured ? meta.brandHex : "transparent",
            border: configured ? "none" : "1px dashed rgba(0,0,0,0.15)",
            color: configured ? "white" : undefined,
          }}
        >
          {configured ? meta.initials : <span className="text-ink-400 dark:text-ink-500">{meta.initials}</span>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50">
              {meta.display}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em]",
                stateClass,
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
              {stateLabel}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-500 dark:text-ink-400">
            <span className="truncate">{detail}</span>
            {configured && (
              <>
                <span className="text-ink-300 dark:text-ink-600">·</span>
                <span>
                  {userCount} user{userCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500 shrink-0">
          {configured ? "manage" : "set up"}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
      </button>
    </li>
  );
}

/* ── Side sheet ────────────────────────────────────────────────────── */

function BridgeSheet({
  meta,
  cfg,
  status,
  open,
  onClose,
}: {
  meta: BridgeMeta;
  cfg: PluginConfigRaw;
  status: PluginStatus | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useApp();
  const restart = useRestartPlugin();
  const patchTg = usePatchTelegram();
  const patchDc = usePatchDiscord();
  const validateTg = useValidateTelegramToken();
  const mutate = meta.name === "telegram" ? patchTg : patchDc;

  const configured = !!cfg.botToken;
  const enabled = !!cfg.enabled;
  const running = !!status?.running;

  const [token, setToken] = useState(cfg.botToken);
  const [revealToken, setRevealToken] = useState(false);
  const [users, setUsers] = useState((cfg.allowedUserIds ?? []).join(", "));
  const [identity, setIdentity] =
    useState<import("@agentd/contracts").TelegramBotIdentity | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Reset whenever the sheet opens (so we always show the truth from server).
  useEffect(() => {
    if (!open) return;
    setToken(cfg.botToken);
    setUsers((cfg.allowedUserIds ?? []).join(", "));
    setRevealToken(false);
    setIdentity(null);
    setTokenError(null);
  }, [open, cfg]);

  // Live Telegram getMe whenever a plausibly-shaped token is in the box.
  // Discord doesn't have a free unauthenticated identity probe, so we
  // skip live validation there.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  useEffect(() => {
    if (meta.name !== "telegram") return;
    setIdentity(null);
    setTokenError(null);
    const t = token.trim();
    if (!/^\d+:[\w-]+/.test(t)) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      const r = await validateTg.mutateAsync(t);
      if (cancelled || tokenRef.current !== token) return;
      if (r.ok) setIdentity(r.bot);
      else setTokenError(r.error);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, meta.name]);

  const parseList = (raw: string) =>
    raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const parseUsers = (raw: string) => {
    if (meta.name === "telegram") {
      return parseList(raw)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n));
    }
    return parseList(raw);
  };

  const userIds = parseUsers(users);
  const tokenLooksValid = /^\d+:[\w-]+/.test(token.trim()) || configured;
  const ready = tokenLooksValid && userIds.length > 0;

  const apply = async (nextEnabled: boolean) => {
    try {
      const patch: Record<string, unknown> = { enabled: nextEnabled };
      if (nextEnabled) {
        if (token) patch.botToken = token;
        patch.allowedUserIds = parseUsers(users);
        // Drop any legacy default — projects are picked at /new time now.
        patch.defaultRepo = null;
      }
      await mutate.mutateAsync(patch as never);
      toast(`${meta.display} ${nextEnabled ? "saved" : "disabled"}`);
      if (nextEnabled) onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const onRestart = async () => {
    try {
      const r = await restart.mutateAsync(meta.name);
      if (r.ok) toast(`${meta.display} restarting…`);
      else toast(r.reason ?? "restart failed", true);
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
        <SheetHeader className="px-6 pb-3 pt-5">
          <SheetTitle className="flex items-center gap-2">
            <span
              className="h-7 w-7 rounded-md grid place-items-center font-mono text-[11px] font-semibold text-white"
              style={{ background: meta.brandHex }}
            >
              {meta.initials}
            </span>
            {meta.display}
            <BridgeStatusPill running={running} enabled={enabled} configured={configured} />
          </SheetTitle>
          <SheetDescription>
            {configured
              ? `${
                  running
                    ? `up since ${formatTs(status?.startedAt ?? Date.now())}`
                    : enabled
                    ? "enabled but not running"
                    : "disabled"
                }${status?.pid != null && running ? ` · pid ${status.pid}` : ""}`
              : `Connect your ${meta.display} bot. The daemon dials out — your network never opens.`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-3">
          <ol className="mt-2 space-y-5">
            <SheetStep
              n={1}
              title="Bot token"
              hint={
                <>
                  Get one from{" "}
                  <a
                    href={meta.helpLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ember-700 hover:underline dark:text-ember-300 inline-flex items-center gap-0.5"
                  >
                    {meta.name === "telegram"
                      ? "@BotFather"
                      : "the developer portal"}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                  .{" "}
                  {meta.helpSteps[meta.helpSteps.length - 1]}
                </>
              }
            >
              <div className="relative">
                <Input
                  type={revealToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={configured ? "•••••••• (saved)" : "paste here"}
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
              {meta.name === "telegram" && (
                <div className="mt-2 min-h-[2.4rem]">
                  {validateTg.isPending && (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-500 dark:text-ink-400">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      checking with Telegram…
                    </span>
                  )}
                  {!validateTg.isPending && tokenError && (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-red-700 dark:text-red-300">
                      {tokenError}
                    </span>
                  )}
                  {identity && (
                    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 flex items-center gap-2.5">
                      <span
                        className="h-7 w-7 shrink-0 rounded-full grid place-items-center text-white font-mono text-[11px] font-semibold"
                        style={{ background: meta.brandHex }}
                      >
                        {(identity.firstName.trim().slice(0, 1) || "?").toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
                          {identity.firstName}
                        </div>
                        {identity.username && (
                          <div className="font-mono text-[11px] text-ink-500 dark:text-ink-400 truncate">
                            @{identity.username}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </SheetStep>

            <SheetStep
              n={2}
              title="Allowed users"
              dim={!tokenLooksValid}
              hint={
                <>
                  {meta.userIdHelp.tip}{" "}
                  <a
                    href={meta.userIdHelp.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ember-700 hover:underline dark:text-ember-300 inline-flex items-center gap-0.5"
                  >
                    {meta.userIdHelp.label}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                </>
              }
            >
              <Input
                value={users}
                onChange={(e) => setUsers(e.target.value)}
                placeholder={
                  meta.name === "telegram"
                    ? "123456, 789012"
                    : "111111111111111111"
                }
                className="font-mono text-xs"
                spellCheck={false}
                disabled={!tokenLooksValid}
              />
              <div className="mt-1.5 font-mono text-[10px] text-ink-400 dark:text-ink-500">
                {userIds.length === 0
                  ? "comma-separated · required"
                  : `${userIds.length} user${userIds.length === 1 ? "" : "s"} on the allowlist`}
              </div>
            </SheetStep>

            <SheetStep n={3} title="Save & enable" dim={!ready}>
              <p className="text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
                The daemon supervises this subprocess — crashes auto-restart with
                backoff. Type{" "}
                <code className="font-mono text-[10px] text-ember-700 dark:text-ember-300">
                  {meta.name === "telegram" ? "/" : "!"}new &lt;prompt&gt;
                </code>{" "}
                in chat to spawn a task once it's live.
              </p>
            </SheetStep>
          </ol>
        </div>

        <SheetFooter className="border-t border-ink-900/10 bg-paper-50 px-6 py-3 dark:border-ink-50/10 dark:bg-ink-800">
          {configured ? (
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRestart}
                  disabled={restart.isPending || !enabled}
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      restart.isPending && "animate-spin",
                    )}
                  />
                  Restart
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void apply(false)}
                  disabled={mutate.isPending || !enabled}
                  className="text-red-700 dark:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Disconnect
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Close
                </Button>
                <Button
                  size="sm"
                  onClick={() => void apply(true)}
                  disabled={mutate.isPending || !ready}
                >
                  {mutate.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void apply(true)}
                disabled={mutate.isPending || !ready}
              >
                {mutate.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
                Connect {meta.display}
              </Button>
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function BridgeStatusPill({
  running,
  enabled,
  configured,
}: {
  running: boolean;
  enabled: boolean;
  configured: boolean;
}) {
  if (!configured) {
    return (
      <span className="inline-flex items-center h-4 px-1.5 rounded font-mono text-[9px] uppercase tracking-[0.12em] bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.05] dark:text-ink-400">
        not set up
      </span>
    );
  }
  if (running) {
    return (
      <span className="inline-flex items-center gap-1 h-4 px-1.5 rounded font-mono text-[9px] uppercase tracking-[0.12em] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        <span className="h-1 w-1 rounded-full bg-emerald-500" />
        live
      </span>
    );
  }
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1 h-4 px-1.5 rounded font-mono text-[9px] uppercase tracking-[0.12em] bg-red-500/10 text-red-700 dark:text-red-300">
        <span className="h-1 w-1 rounded-full bg-red-500 animate-blink" />
        down
      </span>
    );
  }
  return (
    <span className="inline-flex items-center h-4 px-1.5 rounded font-mono text-[9px] uppercase tracking-[0.12em] bg-paper-100 text-ink-500 border border-ink-900/10 dark:bg-ink-900 dark:text-ink-400 dark:border-ink-50/10">
      disabled
    </span>
  );
}

function SheetStep({
  n,
  title,
  children,
  hint,
  dim,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <li className={cn(dim && "opacity-50 pointer-events-none")}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="grid place-items-center h-4 w-4 rounded-full border border-ink-900/15 dark:border-ink-50/15 font-mono text-[9px] tabular-nums text-ink-500">
          {n}
        </span>
        <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50">
          {title}
        </span>
      </div>
      {hint && (
        <p className="ml-6 mb-2 text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">
          {hint}
        </p>
      )}
      <div className="ml-6">{children}</div>
    </li>
  );
}

/* ── Project routing ───────────────────────────────────────────── */

function ProjectRoutingSection({
  bridges,
  discordChannelsKnown,
  hasGuilds,
}: {
  bridges: import("@agentd/contracts").ProjectBridgeSummary[];
  discordChannelsKnown: boolean;
  hasGuilds: boolean;
}) {
  if (bridges.length === 0) {
    return (
      <div className="mt-8">
        <div className="flex items-baseline gap-2 mb-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
            Project routing
          </span>
          <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
            none yet
          </span>
        </div>
        <div className="rounded-md border border-dashed border-ink-900/15 dark:border-ink-50/15 px-4 py-6 text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
          Each project can have its own Telegram bot or Discord channel.
          Open any project's right rail → "Connect chat" to wire one up.
          {discordChannelsKnown && !hasGuilds ? (
            <span className="block mt-1 text-ink-400 dark:text-ink-500">
              The Discord bot reported zero guilds — invite it via the
              OAuth2 URL Generator first.
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          Project routing
        </span>
        <span className="font-mono text-[9px] text-ink-400 dark:text-ink-500">
          per-project bots / channels
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {bridges.length} project{bridges.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="rounded-md border border-ink-900/10 bg-paper-50 divide-y divide-ink-900/[0.06] overflow-hidden dark:border-ink-50/10 dark:bg-ink-800 dark:divide-ink-50/[0.06]">
        {bridges.map((b) => (
          <ProjectRoutingRow key={b.projectId} summary={b} />
        ))}
      </ul>
    </div>
  );
}

function ProjectRoutingRow({
  summary,
}: {
  summary: import("@agentd/contracts").ProjectBridgeSummary;
}) {
  const tg = summary.telegram;
  const dc = summary.discord;
  return (
    <li>
      <Link
        to={`/projects/${encodeURIComponent(summary.slug)}`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors"
      >
        <span
          className="size-3 rounded-md shrink-0"
          style={{ background: summary.color || "#DC2626" }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {summary.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {tg && <RoutingPill platform="telegram" label={
              tg.botUsername ? `@${tg.botUsername}` : tg.botFirstName || "bot"
            } sub={tg.chatLabel ?? `chat ${tg.chatId.slice(-6)}`} stats={tg.stats} />}
            {dc && (
              <RoutingPill
                platform="discord"
                label={dc.channelName ? `#${dc.channelName}` : `channel ${dc.channelId.slice(-6)}`}
                sub={dc.guildName ?? null}
                stats={dc.stats}
              />
            )}
          </div>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
      </Link>
    </li>
  );
}

function RoutingPill({
  platform,
  label,
  sub,
  stats,
}: {
  platform: "telegram" | "discord";
  label: string;
  sub: string | null;
  stats: import("@agentd/contracts").BridgeDeliveryStats;
}) {
  const brand = platform === "telegram" ? "#229ED9" : "#5865F2";
  const Icon = platform === "telegram" ? Send : Hash;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-700 dark:text-ink-200">
      <span
        className="h-3 w-3 rounded grid place-items-center text-white"
        style={{ background: brand }}
      >
        <Icon className="h-2 w-2" />
      </span>
      <span className="truncate max-w-[20ch]">{label}</span>
      {sub && (
        <span className="text-ink-400 dark:text-ink-500 truncate max-w-[18ch]">
          · {sub}
        </span>
      )}
      <span className="text-ink-300 dark:text-ink-600">·</span>
      <span
        className={cn(
          "tabular-nums",
          stats.count24h > 0
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-ink-400 dark:text-ink-500",
        )}
      >
        {stats.count24h}/24h
      </span>
      {stats.lastDeliveredAt && (
        <span className="text-ink-400 dark:text-ink-500">
          · {formatTs(stats.lastDeliveredAt)}
        </span>
      )}
    </span>
  );
}

void PowerOff;
