import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TaskPlanItem } from "@/views/TaskPlan";

/**
 * UI / client-side state. TanStack Query owns server-truth data (task
 * messages, projects, etc.); this store owns everything that's purely
 * about *what the user is looking at right now* AND per-task derived
 * realtime state (streams, plan snapshot, current-turn meter, last
 * tool hint) that the global WS bus accumulates so it survives across
 * route mounts. The previous design held that state inside TaskDetail's
 * useState — switching tabs unmounted the component, dropped the state,
 * and the chat looked like it was reloading from scratch on return.
 *
 * Persisted across page reloads:
 *   - Sidebar collapse, focused project, last-opened-task per project
 *   - Workspace pane open/close
 *
 * Session-only:
 *   - Per-project unread counters
 *   - Per-task pulse timestamps
 *   - Per-task realtime state (`taskRt`)
 */

interface PersistedState {
  sidebarCollapsed: boolean;
  /** Map of projectId → most-recently-opened taskId. Lets us bounce back to
   *  whatever you were looking at last time you visited the project. */
  lastTaskByProject: Record<string, string>;
  /** Color palette index per project (cosmetic). */
  projectColors: Record<string, number>;
  workspaceOpen: boolean;
}

/**
 * Per-task derived realtime state. Lives in zustand (not React state) so
 * it survives route changes — the operator can leave a running task,
 * navigate around, and come back to a fully populated chat with the
 * agent's current plan, in-flight streaming bubble, per-turn token
 * meter, and tool hint already there. Reset on terminal status.
 */
export interface TaskRtState {
  /** In-flight streaming bubbles, keyed by streamId. message_delta events
   *  append; message_end removes the entry; the final committed text
   *  arrives separately as a message event. */
  streams: Record<string, string>;
  /** Latest TodoWrite / update_plan snapshot. Replaced wholesale on each
   *  matching tool_call (those tools always send the full plan). */
  plan: TaskPlanItem[];
  planUpdatedAt: number | null;
  /** When the current turn started; null between turns. */
  turnStartedAt: number | null;
  /** Tokens reported by usage events for the current turn. */
  turnTokens: number;
  /** "→ Bash" / "→ Read" hint while a tool runs; cleared on result/exit. */
  lastToolHint: string | null;
}

const EMPTY_TASK_RT: TaskRtState = {
  streams: {},
  plan: [],
  planUpdatedAt: null,
  turnStartedAt: null,
  turnTokens: 0,
  lastToolHint: null,
};

interface SessionState {
  /** Project the user is currently focused on (drives sidebar highlight,
   *  spawn-sheet defaults). null when looking at cross-project pages. */
  currentProjectId: string | null;
  /** Per-project counter that ticks up every time a WS event arrives for
   *  one of its tasks while the user isn't looking at the project. */
  unreadByProject: Record<string, number>;
  /** Per-task pulse — last-event timestamp. Used by row-pulse animations.
   *  Trimmed periodically to avoid unbounded growth. */
  lastEventByTask: Record<string, number>;
  /** Per-task derived realtime state. See {@link TaskRtState}. */
  taskRt: Record<string, TaskRtState>;
}

interface Actions {
  setSidebarCollapsed: (v: boolean) => void;
  setCurrentProjectId: (id: string | null) => void;
  rememberTaskForProject: (projectId: string, taskId: string) => void;
  setProjectColor: (projectId: string, idx: number) => void;
  setWorkspaceOpen: (v: boolean) => void;
  /** Increment the unread counter for a project unless the user is currently
   *  looking at it. */
  bumpUnread: (projectId: string) => void;
  clearUnread: (projectId: string) => void;
  /** Mark that an event just landed for a task — drives flash animations. */
  recordTaskPulse: (taskId: string, ts: number) => void;
  /** Per-task realtime state mutators. All keep the rest of the slice intact. */
  appendStreamDelta: (taskId: string, streamId: string, delta: string) => void;
  endStream: (taskId: string, streamId: string) => void;
  setTaskPlan: (taskId: string, plan: TaskPlanItem[]) => void;
  setTaskHint: (taskId: string, hint: string | null) => void;
  beginTaskTurn: (taskId: string) => void;
  endTaskTurn: (taskId: string) => void;
  addTaskUsage: (taskId: string, tokens: number) => void;
  resetTaskRt: (taskId: string) => void;
}

