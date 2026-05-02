import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AgentEvent,
  Task,
  TaskStatus,
  TerminalSession,
  TerminalWindow,
  WsServerEvent,
} from "@agentd/contracts";
import { useApp } from "@/AppContext";
import { qk } from "@/queries";
import { useStore } from "@/store";
import type { Project } from "@agentd/contracts";

/**
 * Realtime bus.
 *
 * Single shared WS subscription that any component can read from. Surfaces:
 *   - `live`: the WS connection state
 *   - `pulses[taskId]`: a transient timestamp set by every event for that
 *      task — components use it to flash dots, blink rows, etc.
 *   - `recent`: bounded list of human-readable activity entries
 *   - `latest`: the most recent activity entry (cheap subscribe for sidebar
 *     ticker)
 *
 * The bus also invalidates TanStack queries on status / exit / usage events
 * so list views automatically refresh without polling.
 */

export interface RtEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  taskAgent: string;
  text: string;
  kind: AgentEvent["kind"];
  status?: TaskStatus;
  ts: number;
}

export type RtStatus = "connecting" | "live" | "reconnecting";

interface RtState {
  /** Tri-state: have we ever connected? are we trying again? */
  status: RtStatus;
  /** Convenience boolean — true only when status === "live". */
  live: boolean;
  recent: RtEntry[];
  pulses: Record<string, number>;
  latest: RtEntry | null;
  lastStatusChange: Record<
    string,
    { status: TaskStatus; ts: number } | undefined
  >;
}

interface RtContext extends RtState {
  /** subscribe-only — components shouldn't push. */
}

const Ctx = createContext<RtContext | null>(null);
const RECENT_CAP = 80;

