import { useEffect, useState } from "react";
import { Check, Clipboard, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { cn, formatTs } from "@/lib/utils";

const SESSIONS_KEY = ["admin", "sessions"] as const;

interface Pairing {
  token: string;
  expiresAt: number;
  issuedAt: number;
}

export function Devices() {
  const client = useClient();
  const { server, toast } = useApp();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const sessionsQ = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => client.listDeviceSessions(),
    staleTime: 10_000,
  });
  const sessions = sessionsQ.data?.sessions ?? [];

  const revoke = useMutation({
    mutationFn: (id: string) => client.revokeDeviceSession(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      toast("Session revoked");
    },
    onError: (e) => toast((e as Error).message, true),
  });

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
        <Count>{sessions.length || 1} paired</Count>
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
                      : "text-ember-700 dark:text-ember-300",
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink" />
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
                <code className="flex-1 select-all rounded-md bg-ink-900 text-paper-100 px-3 py-2 font-mono text-[11px] leading-relaxed break-all">
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
                Open <span className="text-ember-700 dark:text-ember-300">{server}</span> on the new device, then paste the token.
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
          hint={`${sessions.length} active`}
          sticky={false}
        />
        <div className="px-5 py-4 max-w-3xl">
          {sessionsQ.isLoading ? (
            <div className="flex items-center gap-2 text-[12px] text-ink-500 dark:text-ink-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-[11px] text-ink-500 dark:text-ink-400">
              No active sessions.
            </div>
          ) : (
            <ul className="divide-y divide-ink-900/10 rounded-md border border-ink-900/10 bg-paper-50 dark:divide-ink-50/10 dark:border-ink-50/10 dark:bg-ink-800">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px] text-ink-900 dark:text-ink-50">
                        {s.deviceLabel || "(unnamed device)"}
                      </span>
                      {s.current && (
                        <span className="inline-flex items-center rounded-md bg-ember-500/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
                          this device
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-500 dark:text-ink-400">
                      <span title={new Date(s.lastSeenAt).toLocaleString()}>
                        last seen {formatTs(s.lastSeenAt)}
                      </span>
                      <span className="text-ink-300 dark:text-ink-600">·</span>
                      <span title={new Date(s.createdAt).toLocaleString()}>
                        paired {formatTs(s.createdAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={s.current || revoke.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke session "${s.deviceLabel}"? It'll have to re-pair to continue.`,
                        )
                      ) {
                        revoke.mutate(s.id);
                      }
                    }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-ink-900/10 bg-paper-50 px-2 text-[11px] font-medium text-ink-600 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-900/10 disabled:hover:bg-paper-50 disabled:hover:text-ink-600 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-300 dark:hover:border-red-400/40 dark:hover:bg-red-500/10 dark:hover:text-red-300"
                    title={s.current ? "Log out instead to revoke this device" : "Revoke this session"}
                  >
                    <Trash2 className="h-3 w-3" />
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-ink-500 dark:text-ink-400">
            Revoke any device that should no longer access this daemon.
            Revoking the current device requires logging out instead — the
            "this device" row's button is disabled to prevent locking
            yourself out.
          </p>
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
      <span className="num shrink-0 text-ember-600 dark:text-ember-400 w-5">
        {n}.
      </span>
      <span>{children}</span>
    </li>
  );
}
