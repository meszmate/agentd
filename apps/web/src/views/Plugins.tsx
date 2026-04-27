import { useState } from "react";
import type { PluginStatus } from "@agentd/client";
import { useApp } from "../AppContext";
import { usePatchDiscord, usePatchTelegram, usePluginsStatus } from "../queries";

interface PluginConfigRaw {
  enabled: boolean;
  botToken: string;
  defaultRepo: string | null;
  allowedUserIds: Array<number | string>;
  allowedChatIds?: number[];
  allowedChannelIds?: string[];
}

export function Plugins() {
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const onInfo = (m: string) => toast(m);
  const q = usePluginsStatus();

  if (!q.data) return <div className="page empty">loading…</div>;
  const status = q.data.plugins;
  const config = q.data.config as unknown as Record<string, PluginConfigRaw>;
  const tg = config.telegram;
  const dc = config.discord;
  if (!tg || !dc) return <div className="page empty">loading…</div>;

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="crumb">~/plugins</div>
        <h2>Plugins</h2>
      </div>
      <PluginPanel
        name="telegram"
        cfg={tg}
        status={status.find((s) => s.name === "telegram")}
        idsLabel="allowed chat ids"
        idsKey="allowedChatIds"
        idsParse={(s) => s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))}
        userIdsParse={(s) => s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))}
        onError={onError}
        onInfo={onInfo}
      />
      <PluginPanel
        name="discord"
        cfg={dc}
        status={status.find((s) => s.name === "discord")}
        idsLabel="allowed channel ids"
        idsKey="allowedChannelIds"
        idsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
        userIdsParse={(s) => s.split(",").map((x) => x.trim()).filter(Boolean)}
        onError={onError}
        onInfo={onInfo}
      />
    </div>
  );
}

function PluginPanel<S extends number | string>({
  name,
  cfg,
  status,
  idsLabel,
  idsKey,
  idsParse,
  userIdsParse,
  onError,
  onInfo,
}: {
  name: "telegram" | "discord";
  cfg: PluginConfigRaw;
  status: PluginStatus | undefined;
  idsLabel: string;
  idsKey: "allowedChatIds" | "allowedChannelIds";
  idsParse: (raw: string) => S[];
  userIdsParse: (raw: string) => S[];
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}) {
  const [token, setToken] = useState(cfg.botToken);
  const [users, setUsers] = useState((cfg.allowedUserIds ?? []).join(","));
  const [scopes, setScopes] = useState(
    ((cfg[idsKey] as Array<S> | undefined) ?? []).join(","),
  );
  const [repo, setRepo] = useState(cfg.defaultRepo ?? "");

  const patchTg = usePatchTelegram();
  const patchDc = usePatchDiscord();
  const mutate = name === "telegram" ? patchTg : patchDc;

  async function apply(enabled: boolean) {
    try {
      const patch: Record<string, unknown> = { enabled };
      if (enabled) {
        if (token) patch.botToken = token;
        patch.allowedUserIds = userIdsParse(users);
        patch[idsKey] = idsParse(scopes);
        patch.defaultRepo = repo || null;
      }
      await mutate.mutateAsync(patch as never);
      onInfo(`${name} ${enabled ? "saved" : "disabled"}`);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  const stateLabel = cfg.enabled
    ? status?.running
      ? `running (pid ${status.pid})`
      : status?.lastError ?? "stopped"
    : "disabled";
  const stateClass = cfg.enabled ? (status?.running ? "ok" : "err") : "mute";

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void apply(true);
      }}
    >
      <div className="title">
        <span style={{ color: "var(--ink)", fontWeight: 700 }}>{name.toUpperCase()}</span>
        <span className={`pill ${stateClass}`} style={{ marginLeft: "auto" }}>
          {stateLabel}
        </span>
      </div>
      <div className="row">
        <label>bot token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="••••••"
          spellCheck={false}
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
        <button onClick={() => void apply(false)} disabled={mutate.isPending} type="button">
          disable
        </button>
        <button className="primary" type="submit" disabled={mutate.isPending}>
          {mutate.isPending ? "saving…" : "› enable + save"}
        </button>
      </div>
    </form>
  );
}
