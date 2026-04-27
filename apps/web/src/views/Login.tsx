import { useState } from "react";
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

  return (
    <div className="login">
      <h1>agentd</h1>
      <p>Pair this browser with a running daemon.</p>
      <form onSubmit={submit}>
        <label>server URL</label>
        <input value={server} onChange={(e) => setServer(e.target.value)} required />
        <label>one-time pairing token</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoFocus
          placeholder="paste token printed on daemon startup"
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "pairing…" : "pair"}
        </button>
      </form>
    </div>
  );
}
