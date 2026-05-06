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
  Message,
  ProviderRateLimit,
  Task,
  TaskStatus,
  TerminalSession,
  TerminalWindow,
  WsServerEvent,
} from "@agentd/contracts";
import { useApp } from "@/AppContext";
import { qk } from "@/queries";
import { useStore } from "@/store";
import { parsePlanFromTool, shapeMessageFromEvent } from "@/lib/agent-event";
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
  /**
   * Task this event belongs to. Empty string for project-scoped
   * events that aren't attached to any task — brainstorm
   * suggestions, plan-it results, etc. Renderers should fall back
   * to `projectId` / `projectSlug` for those.
   */
  taskId: string;
  taskTitle: string;
  taskAgent: string;
  text: string;
  kind: AgentEvent["kind"] | "suggestion";
  status?: TaskStatus;
  ts: number;
  /** Set on project-scoped entries (brainstorm, plan-it). */
  projectId?: string;
  projectSlug?: string;
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
  /**
   * Per-task latest meaningful event — used by the sidebar to show
   * "what is task X doing right now" (active tool, last progress
   * note, current in-progress thought). Skips low-signal events like
   * usage / message_delta so the line doesn't jitter on every token.
   */
  latestByTask: Record<string, RtEntry | undefined>;
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

// Tools that don't mutate the worktree — invalidating files/git/log on
// these would just trigger a re-fetch storm during a long agent turn
// where the agent is reading dozens of files. Anything not in this set
// (Edit/Write/Bash/MultiEdit/etc.) is treated as potentially mutating.
const READONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "ReadNotebook",
  "TodoWrite",
  "ExitPlanMode",
  "ToolSearch",
]);

/**
 * Idempotently append a live-shaped Message into the qk.task(id).messages
 * cache. Same-shape rows that landed within a 2s window are treated as
 * duplicates so a refetch (which returns the proper `msg_…` ids) doesn't
 * leave the live `live_…` row beside its persisted twin. Cache is left
 * untouched if the task detail hasn't been opened yet — the next mount
 * will fetch the persisted history fresh.
 */
