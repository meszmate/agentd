import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  createBrowserRouter,
  NavLink,
  Outlet,
  RouterProvider,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { AppProvider, useApp } from "./AppContext";
import { ErrorBoundary } from "./ErrorBoundary";
import { Login } from "./views/Login";
import { CommandPalette } from "./CommandPalette";
import { HelpOverlay } from "./HelpOverlay";
import { useShortcuts } from "./useKeyboard";
import { qk } from "./queries";
import { useTaskCompletionNotifications } from "./useNotifications";
import type { Task } from "@agentd/contracts";

// Each view ships in its own chunk so xterm.js (only used by the terminal
// tab) and the bigger plugin/settings forms don't bloat the initial paint.
const Tasks = lazy(() => import("./views/Tasks").then((m) => ({ default: m.Tasks })));
const Templates = lazy(() => import("./views/Templates").then((m) => ({ default: m.Templates })));
const Schedules = lazy(() => import("./views/Schedules").then((m) => ({ default: m.Schedules })));
const Plugins = lazy(() => import("./views/Plugins").then((m) => ({ default: m.Plugins })));
const Settings = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));

function ViewSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="empty">loading...</div>}>
      <div className="fade-in" style={{ display: "contents" }}>
        {children}
      </div>
    </Suspense>
  );
}

const NAV: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/tasks", label: "tasks" },
  { to: "/templates", label: "templates" },
  { to: "/schedules", label: "schedules" },
  { to: "/plugins", label: "plugins" },
  { to: "/settings", label: "settings" },
];

function ThemeToggle() {
  const [mode, setMode] = useState<"system" | "light" | "dark">(() => {
    return (localStorage.getItem("agentd.theme") as "system" | "light" | "dark") ?? "system";
  });
  useEffect(() => {
    if (mode === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", mode);
    }
    localStorage.setItem("agentd.theme", mode);
  }, [mode]);
  const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const icon = mode === "dark" ? "◐" : mode === "light" ? "◑" : "◓";
  return (
    <button
      className="ghost"
      onClick={() => setMode(next)}
      title={`theme: ${mode} (click for ${next})`}
      aria-label={`theme: ${mode}, switch to ${next}`}
    >
      <span aria-hidden="true" style={{ fontSize: 14 }}>
        {icon}
      </span>
    </button>
  );
}

function Modeline() {
  const { client } = useApp();
  const loc = useLocation();
  const path = loc.pathname.split("/").filter(Boolean).join(" / ") || "tasks";
  const server = client?.baseUrl ?? "—";
  const host = (() => {
    try {
      return new URL(server).host;
    } catch {
      return "—";
    }
  })();
  return (
    <footer className="modeline" role="contentinfo" aria-label="Status">
      <div className="mode" aria-label="Connection status">
        CONNECTED
      </div>
      <div className="spacer" aria-hidden="true" />
      <div aria-label="Current path">~/{path}</div>
      <div aria-label="Server host">{host}</div>
      <div className="spacer">
        <a href="https://github.com/meszmate/agentd" target="_blank" rel="noreferrer">
          /agentd
        </a>
      </div>
    </footer>
  );
}

/**
 * Live notification announcer for SR users — invisible region updated when
 * a task changes status. We deliberately only announce terminal transitions
 * (done/failed/stopped) so screen readers don't get spammed during normal
 * agent activity.
 */
