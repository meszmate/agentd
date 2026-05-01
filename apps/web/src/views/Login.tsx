import { useState } from "react";
import { AgentdClient } from "@agentd/client";
import { Clipboard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Wordmark } from "@/components/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";

interface Props {
  initialServer: string;
  onPair: (server: string, token: string) => void;
  onError: (msg: string) => void;
}

export function Login({ initialServer, onPair, onError }: Props) {
  const [server, setServer] = useState(initialServer);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = new AgentdClient(server, null);
      const label =
        "web@" +
        (navigator.userAgent.match(/\((.*?)\)/)?.[1] ?? "browser");
      const r = await c.pair({ pairingToken: token, deviceLabel: label });
      onPair(server, r.sessionToken);
    } catch (e) {
      onError(`pair: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function pasteToken() {
    try {
      const t = await navigator.clipboard.readText();
      setToken(t.trim());
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <div className="grid h-full w-full grid-cols-1 lg:grid-cols-5 bg-paper-100 dark:bg-ink-900">
      {/* Editorial brand panel */}
      <aside className="relative hidden lg:col-span-3 lg:flex flex-col justify-between overflow-hidden bg-paper-50 dark:bg-ink-800 border-r border-ink-900/10 dark:border-ink-50/10 p-12">
        {/* Editorial radial wash */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-100"
          style={{
            backgroundImage:
              "radial-gradient(circle at 0% 0%, rgba(255, 92, 40, 0.14), transparent 45%), radial-gradient(circle at 100% 100%, rgba(10, 10, 10, 0.06), transparent 50%)",
          }}
        />
        {/* Faint grid */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(to_right,rgba(10,10,10,1)_1px,transparent_1px),linear-gradient(to_bottom,rgba(10,10,10,1)_1px,transparent_1px)] [background-size:40px_40px] dark:opacity-[0.06]"
        />

        <div className="relative">
          <Wordmark size="lg" />
        </div>

        <div className="relative max-w-xl">
          <div className="label-section mb-3">A self-hosted orchestrator</div>
          <p className="display text-5xl xl:text-6xl text-ink-900 dark:text-ink-50">
            Spawn agents{" "}
            <span className="italic text-ember-600 dark:text-ember-400">
              in worktrees,
            </span>{" "}
            chat from anywhere, auto-PR.
          </p>
          <p className="mt-5 max-w-md text-sm text-ink-600 dark:text-ink-300">
            Reach the daemon from any device on your tailnet. Pair once per
            browser, terminal, or bot — the daemon never accepts inbound
            connections from the public internet.
          </p>
        </div>

        <div className="relative">
          <div className="label-section mb-2">Pair a CLI</div>
          <pre className="font-mono text-xs text-ink-700 dark:text-ink-300 leading-relaxed">
            <span className="text-ink-400 dark:text-ink-500">$</span>{" "}
            <span className="text-ink-900 dark:text-ink-50">
              agentd pair --server &lt;url&gt; --token &lt;token&gt;
            </span>
          </pre>
        </div>
      </aside>

      {/* Form panel */}
      <main className="relative col-span-1 lg:col-span-2 flex flex-col justify-center px-6 sm:px-12 py-10">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>

        <div className="mx-auto w-full max-w-sm rise rise-1">
          <div className="mb-8 lg:hidden">
            <Wordmark size="lg" />
          </div>

          <div className="label-section mb-3">Pairing</div>
          <h1 className="display text-3xl text-ink-900 dark:text-ink-50">
            Authorize this device
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-ink-400">
            Paste the one-time token printed by the daemon.
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-server">Server</Label>
              <Input
                id="login-server"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                required
                autoComplete="url"
                inputMode="url"
                spellCheck={false}
                className="font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-token">Pairing token</Label>
              <div className="relative">
                <Input
                  id="login-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  autoFocus
                  placeholder="paste token from daemon log"
                  spellCheck={false}
                  autoComplete="one-time-code"
                  className="font-mono pr-9"
                />
                <button
                  type="button"
                  onClick={pasteToken}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink-400 hover:bg-ink-900/[0.04] hover:text-ink-700 dark:text-ink-500 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-200"
                  aria-label="Paste from clipboard"
                  title="Paste from clipboard"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <Button
              type="submit"
              size="lg"
              variant="vermilion"
              className="w-full"
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Pairing…
                </>
              ) : (
                "Authorize"
              )}
            </Button>

            <p className="text-2xs text-center text-ink-500 dark:text-ink-400">
              Token expires <span className="font-mono">10 min</span> after the
              daemon prints it. Press <Kbd>↵</Kbd> to submit.
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
