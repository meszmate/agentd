import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  CircleSlash,
  ExternalLink,
  Eye,
  EyeOff,
  Hash,
  Loader2,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type {
  Project,
  TelegramBotIdentity,
  TelegramChatInfo,
} from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDiscordChannels,
  useDiscordTestSend,
  useGetTelegramChat,
  useTelegramTestSend,
  useUpdateProject,
  useValidateTelegramToken,
} from "@/queries";
import { useApp } from "@/AppContext";
import { cn } from "@/lib/utils";

export type ChatPlatform = "telegram" | "discord";

interface Props {
  project: Project;
  platform: ChatPlatform | null;
  onClose: () => void;
}

/**
 * "Connect chat" guided flow. Unlike a pile of raw inputs, this walks the
 * user through: validate the token (Telegram) or list channels (Discord),
 * confirm with the bot's actual identity, send a test message, save.
 *
 * Re-opens against an existing connection seeded with the saved values
 * so the same sheet doubles as "manage / disconnect".
 */
export function ChatConnectSheet({ project, platform, onClose }: Props) {
  if (platform == null) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-end sm:place-items-center bg-ink-900/40 backdrop-blur-sm animate-in fade-in">
      <div
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-ink-900/10 bg-paper-50 shadow-2xl dark:border-ink-50/10 dark:bg-ink-800 animate-in slide-in-from-bottom-4"
        role="dialog"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 text-ink-400 hover:bg-ink-900/[0.05] hover:text-ink-900 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-50"
        >
          <X className="h-4 w-4" />
        </button>
        {platform === "telegram" ? (
          <TelegramFlow project={project} onClose={onClose} />
        ) : (
          <DiscordFlow project={project} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

/* ── Telegram ─────────────────────────────────────────────────── */

function TelegramFlow({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { toast } = useApp();
  const [token, setToken] = useState(project.telegramBotToken ?? "");
  const [reveal, setReveal] = useState(false);
  const [chatId, setChatId] = useState(project.telegramChatId ?? "");
  const [identity, setIdentity] = useState<TelegramBotIdentity | null>(null);
  const [chat, setChat] = useState<TelegramChatInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  const validate = useValidateTelegramToken();
  const getChat = useGetTelegramChat();
  const test = useTelegramTestSend();
  const update = useUpdateProject();

  const valid = !!identity;
  const ready = valid && chatId.trim().length > 0;
  const hasExisting =
    !!project.telegramBotToken && !!project.telegramChatId;

  // Debounced token validation. Triggers on token change once it looks
  // shaped like a Telegram token (`<digits>:<rest>`).
  const tokenRef = useRef(token);
  tokenRef.current = token;
  useEffect(() => {
    setIdentity(null);
    setTokenError(null);
    const t = token.trim();
    if (!/^\d+:[\w-]+/.test(t)) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      const r = await validate.mutateAsync(t);
      if (cancelled || tokenRef.current !== token) return;
      if (r.ok) setIdentity(r.bot);
      else setTokenError(r.error);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // We intentionally only watch token; mutate fns are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const fetchChat = async () => {
    setChatError(null);
    setChat(null);
    if (!identity || !chatId.trim()) return;
    const r = await getChat.mutateAsync({ token, chatId: chatId.trim() });
    if (r.ok) setChat(r.chat);
    else setChatError(r.error);
  };

  const onTest = async () => {
    if (!ready) return;
    const r = await test.mutateAsync({ token, chatId: chatId.trim() });
    if (r.ok) toast("test message sent — check your chat");
    else toast(r.error || "send failed", true);
  };

  const onSave = async () => {
    if (!ready) return;
    try {
      await update.mutateAsync({
        idOrSlug: project.id,
        patch: {
          telegramBotToken: token.trim(),
          telegramChatId: chatId.trim(),
        },
      });
      toast(`telegram connected — ${identity.firstName}`);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const onDisconnect = async () => {
    if (
      !confirm(
        "Disconnect this project's Telegram bot? Events will fall back to the global plugin.",
      )
    )
      return;
    try {
      await update.mutateAsync({
        idOrSlug: project.id,
        patch: { telegramBotToken: null, telegramChatId: null },
      });
      toast("telegram disconnected");
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <BrandTile platform="telegram" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[18px] font-semibold text-ink-900 dark:text-ink-50">
              Connect Telegram
            </h2>
            {hasExisting && (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
                · connected
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
            Paste a bot token. We'll fetch the bot's identity from Telegram so you can confirm it's the right one before saving.
          </p>
        </div>
      </div>

      <ol className="mt-6 space-y-5">
        <Step
          n={1}
          title="Bot token"
          hint={
            <>
              Get one from{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="text-ember-700 hover:underline dark:text-ember-300 inline-flex items-center gap-0.5"
              >
                @BotFather
                <ExternalLink className="h-2.5 w-2.5" />
              </a>{" "}
              with <code className="font-mono">/newbot</code>.
            </>
          }
        >
          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456:AABBCC..."
              spellCheck={false}
              autoComplete="off"
              className="font-mono pr-9"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink-400 hover:bg-ink-900/[0.04] hover:text-ink-700 dark:text-ink-500 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-200"
              aria-label={reveal ? "Hide token" : "Show token"}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="mt-2 min-h-[2.4rem]">
            {validate.isPending && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-500 dark:text-ink-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                checking with Telegram…
              </span>
            )}
            {!validate.isPending && tokenError && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-red-700 dark:text-red-300">
                <CircleSlash className="h-3 w-3" />
                {tokenError}
              </span>
            )}
            {identity && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 flex items-center gap-2.5">
                <BotAvatar firstName={identity.firstName} />
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
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              </div>
            )}
          </div>
        </Step>

        <Step
          n={2}
          title="Chat to deliver to"
          dim={!valid}
          hint={
            <>
              Open Telegram, DM your bot once with{" "}
              <code className="font-mono">/start</code>. Then DM{" "}
              <a
                href="https://t.me/userinfobot"
                target="_blank"
                rel="noreferrer"
                className="text-ember-700 hover:underline dark:text-ember-300 inline-flex items-center gap-0.5"
              >
                @userinfobot
                <ExternalLink className="h-2.5 w-2.5" />
              </a>{" "}
              and paste your numeric ID below.
            </>
          }
        >
          <div className="flex items-center gap-2">
            <Input
              value={chatId}
              onChange={(e) => {
                setChatId(e.target.value);
                setChat(null);
                setChatError(null);
              }}
              onBlur={() => void fetchChat()}
              placeholder="-100... or your user id"
              className="font-mono"
              spellCheck={false}
              disabled={!valid}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void fetchChat()}
              disabled={!valid || !chatId.trim() || getChat.isPending}
            >
              {getChat.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Search className="h-3 w-3" />
              )}
              Verify
            </Button>
          </div>
          <div className="mt-2 min-h-[1.4rem]">
            {chatError && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-red-700 dark:text-red-300">
                <CircleSlash className="h-3 w-3" />
                {chatError}
              </span>
            )}
            {chat && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="h-3 w-3" />
                {chat.title ||
                  [chat.firstName, chat.lastName].filter(Boolean).join(" ") ||
                  chat.username ||
                  "chat"}{" "}
                <span className="text-ink-400 dark:text-ink-500">· {chat.type}</span>
              </span>
            )}
          </div>
        </Step>

        <Step n={3} title="Test send" dim={!ready}>
          <Button
            variant="outline"
            size="sm"
            disabled={!ready || test.isPending}
            onClick={() => void onTest()}
          >
            {test.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Send test message
          </Button>
        </Step>
      </ol>

      <div className="mt-6 flex items-center gap-2 border-t border-ink-900/10 dark:border-ink-50/10 pt-4">
        {hasExisting && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onDisconnect()}
            className="text-red-700 dark:text-red-300"
          >
            <Trash2 className="h-3 w-3" />
            Disconnect
          </Button>
        )}
        <span className="ml-auto" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={!ready || update.isPending}
        >
          {update.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Save connection"
          )}
        </Button>
      </div>
    </div>
  );
}

/* ── Discord ──────────────────────────────────────────────────── */

function DiscordFlow({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { toast } = useApp();
  const channelsQ = useDiscordChannels(8000);
  const test = useDiscordTestSend();
  const update = useUpdateProject();

  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string>(project.discordChannelId ?? "");
  const hasExisting = !!project.discordChannelId;

  const guilds = channelsQ.data?.guilds ?? [];
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return guilds;
    return guilds
      .map((g) => ({
        ...g,
        channels: g.channels.filter(
          (c) =>
            c.name.toLowerCase().includes(f) ||
            g.name.toLowerCase().includes(f),
        ),
      }))
      .filter((g) => g.channels.length > 0);
  }, [guilds, filter]);
  const totalChannels = guilds.reduce((acc, g) => acc + g.channels.length, 0);

  const pickedChannel = guilds
    .flatMap((g) => g.channels.map((c) => ({ guild: g, channel: c })))
    .find((row) => row.channel.id === picked);

  const onTest = async () => {
    if (!picked) return;
    const r = await test.mutateAsync({ channelId: picked });
    if (r.ok) toast("test message queued — watch the channel");
    else toast(r.error || "send failed", true);
  };

  const onSave = async () => {
    if (!picked) return;
    try {
      await update.mutateAsync({
        idOrSlug: project.id,
        patch: { discordChannelId: picked },
      });
      toast("discord connected");
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const onDisconnect = async () => {
    if (
      !confirm(
        "Disconnect this project's Discord channel? Events will fall back to the global plugin.",
      )
    )
      return;
    try {
      await update.mutateAsync({
        idOrSlug: project.id,
        patch: { discordChannelId: null },
      });
      toast("discord disconnected");
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <BrandTile platform="discord" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[18px] font-semibold text-ink-900 dark:text-ink-50">
              Connect Discord
            </h2>
            {hasExisting && (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
                · connected
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
            Pick the channel where this project's task events should land. The global Discord bot must be in the server already.
          </p>
        </div>
      </div>

      {channelsQ.isLoading ? (
        <div className="mt-6 grid place-items-center py-12 text-[12px] text-ink-500 dark:text-ink-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : guilds.length === 0 ? (
        <div className="mt-6 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed">
          No channels visible. Make sure the global Discord bot is invited
          to a server (use the OAuth2 URL Generator with the{" "}
          <code className="font-mono text-[11px]">bot</code> scope) and that
          the plugin is enabled on the Plugins page.
        </div>
      ) : (
        <>
          <div className="mt-5 relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-400" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Search ${totalChannels} channels…`}
              className="pl-8"
            />
          </div>

          <div className="mt-3 max-h-[320px] overflow-y-auto rounded-md border border-ink-900/10 bg-paper-100/50 dark:border-ink-50/10 dark:bg-ink-900/40">
            {filtered.map((g) => (
              <div key={g.id}>
                <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-paper-100 dark:bg-ink-900 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
                  {g.iconUrl ? (
                    // discord guild icon — lazy
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={g.iconUrl}
                      alt=""
                      className="h-4 w-4 rounded"
                    />
                  ) : (
                    <span className="h-4 w-4 rounded grid place-items-center font-mono text-[8px] font-semibold bg-ink-300 text-ink-50 dark:bg-ink-700">
                      {g.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-600 dark:text-ink-300 truncate">
                    {g.name}
                  </span>
                </div>
                <ul>
                  {g.channels.map((c) => {
                    const sel = picked === c.id;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setPicked(c.id)}
                          className={cn(
                            "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
                            sel
                              ? "bg-ember-500/10 text-ember-700 dark:text-ember-300"
                              : "hover:bg-paper-100 dark:hover:bg-ink-700",
                          )}
                        >
                          <Hash className="h-3 w-3 shrink-0 opacity-70" />
                          <span className="font-mono text-[12px] truncate flex-1">
                            {c.name}
                          </span>
                          {sel && (
                            <ChevronRight className="h-3 w-3 shrink-0 opacity-80" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-ink-400 dark:text-ink-500">
                no matches
              </div>
            )}
          </div>

          {pickedChannel && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300 shrink-0" />
              <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate">
                {pickedChannel.guild.name} · #{pickedChannel.channel.name}
              </span>
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                disabled={test.isPending}
                onClick={() => void onTest()}
              >
                {test.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Test
              </Button>
            </div>
          )}
        </>
      )}

      <div className="mt-6 flex items-center gap-2 border-t border-ink-900/10 dark:border-ink-50/10 pt-4">
        {hasExisting && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onDisconnect()}
            className="text-red-700 dark:text-red-300"
          >
            <Trash2 className="h-3 w-3" />
            Disconnect
          </Button>
        )}
        <span className="ml-auto" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={!picked || update.isPending}
        >
          {update.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Save connection"
          )}
        </Button>
      </div>
    </div>
  );
}

/* ── Bits ─────────────────────────────────────────────────────── */

function Step({
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

function BrandTile({ platform }: { platform: ChatPlatform }) {
  const bg = platform === "telegram" ? "#229ED9" : "#5865F2";
  const initials = platform === "telegram" ? "TG" : "DC";
  return (
    <div
      className="h-12 w-12 shrink-0 rounded-xl grid place-items-center font-mono text-[15px] font-semibold text-white shadow-sm"
      style={{ background: bg }}
    >
      {initials}
    </div>
  );
}

function BotAvatar({ firstName }: { firstName: string }) {
  const letter = firstName.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <div className="h-8 w-8 shrink-0 rounded-full grid place-items-center bg-[#229ED9] text-white font-mono text-[12px] font-semibold">
      {letter}
    </div>
  );
}