function appendMessageToCache(
  qc: ReturnType<typeof useQueryClient>,
  taskId: string,
  shaped: Message,
): void {
  qc.setQueryData(qk.task(taskId), (cur: unknown) => {
    const prev = cur as
      | { task: Task; messages: Message[] }
      | undefined;
    if (!prev || !prev.task) return cur;
    const dup = prev.messages.some(
      (m) =>
        m.role === shaped.role &&
        m.content === shaped.content &&
        Math.abs(m.ts - shaped.ts) < 2_000,
    );
    if (dup) return prev;
    return { ...prev, messages: [...prev.messages, shaped] };
  });
}

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
    case "rate_limit":
      // Account-wide event — already drives the global header chip.
      // Rendering it once per session in the activity ticker would
      // crowd the per-task signal without telling the operator
      // anything they don't already see.
      return null;
    case "auto_compacted":
      return ev.preTokens
        ? `✂ compacted · ${ev.preTokens.toLocaleString()} tokens`
        : "✂ compacted";
    // Streaming partials are too noisy for the activity ticker — drop them.
    case "message_delta":
    case "message_end":
    case "todos_updated":
    case "queue_updated":
      return null;
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { client, logout, toast } = useApp();
  const qc = useQueryClient();

  const [status, setStatus] = useState<RtStatus>("connecting");
  const [recent, setRecent] = useState<RtEntry[]>([]);
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const [latestByTask, setLatestByTask] = useState<
    Record<string, RtEntry | undefined>
  >({});
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
    let helloCount = 0;
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
          helloCount += 1;
          // The bus is in-memory — events between WS disconnect and
          // reconnect aren't replayed. After a reconnect, anything
          // the daemon mutated while we were gone (a chained slice
          // spawning, a steered task moving status, a project being
          // created from a brainstorm) is missing from our caches.
          // Invalidate the queries the sidebar reads from so they
          // refetch and pick up any drift. Skip on the very first
          // hello — the initial mount already triggered fresh fetches.
          if (helloCount > 1) {
            void qc.invalidateQueries({ queryKey: qk.tasks() });
            void qc.invalidateQueries({ queryKey: qk.projects() });
            void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
            void qc.invalidateQueries({ queryKey: qk.bridgeSummary() });
            // Any task page that was already open during the disconnect
            // is missing the messages the daemon emitted while we were
            // gone. We've been patching qk.task(*).messages on every
            // live event below, but events between WS close and reopen
            // never arrived. Refetch every cached task detail so the
            // chat history catches up before the operator notices.
            void qc.invalidateQueries({ queryKey: ["task"] });
          }
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
          qc.setQueryData(qk.task(msg.task.id), (curTask: unknown) => {
            const prev = curTask as
              | { task: Task; messages: unknown[] }
              | undefined;
            return prev ? { ...prev, task: msg.task } : prev;
          });
          void qc.invalidateQueries({ queryKey: ["taskContext", msg.task.id] });
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
        if (msg.type === "task_removed") {
          // Drop the task from any cached list so every connected
          // surface (sidebar, project view) reflects the deletion
          // without a polling round-trip.
          const cur =
            qc.getQueryData<{ tasks: Task[] }>(qk.tasks())?.tasks ?? [];
          const removed = cur.find((t) => t.id === msg.taskId);
          if (removed) {
            qc.setQueryData(qk.tasks(), {
              tasks: cur.filter((t) => t.id !== msg.taskId),
            });
          }
          if (removed?.projectId) {
            const cachedProjects = qc.getQueryData<{ projects: Project[] }>(
              qk.projects(),
            )?.projects;
            if (cachedProjects) {
              const remaining = cur.filter(
                (t) => t.id !== msg.taskId,
              );
              let total = 0;
              let active = 0;
              for (const t of remaining) {
                if (t.projectId !== removed.projectId) continue;
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
                  p.id === removed.projectId
                    ? { ...p, taskCount: total, activeCount: active }
                    : p,
                ),
              });
            }
          }
          qc.removeQueries({ queryKey: qk.task(msg.taskId) });
          return;
        }
        if (msg.type === "project_updated" || msg.type === "project_created") {
          const cached =
            qc.getQueryData<{ projects: Project[] }>(qk.projects())
              ?.projects ?? [];
          const found = cached.find((p) => p.id === msg.project.id);
          if (found) {
            qc.setQueryData(qk.projects(), {
              projects: cached.map((p) =>
                p.id === msg.project.id ? { ...p, ...msg.project } : p,
              ),
            });
          } else {
            qc.setQueryData(qk.projects(), {
              projects: [msg.project, ...cached],
            });
          }
          // Also patch the per-project detail cache so views opened on
          // /projects/<slug> pick up the change without a refetch. The
          // detail page is keyed by slug, but callers sometimes mutate
          // by id — write both to be safe.
          const detailPayload = { project: msg.project };
          qc.setQueryData(qk.project(msg.project.slug), detailPayload);
          qc.setQueryData(qk.project(msg.project.id), detailPayload);
          return;
        }
        if (msg.type === "project_removed") {
          const cached =
            qc.getQueryData<{ projects: Project[] }>(qk.projects())
              ?.projects ?? [];
          qc.setQueryData(qk.projects(), {
            projects: cached.filter((p) => p.id !== msg.projectId),
          });
          return;
        }
        if (
          msg.type === "suggestion_created" ||
          msg.type === "suggestion_updated"
        ) {
          // Refresh whichever project's idea factory just got new
          // input. Broad invalidation since one project's panel
          // might be open while a different surface (chat) is
          // resolving an older suggestion at the same time.
          void qc.invalidateQueries({ queryKey: ["project-suggestions"] });
          // Surface brainstorm activity in the same channels that
          // task events use — recent ticker at the bottom of the
          // sidebar AND the per-project pulse + unread counter.
          // Project gets a synthetic RtEntry whose taskId is empty
          // and `projectId/projectSlug` carry the link target.
          const sug = msg.suggestion;
          if (sug.projectId) {
            const cachedProjects = qc.getQueryData<{ projects: Project[] }>(
              qk.projects(),
            )?.projects;
            const project = cachedProjects?.find((p) => p.id === sug.projectId);
            const slug = project?.slug ?? sug.projectId;
            const isCreate = msg.type === "suggestion_created";
            const ts = msg.ts ?? Date.now();
            const text = isCreate
              ? `💡 brainstormed · ${sug.title}`
              : `↳ ${sug.title}`;
            const entry: RtEntry = {
              id: `sug-${sug.id}-${ts}`,
              taskId: "",
              taskTitle: project?.name ?? "Brainstorm",
              taskAgent: "claude",
              text,
              kind: "suggestion",
              ts,
              projectId: sug.projectId,
              projectSlug: slug,
            };
            setRecent((r) => [entry, ...r].slice(0, RECENT_CAP));
            setPulses((p) => ({
              ...p,
              [`proj:${sug.projectId}`]: ts,
            }));
            if (isCreate) {
              useStore.getState().bumpUnread(sug.projectId);
            }
          }
          return;
        }
        if (msg.type === "plugin_delivery") {
          // Refresh the bridge summary so per-project counters tick up
          // live without polling. Cheap — single endpoint.
          void qc.invalidateQueries({ queryKey: qk.bridgeSummary() });
          return;
        }
        if (msg.type === "discord_channels_updated") {
          void qc.invalidateQueries({ queryKey: qk.discordChannels() });
          void qc.invalidateQueries({ queryKey: qk.bridgeSummary() });
          return;
        }
        if (
          msg.type === "saved_idea_changed" ||
          msg.type === "saved_idea_removed"
        ) {
          // Cross-device sync — every connected client refreshes the
          // saved-ideas list (project-scoped) + the per-idea query
          // (idea + messages). The brainstorm view's idea-mode
          // convos hydrate from this so every device sees the same
          // active drafts and conversation history.
          void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
          void qc.invalidateQueries({ queryKey: qk.idea(msg.ideaId) });
          if (msg.type === "saved_idea_removed") {
            qc.removeQueries({ queryKey: qk.idea(msg.ideaId) });
            qc.removeQueries({ queryKey: qk.ideaActiveTurn(msg.ideaId) });
          }
          return;
        }
        if (msg.type === "idea_turn") {
          // Patch the active-turn snapshot cache so any open workshop
          // surface follows the helper's progress live without holding
          // open the original streaming HTTP request. `turn: null` =
          // the turn ended (the persisted message + plan land via
          // `saved_idea_changed`).
          qc.setQueryData(qk.ideaActiveTurn(msg.ideaId), {
            turn: msg.turn,
          });
          return;
        }
        if (msg.type === "models_changed") {
          // Codex's cache file or the operator's config.json was
          // rewritten. Drop the registry cache so the next picker
          // open re-pulls from the daemon (which re-reads the
          // sources fresh). No polling, no buttons.
          void qc.invalidateQueries({ queryKey: ["models"] });
          return;
        }
        if (msg.type === "github_refreshed") {
          // Project's GitHub state shifted — issue/PR list refresh,
          // spawn, PR action completed, status probe re-ran. Web
          // refetches every project-scoped github query so every
          // connected client picks up the new state without polling.
          void qc.invalidateQueries({
            queryKey: ["github", "issues", msg.projectId],
          });
          void qc.invalidateQueries({
            queryKey: ["github", "prs", msg.projectId],
          });
          // Detail panels (single issue/PR) too — a PR action that
          // posted a comment/review should refresh the open detail.
          void qc.invalidateQueries({
            queryKey: ["github", "issue", msg.projectId],
          });
          void qc.invalidateQueries({
            queryKey: ["github", "pr", msg.projectId],
          });
          // Project itself may have had `githubRepo` cached in this
          // tick — invalidate the project queries so the GitHub link
          // reflects the resolved owner/repo.
          void qc.invalidateQueries({ queryKey: ["project", msg.projectId] });
          return;
        }
        if (
          msg.type === "discord_test_send" ||
          msg.type === "discord_create_thread" ||
          msg.type === "discord_archive_thread"
        ) {
          // Web ignores these — they're meant for the discord subprocess.
          return;
        }
        if (msg.type === "provider_rate_limit_updated") {
          // Replace the entry for this provider in the cached list,
          // appending if it's the first time we've seen it. Falling
          // back to invalidate is fine but the patch is one ms and
          // keeps the chip from flickering while react-query refetches.
          qc.setQueryData<{ rateLimits: ProviderRateLimit[] }>(
            qk.rateLimits(),
            (prev) => {
              const next = prev?.rateLimits ? [...prev.rateLimits] : [];
              const i = next.findIndex(
                (r) => r.provider === msg.rateLimit.provider,
              );
              if (i >= 0) next[i] = msg.rateLimit;
              else next.push(msg.rateLimit);
              return { rateLimits: next };
            },
          );
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
        // Patch the per-task message cache the moment a message-shaped
        // event lands. The daemon already wrote the row to SQLite (see
        // taskManager.ts handleEvent), so the cache stays in lockstep
        // with the server. Without this, the cache only refreshed on
        // terminal events (idle/done/exit), which meant tab-switching
        // away mid-turn and back showed an empty chat for a refetch
        // round-trip — the bug operators called "loads from nothing".
        const shaped = shapeMessageFromEvent(msg.event, msg.ts, msg.taskId);
        if (shaped) appendMessageToCache(qc, msg.taskId, shaped);

        // Per-task derived realtime state lives in zustand so it survives
        // the TaskDetail unmount/remount that happens on any route change.
        const store = useStore.getState();
        if (msg.event.kind === "message_delta") {
          store.appendStreamDelta(msg.taskId, msg.event.streamId, msg.event.delta);
        } else if (msg.event.kind === "message_end") {
          store.endStream(msg.taskId, msg.event.streamId);
        } else if (msg.event.kind === "tool_call") {
          const planItems = parsePlanFromTool(msg.event.tool, msg.event.args);
          if (planItems) {
            store.setTaskPlan(msg.taskId, planItems);
            store.setTaskHint(
              msg.taskId,
              `✓ plan · ${planItems.length} item${planItems.length === 1 ? "" : "s"}`,
            );
          } else {
            store.setTaskHint(msg.taskId, `→ ${msg.event.tool}`);
          }
        } else if (msg.event.kind === "tool_result") {
          // Result lands; let the next tool_call (or status flip) overwrite
          // the hint. Don't proactively clear here — claude often emits a
          // back-to-back call+result within ~10ms which would flicker.
        } else if (msg.event.kind === "status") {
          if (msg.event.status === "running") {
            store.beginTaskTurn(msg.taskId);
          } else {
            store.endTaskTurn(msg.taskId);
          }
        } else if (msg.event.kind === "exit") {
          store.endTaskTurn(msg.taskId);
        } else if (msg.event.kind === "usage") {
          const delta =
            (msg.event.inputTokens ?? 0) +
            (msg.event.outputTokens ?? 0) +
            (msg.event.cacheReadTokens ?? 0) +
            (msg.event.cacheWriteTokens ?? 0);
          if (delta > 0) store.addTaskUsage(msg.taskId, delta);
        } else if (msg.event.kind === "message") {
          // Final committed text lands — drop any matching streaming
          // bubble (same task) so the timeline doesn't double-render the
          // text. Streams are keyed by streamId which we don't see here,
          // so flush all open streams; another delta will rebuild one if
          // the agent starts a new content block.
          const cur = useStore.getState().taskRt[msg.taskId];
          if (cur && Object.keys(cur.streams).length > 0) {
            for (const sid of Object.keys(cur.streams)) {
              store.endStream(msg.taskId, sid);
            }
          }
          store.setTaskHint(msg.taskId, null);
        }

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
        // Per-task "currently doing" line for the sidebar. Only
        // capture meaningful events — skip raw streaming token
        // deltas / usage so the line doesn't jitter every frame.
        if (
          msg.event.kind === "tool_call" ||
          msg.event.kind === "progress" ||
          msg.event.kind === "share" ||
          msg.event.kind === "ask" ||
          msg.event.kind === "message" ||
          msg.event.kind === "status"
        ) {
          setLatestByTask((cur) => ({ ...cur, [msg.taskId]: entry }));
        }

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
        // Clear / refresh the queue chips immediately on turn boundary
        // events. Without this the chip lingers up to ~2s after the
        // agent finishes, which makes the steer flow feel stale.
        if (
          msg.event.kind === "status" ||
          msg.event.kind === "exit" ||
          msg.event.kind === "queue_updated"
        ) {
          if (msg.event.kind === "queue_updated") {
            const queue = msg.event.queue;
            qc.setQueryData(["task-steer", msg.taskId], (cur: unknown) => {
              const prev = cur as
                | { running: boolean; queue: string[] }
                | undefined;
              return {
                running: prev?.running ?? true,
                queue,
              };
            });
          } else {
            void qc.invalidateQueries({
              queryKey: ["task-steer", msg.taskId],
            });
          }
        }
        if (
          msg.event.kind === "usage" ||
          msg.event.kind === "status" ||
          msg.event.kind === "exit"
        ) {
          void qc.invalidateQueries({
            queryKey: ["taskContext", msg.taskId],
          });
        }
        // Also refresh the task's messages cache on turn boundaries
        // so a tab-switch + return sees the agent's just-finished
        // reply (it was already in the DB; the cache just hadn't
        // been told to refetch). Idle for claude (between turns)
        // and exit for codex (proc death).
        if (
          msg.event.kind === "exit" ||
          (msg.event.kind === "status" &&
            (msg.event.status === "idle" || msg.event.status === "done"))
        ) {
          void qc.invalidateQueries({ queryKey: qk.task(msg.taskId) });
        }
        // Auto-compaction prunes pre-boundary messages out of the DB
        // and inserts a synthetic divider — the timeline cache is now
        // out of sync with the server, so refetch immediately. Without
        // this the operator's open task page keeps showing the old
        // (already-deleted) rows until the next status flip.
        if (msg.event.kind === "auto_compacted") {
          void qc.invalidateQueries({ queryKey: qk.task(msg.taskId) });
        }
        // Workspace caches (file tree + git status + recent commits)
        // refresh in response to actual state-changing events instead
        // of a 4-8s poll. Tool calls cover mid-turn edits; exit covers
        // the post-turn auto-commit. Read-only tools (Read/Glob/Grep
        // etc.) don't dirty the worktree, so skip those to avoid
        // hammering the daemon on every fetch the agent does.
        if (
          msg.event.kind === "exit" ||
          (msg.event.kind === "tool_result" &&
            !READONLY_TOOLS.has(msg.event.tool))
        ) {
          void qc.invalidateQueries({ queryKey: qk.files(msg.taskId) });
          void qc.invalidateQueries({
            queryKey: ["task", msg.taskId, "git-status"] as const,
          });
          void qc.invalidateQueries({ queryKey: qk.diff(msg.taskId) });
          void qc.invalidateQueries({ queryKey: qk.log(msg.taskId) });
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
    () => ({
      status,
      live,
      recent,
      pulses,
      latest,
      latestByTask,
      lastStatusChange,
    }),
    [status, live, recent, pulses, latest, latestByTask, lastStatusChange],
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
      latestByTask: {},
      lastStatusChange: {},
    };
  }
  return v;
}

/**
 * Returns true if `projectId` had a brainstorm/plan event in the
 * last `windowMs` ms. Mirrors `useRecentPulse` but keyed under the
 * `proj:` namespace so the sidebar can blink the project row in
 * the same way it does for tasks.
 */
export function useProjectPulse(
  projectId: string | null | undefined,
  windowMs = 1800,
): boolean {
  return useRecentPulse(projectId ? `proj:${projectId}` : "", windowMs);
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