function StatusAnnouncer({ tasks }: { tasks: Task[] }) {
  const last = useState<Map<string, string>>(() => new Map())[0];
  const [text, setText] = useState("");
  useEffect(() => {
    for (const t of tasks) {
      const prev = last.get(t.id);
      if (prev && prev !== t.status && (t.status === "done" || t.status === "failed" || t.status === "stopped")) {
        setText(`Task ${t.title} ${t.status}.`);
      }
      last.set(t.id, t.status);
    }
  }, [tasks, last]);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

function KeyboardShortcutsBus({ openCmd, openHelp }: { openCmd: () => void; openHelp: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useTaskCompletionNotifications(
    (qc.getQueryData(qk.tasks()) as { tasks: Task[] } | undefined)?.tasks,
  );

  useShortcuts(
    [
      { key: "ctrl+k", handler: openCmd, allowInEditable: true, describe: "open palette" },
      { key: "?", handler: openHelp, describe: "show help" },
      {
        key: "/",
        handler: () => {
          // Focus the spawn-form repo input if we're on /tasks; otherwise jump
          // there first.
          const repo = document.querySelector<HTMLInputElement>(
            'form.spawn input[placeholder*="git"]',
          );
          if (repo) {
            repo.focus();
          } else {
            navigate("/tasks");
          }
        },
        describe: "focus spawn input",
      },
    ],
    {
      gt: () => navigate("/tasks"),
      ge: () => navigate("/templates"),
      gs: () => navigate("/schedules"),
      gp: () => navigate("/plugins"),
      "g,": () => navigate("/settings"),
      gh: () => navigate("/tasks"),
    },
  );
  return null;
}

function Shell() {
  const { client, server, setSession, logout, toast, toastState } = useApp();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const qc = useQueryClient();

  // Verify session on mount; on 401 boot back to login.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        await client.health();
      } catch {
        if (!cancelled) {
          logout();
          toast("session invalid — please pair again", true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, logout, toast]);

  const openCmd = useCallback(() => setPaletteOpen(true), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);

  if (!client) {
    return (
      <Login
        initialServer={server}
        onPair={(s, t) => {
          setSession(s, t);
          toast("paired ✓");
        }}
        onError={(m) => toast(m, true)}
      />
    );
  }

  const tasks =
    (qc.getQueryData(qk.tasks()) as { tasks: Task[] } | undefined)?.tasks ?? [];

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="topbar" role="banner">
        <NavLink
          to="/"
          className="topbar__brand"
          end
          aria-label="agentd — back to home"
        >
          <span className="slash" aria-hidden="true">/</span>agentd
        </NavLink>
        <nav className="topbar__nav" role="navigation" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar__right">
          <button
            className="ghost"
            onClick={openCmd}
            title="Command palette (⌘K)"
            aria-label="Open command palette"
          >
            <span aria-hidden="true">⌘K</span>
          </button>
          <div className="meta">
            <strong>{server.replace(/^https?:\/\//, "")}</strong>
          </div>
          <ThemeToggle />
          <button className="ghost" onClick={logout} title="log out" aria-label="Log out">
            <span aria-hidden="true">⎋</span>
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1} role="main" style={{ minHeight: 0, overflow: "hidden" }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      <Modeline />
      {toastState && (
        <div
          className={`toast${toastState.isErr ? " err" : ""}`}
          role={toastState.isErr ? "alert" : "status"}
          aria-live={toastState.isErr ? "assertive" : "polite"}
        >
          {toastState.msg}
        </div>
      )}
      <StatusAnnouncer tasks={tasks} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <KeyboardShortcutsBus openCmd={openCmd} openHelp={openHelp} />
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      {
        path: "tasks",
        element: (
          <ViewSuspense>
            <Tasks />
          </ViewSuspense>
        ),
        children: [{ path: ":taskId" }],
      },
      {
        path: "templates",
        element: (
          <ViewSuspense>
            <Templates />
          </ViewSuspense>
        ),
      },
      {
        path: "schedules",
        element: (
          <ViewSuspense>
            <Schedules />
          </ViewSuspense>
        ),
      },
      {
        path: "plugins",
        element: (
          <ViewSuspense>
            <Plugins />
          </ViewSuspense>
        ),
      },
      {
        path: "settings",
        element: (
          <ViewSuspense>
            <Settings />
          </ViewSuspense>
        ),
      },
      { path: "*", element: <Navigate to="/tasks" replace /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 2000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <RouterProvider router={router} />
      </AppProvider>
    </QueryClientProvider>
  );
}
