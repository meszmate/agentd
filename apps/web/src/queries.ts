import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentdClient } from "@agentd/client";
import type { WsServerEvent, AgentEvent } from "@agentd/contracts";
import { useClient } from "./AppContext";

/**
 * One place that defines query keys so cache invalidation is precise. Keep
 * shapes shallow — TanStack does structural matching from the prefix down.
 */
export const qk = {
  health: () => ["health"] as const,
  tasks: () => ["tasks"] as const,
  task: (id: string) => ["task", id] as const,
  files: (id: string) => ["files", id] as const,
  file: (id: string, path: string) => ["file", id, path] as const,
  diff: (id: string, base?: string) => ["diff", id, base ?? null] as const,
  log: (id: string, limit?: number) => ["log", id, limit ?? 50] as const,
  templates: () => ["templates"] as const,
  schedules: () => ["schedules"] as const,
  plugins: () => ["plugins"] as const,
  settings: () => ["settings"] as const,
};

export function useTasks(refetchInterval = 4000) {
  const client = useClient();
  return useQuery({
    queryKey: qk.tasks(),
    queryFn: () => client.listTasks(),
    refetchInterval,
  });
}

export function useTask(id: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.task(id ?? "_none"),
    queryFn: () => client.getTask(id!),
    enabled: !!id,
  });
}

export function useFiles(id: string | null | undefined, refetchInterval = 8000) {
  const client = useClient();
  return useQuery({
    queryKey: qk.files(id ?? "_none"),
    queryFn: () => client.listFiles(id!),
    enabled: !!id,
    refetchInterval,
  });
}

export function useFile(id: string | null | undefined, path: string | null) {
  const client = useClient();
  return useQuery({
    queryKey: qk.file(id ?? "_none", path ?? "_none"),
    queryFn: () => client.getFile(id!, path!),
    enabled: !!id && !!path,
  });
}

export function useDiff(id: string | null | undefined, base?: string) {
  const client = useClient();
  return useQuery({
    queryKey: qk.diff(id ?? "_none", base),
    queryFn: () => client.getDiff(id!, base),
    enabled: !!id,
  });
}

export function useLog(id: string | null | undefined, limit = 50, refetchInterval = 6000) {
  const client = useClient();
  return useQuery({
    queryKey: qk.log(id ?? "_none", limit),
    queryFn: () => client.getLog(id!, limit),
    enabled: !!id,
    refetchInterval,
  });
}

export function useTemplates(opts?: { refetchInterval?: number }) {
  const client = useClient();
  return useQuery({
    queryKey: qk.templates(),
    queryFn: () => client.listTemplates(),
    refetchInterval: opts?.refetchInterval ?? 6000,
  });
}

export function useSchedules() {
  const client = useClient();
  return useQuery({
    queryKey: qk.schedules(),
    queryFn: () => client.listSchedules(),
    refetchInterval: 6000,
  });
}

export function usePluginsStatus(refetchInterval = 5000) {
  const client = useClient();
  return useQuery({
    queryKey: qk.plugins(),
    queryFn: () => client.pluginStatus(),
    refetchInterval,
  });
}

export function useSettings() {
  const client = useClient();
  return useQuery({
    queryKey: qk.settings(),
    queryFn: () => client.getSettings(),
  });
}

/* ── Mutations ────────────────────────────────────────────────────── */

export function useCreateTask() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: Parameters<AgentdClient["createTask"]>[0]) => client.createTask(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useSendInput(taskId: string) {
  const client = useClient();
  return useMutation({
    mutationFn: (text: string) => client.sendInput(taskId, text),
  });
}

export function useStopTask(taskId: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.stopTask(taskId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
      void qc.invalidateQueries({ queryKey: qk.task(taskId) });
    },
  });
}

export function useRemoveTask() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.removeTask(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useRevertCommit(taskId: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sha: string) => client.revert(taskId, sha),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.log(taskId) });
      void qc.invalidateQueries({ queryKey: qk.diff(taskId) });
    },
  });
}

export function useCreateTemplate() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: Parameters<AgentdClient["createTemplate"]>[0]) => client.createTemplate(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.templates() }),
  });
}
export function useDeleteTemplate() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idOrName: string) => client.deleteTemplate(idOrName),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.templates() }),
  });
}
export function useRunTemplate() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, args }: { name: string; args: Record<string, string> }) =>
      client.runTemplate(name, { args }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.tasks() }),
  });
}

export function useCreateSchedule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: Parameters<AgentdClient["createSchedule"]>[0]) => client.createSchedule(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.schedules() }),
  });
}
export function useToggleSchedule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? client.enableSchedule(id) : client.disableSchedule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.schedules() }),
  });
}
export function useDeleteSchedule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteSchedule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.schedules() }),
  });
}

export function usePatchTelegram() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<AgentdClient["patchPlugin"]>[1]) =>
      client.patchPlugin("telegram", patch as never),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.plugins() }),
  });
}
export function usePatchDiscord() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<AgentdClient["patchPlugin"]>[1]) =>
      client.patchPlugin("discord", patch as never),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.plugins() }),
  });
}

export function usePatchSettings() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<AgentdClient["patchSettings"]>[0]) =>
      client.patchSettings(patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.settings() }),
  });
}

/* ── WS event stream hook (reused from old api.ts, lightly rewritten) ─ */

export function useTaskStream(
  taskId: string | null,
  onEvent: (env: { taskId: string; event: AgentEvent; ts: number }) => void,
): { live: boolean } {
  const client = useClient();
  const [live, setLive] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!taskId) {
      setLive(false);
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = client.watch(taskId, (msg: WsServerEvent) => {
        if (msg.type === "event") {
          onEventRef.current({ taskId: msg.taskId, event: msg.event, ts: msg.ts });
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
