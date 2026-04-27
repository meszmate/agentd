import { useId, useState } from "react";
import { AgentdClient } from "@agentd/client";

interface Props {
  initialServer: string;
  onPair: (server: string, token: string) => void;
  onError: (msg: string) => void;
}

export function Login({ initialServer, onPair, onError }: Props) {
  const [server, setServer] = useState(initialServer);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const serverId = useId();
  const tokenId = useId();
  const hintId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = new AgentdClient(server, null);
      const label = "web@" + (navigator.userAgent.match(/\((.*?)\)/)?.[1] ?? "browser");
      const r = await c.pair({ pairingToken: token, deviceLabel: label });
      onPair(server, r.sessionToken);
    } catch (e) {
      onError(`pair: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <main className="login fade-in" aria-labelledby={`${serverId}-title`}>
        <div className="login__head">
          <div className="login__brand" id={`${serverId}-title`}>
            <span className="slash" aria-hidden="true">
              /
            </span>
            agentd
          </div>
          <div className="login__sub" id={hintId}>
            $ pair --server &lt;url&gt; --token &lt;token&gt;
            <br />
            <span style={{ opacity: 0.6 }}>
              # daemon prints a one-time token + QR on startup
            </span>
          </div>
        </div>
        <form className="login__body" onSubmit={submit} aria-describedby={hintId}>
          <label htmlFor={serverId}>SERVER</label>
          <input
            id={serverId}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            required
            autoComplete="url"
            inputMode="url"
          />
          <label htmlFor={tokenId}>PAIRING TOKEN</label>
          <input
            id={tokenId}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
            placeholder="paste token from daemon log"
            spellCheck={false}
            autoComplete="one-time-code"
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "PAIRING…" : "› AUTHORIZE"}
          </button>
        </form>
      </main>
    </div>
  );
}