function describe(ev: AgentEvent): string | null {
  switch (ev.kind) {
    case "message": {
      const t = (ev.text || "").replace(/\s+/g, " ").trim();
      return t.length > 140 ? t.slice(0, 137) + "…" : t;
    }
    case "tool_call":
      return `→ ${ev.tool}`;
    case "tool_result":
      return `← ${ev.tool} ${ev.ok ? "ok" : "err"}`;
    case "permission_request":
      return `${ev.tool} · awaiting decision`;
    case "status":
      return `status → ${ev.status}`;
    case "exit":
      return `exited code=${ev.code ?? "?"}`;
    case "usage":
      return `${(ev.inputTokens ?? 0) + (ev.outputTokens ?? 0)} tok`;
    case "raw":
      return ev.text.slice(0, 140);
    case "progress":
      return `${ev.done ? "✓ done · " : "↻ "}${ev.text.slice(0, 140)}`;
    case "share":
      return `💭 ${ev.text.slice(0, 140)}`;
    case "ask":
      return `❓ ${ev.prompt.slice(0, 140)}`;
    case "answer":
      return `↳ ${ev.answer.slice(0, 140)}`;
    // Streaming partials are too noisy for the activity ticker — drop them.
    case "message_delta":
    case "message_end":
    case "todos_updated":
      return null;
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { client, logout, toast } = useApp();
  const qc = useQueryClient();

  const [status, setStatus] = useState<RtStatus>("connecting");
  const [recent, setRecent] = useState<RtEntry[]>([]);
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const [lastStatusChange, setLastStatusChange] = useState<
    Record<string, { status: TaskStatus; ts: number } | undefined>
  >({});

  // Title cache — populated from cached tasks list.
  const titleCache = useRef(new Map<string, { title: string; agent: string }>());

  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const data = qc.getQueryData<{ tasks: Task[] }>(qk.tasks());
      if (!data?.tasks) return;
      const m = titleCache.current;
      for (const t of data.tasks) m.set(t.id, { title: t.title, agent: t.agent });
    });
    return () => unsub();
  }, [qc]);

  useEffect(() => {
    if (!client) {
      setStatus("connecting");
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let everConnected = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let openedAt = 0;
    let consecutiveFastFails = 0;
    setStatus("connecting");

    const open = () => {
      console.log("[rt] opening WS to", client.baseUrl);
      openedAt = Date.now();
      ws = client.watch(null, (msg: WsServerEvent) => {
        if (msg.type === "hello") {
          console.log("[rt] hello", msg);
          return;
        }
        if (msg.type === "task_updated") {
          // Push the fresh task into the cached list and pulse it.
          const cur =
            qc.getQueryData<{ tasks: Task[] }>(qk.tasks())?.tasks ?? [];
          const next = cur.map((t) =>
            t.id === msg.task.id ? msg.task : t,
          );
          const wasNew = !cur.find((t) => t.id === msg.task.id);
          if (wasNew) next.unshift(msg.task);
          qc.setQueryData(qk.tasks(), { tasks: next });
          setPulses((p) => ({ ...p, [msg.task.id]: Date.now() }));
          setLastStatusChange((cur2) => ({
            ...cur2,
            [msg.task.id]: { status: msg.task.status, ts: Date.now() },
          }));

          // Update the projects cache without refetching: derive new
          // taskCount + activeCount from `next`, bump lastActiveAt.
          if (msg.task.projectId) {
            const cachedProjects = qc.getQueryData<{ projects: Project[] }>(
              qk.projects(),
            )?.projects;
            if (cachedProjects) {
              const knownProject = cachedProjects.find(
                (p) => p.id === msg.task.projectId,
              );
              if (knownProject) {
                let total = 0;
                let active = 0;
                for (const t of next) {
                  if (t.projectId !== msg.task.projectId) continue;
                  total += 1;
                  if (
                    t.status === "running" ||
                    t.status === "waiting_input" ||
                    t.status === "waiting_perm" ||
                    t.status === "pending"
                  ) {
                    active += 1;
                  }
                }
                qc.setQueryData(qk.projects(), {
                  projects: cachedProjects.map((p) =>
                    p.id === msg.task.projectId
                      ? {
                          ...p,
                          taskCount: total,
                          activeCount: active,
                          lastActiveAt: Date.now(),
                        }
                      : p,
                  ),
                });
              } else {
                // Brand new project — single fetch to learn its name/color.
                void qc.invalidateQueries({ queryKey: qk.projects() });
              }
            }

            useStore.getState().bumpUnread(msg.task.projectId);
          }
          return;
        }
        if (msg.type === "terminal_sessions") {
          qc.setQueryData<{ sessions: TerminalSession[] }>(
            ["terminal", "sessions"],
            { sessions: msg.sessions },
          );
          return;
        }
        if (msg.type === "terminal_windows") {
          qc.setQueryData<{ windows: TerminalWindow[] }>(
            ["terminal", "sessions", msg.sessionName, "windows"],
            { windows: msg.windows },
          );
          return;
        }
        if (msg.type !== "event") return;
        const summary = describe(msg.event);
        if (summary == null) {
          // Streaming partials still bump the pulse so the row glows, but
          // they don't enter the recent-events ticker (too noisy).
          setPulses((p) => ({ ...p, [msg.taskId]: msg.ts }));
          return;
        }
        const meta = titleCache.current.get(msg.taskId);
        const entry: RtEntry = {
          id: `${msg.taskId}-${msg.ts}-${Math.random().toString(36).slice(2, 6)}`,
          taskId: msg.taskId,
          taskTitle: meta?.title ?? "task",
          taskAgent: meta?.agent ?? "",
          text: summary,
          kind: msg.event.kind,
          status: msg.event.kind === "status" ? msg.event.status : undefined,
          ts: msg.ts,
        };
        setRecent((prev) => [entry, ...prev].slice(0, RECENT_CAP));
        setPulses((p) => ({ ...p, [msg.taskId]: msg.ts }));

        // Bump unread on the parent project for any meaningful event kind.
        if (
          msg.event.kind === "message" ||
          msg.event.kind === "status" ||
          msg.event.kind === "exit" ||
          msg.event.kind === "permission_request"
        ) {
          const cached =
            qc.getQueryData<{ tasks: Task[] }>(qk.tasks())?.tasks ?? [];
          const owner = cached.find((t) => t.id === msg.taskId);
          if (owner?.projectId) {
            useStore.getState().bumpUnread(owner.projectId);
          }
        }

        if (msg.event.kind === "status") {
          const st = msg.event.status;
          setLastStatusChange((cur) => ({
            ...cur,
            [msg.taskId]: { status: st, ts: msg.ts },
          }));
        }

        // No invalidation needed: the server now follows up these events
        // with a `task_updated` push that updates the cache directly.
        // Per-task detail (qk.task) is only fetched on first open and stays
        // hydrated by the messages we append locally.

        // Todos are the exception — the runner mirrors TodoWrite into the
        // todos table and emits this signal so the right-side panel
        // refreshes without polling.
        if (msg.event.kind === "todos_updated") {
          void qc.invalidateQueries({ queryKey: ["todos"] });
        }
      });
      ws.addEventListener("open", () => {
        console.log("[rt] WS open");
        everConnected = true;
        consecutiveFastFails = 0;
        setStatus("live");
      });
      ws.addEventListener("close", (ev) => {
        const liveFor = Date.now() - openedAt;
        console.warn("[rt] WS close", {
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
          liveFor,
        });
        if (closed) return;
        // Closed before ever opening, repeatedly: almost always a 401 from
        // the upgrade. Force re-pair after a few attempts so we don't get
        // stuck on "connecting…" forever.
        if (!everConnected && liveFor < 1500) {
          consecutiveFastFails += 1;
          if (consecutiveFastFails >= 3) {
            closed = true;
            toast(
              "Realtime connection rejected — token expired or daemon restarted. Please pair again.",
              true,
            );
            logout();
            return;
          }
        }
        setStatus(everConnected ? "reconnecting" : "connecting");
        reconnectTimer = setTimeout(open, 2000);
      });
      ws.addEventListener("error", (ev) => {
        console.error("[rt] WS error", ev);
        if (closed) return;
        setStatus(everConnected ? "reconnecting" : "connecting");
      });
    };
    open();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
    };
  }, [client, qc, logout, toast]);

  const latest = recent.length > 0 ? recent[0]! : null;
  const live = status === "live";

  const value = useMemo<RtContext>(
    () => ({ status, live, recent, pulses, latest, lastStatusChange }),
    [status, live, recent, pulses, latest, lastStatusChange],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RtContext {
  const v = useContext(Ctx);
  if (!v) {
    return {
      status: "connecting",
      live: false,
      recent: [],
      pulses: {},
      latest: null,
      lastStatusChange: {},
    };
  }
  return v;
}

/** Returns true if `taskId` had any event in the last `windowMs` ms. */
export function useRecentPulse(taskId: string, windowMs = 1500): boolean {
  const { pulses } = useRealtime();
  const ts = pulses[taskId];
  const [hot, setHot] = useState(false);

  useEffect(() => {
    if (!ts) return;
    const age = Date.now() - ts;
    if (age >= windowMs) {
      setHot(false);
      return;
    }
    setHot(true);
    const t = window.setTimeout(() => setHot(false), windowMs - age);
    return () => window.clearTimeout(t);
  }, [ts, windowMs]);

  return hot;
}

/**
 * Pull `useRealtime()` into a callback — used by components that want to
 * react when a new event arrives, but don't want to re-render on every pulse
 * tick.
 */
export function useOnRtEvent(cb: (entry: RtEntry) => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const { latest } = useRealtime();
  useEffect(() => {
    if (latest) cbRef.current(latest);
  }, [latest]);
}
