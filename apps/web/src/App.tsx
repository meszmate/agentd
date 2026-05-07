import { lazy, Suspense, useEffect } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AppProvider, useApp } from "@/AppContext";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { ErrorBoundary } from "@/ErrorBoundary";
import { AppShell } from "@/components/app-shell";
import { Login } from "@/views/Login";
import { useTaskCompletionNotifications } from "@/useNotifications";
import { RealtimeProvider } from "@/realtime";
import { BrainstormWindows } from "@/components/brainstorm-windows";
import { qk } from "@/queries";

const Home = lazy(() =>
  import("@/views/Home").then((m) => ({ default: m.Home })),
);
const Tasks = lazy(() =>
  import("@/views/Tasks").then((m) => ({ default: m.Tasks })),
);
const Templates = lazy(() =>
  import("@/views/Templates").then((m) => ({ default: m.Templates })),
);
const Schedules = lazy(() =>
  import("@/views/Schedules").then((m) => ({ default: m.Schedules })),
);
const Plugins = lazy(() =>
  import("@/views/Plugins").then((m) => ({ default: m.Plugins })),
);
const Settings = lazy(() =>
  import("@/views/Settings").then((m) => ({ default: m.Settings })),
);
const Devices = lazy(() =>
  import("@/views/Devices").then((m) => ({ default: m.Devices })),
);
const Activity = lazy(() =>
  import("@/views/Activity").then((m) => ({ default: m.Activity })),
);
const Projects = lazy(() =>
  import("@/views/Projects").then((m) => ({ default: m.Projects })),
);
const ProjectDetail = lazy(() =>
  import("@/views/ProjectDetail").then((m) => ({ default: m.ProjectDetail })),
);
const ProjectBrainstorm = lazy(() =>
  import("@/views/ProjectBrainstorm").then((m) => ({
    default: m.ProjectBrainstorm,
  })),
);
const ProjectGithub = lazy(() =>
  import("@/views/ProjectGithub").then((m) => ({
    default: m.ProjectGithub,
  })),
);
const IdeaWorkshop = lazy(() =>
  import("@/views/IdeaWorkshop").then((m) => ({
    default: m.IdeaWorkshop,
  })),
);
const TerminalView = lazy(() =>
  import("@/views/Terminal").then((m) => ({ default: m.TerminalView })),
);

function ViewSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-ink-500 dark:text-ink-400">
          Loading…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      {
        path: "home",
        element: (
          <ViewSuspense>
            <Home />
          </ViewSuspense>
        ),
      },
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
      { path: "skills", element: <Navigate to="/settings/skills" replace /> },
      {
        path: "projects",
        element: (
          <ViewSuspense>
            <Projects />
          </ViewSuspense>
        ),
      },
      {
        path: "projects/:slug",
        element: (
          <ViewSuspense>
            <ProjectDetail />
          </ViewSuspense>
        ),
      },
      {
        path: "projects/:slug/brainstorm",
        element: (
          <ViewSuspense>
            <ProjectBrainstorm />
          </ViewSuspense>
        ),
      },
      {
        path: "projects/:slug/github",
        element: (
          <ViewSuspense>
            <ProjectGithub />
          </ViewSuspense>
        ),
      },
      {
        path: "projects/:slug/ideas/:id",
        element: (
          <ViewSuspense>
            <IdeaWorkshop />
          </ViewSuspense>
        ),
      },
      {
        path: "terminal",
        element: (
          <ViewSuspense>
            <TerminalView />
          </ViewSuspense>
        ),
        children: [{ path: ":sessionName" }],
      },
      {
        path: "activity",
        element: (
          <ViewSuspense>
            <Activity />
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
        path: "devices",
        element: (
          <ViewSuspense>
            <Devices />
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
        children: [{ path: "skills" }],
      },
      { path: "*", element: <Navigate to="/home" replace /> },
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

function Root() {
  const { client, server, setSession, logout, toast } = useApp();

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        // listTasks is authenticated — health() is not, so it can't tell us
        // whether our session token is still valid. A 401 here means the
        // daemon was restarted / the token was revoked: force re-pair.
        await client.listTasks();
      } catch (e) {
        if (cancelled) return;
        const msg = (e as Error).message;
        if (/401/.test(msg)) {
          logout();
          toast("Session invalid — please pair again", true);
        } else {
          toast(`Server unreachable: ${msg}`, true);
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
          toast("Paired ✓");
        }}
        onError={(m) => toast(m, true)}
      />
    );
  }

  return (
    <ErrorBoundary>
      <RealtimeProvider>
        <RouterProvider router={router} />
        <BrainstormWindows />
        <BackgroundEffects />
      </RealtimeProvider>
    </ErrorBoundary>
  );
}

function BackgroundEffects() {
  const qc = useQueryClient();
  const tasks =
    qc.getQueryData<{ tasks: import("@agentd/contracts").Task[] }>(
      qk.tasks(),
    )?.tasks ?? [];
  useTaskCompletionNotifications(tasks);
  return null;
}

function ToasterMount() {
  const { resolved } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      theme={resolved}
      toastOptions={{
        classNames: {
          toast:
            "rounded-lg border border-ink-900/10 bg-paper-50 text-ink-900 shadow-deep font-sans dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-50",
          title: "text-sm",
          description: "text-xs text-ink-500 dark:text-ink-400",
        },
      }}
    />
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppProvider>
          <Root />
          <ToasterMount />
        </AppProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
