import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  createBrowserRouter,
  NavLink,
  Outlet,
  RouterProvider,
  Navigate,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppProvider, useApp } from "./AppContext";
import { ErrorBoundary } from "./ErrorBoundary";
import { Login } from "./views/Login";

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
    <button className="ghost" onClick={() => setMode(next)} title={`theme: ${mode} (click for ${next})`}>
      <span style={{ fontSize: 14 }}>{icon}</span>
    </button>
  );
}

function Modeline() {
  const { client } = useApp();
  const loc = useLocation();
  const path = loc.pathname.split("/").filter(Boolean).join(" / ") || "tasks";
  const server = client?.baseUrl ?? "—";
  const host = (() => {
    try { return new URL(server).host; } catch { return "—"; }
  })();
  return (
    <div className="modeline">
      <div className="mode">CONNECTED</div>
      <div className="spacer" />
      <div>~/{path}</div>
      <div>{host}</div>
      <div className="spacer">
        <a href="https://github.com/meszmate/agentd" target="_blank" rel="noreferrer">
          /agentd
        </a>
      </div>
    </div>
  );
}

function Shell() {
  const { client, server, setSession, logout, toast, toastState } = useApp();

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

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="topbar__brand" end>
          <span className="slash">/</span>agentd
        </NavLink>
        <nav className="topbar__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar__right">
          <div className="meta">
            <strong>{server.replace(/^https?:\/\//, "")}</strong>
          </div>
          <ThemeToggle />
          <button className="ghost" onClick={logout} title="log out">
            ⎋
          </button>
        </div>
      </header>
      <ErrorBoundary>
        <Outlet />
      </ErrorBoundary>
      <Modeline />
      {toastState && (
        <div className={`toast${toastState.isErr ? " err" : ""}`}>{toastState.msg}</div>
      )}
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
      // Match the pre-Query polling behavior: refetch in background, don't
      // refetch on window focus (we already poll), keep cached data fresh.
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
