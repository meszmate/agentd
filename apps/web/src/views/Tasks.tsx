import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Task, Message, AgentEvent } from "@agentd/contracts";
import { useApp } from "../AppContext";
import {
  qk,
  useCreateTask,
  useDiff,
  useFile,
  useFiles,
  useLog,
  useRemoveTask,
  useRevertCommit,
  useSendInput,
  useStopTask,
  useTask,
  useTaskStream,
  useTasks,
} from "../queries";

// xterm.js is heavy (~73 KB gzipped) and only used for the terminal tab.
const Terminal = lazy(() => import("./Terminal").then((m) => ({ default: m.Terminal })));

type Tab = "chat" | "files" | "diff" | "log" | "term";

export function Tasks() {
  const { toast } = useApp();
  const onError = (m: string) => toast(m, true);
  const navigate = useNavigate();
  const { taskId: routeTaskId } = useParams<{ taskId: string }>();

  const tasksQ = useTasks();
  const tasks = tasksQ.data?.tasks ?? [];
  const active = useMemo(
    () => tasks.find((t) => t.id === routeTaskId) ?? null,
    [tasks, routeTaskId],
  );

  return (
    <div className={`body${active ? " has-detail" : ""}`}>
      <aside className="left">
        <SpawnForm
          onError={onError}
          onSpawned={(id) => navigate(`/tasks/${id}`)}
        />
        <div className="list">
          {tasks.length === 0 ? (
            <div className="empty">no tasks yet</div>
          ) : (
            tasks.map((t) => <TaskRow key={t.id} task={t} />)
          )}
        </div>
      </aside>
      <main className="right">
        {active ? (
          <TaskDetail
            task={active}
            onError={onError}
            onClose={() => navigate("/tasks")}
          />
        ) : (
          <div className="empty" style={{ margin: "auto" }}>
            select or spawn a task
          </div>
        )}
      </main>
    </div>
  );
}

function TaskRow({ task: t }: { task: Task }) {
  return (
    <NavLink
      to={`/tasks/${t.id}`}
      className={({ isActive }) => `row${isActive ? " active" : ""}`}
    >
      <div className="top">
        <span className="agent">{t.agent}</span>
        <span className="id">
          <strong>{t.id.slice(-8)}</strong>
        </span>
        <span className={`status ${t.status}`}>{t.status}</span>
      </div>
      <div className="title">{t.title}</div>
      <div className="branch">{t.branch}</div>
      {(t.totalInputTokens || t.totalOutputTokens || t.totalCostUsd) ? (
        <div className="meta">
          {(t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0)} tok
          {t.totalCostUsd != null ? ` · $${t.totalCostUsd.toFixed(4)}` : ""}
        </div>
      ) : null}
    </NavLink>
  );
}

function SpawnForm({
  onError,
  onSpawned,
}: {
  onError: (m: string) => void;
  onSpawned: (id: string) => void;
}) {
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [base, setBase] = useState("main");
  const [push, setPush] = useState(false);
  const [pr, setPr] = useState(false);
  const [prompt, setPrompt] = useState("");
  const create = useCreateTask();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!repo || !prompt) {
      onError("repo and prompt required");
      return;
    }
    try {
      const { task } = await create.mutateAsync({
        agent,
        repoPath: repo,
        baseBranch: base || "main",
        prompt,
        ...(pr ? { autoPush: true, autoPr: true } : push ? { autoPush: true } : {}),
      });
      setPrompt("");
      onSpawned(task.id);
    } catch (e) {
      onError(`spawn: ${(e as Error).message}`);
    }
  }

  return (
    <form className="spawn" onSubmit={submit}>
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
        placeholder="what should the agent do?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        required
        rows={3}
      />
      <div className="toggles">
        <label>
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
          auto-push
        </label>
        <label>
          <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} />
          auto-pr
        </label>
      </div>
      <button className="primary" type="submit" disabled={create.isPending}>
        {create.isPending ? "spawning…" : "› SPAWN"}
      </button>
    </form>
  );
}

