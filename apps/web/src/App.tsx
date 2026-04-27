import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentdClient } from "@agentd/client";
import {
  clearSession,
  loadStoredServer,
  loadStoredToken,
  saveSession,
} from "./api";
import { Login } from "./views/Login";
import { Tasks } from "./views/Tasks";
import { Templates } from "./views/Templates";
import { Schedules } from "./views/Schedules";
import { Settings } from "./views/Settings";
import { Plugins } from "./views/Plugins";

type Page = "tasks" | "templates" | "schedules" | "plugins" | "settings";

export function App() {
  const [server, setServer] = useState<string>(() => loadStoredServer());
  const [token, setToken] = useState<string | null>(() => loadStoredToken());
  const [page, setPage] = useState<Page>("tasks");
  const [toast, setToast] = useState<{ msg: string; isErr: boolean } | null>(null);

  const client = useMemo<AgentdClient | null>(
    () => (token ? new AgentdClient(server, token) : null),
    [server, token],
  );

  const showToast = useCallback((msg: string, isErr = false) => {
    setToast({ msg, isErr });
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, []);

  // Verify session on mount; if it 401s, log out and prompt re-pair.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        await client.health();
      } catch {
        if (!cancelled) {
          clearSession();
          setToken(null);
          showToast("session invalid — please pair again", true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, showToast]);

  if (!client) {
    return (
      <Login
        initialServer={server}
        onPair={(s, tok) => {
          saveSession(s, tok);
          setServer(s);
          setToken(tok);
          showToast("paired ✓");
        }}
        onError={(m) => showToast(m, true)}
      />
    );
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          agentd
        </div>
        <div className="nav">
          {(["tasks", "templates", "schedules", "plugins", "settings"] as const).map((p) => (
            <button
              key={p}
              className={p === page ? "active" : ""}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <button
          className="ghost"
          onClick={() => {
            clearSession();
            setToken(null);
          }}
          title="log out"
        >
          ⎋
        </button>
      </div>
      <div style={{ minHeight: 0, overflow: "hidden" }}>
        {page === "tasks" && <Tasks client={client} onError={(m) => showToast(m, true)} />}
        {page === "templates" && <Templates client={client} onError={(m) => showToast(m, true)} onInfo={(m) => showToast(m)} />}
        {page === "schedules" && <Schedules client={client} onError={(m) => showToast(m, true)} onInfo={(m) => showToast(m)} />}
        {page === "plugins" && <Plugins client={client} onError={(m) => showToast(m, true)} onInfo={(m) => showToast(m)} />}
        {page === "settings" && <Settings client={client} onError={(m) => showToast(m, true)} onInfo={(m) => showToast(m)} />}
      </div>
      {toast && (
        <div className={`toast${toast.isErr ? " err" : ""}`}>{toast.msg}</div>
      )}
    </div>
  );
}
