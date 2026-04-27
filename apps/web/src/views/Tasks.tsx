import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentdClient } from "@agentd/client";
import type { Task, Message, AgentEvent } from "@agentd/contracts";
import { usePoll, useTaskStream } from "../api";
import { Terminal } from "./Terminal";

type Tab = "chat" | "files" | "diff" | "log" | "term";

interface Props {
  client: AgentdClient;
  onError: (msg: string) => void;
}

export function Tasks({ client, onError }: Props) {
  const tasksPoll = usePoll(
    () => client.listTasks(),
    { tasks: [] as Task[] },
    4000,
  );
  const tasks = tasksPoll.data.tasks;
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useMemo(() => tasks.find((t) => t.id === activeId) ?? null, [tasks, activeId]);

  return (
    <div className={`body${active ? " has-detail" : ""}`}>
      <aside className="left">
        <SpawnForm
          client={client}
          onError={onError}
          onSpawned={async (id) => {
            await tasksPoll.refresh();
            setActiveId(id);
          }}
        />
        <div className="list">
          {tasks.length === 0 ? (
            <div className="empty">No tasks yet.</div>
          ) : (
            tasks.map((t) => (
              <div
                key={t.id}
                className={`row${t.id === activeId ? " active" : ""}`}
                onClick={() => setActiveId(t.id)}
              >
                <div className="top">
                  <span className="agent">{t.agent}</span>
                  <span className={`status ${t.status}`}>{t.status}</span>
                </div>
                <div className="title">{t.title}</div>
                <div className="branch">{t.branch}</div>
                {(t.totalInputTokens || t.totalOutputTokens || t.totalCostUsd) && (
                  <div className="meta">
                    {(t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0)} tok
                    {t.totalCostUsd != null ? ` · $${t.totalCostUsd.toFixed(4)}` : ""}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </aside>
      <main className="right">
        {active ? (
          <TaskDetail
            client={client}
            task={active}
            onError={onError}
            onClose={() => setActiveId(null)}
            onTaskChanged={() => void tasksPoll.refresh()}
          />
        ) : (
          <div className="empty" style={{ margin: "auto" }}>
            Select or spawn a task.
          </div>
        )}
      </main>
    </div>
  );
}

function SpawnForm({
  client,
  onError,
  onSpawned,
}: {
  client: AgentdClient;
  onError: (m: string) => void;
  onSpawned: (id: string) => Promise<void>;
}) {
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [base, setBase] = useState("main");
  const [push, setPush] = useState(false);
  const [pr, setPr] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!repo || !prompt) {
      onError("repo and prompt required");
      return;
    }
    setBusy(true);
    try {
      const { task } = await client.createTask({
        agent,
        repoPath: repo,
        baseBranch: base || "main",
        prompt,
        ...(pr ? { autoPush: true, autoPr: true } : push ? { autoPush: true } : {}),
      });
      setPrompt("");
      await onSpawned(task.id);
    } catch (e) {
      onError(`spawn: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-form" onSubmit={submit}>
      <input
        placeholder="/path/to/git/repo"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        required
      />
      <div className="row">
        <select value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")}>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <input
          placeholder="base"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          style={{ width: 100 }}
        />
      </div>
      <textarea
        placeholder="What should the agent do?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        required
      />
      <div style={{ display: "flex", gap: 12 }}>
        <label className="toggle">
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
          push
        </label>
        <label className="toggle">
          <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} />
          PR
        </label>
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? "spawning…" : "spawn"}
      </button>
    </form>
  );
}

interface DetailProps {
  client: AgentdClient;
  task: Task;
  onError: (m: string) => void;
  onClose: () => void;
  onTaskChanged: () => void;
}

function TaskDetail({ client, task, onError, onClose, onTaskChanged }: DetailProps) {
  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);

  // load history when active task changes
  useEffect(() => {
    if (loaded === task.id) return;
    void (async () => {
      try {
        const { messages } = await client.getTask(task.id);
        setMessages(messages);
        setLoaded(task.id);
      } catch (e) {
        onError((e as Error).message);
      }
    })();
  }, [client, task.id, loaded, onError]);

  // subscribe to live events for the active task
  const handleEvent = useCallback(
    ({ event }: { taskId: string; event: AgentEvent; ts: number }) => {
      if (event.kind === "message") {
        appendLocal(event.role, event.text);
      } else if (event.kind === "tool_call") {
        appendLocal(
          "tool",
          `[call ${event.tool}] ${JSON.stringify(event.args).slice(0, 400)}`,
        );
      } else if (event.kind === "tool_result") {
        appendLocal(
          "tool",
          `[result ${event.tool}] ${event.ok ? "ok" : "err"}: ${String(event.output).slice(0, 400)}`,
        );
      } else if (event.kind === "raw") {
        appendLocal("system", event.text);
      } else if (event.kind === "status" || event.kind === "exit" || event.kind === "usage") {
        // bubble out so the header re-renders
        onTaskChanged();
      }
    },
    [onTaskChanged],
  );

  function appendLocal(role: Message["role"], content: string) {
    setMessages((prev) => [
      ...prev,
      { id: "tmp_" + Math.random(), taskId: task.id, role, content, ts: Date.now() },
    ]);
  }

  const { live } = useTaskStream(client, task.id, handleEvent);

  async function send(text: string) {
    if (!text.trim()) return;
    appendLocal("user", text);
    try {
      await client.sendInput(task.id, text);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function stop() {
    try {
      await client.stopTask(task.id);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function rm() {
    if (!confirm("Remove task and worktree?")) return;
    try {
      await client.removeTask(task.id);
      onClose();
      onTaskChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <>
      <header className="bar">
        <button className="back ghost" onClick={onClose}>
          ←
        </button>
        <div className="title">{task.title}</div>
        <span className={`conn${live ? " live" : ""}`}>{live ? "live" : "off"}</span>
        <span className="meta">
          {task.agent} · {task.status} · {task.branch}
        </span>
        {(task.totalInputTokens || task.totalOutputTokens) && (
          <span className="usage-pill">
            <span>in {task.totalInputTokens ?? 0}</span>
            <span>out {task.totalOutputTokens ?? 0}</span>
            {task.totalCostUsd != null && (
              <span className="cost">${task.totalCostUsd.toFixed(4)}</span>
            )}
          </span>
        )}
        {task.prUrl && (
          <a href={task.prUrl} target="_blank" rel="noreferrer">
            PR ↗
          </a>
        )}
        <button onClick={stop}>stop</button>
        <button className="danger" onClick={rm}>
          rm
        </button>
      </header>
      <nav className="tabs">
        {(["chat", "files", "diff", "log", "term"] as const).map((t) => (
          <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="content">
        {tab === "chat" && <ChatView messages={messages} onSend={send} />}
        {tab === "files" && <FilesView client={client} taskId={task.id} onError={onError} />}
        {tab === "diff" && <DiffView client={client} taskId={task.id} onError={onError} />}
        {tab === "log" && (
          <LogView client={client} taskId={task.id} onError={onError} />
        )}
        {tab === "term" && <Terminal taskId={task.id} onError={onError} />}
      </div>
    </>
  );
}

function ChatView({
  messages,
  onSend,
}: {
  messages: Message[];
  onSend: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }
  function submit() {
    onSend(text);
    setText("");
  }

  return (
    <>
      <div className="chat" ref={ref}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="body">{m.content}</div>
          </div>
        ))}
      </div>
      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Send input… (Cmd/Ctrl+Enter to send)"
          rows={2}
        />
        <button className="primary" type="submit">
          send
        </button>
      </form>
    </>
  );
}

function FilesView({
  client,
  taskId,
  onError,
}: {
  client: AgentdClient;
  taskId: string;
  onError: (m: string) => void;
}) {
  const filesPoll = usePoll(
    () => client.listFiles(taskId),
    { files: [] as string[] },
    8000,
  );
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");

  async function open(p: string) {
    try {
      const r = await client.getFile(taskId, p);
      setPath(p);
      setContent(r.content);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className={`files-pane${path ? " has-file" : ""}`}>
      <div className="file-tree">
        {filesPoll.data.files.length === 0 ? (
          <div className="empty">(loading)</div>
        ) : (
          filesPoll.data.files.map((f) => (
            <div
              key={f}
              className={`file${f === path ? " active" : ""}`}
              onClick={() => void open(f)}
            >
              {f}
            </div>
          ))
        )}
      </div>
      <div className="file-view">
        {path ? (
          <>
            <div className="header">
              <span style={{ flex: 1 }}>{path}</span>
              <button className="ghost" onClick={() => setPath(null)}>
                close
              </button>
            </div>
            <pre>{content}</pre>
          </>
        ) : (
          <div className="empty">Select a file</div>
        )}
      </div>
    </div>
  );
}

function DiffView({
  client,
  taskId,
  onError,
}: {
  client: AgentdClient;
  taskId: string;
  onError: (m: string) => void;
}) {
  const [diff, setDiff] = useState<{ stat: string; diff: string; baseRef: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await client.getDiff(taskId);
        if (!cancelled) setDiff(d);
      } catch (e) {
        if (!cancelled) onError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, taskId, onError]);

  if (!diff) return <div className="diff-pane empty">loading…</div>;
  return (
    <div className="diff-pane">
      <div style={{ color: "var(--muted)", marginBottom: 8 }}>vs {diff.baseRef}</div>
      <pre>
        {diff.stat ? <span>{diff.stat + "\n"}</span> : null}
        {colorDiff(diff.diff || "(no changes)")}
      </pre>
    </div>
  );
}

function colorDiff(text: string): React.ReactNode[] {
  return text.split("\n").map((line, i) => {
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    return (
      <span key={i} className={cls}>
        {line + "\n"}
      </span>
    );
  });
}

function LogView({
  client,
  taskId,
  onError,
}: {
  client: AgentdClient;
  taskId: string;
  onError: (m: string) => void;
}) {
  const logPoll = usePoll(
    () => client.getLog(taskId, 50),
    { log: [] as Awaited<ReturnType<typeof client.getLog>>["log"] },
    6000,
  );

  async function revert(sha: string) {
    if (!confirm(`Revert ${sha.slice(0, 7)}?`)) return;
    try {
      await client.revert(taskId, sha);
      await logPoll.refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  if (logPoll.data.log.length === 0) return <div className="log-pane empty">no commits</div>;
  return (
    <div className="log-pane">
      {logPoll.data.log.map((c) => (
        <div key={c.sha} className="commit">
          <div className="sha">
            {c.sha.slice(0, 12)} · {c.author} · {new Date(c.ts).toLocaleString()}
          </div>
          <div className="subject">{c.subject}</div>
          <div className="actions">
            <button onClick={() => void revert(c.sha)}>revert</button>
          </div>
        </div>
      ))}
    </div>
  );
}
