import { useEffect, useRef, useState, useCallback } from "react";
import { AgentdClient } from "@agentd/client";
import type { Task, Message, WsServerEvent } from "@agentd/contracts";

const TOKEN_KEY = "agentd.token";
const SERVER_KEY = "agentd.server";

export function loadStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function loadStoredServer(): string {
  return localStorage.getItem(SERVER_KEY) ?? location.origin;
}

export function saveSession(server: string, token: string): void {
  localStorage.setItem(SERVER_KEY, server);
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function makeClient(server: string, token: string | null): AgentdClient {
  return new AgentdClient(server, token);
}

/**
 * Polls the given async fetcher on an interval, returning the latest value
 * and a manual refresh hook. Skips polling while document is hidden, since
 * background tabs shouldn't burn API quota.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  initial: T,
  intervalMs = 4000,
): { data: T; refresh: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const v = await fetcherRef.current();
      setData(v);
    } catch (e) {
      // surfaced via the toast layer; swallow here to keep poll alive
      console.warn("poll fetch failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await refresh();
    })();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { data, refresh, loading };
}

/**
 * Subscribe to the daemon's event firehose for a single task. Auto-reconnects
 * on close. Live status flag exposed for the connection-indicator chip.
 */
export function useTaskStream(
  client: AgentdClient | null,
  taskId: string | null,
  onEvent: (env: { taskId: string; event: WsServerEvent extends { type: "event"; event: infer E } ? E : never; ts: number }) => void,
): { live: boolean } {
  const [live, setLive] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!client || !taskId) {
      setLive(false);
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = client.watch(taskId, (msg) => {
        if (msg.type === "event") {
          onEventRef.current({
            taskId: msg.taskId,
            event: msg.event as never,
            ts: msg.ts,
          });
        }
      });
      ws.addEventListener("open", () => setLive(true));
      ws.addEventListener("close", () => {
        setLive(false);
        if (closed) return;
        reconnectTimer = setTimeout(open, 2000);
      });
      ws.addEventListener("error", () => setLive(false));
    };
    open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
    };
  }, [client, taskId]);

  return { live };
}

export type { AgentdClient, Task, Message };
