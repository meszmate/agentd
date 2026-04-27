import { useState } from "react";
import type { AgentdClient } from "@agentd/client";
import type { Template } from "@agentd/contracts";
import { usePoll } from "../api";

interface Props {
  client: AgentdClient;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}

export function Templates({ client, onError, onInfo }: Props) {
  const poll = usePoll(() => client.listTemplates(), { templates: [] as Template[] }, 6000);
  const [showForm, setShowForm] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [argInput, setArgInput] = useState("");

  async function fire(t: Template) {
    if (running) return;
    setRunning(t.name);
    try {
      const args = parseArgs(argInput);
      const { task } = await client.runTemplate(t.name, { args });
      onInfo(`fired '${t.name}' → ${task.id.slice(-8)}`);
      setArgInput("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setRunning(null);
    }
  }

  async function rm(t: Template) {
    if (!confirm(`delete template '${t.name}'?`)) return;
    try {
      await client.deleteTemplate(t.name);
      await poll.refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="page-pad">
      <h2>
        Templates{" "}
        <button className="ghost" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "cancel" : "+ new"}
        </button>
      </h2>
      {showForm && (
        <CreateForm
          client={client}
          onError={onError}
          onCreated={async () => {
            setShowForm(false);
            await poll.refresh();
          }}
        />
      )}
      <div style={{ marginBottom: 12 }}>
        <input
          placeholder='args for template runs (e.g. "name=foo target=server")'
          value={argInput}
          onChange={(e) => setArgInput(e.target.value)}
        />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>name</th>
            <th>agent</th>
            <th>repo</th>
            <th>flags</th>
            <th>prompt</th>
            <th className="actions">actions</th>
          </tr>
        </thead>
        <tbody>
          {poll.data.templates.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <div className="empty">No templates yet.</div>
              </td>
            </tr>
          ) : (
            poll.data.templates.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.agent}</td>
                <td>{t.repoPath}</td>
                <td>
                  {t.autoPush ? "push " : ""}
                  {t.autoPr ? "pr" : ""}
                </td>
                <td title={t.promptTemplate}>
                  {t.promptTemplate.length > 60
                    ? t.promptTemplate.slice(0, 60) + "…"
                    : t.promptTemplate}
                </td>
                <td className="actions">
                  <button
                    className="primary"
                    onClick={() => void fire(t)}
                    disabled={running === t.name}
                  >
                    {running === t.name ? "…" : "run"}
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
  client,
  onError,
  onCreated,
}: {
  client: AgentdClient;
  onError: (m: string) => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [push, setPush] = useState(false);
  const [pr, setPr] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await client.createTemplate({
        name,
        agent,
        repoPath: repo,
        baseBranch: base,
        promptTemplate: prompt,
        autoPush: push || pr,
        autoPr: pr,
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
        <div>
          <label className="toggle" style={{ display: "inline-flex", marginRight: 16 }}>
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />{" "}
            auto-push
          </label>
          <label className="toggle" style={{ display: "inline-flex" }}>
            <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} />{" "}
            auto-PR
          </label>
        </div>
      </div>
      <div className="row">
        <label>prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Use {placeholders} for values to substitute at run time."
          required
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
