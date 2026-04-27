import { useState } from "react";
import type { Schedule, Template } from "@agentd/contracts";
import { useApp } from "../AppContext";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useSchedules,
  useTemplates,
  useToggleSchedule,
} from "../queries";

export function Schedules() {
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const onInfo = (m: string) => toast(m);
  const schQ = useSchedules();
  const tplQ = useTemplates({ refetchInterval: 30_000 });
  const toggle = useToggleSchedule();
  const del = useDeleteSchedule();
  const [showForm, setShowForm] = useState(false);

  async function flip(s: Schedule) {
    try {
      await toggle.mutateAsync({ id: s.id, enabled: !s.enabled });
      onInfo(`${s.name} ${s.enabled ? "disabled" : "enabled"}`);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function rm(s: Schedule) {
    if (!confirm(`delete schedule '${s.name}'?`)) return;
    try {
      await del.mutateAsync(s.id);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="crumb">~/schedules</div>
        <h2>Schedules</h2>
        <div className="actions">
          <button className="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "× cancel" : "+ new schedule"}
          </button>
        </div>
      </div>

      {showForm && (
        <CreateForm
          templates={(tplQ.data?.templates as Template[]) ?? []}
          onError={onError}
          onCreated={() => setShowForm(false)}
        />
      )}

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 160 }}>name</th>
            <th style={{ width: 140 }}>cron</th>
            <th>template</th>
            <th style={{ width: 90 }}>state</th>
            <th>last</th>
            <th>next</th>
            <th className="actions">actions</th>
          </tr>
        </thead>
        <tbody>
          {!schQ.data ? (
            <tr><td colSpan={7}><div className="empty">loading…</div></td></tr>
          ) : schQ.data.schedules.length === 0 ? (
            <tr><td colSpan={7}><div className="empty">no schedules</div></td></tr>
          ) : (
            schQ.data.schedules.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td><code>{s.cron}</code></td>
                <td>{s.templateId}</td>
                <td>
                  <span className={`pill ${s.enabled ? "ok" : "mute"}`}>
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td style={{ color: "var(--ink-mute)", fontSize: 11 }}>
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—"}
                </td>
                <td style={{ fontSize: 11 }}>
                  {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
                </td>
                <td className="actions">
                  <button onClick={() => void flip(s)} disabled={toggle.isPending}>
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
  templates,
  onError,
  onCreated,
}: {
  templates: Template[];
  onError: (m: string) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [args, setArgs] = useState("");
  const create = useCreateSchedule();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!templateId) {
      onError("create a template first");
      return;
    }
    const argMap: Record<string, string> = {};
    for (const part of args.split(/\s+/).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq > 0) argMap[part.slice(0, eq)] = part.slice(eq + 1);
    }
    try {
      await create.mutateAsync({
        name,
        cron,
        templateId,
        templateArgs: argMap,
        enabled: true,
      });
      onCreated();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="title">NEW SCHEDULE</div>
      <div className="row">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="row">
        <label>cron (5-field)</label>
        <input value={cron} onChange={(e) => setCron(e.target.value)} required spellCheck={false} />
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
          placeholder="key=value space-separated"
        />
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={create.isPending}>
          {create.isPending ? "creating…" : "› create"}
        </button>
      </div>
    </form>
  );
}
