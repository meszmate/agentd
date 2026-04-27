import { useState } from "react";
import type { Template } from "@agentd/contracts";
import { useApp } from "../AppContext";
import { useCreateTemplate, useDeleteTemplate, useRunTemplate, useTemplates } from "../queries";

export function Templates() {
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const onInfo = (m: string) => toast(m);
  const tplQ = useTemplates();
  const del = useDeleteTemplate();
  const run = useRunTemplate();
  const [showForm, setShowForm] = useState(false);
  const [argInput, setArgInput] = useState("");

  async function fire(t: Template) {
    try {
      const args = parseArgs(argInput);
      const { task } = await run.mutateAsync({ name: t.name, args });
      onInfo(`fired '${t.name}' → ${task.id.slice(-8)}`);
      setArgInput("");
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function rm(t: Template) {
    if (!confirm(`delete template '${t.name}'?`)) return;
    try {
      await del.mutateAsync(t.name);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="crumb">~/templates</div>
        <h2>Templates</h2>
        <div className="actions">
          <button className="primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "× cancel" : "+ new template"}
          </button>
        </div>
      </div>

      {showForm && (
        <CreateForm onError={onError} onCreated={() => setShowForm(false)} />
      )}

      <div className="panel">
        <div className="title">RUN ARGS</div>
        <input
          placeholder='space-separated key=value pairs, e.g. name=foo target=server'
          value={argInput}
          onChange={(e) => setArgInput(e.target.value)}
        />
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-mute)" }}>
          // these substitute into <code>{"{placeholders}"}</code> in any template you fire
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 180 }}>name</th>
            <th style={{ width: 80 }}>agent</th>
            <th>repo</th>
            <th style={{ width: 120 }}>flags</th>
            <th>prompt</th>
            <th className="actions">actions</th>
          </tr>
        </thead>
        <tbody>
          {!tplQ.data ? (
            <tr><td colSpan={6}><div className="empty">loading…</div></td></tr>
          ) : tplQ.data.templates.length === 0 ? (
            <tr><td colSpan={6}><div className="empty">no templates yet</div></td></tr>
          ) : (
            tplQ.data.templates.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.name}</strong></td>
                <td>{t.agent}</td>
                <td>{t.repoPath}</td>
                <td>
                  {t.autoPush && <span className="pill mute" style={{ marginRight: 4 }}>push</span>}
                  {t.autoPr && <span className="pill red">pr</span>}
                </td>
                <td title={t.promptTemplate} style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.promptTemplate.length > 60
                    ? t.promptTemplate.slice(0, 60) + "…"
                    : t.promptTemplate}
                </td>
                <td className="actions">
                  <button className="primary" onClick={() => void fire(t)} disabled={run.isPending}>
                    › run
                  </button>
                  <button className="danger" onClick={() => void rm(t)}>
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

function parseArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function CreateForm({
  onError,
  onCreated,
}: {
  onError: (m: string) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [push, setPush] = useState(false);
  const [pr, setPr] = useState(false);
  const [prompt, setPrompt] = useState("");
  const create = useCreateTemplate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await create.mutateAsync({
        name,
        agent,
        repoPath: repo,
        baseBranch: base,
        promptTemplate: prompt,
        autoPush: push || pr,
        autoPr: pr,
      });
      onCreated();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="title">NEW TEMPLATE</div>
      <div className="row">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="row">
        <label>agent</label>
        <select value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")}>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
      </div>
      <div className="row">
        <label>repo path</label>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} required />
      </div>
      <div className="row">
        <label>base branch</label>
        <input value={base} onChange={(e) => setBase(e.target.value)} />
      </div>
      <div className="row">
        <label>flags</label>
        <div style={{ display: "flex", gap: 18 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, color: "var(--ink-mute)" }}>
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> auto-push
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, color: "var(--ink-mute)" }}>
            <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} /> auto-pr
          </label>
        </div>
      </div>
      <div className="row">
        <label>prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="use {placeholders} for run-time args"
          required
          rows={4}
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
