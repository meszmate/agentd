import { useEffect, useState } from "react";
import type { AgentdClient } from "@agentd/client";

interface Props {
  client: AgentdClient;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}

export function Settings({ client, onError, onInfo }: Props) {
  const [agentInstructions, setAgentInstructions] = useState("");
  const [commitPrefix, setCommitPrefix] = useState("");
  const [prTitlePrefix, setPrTitlePrefix] = useState("");
  const [prBodyTemplate, setPrBodyTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await client.getSettings();
        setAgentInstructions(s.agentInstructions);
        setCommitPrefix(s.commitPrefix);
        setPrTitlePrefix(s.prTitlePrefix);
        setPrBodyTemplate(s.prBodyTemplate);
        setLoaded(true);
      } catch (e) {
        onError((e as Error).message);
      }
    })();
  }, [client, onError]);

  async function save() {
    setBusy(true);
    try {
      await client.patchSettings({
        agentInstructions,
        commitPrefix,
        prTitlePrefix,
        prBodyTemplate,
      });
      onInfo("settings saved");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="page-pad empty">loading…</div>;
  return (
    <div className="page-pad">
      <h2>Settings</h2>
      <div className="form">
        <div className="row">
          <label>agent instructions</label>
          <textarea
            value={agentInstructions}
            onChange={(e) => setAgentInstructions(e.target.value)}
            rows={6}
          />
        </div>
        <div className="row">
          <label>commit prefix</label>
          <input value={commitPrefix} onChange={(e) => setCommitPrefix(e.target.value)} />
        </div>
        <div className="row">
          <label>PR title prefix</label>
          <input value={prTitlePrefix} onChange={(e) => setPrTitlePrefix(e.target.value)} />
        </div>
        <div className="row">
          <label>PR body template</label>
          <textarea
            value={prBodyTemplate}
            onChange={(e) => setPrBodyTemplate(e.target.value)}
            rows={4}
          />
        </div>
        <div className="actions">
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </div>
      <p style={{ color: "var(--muted)", fontSize: 12 }}>
        Placeholders for PR body: <code>{"{prompt}"}</code>, <code>{"{title}"}</code>,{" "}
        <code>{"{task_id}"}</code>, <code>{"{branch}"}</code>.
      </p>
    </div>
  );
}
