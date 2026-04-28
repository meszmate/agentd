import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AgentdClient } from "@agentd/client";
import { toast as sonnerToast } from "sonner";
import { clearSession, loadStoredServer, loadStoredToken, saveSession } from "./api";

interface AppContextValue {
  client: AgentdClient | null;
  server: string;
  setSession: (server: string, token: string) => void;
  logout: () => void;
  toast: (msg: string, isErr?: boolean) => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<string>(() => loadStoredServer());
  const [token, setToken] = useState<string | null>(() => loadStoredToken());

  const client = useMemo<AgentdClient | null>(
    () => (token ? new AgentdClient(server, token) : null),
    [server, token],
  );

  const toast = useCallback((msg: string, isErr = false) => {
    if (isErr) sonnerToast.error(msg);
    else sonnerToast(msg);
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
    () => ({ client, server, setSession, logout, toast }),
    [client, server, setSession, logout, toast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}

export function useClient(): AgentdClient {
  const { client } = useApp();
  if (!client) throw new Error("useClient called without a session");
  return client;
}
