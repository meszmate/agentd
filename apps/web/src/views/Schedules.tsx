import { useState } from "react";
import type { AgentdClient } from "@agentd/client";
import type { Schedule, Template } from "@agentd/contracts";
import { usePoll } from "../api";
import { useApp, useClient } from "../AppContext";

export function Schedules() {
  const client = useClient();
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const onInfo = (m: string) => toast(m);
  const sched = usePoll(() => client.listSchedules(), { schedules: [] as Schedule[] }, 6000);
  const tpl = usePoll(() => client.listTemplates(), { templates: [] as Template[] }, 30_000);
  const [showForm, setShowForm] = useState(false);

  async function toggle(s: Schedule) {
    try {
      if (s.enabled) await client.disableSchedule(s.id);
      else await client.enableSchedule(s.id);
      onInfo(`${s.name} ${s.enabled ? "disabled" : "enabled"}`);
      await sched.refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function rm(s: Schedule) {
    if (!confirm(`delete schedule '${s.name}'?`)) return;
    try {
      await client.deleteSchedule(s.id);
      await sched.refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="page-pad">
      <h2>
        Schedules{" "}
        <button className="ghost" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "cancel" : "+ new"}
        </button>
      </h2>
      {showForm && (
        <CreateForm
          client={client}
          templates={tpl.data.templates}
          onError={onError}
          onCreated={async () => {
            setShowForm(false);
            await sched.refresh();
          }}
        />
      )}
      <table className="table">
        <thead>
          <tr>
            <th>name</th>
            <th>cron</th>
            <th>template</th>
            <th>state</th>
            <th>last</th>
            <th>next</th>
            <th className="actions">actions</th>
          </tr>
        </thead>
        <tbody>
          {sched.data.schedules.length === 0 ? (
            <tr>
              <td colSpan={7}>
                <div className="empty">No schedules.</div>
              </td>
            </tr>
          ) : (
            sched.data.schedules.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>
                  <code>{s.cron}</code>
                </td>
                <td>{s.templateId}</td>
                <td>{s.enabled ? "enabled" : "disabled"}</td>
                <td>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—"}</td>
                <td>{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}</td>
                <td className="actions">
                  <button onClick={() => void toggle(s)}>
                    {s.enabled ? "disable" : "enable"}
                  </button>
                  <button className="danger" onClick={() => void rm(s)}>
                    rm
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function CreateForm({
  client,
  templates,
  onError,
  onCreated,
}: {
  client: AgentdClient;
  templates: Template[];
  onError: (m: string) => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!templateId) {
      onError("create a template first");
      return;
    }
    setBusy(true);
    try {
      const argMap: Record<string, string> = {};
      for (const part of args.split(/\s+/).filter(Boolean)) {
        const eq = part.indexOf("=");
        if (eq > 0) argMap[part.slice(0, eq)] = part.slice(eq + 1);
      }
      await client.createSchedule({
        name,
        cron,
        templateId,
        templateArgs: argMap,
        enabled: true,
      });
      await onCreated();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="row">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="row">
        <label>cron (5-field)</label>
        <input value={cron} onChange={(e) => setCron(e.target.value)} required />
      </div>
      <div className="row">
        <label>template</label>
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>args</label>
        <input
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="key=value space-separated, e.g. branch=main since=24h"
        />
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          create
        </button>
      </div>
    </form>
  );
}
