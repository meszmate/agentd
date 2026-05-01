import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * UI / client-side state. TanStack Query owns server data; this store owns
 * everything that's purely about *what the user is looking at right now*:
 *
 *   - Sidebar collapse, focused project, last-opened-task per project
 *   - Per-project unread counters (incremented by the realtime bus, reset
 *     when the user visits the project)
 *   - Workspace pane open/close, etc.
 *
 * Subset that should survive a page reload is wrapped in `persist`. The
 * unread counters are intentionally *not* persisted — they're "since you
 * last looked", which only makes sense within a session.
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
