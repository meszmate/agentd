import { useEffect, useState } from "react";
import { useApp } from "../AppContext";
import { usePatchSettings, useSettings } from "../queries";

export function Settings() {
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const onInfo = (m: string) => toast(m);
  const settingsQ = useSettings();
  const patch = usePatchSettings();

  const [agentInstructions, setAgentInstructions] = useState("");
  const [commitPrefix, setCommitPrefix] = useState("");
  const [prTitlePrefix, setPrTitlePrefix] = useState("");
  const [prBodyTemplate, setPrBodyTemplate] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!settingsQ.data || hydrated) return;
    setAgentInstructions(settingsQ.data.agentInstructions);
    setCommitPrefix(settingsQ.data.commitPrefix);
    setPrTitlePrefix(settingsQ.data.prTitlePrefix);
    setPrBodyTemplate(settingsQ.data.prBodyTemplate);
    setHydrated(true);
  }, [settingsQ.data, hydrated]);

  async function save() {
    try {
      await patch.mutateAsync({
        agentInstructions,
        commitPrefix,
        prTitlePrefix,
        prBodyTemplate,
      });
      onInfo("settings saved");
    } catch (e) {
      onError((e as Error).message);
    }
  }

  if (!hydrated) return <div className="page empty">loading…</div>;

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="crumb">~/settings</div>
        <h2>Settings</h2>
      </div>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="title">AGENT POLICY</div>
        <div className="row">
          <label>agent instructions</label>
          <textarea
            value={agentInstructions}
            onChange={(e) => setAgentInstructions(e.target.value)}
            rows={6}
          />
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-mute)", marginLeft: 176, marginTop: -4, marginBottom: 8 }}>
          // appended to every agent run via <code>--append-system-prompt</code>
        </div>

        <div className="title" style={{ marginTop: 24 }}>COMMITS &amp; PRS</div>
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
        <div style={{ fontSize: 11, color: "var(--ink-mute)", marginLeft: 176, marginTop: -4 }}>
          // placeholders: <code>{"{prompt}"}</code> <code>{"{title}"}</code>{" "}
          <code>{"{task_id}"}</code> <code>{"{branch}"}</code>
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={patch.isPending}>
            {patch.isPending ? "saving…" : "› save"}
          </button>
        </div>
      </form>
    </div>
  );
}
