import { useEffect, useState } from "react";
import { Check, Clipboard, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
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
      toast("Pair token issued");
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
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>account</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Devices
        </span>
        <Count>1 paired</Count>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          this browser
        </span>
        <Spacer />
        <Button size="xs" onClick={issue} disabled={busy}>
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          Issue token
        </Button>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Active pairing token (or empty state) */}
        <SectionHeader
          label="Pair token"
          hint={
            pair
              ? expired
                ? "expired — issue a new one"
                : `${Math.floor(remainingSec / 60)}:${String(
                    remainingSec % 60,
                  ).padStart(2, "0")} until expiry`
              : "issue a one-time token to authorize a new device"
          }
          sticky={false}
        />

        {!pair ? (
          <div className="px-5 py-6 text-[12px] text-ink-500 dark:text-ink-400 max-w-2xl">
            Tap{" "}
            <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200">
              Issue token
            </span>{" "}
            to mint a fresh pairing token. It's good for{" "}
            <span className="num text-[14px] text-ink-900 dark:text-ink-50">
              10
            </span>{" "}
            minutes.
          </div>
        ) : expired ? (
          <div className="px-5 py-6 text-[12px] text-ink-500 dark:text-ink-400">
            That token has timed out. Issue a fresh one to continue.
          </div>
        ) : (
          <div className="px-5 py-5 space-y-4 max-w-3xl">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-1.5">
                Token
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 select-all rounded-md border border-ink-900/10 bg-ink-900/[0.03] px-3 py-2 font-mono text-[13px] tracking-wider break-all text-ink-900 dark:border-ink-50/10 dark:bg-ink-50/[0.03] dark:text-ink-50">
                  {pair.token}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copy(pair.token)}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Clipboard className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-2 font-mono text-[10px]">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md uppercase tracking-[0.06em]",
                    remainingSec < 60
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-vermilion-700 dark:text-vermilion-300",
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-vermilion-500 animate-blink" />
                  <span className="num text-[12px]">
                    {Math.floor(remainingSec / 60)}:
                    {String(remainingSec % 60).padStart(2, "0")}
                  </span>
                </span>
                <span className="text-ink-300 dark:text-ink-600">·</span>
                <span className="text-ink-400 dark:text-ink-500">
                  single-use, expires after pairing
                </span>
              </div>
            </div>

            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-1.5">
                CLI command
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 select-all rounded-md bg-ink-900 text-cream-100 px-3 py-2 font-mono text-[11px] leading-relaxed break-all">
                  agentd pair --server {server} --token {pair.token}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    copy(`agentd pair --server ${server} --token ${pair.token}`)
                  }
                >
                  <Clipboard className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
            </div>

            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 mb-1.5">
                Browser
              </div>
              <div className="font-mono text-[11px] text-ink-700 dark:text-ink-200">
                Open <span className="text-vermilion-700 dark:text-vermilion-300">{server}</span> on the new device, then paste the token.
              </div>
            </div>
          </div>
        )}

        <SectionHeader
          label="How pairing works"
          hint="brief"
          sticky={false}
        />
        <ol className="px-5 pt-4 pb-2 space-y-2 text-[12px] text-ink-700 dark:text-ink-200 max-w-2xl">
          <ListStep n={1}>Issue a one-time token here.</ListStep>
          <ListStep n={2}>Open the daemon URL on the new device.</ListStep>
          <ListStep n={3}>
            Paste the token into the pairing screen — or run{" "}
            <code className="font-mono text-[11px]">agentd pair</code>.
          </ListStep>
          <ListStep n={4}>
            The new device receives a long-lived session token, stored on that
            device only.
          </ListStep>
        </ol>

        <SectionHeader
          label="Sessions"
          hint="not yet exposed by the daemon"
          sticky={false}
        />
        <div className="px-5 py-4 max-w-2xl text-[11px] text-ink-500 dark:text-ink-400">
          Listing or revoking other paired sessions isn't supported by the
          daemon yet. As a workaround, restart the daemon to invalidate every
          session at once.
        </div>
      </div>
    </div>
  );
}

function ListStep({
  n,
  children,
}: {
  n: number;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="num shrink-0 text-vermilion-600 dark:text-vermilion-400 w-5">
        {n}.
      </span>
      <span>{children}</span>
    </li>
  );
}
