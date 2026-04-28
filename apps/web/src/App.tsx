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
        await client.health();
      } catch {
        if (!cancelled) {
          logout();
          toast("Session invalid — please pair again", true);
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
      <RouterProvider router={router} />
      <BackgroundEffects />
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
            "rounded-lg border border-ink-900/10 bg-cream-50 text-ink-900 shadow-deep font-sans dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-50",
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
