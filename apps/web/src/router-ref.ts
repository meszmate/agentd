import type { createBrowserRouter } from "react-router-dom";

/**
 * Shared handle on the app's router instance. App.tsx writes to it
 * once at boot; non-router code (e.g. realtime.tsx, which lives above
 * the RouterProvider and can't call useNavigate) reads from it to do
 * SPA navigations without forcing a full page reload.
 */
type RouterInstance = ReturnType<typeof createBrowserRouter>;

let current: RouterInstance | null = null;

export function setAppRouter(r: RouterInstance): void {
  current = r;
}

export function navigateTo(path: string): void {
  if (current) {
    void current.navigate(path);
  } else if (typeof window !== "undefined") {
    window.location.assign(path);
  }
}