type Store = PersistedState & SessionState & Actions;

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      // persisted
      sidebarCollapsed: false,
      lastTaskByProject: {},
      projectColors: {},
      workspaceOpen: true,

      // session-only
      currentProjectId: null,
      unreadByProject: {},
      lastEventByTask: {},
      taskRt: {},

      // actions
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      setCurrentProjectId: (id) => set({ currentProjectId: id }),
      rememberTaskForProject: (projectId, taskId) =>
        set((s) => ({
          lastTaskByProject: { ...s.lastTaskByProject, [projectId]: taskId },
        })),
      setProjectColor: (projectId, idx) =>
        set((s) => ({
          projectColors: { ...s.projectColors, [projectId]: idx },
        })),
      setWorkspaceOpen: (v) => set({ workspaceOpen: v }),
      bumpUnread: (projectId) => {
        const { currentProjectId, unreadByProject } = get();
        if (currentProjectId === projectId) return;
        set({
          unreadByProject: {
            ...unreadByProject,
            [projectId]: (unreadByProject[projectId] ?? 0) + 1,
          },
        });
      },
      clearUnread: (projectId) =>
        set((s) => {
          if (!s.unreadByProject[projectId]) return s;
          const next = { ...s.unreadByProject };
          delete next[projectId];
          return { unreadByProject: next };
        }),
      recordTaskPulse: (taskId, ts) =>
        set((s) => ({
          lastEventByTask: { ...s.lastEventByTask, [taskId]: ts },
        })),
      appendStreamDelta: (taskId, streamId, delta) =>
        set((s) => {
          const cur = s.taskRt[taskId] ?? EMPTY_TASK_RT;
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: {
                ...cur,
                streams: {
                  ...cur.streams,
                  [streamId]: (cur.streams[streamId] ?? "") + delta,
                },
              },
            },
          };
        }),
      endStream: (taskId, streamId) =>
        set((s) => {
          const cur = s.taskRt[taskId];
          if (!cur || !(streamId in cur.streams)) return s;
          const nextStreams = { ...cur.streams };
          delete nextStreams[streamId];
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: { ...cur, streams: nextStreams },
            },
          };
        }),
      setTaskPlan: (taskId, plan) =>
        set((s) => {
          const cur = s.taskRt[taskId] ?? EMPTY_TASK_RT;
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: { ...cur, plan, planUpdatedAt: Date.now() },
            },
          };
        }),
      setTaskHint: (taskId, hint) =>
        set((s) => {
          const cur = s.taskRt[taskId] ?? EMPTY_TASK_RT;
          if (cur.lastToolHint === hint) return s;
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: { ...cur, lastToolHint: hint },
            },
          };
        }),
      beginTaskTurn: (taskId) =>
        set((s) => {
          const cur = s.taskRt[taskId] ?? EMPTY_TASK_RT;
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: { ...cur, turnStartedAt: Date.now(), turnTokens: 0 },
            },
          };
        }),
      endTaskTurn: (taskId) =>
        set((s) => {
          const cur = s.taskRt[taskId];
          if (!cur) return s;
          if (cur.turnStartedAt == null && cur.lastToolHint == null) return s;
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: {
                ...cur,
                turnStartedAt: null,
                lastToolHint: null,
                streams: {},
              },
            },
          };
        }),
      addTaskUsage: (taskId, tokens) =>
        set((s) => {
          const cur = s.taskRt[taskId] ?? EMPTY_TASK_RT;
          return {
            taskRt: {
              ...s.taskRt,
              [taskId]: { ...cur, turnTokens: cur.turnTokens + tokens },
            },
          };
        }),
      resetTaskRt: (taskId) =>
        set((s) => {
          if (!s.taskRt[taskId]) return s;
          const next = { ...s.taskRt };
          delete next[taskId];
          return { taskRt: next };
        }),
    }),
    {
      name: "agentd.ui",
      partialize: (s): PersistedState => ({
        sidebarCollapsed: s.sidebarCollapsed,
        lastTaskByProject: s.lastTaskByProject,
        projectColors: s.projectColors,
        workspaceOpen: s.workspaceOpen,
      }),
    },
  ),
);

/**
 * Stable selector that returns the per-task realtime slice or a frozen
 * empty object when the task hasn't seen any events yet. Without the
 * shared frozen reference, every TaskDetail render that touches an
 * untouched task would get a fresh `{}`-equivalent object and re-trigger
 * downstream memos / panel renders.
 */
export function useTaskRt(taskId: string | null | undefined): TaskRtState {
  return useStore((s) =>
    taskId ? (s.taskRt[taskId] ?? EMPTY_TASK_RT) : EMPTY_TASK_RT,
  );
}