interface DetailProps {
  task: Task;
  onError: (m: string) => void;
  onClose: () => void;
}

function TaskDetail({ task, onError, onClose }: DetailProps) {
  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const taskQ = useTask(task.id);
  const stop = useStopTask(task.id);
  const remove = useRemoveTask();
  const qc = useQueryClient();
  void taskQ; // hydrate-once via useEffect below; query stays subscribed

  // Hydrate the message list from the persisted history when the active task
  // changes; subsequent live events just append.
  useEffect(() => {
    if (loadedFor === task.id) return;
    if (!taskQ.data) return;
    setMessages(taskQ.data.messages);
    setLoadedFor(task.id);
  }, [task.id, taskQ.data, loadedFor]);

  const handleEvent = useCallback(
    ({ event, taskId: evTaskId }: { taskId: string; event: AgentEvent; ts: number }) => {
      if (evTaskId !== task.id) return;
      if (event.kind === "message") {
        appendLocal(event.role, event.text);
      } else if (event.kind === "tool_call") {
        appendLocal("tool", `[${event.tool}] ${JSON.stringify(event.args).slice(0, 400)}`);
      } else if (event.kind === "tool_result") {
        appendLocal(
          "tool",
          `[${event.tool}] ${event.ok ? "ok" : "err"}: ${String(event.output).slice(0, 400)}`,
        );
      } else if (event.kind === "raw") {
        appendLocal("system", event.text);
      } else if (event.kind === "status" || event.kind === "exit" || event.kind === "usage") {
        // server-side state changed; refetch the task list + this task summary
        void qc.invalidateQueries({ queryKey: qk.tasks() });
        void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      }
    },
    [task.id, qc],
  );

  function appendLocal(role: Message["role"], content: string) {
    setMessages((prev) => [
      ...prev,
      { id: "tmp_" + Math.random(), taskId: task.id, role, content, ts: Date.now() },
    ]);
  }

  const { live } = useTaskStream(task.id, handleEvent);

  return (
    <>
      <header className="detail-head">
        <div className="top">
          <button className="back" onClick={onClose}>
            ←
          </button>
          <h2>{task.title}</h2>
          <span className={`chip${live ? " live" : ""}`}>{live ? "live" : "off"}</span>
          <div className="actions">
            {task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                <button>↗ PR</button>
              </a>
            )}
            <button onClick={() => stop.mutate()} disabled={stop.isPending}>
              stop
            </button>
            <button
              className="danger"
              onClick={async () => {
                if (!confirm("Remove task and worktree?")) return;
                await remove.mutateAsync(task.id);
                onClose();
              }}
            >
              rm
            </button>
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <div className={`v ${statusColor(task.status)}`}>{task.status}</div>
            <div className="l">status</div>
          </div>
          <div className="stat">
            <div className="v">{task.agent}</div>
            <div className="l">agent</div>
          </div>
          <div className="stat">
            <div className="v" style={{ fontSize: 13, fontWeight: 500 }}>{task.branch}</div>
            <div className="l">branch</div>
          </div>
          {(task.totalInputTokens != null || task.totalOutputTokens != null) && (
            <div className="stat">
              <div className="v">
                {((task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0)).toLocaleString()}
              </div>
              <div className="l">tokens</div>
            </div>
          )}
          {task.totalCostUsd != null && (
            <div className="stat">
              <div className="v red">${task.totalCostUsd.toFixed(4)}</div>
              <div className="l">cost</div>
            </div>
          )}
          <div className="stat">
            <div className="v" style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-mute)" }}>
              {task.id.slice(-12)}
            </div>
            <div className="l">id</div>
          </div>
        </div>
      </header>
      <nav className="tabs">
        {(["chat", "files", "diff", "log", "term"] as const).map((t) => (
          <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="content fade-in">
        {tab === "chat" && (
          <ChatView messages={messages} taskId={task.id} onError={onError} appendLocal={appendLocal} />
        )}
        {tab === "files" && <FilesView taskId={task.id} onError={onError} />}
        {tab === "diff" && <DiffView taskId={task.id} />}
        {tab === "log" && <LogView taskId={task.id} onError={onError} />}
        {tab === "term" && (
          <Suspense fallback={<div className="empty">loading terminal…</div>}>
            <Terminal taskId={task.id} onError={onError} />
          </Suspense>
        )}
      </div>
    </>
  );
}

function statusColor(s: string): string {
  if (s === "done") return "ok";
  if (s === "running") return "warn";
  if (s === "failed" || s === "stopped") return "red";
  return "";
}

function ChatView({
  messages,
  taskId,
  onError,
  appendLocal,
}: {
  messages: Message[];
  taskId: string;
  onError: (m: string) => void;
  appendLocal: (role: Message["role"], content: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const send = useSendInput(taskId);

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
  async function submit() {
    if (!text.trim()) return;
    const msg = text;
    setText("");
    appendLocal("user", msg);
    try {
      await send.mutateAsync(msg);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <>
      <div
        className="chat"
        ref={ref}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation"
      >
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="role" aria-hidden="true">
              {m.role}
            </div>
            <div className="body">
              <span className="sr-only">{m.role}: </span>
              {m.content}
            </div>
          </div>
        ))}
      </div>
      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-label="Send input to agent"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder="send input…  ⌘/ctrl + ↵ to send"
          rows={2}
          aria-label="Message"
        />
        <button className="primary" type="submit" disabled={send.isPending}>
          send
        </button>
      </form>
    </>
  );
}

function FilesView({ taskId, onError }: { taskId: string; onError: (m: string) => void }) {
  const filesQ = useFiles(taskId);
  const [path, setPath] = useState<string | null>(null);
  const fileQ = useFile(taskId, path);

  useEffect(() => {
    if (fileQ.error) onError((fileQ.error as Error).message);
  }, [fileQ.error, onError]);

  return (
    <div className={`files-pane${path ? " has-file" : ""}`}>
      <div className="file-tree">
        {!filesQ.data ? (
          <div className="empty">loading…</div>
        ) : filesQ.data.files.length === 0 ? (
          <div className="empty">no files</div>
        ) : (
          filesQ.data.files.map((f) => (
            <div
              key={f}
              className={`file${f === path ? " active" : ""}`}
              onClick={() => setPath(f)}
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
            <pre>{fileQ.data?.content ?? "loading…"}</pre>
          </>
        ) : (
          <div className="empty">select a file</div>
        )}
      </div>
    </div>
  );
}

function DiffView({ taskId }: { taskId: string }) {
  const diffQ = useDiff(taskId);
  if (!diffQ.data) return <div className="diff-pane empty">loading…</div>;
  return (
    <div className="diff-pane">
      <div style={{ color: "var(--ink-mute)", marginBottom: 12, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        vs <code>{diffQ.data.baseRef}</code>
      </div>
      <pre>
        {diffQ.data.stat ? <span>{diffQ.data.stat + "\n"}</span> : null}
        {colorDiff(diffQ.data.diff || "(no changes)")}
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

function LogView({ taskId, onError }: { taskId: string; onError: (m: string) => void }) {
  const logQ = useLog(taskId);
  const revert = useRevertCommit(taskId);

  async function doRevert(sha: string) {
    if (!confirm(`Revert ${sha.slice(0, 7)}?`)) return;
    try {
      await revert.mutateAsync(sha);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  if (!logQ.data) return <div className="log-pane empty">loading…</div>;
  if (logQ.data.log.length === 0) return <div className="log-pane empty">no commits</div>;
  return (
    <div className="log-pane">
      {logQ.data.log.map((c) => (
        <div key={c.sha} className="commit">
          <div>
            <div className="sha">{c.sha.slice(0, 7)}</div>
          </div>
          <div className="body">
            <div className="subject">{c.subject}</div>
            <div className="meta">
              {c.author} · {new Date(c.ts).toLocaleString()}
            </div>
          </div>
          <div>
            <button onClick={() => void doRevert(c.sha)} disabled={revert.isPending}>
              revert
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
