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
  skills: (repoPath?: string) => ["skills", repoPath ?? null] as const,
  projects: () => ["projects"] as const,
  project: (idOrSlug: string) => ["project", idOrSlug] as const,
};

export function useProjects() {
  const client = useClient();
  return useQuery({
    queryKey: qk.projects(),
    queryFn: () => client.listProjects(),
    // No polling — the realtime bus invalidates this on task_updated /
    // status / exit events. Initial fetch + WS-driven refresh only.
    staleTime: 60_000,
  });
}

export function useProject(idOrSlug: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.project(idOrSlug ?? "_none"),
    queryFn: () => client.getProject(idOrSlug!),
    enabled: !!idOrSlug,
  });
}

export function useDeleteProject() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idOrSlug: string) => client.deleteProject(idOrSlug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.projects() });
    },
  });
}

export function useTasks() {
  const client = useClient();
  return useQuery({
    queryKey: qk.tasks(),
    queryFn: () => client.listTasks(),
    // The realtime bus pushes task_updated and status/exit events, and
    // updates this query's data directly. No need to poll.
    staleTime: 60_000,
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

export function useGitStatus(
  id: string | null | undefined,
  refetchInterval = 4000,
) {
  const client = useClient();
  return useQuery({
    queryKey: ["task", id ?? "_none", "git-status"] as const,
    queryFn: () => client.gitStatus(id!),
    enabled: !!id,
    refetchInterval,
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

/* ── Councils ─────────────────────────────────────────────────────── */

export function useCouncils() {
  const client = useClient();
  return useQuery({
    queryKey: ["councils"] as const,
    queryFn: () => client.listCouncils(),
    refetchInterval: 5_000,
  });
}

export function useCouncil(id: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["councils", id ?? ""] as const,
    queryFn: () => client.getCouncil(id!),
    enabled: !!id,
    refetchInterval: 3_000,
  });
}

export function useCreateCouncil() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: Parameters<AgentdClient["createCouncil"]>[0]) =>
      client.createCouncil(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["councils"] });
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function usePickCouncilWinner() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      taskId,
      explanation,
    }: {
      id: string;
      taskId: string;
      explanation?: string;
    }) => client.pickCouncilWinner(id, taskId, explanation),
    onSuccess: (_r, vars) => {
      void qc.invalidateQueries({ queryKey: ["councils", vars.id] });
      void qc.invalidateQueries({ queryKey: ["councils"] });
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

export function useRestartPlugin() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: "telegram" | "discord") => client.restartPlugin(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.plugins() }),
  });
}

export function useTaskContext(id: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["taskContext", id ?? "_none"],
    queryFn: () => client.getTaskContext(id!),
    enabled: !!id,
  });
}

export function useCompactTask(taskId: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (focus: string) => client.compactTask(taskId, focus),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["taskContext", taskId] });
      void qc.invalidateQueries({ queryKey: qk.task(taskId) });
    },
  });
}

/* ── Skills ─────────────────────────────────────────────────────── */

export function useSkills(repoPath?: string) {
  const client = useClient();
  return useQuery({
    queryKey: qk.skills(repoPath),
    queryFn: () => client.listSkills(repoPath),
    refetchInterval: 30_000,
  });
}

export function useCreateSkill() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: Parameters<AgentdClient["createSkill"]>[0]) =>
      client.createSkill(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useUpdateSkill() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      scope: string;
      slug: string;
      patch: Parameters<AgentdClient["updateSkill"]>[2];
      repoPath?: string;
    }) => client.updateSkill(args.scope, args.slug, args.patch, args.repoPath),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useDeleteSkill() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { scope: string; slug: string; repoPath?: string }) =>
      client.deleteSkill(args.scope, args.slug, args.repoPath),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["skills"] });
    },
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

/**
 * Model registry — single source of truth for the model lists the UI
 * shows in pickers. Backed by `cfg.models` server-side, overridable
 * in `~/.agentd/config.json`.
 */
export function useModels() {
  const client = useClient();
  return useQuery({
    queryKey: ["models"] as const,
    queryFn: () => client.getModels(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Cross-device "last used" defaults for the spawn flow. Backed by the
 * daemon's config.json under `prefs`. Replaces the old agentd.last*
 * localStorage keys.
 */
export function usePrefs() {
  const client = useClient();
  return useQuery({
    queryKey: ["prefs"] as const,
    queryFn: () => client.getPrefs(),
    staleTime: 60_000,
  });
}

export function usePatchPrefs() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<AgentdClient["patchPrefs"]>[0]) =>
      client.patchPrefs(patch),
    onSuccess: (res) => {
      qc.setQueryData(["prefs"], { prefs: res.prefs });
    },
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
