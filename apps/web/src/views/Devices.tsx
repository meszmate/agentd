import { useEffect, useState } from "react";
import {
  Check,
  Clipboard,
  Loader2,
  Smartphone,
  Sparkles,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp, useClient } from "@/AppContext";
import { cn } from "@/lib/utils";

interface Pairing {
  token: string;
  expiresAt: number;
  issuedAt: number;
}

export function Devices() {
  const client = useClient();
  const { server, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const issue = async () => {
    setBusy(true);
    try {
      const r = await client.issuePairToken();
      setPair({ token: r.token, expiresAt: r.expiresAt, issuedAt: Date.now() });
      setCopied(false);
      toast("New pair token issued");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Clipboard unavailable", true);
    }
  };

  const remainingSec = pair
    ? Math.max(0, Math.floor((pair.expiresAt - now) / 1000))
    : 0;
  const expired = pair && remainingSec <= 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Devices"
          subtitle="Pair new browsers and CLIs from this session. Tokens expire 10 minutes after issue."
        />

        <div className="mt-8 grid gap-8 lg:grid-cols-3">
          {/* Issue token card */}
          <section className="lg:col-span-2 rise rise-1">
            <div className="rounded-2xl border border-ink-900/10 bg-cream-50 dark:border-ink-50/10 dark:bg-ink-800 overflow-hidden">
              <div className="flex items-start gap-4 p-6 border-b border-ink-900/10 dark:border-ink-50/10">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-vermilion-500/15 text-vermilion-600 dark:text-vermilion-400">
                  <Smartphone className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <h2 className="display text-2xl text-ink-900 dark:text-ink-50">
                    Pair another device
                  </h2>
                  <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
                    Issue a one-time token to authorize a new browser, the
                    <span className="font-mono"> agentd</span> CLI, or another
                    Tailscale-reachable client.
                  </p>
                </div>
              </div>

              <div className="p-6">
                {!pair ? (
                  <div className="flex flex-col items-start gap-4">
                    <p className="text-sm text-ink-700 dark:text-ink-200">
                      Tap{" "}
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-ink-900/15 bg-ink-900/[0.04] px-2 py-0.5 font-mono text-xs">
                        Issue token
                      </span>{" "}
                      to mint a fresh pairing token. It's good for{" "}
                      <span className="num text-base">10</span> minutes.
                    </p>
                    <Button onClick={issue} disabled={busy}>
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      Issue token
                    </Button>
                  </div>
                ) : expired ? (
                  <ExpiredState onReissue={issue} busy={busy} />
                ) : (
                  <ActivePair
                    pair={pair}
                    server={server}
                    remainingSec={remainingSec}
                    onCopyToken={() => copy(pair.token)}
                    onCopyCli={() =>
                      copy(
                        `agentd pair --server ${server} --token ${pair.token}`,
                      )
                    }
                    onReissue={issue}
                    busy={busy}
                    copied={copied}
                  />
                )}
              </div>
            </div>
          </section>

          {/* Side rail */}
          <aside className="rise rise-2 space-y-6">
            <section>
              <h3 className="display text-xl text-ink-900 dark:text-ink-50">
                How pairing works
              </h3>
              <ol className="mt-2 space-y-2 text-sm text-ink-700 dark:text-ink-200">
                <ListItem n={1}>
                  Issue a one-time token here.
                </ListItem>
                <ListItem n={2}>
                  Open the daemon URL on the new device.
                </ListItem>
                <ListItem n={3}>
                  Paste the token into the pairing screen — or run{" "}
                  <code className="font-mono text-2xs">agentd pair</code>.
                </ListItem>
                <ListItem n={4}>
                  The new device receives a long-lived session token stored on
                  that device only.
                </ListItem>
              </ol>
            </section>

            <section className="rounded-xl border border-vermilion-500/20 bg-vermilion-500/[0.06] p-4">
              <div className="flex items-start gap-2.5">
                <TerminalIcon className="h-4 w-4 text-vermilion-600 dark:text-vermilion-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-medium text-ink-900 dark:text-ink-50">
                    Securing tokens
                  </div>
                  <div className="mt-1 text-2xs text-ink-700 dark:text-ink-300 leading-relaxed">
                    Treat the token like a password: anyone with it can pair a
                    device. Tokens are single-use and expire automatically.
                  </div>
                </div>
              </div>
            </section>

            <section>
              <h3 className="display text-xl text-ink-900 dark:text-ink-50">
                Sessions
              </h3>
              <p className="mt-2 text-2xs text-ink-500 dark:text-ink-400">
                Listing or revoking other paired sessions isn't exposed by the
                daemon yet. As a workaround, restart the daemon to invalidate
                every session at once.
              </p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ActivePair({
  pair,
  server,
  remainingSec,
  onCopyToken,
  onCopyCli,
  onReissue,
  busy,
  copied,
}: {
  pair: Pairing;
  server: string;
  remainingSec: number;
  onCopyToken: () => void;
  onCopyCli: () => void;
  onReissue: () => void;
  busy: boolean;
  copied: boolean;
}) {
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;
  const cliCommand = `agentd pair --server ${server} --token ${pair.token}`;

  return (
    <div className="space-y-5">
      <div>
        <div className="label-section mb-1.5">Token</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 select-all rounded-lg border border-ink-900/10 bg-ink-900/[0.03] px-3 py-2 font-mono text-sm tracking-wider break-all text-ink-900 dark:border-ink-50/10 dark:bg-ink-50/[0.03] dark:text-ink-50">
            {pair.token}
          </code>
          <Button variant="outline" size="sm" onClick={onCopyToken}>
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Clipboard className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2 font-mono text-2xs">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md uppercase tracking-[0.06em]",
              remainingSec < 60
                ? "text-amber-700 dark:text-amber-300"
                : "text-vermilion-700 dark:text-vermilion-300",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-vermilion-500 animate-blink" />
            <span className="num text-xs">
              {min}:{String(sec).padStart(2, "0")}
            </span>
          </span>
          <span className="text-ink-400 dark:text-ink-500">until expiry</span>
        </div>
      </div>

      <div>
        <div className="label-section mb-1.5">CLI command</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 select-all rounded-lg bg-ink-900 text-cream-100 px-3 py-2 font-mono text-2xs leading-relaxed break-all">
            {cliCommand}
          </code>
          <Button variant="outline" size="sm" onClick={onCopyCli}>
            <Clipboard className="h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-ink-900/10 dark:border-ink-50/10">
        <Button variant="ghost" size="sm" onClick={onReissue} disabled={busy}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Issue another
        </Button>
        <span className="ml-auto text-2xs text-ink-400 dark:text-ink-500">
          Single-use · expires after pairing
        </span>
      </div>
    </div>
  );
}

function ExpiredState({
  onReissue,
  busy,
}: {
  onReissue: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-2 chip chip-mute">expired</div>
      <p className="text-sm text-ink-700 dark:text-ink-200">
        That token has timed out. Issue a fresh one to continue.
      </p>
      <Button onClick={onReissue} disabled={busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        Issue token
      </Button>
    </div>
  );
}

function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="rise rise-1">
      <div className="label-section mb-3">Account</div>
      <h1 className="display text-4xl sm:text-5xl text-ink-900 dark:text-ink-50">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-2 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
          {subtitle}
        </p>
      )}
    </header>
  );
}

function ListItem({
  n,
  children,
}: {
  n: number;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="num shrink-0 text-vermilion-600 dark:text-vermilion-400">
        {n}.
      </span>
      <span>{children}</span>
    </li>
  );
}

