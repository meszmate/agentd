import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AgentdClient } from "@agentd/client";
import { clearSession, loadStoredServer, loadStoredToken, saveSession } from "./api";

interface ToastState {
  msg: string;
  isErr: boolean;
}

interface AppContextValue {
  client: AgentdClient | null;
  server: string;
  setSession: (server: string, token: string) => void;
  logout: () => void;
  toast: (msg: string, isErr?: boolean) => void;
  toastState: ToastState | null;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<string>(() => loadStoredServer());
  const [token, setToken] = useState<string | null>(() => loadStoredToken());
  const [toastState, setToastState] = useState<ToastState | null>(null);

  const client = useMemo<AgentdClient | null>(
    () => (token ? new AgentdClient(server, token) : null),
    [server, token],
  );

  const toast = useCallback((msg: string, isErr = false) => {
    setToastState({ msg, isErr });
    window.setTimeout(() => setToastState(null), 3500);
  }, []);

  const setSession = useCallback((s: string, t: string) => {
    saveSession(s, t);
    setServer(s);
    setToken(t);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setToken(null);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ client, server, setSession, logout, toast, toastState }),
    [client, server, setSession, logout, toast, toastState],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Throws if called outside the provider — caller bug, not user-facing, so a
 * loud throw beats a silent null check.
 */
export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}

/**
 * Convenience for views that need a non-null client. After login the client
 * is guaranteed by the router structure (login is on its own route), so this
 * narrows the type without forcing every view to write `client!`.
 */
export function useClient(): AgentdClient {
  const { client } = useApp();
  if (!client) throw new Error("useClient called without a session");
  return client;
}
