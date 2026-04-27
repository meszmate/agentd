import { useEffect, useState } from "react";
import type { AgentdClient, PluginStatus } from "@agentd/client";

interface Props {
  client: AgentdClient;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}

interface PluginConfigRaw {
  enabled: boolean;
  botToken: string;
  defaultRepo: string | null;
  allowedUserIds: Array<number | string>;
  allowedChatIds?: number[];
  allowedChannelIds?: string[];
}

export function Plugins({ client, onError, onInfo }: Props) {
  const [status, setStatus] = useState<PluginStatus[]>([]);
  const [config, setConfig] = useState<Record<string, PluginConfigRaw> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await client.pluginStatus();
      setStatus(r.plugins);
      setConfig(r.config as unknown as Record<string, PluginConfigRaw>);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  async function patchTelegram(patch: Record<string, unknown>) {
    setBusy("telegram");
    try {
      await client.patchPlugin("telegram", patch);
      onInfo("telegram updated");
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function patchDiscord(patch: Record<string, unknown>) {
    setBusy("discord");
    try {
      await client.patchPlugin("discord", patch);
      onInfo("discord updated");
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!config) return <div className="page-pad empty">loading…</div>;

  const tg = config.telegram;
  const dc = config.discord;
  if (!tg || !dc) return <div className="page-pad empty">loading…</div>;
  const tgStatus = status.find((s) => s.name === "telegram");
  const dcStatus = status.find((s) => s.name === "discord");

  return (
    <div className="page-pad">
      <h2>Plugins</h2>
      <PluginPanel
        title="Telegram"
        cfg={tg}
        idsLabel="allowed chat ids (comma)"
        idsKey="allowedChatIds"
        idsParse={(s) => s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))}
        userIdsParse={(s) => s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))}
        status={tgStatus}
        busy={busy === "telegram"}
        onPatch={patchTelegram}
      />
      <PluginPanel
        title="Discord"
        cfg={dc}
        idsLabel="allowed channel ids (comma)"
        idsKey="allowedChannelIds"
        idsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
        userIdsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
        status={dcStatus}
        busy={busy === "discord"}
        onPatch={patchDiscord}
      />
    </div>
  );
}

function PluginPanel<S extends number | string>({
  title,
  cfg,
  idsLabel,
  idsKey,
  idsParse,
  userIdsParse,
  status,
  busy,
  onPatch,
}: {
  title: string;
  cfg: PluginConfigRaw;
  idsLabel: string;
  idsKey: "allowedChatIds" | "allowedChannelIds";
  idsParse: (raw: string) => S[];
  userIdsParse: (raw: string) => S[];
  status: PluginStatus | undefined;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [token, setToken] = useState(cfg.botToken);
  const [users, setUsers] = useState((cfg.allowedUserIds ?? []).join(","));
  const [scopes, setScopes] = useState(
    ((cfg[idsKey] as Array<S> | undefined) ?? []).join(","),
  );
  const [repo, setRepo] = useState(cfg.defaultRepo ?? "");

  return (
    <div className="form">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          {cfg.enabled
            ? status?.running
              ? `running (pid ${status.pid})`
              : status?.lastError ?? "stopped"
            : "disabled"}
        </span>
      </div>
      <div className="row">
        <label>bot token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="••••••"
        />
      </div>
      <div className="row">
        <label>allowed user ids</label>
        <input
          value={users}
          onChange={(e) => setUsers(e.target.value)}
          placeholder="comma-separated"
        />
      </div>
      <div className="row">
        <label>{idsLabel}</label>
        <input
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          placeholder="comma-separated"
        />
      </div>
      <div className="row">
        <label>default repo</label>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} />
      </div>
      <div className="actions">
        <button
          onClick={() =>
            void onPatch({
              enabled: false,
            })
          }
          disabled={busy}
        >
          disable
        </button>
        <button
          className="primary"
          style={{ marginLeft: 8 }}
          onClick={() =>
            void onPatch({
              enabled: true,
              ...(token ? { botToken: token } : {}),
              allowedUserIds: userIdsParse(users),
              [idsKey]: idsParse(scopes),
              defaultRepo: repo || null,
            })
          }
          disabled={busy}
        >
          {busy ? "…" : "enable + save"}
        </button>
      </div>
    </div>
  );
}
