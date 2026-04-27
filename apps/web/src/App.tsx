import { lazy, Suspense, useEffect } from "react";
import {
  createBrowserRouter,
  NavLink,
  Outlet,
  RouterProvider,
  Navigate,
} from "react-router-dom";
import { AppProvider, useApp } from "./AppContext";
import { ErrorBoundary } from "./ErrorBoundary";
import { Login } from "./views/Login";

// Lazy-loaded views: each view ships in its own chunk so xterm.js (only used
// by the terminal tab inside Tasks) and the bigger plugin/settings forms
// don't bloat the initial paint.
const Tasks = lazy(() => import("./views/Tasks").then((m) => ({ default: m.Tasks })));
const Templates = lazy(() => import("./views/Templates").then((m) => ({ default: m.Templates })));
const Schedules = lazy(() => import("./views/Schedules").then((m) => ({ default: m.Schedules })));
const Plugins = lazy(() => import("./views/Plugins").then((m) => ({ default: m.Plugins })));
const Settings = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));

function ViewSuspense({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="empty page-pad">loading…</div>}>{children}</Suspense>;
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
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          agentd
        </div>
        <div className="nav">
          {(["tasks", "templates", "schedules", "plugins", "settings"] as const).map((p) => (
            <NavLink
              key={p}
              to={`/${p}`}
              className={({ isActive }) => (isActive ? "active" : "")}
              // NavLink renders an <a> by default; we want it to look like our
              // existing nav buttons, so we still expose the same DOM as a
              // plain button via role + tabIndex via the className. CSS handles
              // it because .topbar .nav button styling is now duplicated for a.
            >
              {p}
            </NavLink>
          ))}
        </div>
        <button className="ghost" onClick={logout} title="log out">
          ⎋
        </button>
      </div>
      <div style={{ minHeight: 0, overflow: "hidden" }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </div>
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
        children: [
          // /tasks/:id renders the same Tasks view, which reads :id from
          // useParams and selects it. The nested route exists purely so
          // <NavLink to={`/tasks/${id}`}> shows the proper active state and
          // browser nav (back/forward) works.
          { path: ":taskId" },
        ],
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

export function App() {
  return (
    <AppProvider>
      <RouterProvider router={router} />
    </AppProvider>
  );
}
