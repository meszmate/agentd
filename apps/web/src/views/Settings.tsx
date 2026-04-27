import { useEffect, useId, useState } from "react";
import { useApp } from "../AppContext";
import { usePatchSettings, useSettings } from "../queries";
import {
  getNotifPref,
  requestNotifPermission,
  setNotifPref,
} from "../useNotifications";

export function Settings() {
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const onInfo = (m: string) => toast(m);
  const settingsQ = useSettings();
  const patch = usePatchSettings();
  const aiId = useId();
  const cpId = useId();
  const prtId = useId();
  const prbId = useId();
  const notifId = useId();

  const [agentInstructions, setAgentInstructions] = useState("");
  const [commitPrefix, setCommitPrefix] = useState("");
  const [prTitlePrefix, setPrTitlePrefix] = useState("");
  const [prBodyTemplate, setPrBodyTemplate] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [notifs, setNotifs] = useState<"ask" | "on" | "off">(() => getNotifPref());

  async function toggleNotifs() {
    if (notifs === "on") {
      setNotifPref("off");
      setNotifs("off");
      onInfo("notifications disabled");
      return;
    }
    const ok = await requestNotifPermission();
    setNotifs(ok ? "on" : "off");
    onInfo(ok ? "notifications enabled" : "permission denied");
  }

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
          <label htmlFor={aiId}>agent instructions</label>
          <textarea
            id={aiId}
            value={agentInstructions}
            onChange={(e) => setAgentInstructions(e.target.value)}
            rows={6}
            aria-describedby={`${aiId}-hint`}
          />
        </div>
        <div
          id={`${aiId}-hint`}
          style={{ fontSize: 11, color: "var(--ink-mute)", marginLeft: 176, marginTop: -4, marginBottom: 8 }}
        >
          // appended to every agent run via <code>--append-system-prompt</code>
        </div>

        <div className="title" style={{ marginTop: 24 }}>COMMITS &amp; PRS</div>
        <div className="row">
          <label htmlFor={cpId}>commit prefix</label>
          <input id={cpId} value={commitPrefix} onChange={(e) => setCommitPrefix(e.target.value)} />
        </div>
        <div className="row">
          <label htmlFor={prtId}>PR title prefix</label>
          <input id={prtId} value={prTitlePrefix} onChange={(e) => setPrTitlePrefix(e.target.value)} />
        </div>
        <div className="row">
          <label htmlFor={prbId}>PR body template</label>
          <textarea
            id={prbId}
            value={prBodyTemplate}
            onChange={(e) => setPrBodyTemplate(e.target.value)}
            rows={4}
            aria-describedby={`${prbId}-hint`}
          />
        </div>
        <div id={`${prbId}-hint`} style={{ fontSize: 11, color: "var(--ink-mute)", marginLeft: 176, marginTop: -4 }}>
          // placeholders: <code>{"{prompt}"}</code> <code>{"{title}"}</code>{" "}
          <code>{"{task_id}"}</code> <code>{"{branch}"}</code>
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={patch.isPending}>
            {patch.isPending ? "saving…" : "› save"}
          </button>
        </div>
      </form>

      <div className="panel">
        <div className="title">BROWSER</div>
        <div className="row">
          <label htmlFor={notifId}>notifications</label>
          <div>
            <button
              id={notifId}
              type="button"
              onClick={() => void toggleNotifs()}
              className={notifs === "on" ? "primary" : ""}
            >
              {notifs === "on"
                ? "✓ enabled — disable"
                : notifs === "off"
                  ? "ask permission"
                  : "enable browser notifications"}
            </button>
            <div style={{ fontSize: 11, color: "var(--ink-mute)", marginTop: 6 }}>
              // pings you when a task transitions to done / failed / stopped while the tab is in the background
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
