import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentdClient } from "@agentd/client";
import type {
  Task,
  WsServerEvent,
  AgentEvent,
  GithubListQuery,
} from "@agentd/contracts";
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
  bridgeSummary: () => ["bridge-summary"] as const,
  discordChannels: () => ["discord-channels"] as const,
  projectSuggestions: (projectId: string) =>
    ["project-suggestions", projectId] as const,
  savedIdeas: (projectIdOrSlug: string) =>
    ["saved-ideas", projectIdOrSlug] as const,
  idea: (id: string) => ["idea", id] as const,
  githubStatus: () => ["github", "status"] as const,
  githubIssues: (idOrSlug: string, opts?: GithubListQuery) =>
    ["github", "issues", idOrSlug, githubKeyOpts(opts)] as const,
  githubPrs: (idOrSlug: string, opts?: GithubListQuery) =>
    ["github", "prs", idOrSlug, githubKeyOpts(opts)] as const,
  githubIssue: (idOrSlug: string, number: number) =>
    ["github", "issue", idOrSlug, number] as const,
  githubPr: (idOrSlug: string, number: number) =>
    ["github", "pr", idOrSlug, number] as const,
};

/**
 * Stable cache-key projection of a list query. Sorts labels so two
 * queries with the same filters in different label orders share one
 * cache entry, drops empty values, and lower-cases keys.
 */
function githubKeyOpts(opts?: GithubListQuery): Record<string, unknown> {
  if (!opts) return {};
  const out: Record<string, unknown> = {};
  if (opts.state) out.state = opts.state;
  if (opts.search?.trim()) out.q = opts.search.trim();
  if (opts.author?.trim()) out.author = opts.author.trim();
  if (opts.assignee?.trim()) out.assignee = opts.assignee.trim();
  if (opts.milestone?.trim()) out.milestone = opts.milestone.trim();
  if (opts.base?.trim()) out.base = opts.base.trim();
  if (opts.draft) out.draft = true;
  if (typeof opts.limit === "number") out.limit = opts.limit;
  if (opts.labels && opts.labels.length > 0) out.labels = [...opts.labels].sort();
  return out;
}

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

export function useUpdateProject() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      idOrSlug,
      patch,
    }: {
      idOrSlug: string;
      patch: Parameters<AgentdClient["updateProject"]>[1];
    }) => client.updateProject(idOrSlug, patch),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: qk.project(variables.idOrSlug) });
      void qc.invalidateQueries({ queryKey: qk.projects() });
    },
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

export function useFiles(id: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.files(id ?? "_none"),
    queryFn: () => client.listFiles(id!),
    enabled: !!id,
    // Invalidated by the realtime bus on tool_result/exit; no polling.
    staleTime: 60_000,
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

export function useGitStatus(id: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["task", id ?? "_none", "git-status"] as const,
    queryFn: () => client.gitStatus(id!),
    enabled: !!id,
    // Invalidated by the realtime bus on tool_result/exit; no polling.
    staleTime: 60_000,
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

export function useLog(id: string | null | undefined, limit = 50) {
  const client = useClient();
  return useQuery({
    queryKey: qk.log(id ?? "_none", limit),
    queryFn: () => client.getLog(id!, limit),
    enabled: !!id,
    // Invalidated by the realtime bus on tool_result/exit; no polling.
    staleTime: 60_000,
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => client.sendInput(taskId, text),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["task-steer", taskId] as const,
      });
      // Invalidate the task's messages cache so coming back to this
      // task after a tab-switch refetches fresh history (including
      // anything the agent has produced since this send landed).
      void qc.invalidateQueries({ queryKey: qk.task(taskId) });
    },
  });
}

/** Live snapshot of a task's running state + steer queue. */
export function useTaskSteer(taskId: string) {
  const client = useClient();
  return useQuery({
    queryKey: ["task-steer", taskId] as const,
    queryFn: () => client.getTaskSteerState(taskId),
    staleTime: 30_000,
    enabled: !!taskId,
  });
}

export function useRemoveQueuedSteer(taskId: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (index: number) => client.removeQueuedSteer(taskId, index),
    onSuccess: (data) => {
      qc.setQueryData(["task-steer", taskId], (cur: unknown) => {
        const prev = cur as
          | { running: boolean; queue: string[] }
          | undefined;
        return {
          running: prev?.running ?? false,
          queue: data.queue,
        };
      });
    },
  });
}

/**
 * Fire a single queued steer item via the per-row Steer button.
 * The server pops it, persists as a user message, and writes to
 * stdin (claude) or kicks off a respawn (codex). Updates the cache
 * with the returned queue snapshot so the row vanishes on click.
 */
/**
 * Persist a new sidebar task ordering. Optimistically updates the
 * task list cache so the new order shows the moment the user drops,
 * then syncs to the server.
 */
export function useReorderTasks() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskIds: string[]) => client.reorderTasks(taskIds),
    onMutate: async (taskIds) => {
      await qc.cancelQueries({ queryKey: qk.tasks() });
      const prev = qc.getQueryData<{ tasks: Task[] }>(qk.tasks());
      if (prev) {
        const idx = new Map(taskIds.map((id, i) => [id, i] as const));
        const next = prev.tasks.map((t) =>
          idx.has(t.id) ? { ...t, sortOrder: idx.get(t.id)! } : t,
        );
        qc.setQueryData(qk.tasks(), { tasks: next });
      }
      return { prev };
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.tasks(), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useFireQueuedSteer(taskId: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (index: number) => client.fireQueuedSteer(taskId, index),
    onSuccess: (data) => {
      qc.setQueryData(["task-steer", taskId], (cur: unknown) => {
        const prev = cur as
          | { running: boolean; queue: string[] }
          | undefined;
        return {
          running: prev?.running ?? true,
          queue: data.queue,
        };
      });
      // The fired item is now a user message in the DB. Invalidate
      // the task cache so a later return to this task picks up the
      // fresh server-side persisted version (without it, the cache
      // would still hold the pre-fire snapshot).
      void qc.invalidateQueries({ queryKey: qk.task(taskId) });
    },
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

/**
 * Connect-chat wizard hooks. The validate / get-chat / test-send
 * mutations don't go through React Query's cache — they're imperative
 * round-trips kicked off from the wizard's button handlers.
 */
export function useValidateTelegramToken() {
  const client = useClient();
  return useMutation({
    mutationFn: (token: string) => client.validateTelegramToken(token),
  });
}
export function useGetTelegramChat() {
  const client = useClient();
  return useMutation({
    mutationFn: ({ token, chatId }: { token: string; chatId: string }) =>
      client.getTelegramChat(token, chatId),
  });
}
export function useTelegramTestSend() {
  const client = useClient();
  return useMutation({
    mutationFn: ({
      token,
      chatId,
      text,
    }: {
      token: string;
      chatId: string;
      text?: string;
    }) => client.telegramTestSend(token, chatId, text),
  });
}
export function useDiscordChannels(refetchInterval?: number) {
  const client = useClient();
  return useQuery({
    queryKey: qk.discordChannels(),
    queryFn: () => client.listDiscordChannels(),
    staleTime: 30_000,
    refetchInterval,
  });
}
export function useDiscordTestSend() {
  const client = useClient();
  return useMutation({
    mutationFn: ({ channelId, text }: { channelId: string; text?: string }) =>
      client.discordTestSend(channelId, text),
  });
}
export function useBridgeSummary(refetchInterval = 6000) {
  const client = useClient();
  return useQuery({
    queryKey: qk.bridgeSummary(),
    queryFn: () => client.getBridgeSummary(),
    staleTime: 5_000,
    refetchInterval,
  });
}

/**
 * Project-scoped suggestions list — feeds the Idea Factory inbox.
 * The realtime bus invalidates this on `suggestion_created` /
 * `suggestion_updated` so picks/dismisses from chat or CLI show up
 * here without polling.
 */
export function useProjectSuggestions(projectId: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.projectSuggestions(projectId ?? "_none"),
    queryFn: () => client.listSuggestions({ projectId: projectId! }),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useClearProjectBrainstorm() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idOrSlug: string) => client.clearProjectBrainstorm(idOrSlug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-suggestions"] });
    },
  });
}

export function useIdeateForProject() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      idOrSlug,
      ...body
    }: {
      idOrSlug: string;
    } & Parameters<AgentdClient["ideateForProject"]>[1]) =>
      client.ideateForProject(idOrSlug, body),
    onSuccess: (_data, vars) => {
      // The new suggestion lands via the realtime bus too, but we
      // also invalidate so a slow WS doesn't leave the panel stale.
      void qc.invalidateQueries({
        queryKey: qk.projectSuggestions(vars.idOrSlug),
      });
    },
  });
}

export function useResolveSuggestion() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      pick,
    }: {
      id: string;
      pick: Parameters<AgentdClient["resolveSuggestion"]>[1];
    }) => client.resolveSuggestion(id, pick),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-suggestions"] });
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useDismissSuggestion() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.dismissSuggestion(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-suggestions"] });
    },
  });
}

// validateSuggestion is a streaming call now — see
// `client.streamValidateSuggestion`. The call site holds its own
// "validating" state so it can render live tool activity rows; once
// done it calls `qc.invalidateQueries({ queryKey: ["project-suggestions"] })`
// to refresh the persisted scores. Keeping a thin invalidation
// helper here so the brainstorm view doesn't have to know the key.
export function useInvalidateSuggestions() {
  const qc = useQueryClient();
  return () =>
    void qc.invalidateQueries({ queryKey: ["project-suggestions"] });
}

export function useSavedIdeas(
  projectSlugOrId: string | null | undefined,
  opts?: { statuses?: import("@agentd/contracts").IdeaStatus[] },
) {
  const client = useClient();
  const statusKey = opts?.statuses ? opts.statuses.join(",") : "all";
  return useQuery({
    queryKey: [
      ...qk.savedIdeas(projectSlugOrId ?? "_none"),
      statusKey,
    ] as const,
    queryFn: () =>
      client.listSavedIdeas(projectSlugOrId!, {
        ...(opts?.statuses ? { statuses: opts.statuses } : {}),
        includeSpawned: true,
      }),
    enabled: !!projectSlugOrId,
    staleTime: 15_000,
  });
}

export function useIdea(id: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.idea(id ?? "_none"),
    queryFn: () => client.getIdea(id!),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useUpdateIdea() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: { id: string } & Parameters<AgentdClient["updateIdea"]>[1]) =>
      client.updateIdea(id, patch),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: qk.idea(vars.id) });
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
    },
  });
}

export function useSaveIdea() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectSlug,
      ...body
    }: {
      projectSlug: string;
    } & Parameters<AgentdClient["createSavedIdea"]>[1]) =>
      client.createSavedIdea(projectSlug, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: qk.savedIdeas(vars.projectSlug),
      });
    },
  });
}

export function useDeleteSavedIdea() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteSavedIdea(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
    },
  });
}

export function useSpawnFromSavedIdea() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
    } & Parameters<AgentdClient["spawnFromSavedIdea"]>[1]) =>
      client.spawnFromSavedIdea(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useSpawnMultiFromSavedIdea() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
    } & Parameters<AgentdClient["spawnMultiFromSavedIdea"]>[1]) =>
      client.spawnMultiFromSavedIdea(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useSpawnTasksMulti() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<AgentdClient["spawnTasksMulti"]>[0]) =>
      client.spawnTasksMulti(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useSpawnSiblingTask() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      parentId,
      ...body
    }: {
      parentId: string;
    } & Parameters<AgentdClient["spawnSiblingTask"]>[1]) =>
      client.spawnSiblingTask(parentId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
    },
  });
}

export function useUpdateSavedIdeaSlices() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      slices,
    }: {
      id: string;
      slices: Parameters<AgentdClient["updateSavedIdeaSlices"]>[1];
    }) => client.updateSavedIdeaSlices(id, slices),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-ideas"] });
    },
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
      void qc.invalidateQueries({ queryKey: qk.tasks() });
      void qc.invalidateQueries({ queryKey: ["task-steer", taskId] });
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

/* ── Todos ────────────────────────────────────────────────────────── */

export function useTodos(opts: { projectId?: string; taskId?: string }) {
  const client = useClient();
  return useQuery({
    queryKey: ["todos", opts] as const,
    queryFn: () => client.listTodos(opts),
    enabled: !!(opts.projectId || opts.taskId),
    refetchInterval: 4_000,
  });
}

export function useCreateTodo() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: Parameters<AgentdClient["createTodo"]>[0]) =>
      client.createTodo(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
  });
}

export function useUpdateTodo() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<AgentdClient["updateTodo"]>[1];
    }) => client.updateTodo(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
  });
}

export function useDeleteTodo() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteTodo(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
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
    // Realtime invalidation does the work — the daemon watches
    // ~/.codex/models_cache.json and ~/.agentd/config.json, pushes a
    // `models_changed` WS event when either changes, and `realtime.tsx`
    // invalidates this query. So stale data lives at most a frame after
    // the source file is rewritten — no polling, no refetchOnFocus
    // needed. The Infinity staleTime keeps idle pages quiet.
    staleTime: Infinity,
  });
}

/**
 * Project-level git ahead/behind counts vs `origin/<branch>`. Drives
 * the "N commits behind — Pull" pill on the project topbar. The
 * mount-time fetch hits the network (`?fetch=1`) so the counts
 * reflect the real remote, not whatever stale fetch state was on
 * disk; subsequent re-renders read the local refs only.
 */
export function useProjectGitState(idOrSlug: string | null | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ["projects", idOrSlug, "git-state"] as const,
    queryFn: () => client.getProjectGitState(idOrSlug!, { fetch: true }),
    enabled: !!idOrSlug,
    // Refresh against the remote every 60s so a colleague pushing
    // upstream during the brainstorm session shows up automatically.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function usePullProject() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idOrSlug: string) => client.pullProject(idOrSlug),
    onSuccess: (_, idOrSlug) => {
      void qc.invalidateQueries({
        queryKey: ["projects", idOrSlug, "git-state"],
      });
    },
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

// ── GitHub ─────────────────────────────────────────────────────────

/**
 * Global gh preflight — `gh --version` + `gh auth status`. Cheap
 * (~150ms) and rarely changes; web's GitHub view gates on it.
 */
export function useGithubStatus() {
  const client = useClient();
  return useQuery({
    queryKey: qk.githubStatus(),
    queryFn: () => client.getGithubStatus(),
    staleTime: 30_000,
  });
}

/**
 * Project's issues from `gh issue list`. The `opts` accept the full
 * github.com filter vocabulary (state / search / labels / author /
 * assignee / milestone / limit) and are part of the cache key, so
 * different filter combinations cache independently. Realtime bus
 * invalidates on `github_refreshed`; no polling.
 */
export function useGithubIssues(
  idOrSlug: string | null | undefined,
  opts?: GithubListQuery,
) {
  const client = useClient();
  return useQuery({
    queryKey: qk.githubIssues(idOrSlug ?? "_none", opts),
    queryFn: () => client.listGithubIssues(idOrSlug!, opts),
    enabled: !!idOrSlug,
    staleTime: 30_000,
  });
}

export function useGithubPrs(
  idOrSlug: string | null | undefined,
  opts?: GithubListQuery,
) {
  const client = useClient();
  return useQuery({
    queryKey: qk.githubPrs(idOrSlug ?? "_none", opts),
    queryFn: () => client.listGithubPrs(idOrSlug!, opts),
    enabled: !!idOrSlug,
    staleTime: 30_000,
  });
}

/**
 * Single issue / PR detail — full conversation with comments and (for
 * PRs) reviews + commits. Used by the in-app detail panel so the
 * operator can read everything that happened without leaving the tab.
 */
export function useGithubIssue(
  idOrSlug: string | null | undefined,
  number: number | null | undefined,
) {
  const client = useClient();
  return useQuery({
    queryKey: qk.githubIssue(idOrSlug ?? "_none", number ?? 0),
    queryFn: () => client.viewGithubIssue(idOrSlug!, number!),
    enabled: !!idOrSlug && !!number,
    staleTime: 30_000,
  });
}

export function useGithubPr(
  idOrSlug: string | null | undefined,
  number: number | null | undefined,
) {
  const client = useClient();
  return useQuery({
    queryKey: qk.githubPr(idOrSlug ?? "_none", number ?? 0),
    queryFn: () => client.viewGithubPr(idOrSlug!, number!),
    enabled: !!idOrSlug && !!number,
    staleTime: 30_000,
  });
}

export function useRefreshGithub() {
  const client = useClient();
  return useMutation({
    mutationFn: (idOrSlug: string) => client.refreshGithub(idOrSlug),
  });
}

export function useSpawnGithubTask() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      idOrSlug,
      req,
    }: {
      idOrSlug: string;
      req: Parameters<AgentdClient["spawnGithubTask"]>[1];
    }) => client.spawnGithubTask(idOrSlug, req),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: qk.tasks() });
      // Prefix-invalidate so every filter combo refetches, not just
      // the empty-opts cache entry.
      void qc.invalidateQueries({
        queryKey: ["github", "issues", vars.idOrSlug],
      });
      void qc.invalidateQueries({
        queryKey: ["github", "prs", vars.idOrSlug],
      });
    },
  });
}

export function usePrComment(taskId: string) {
  const client = useClient();
  return useMutation({
    mutationFn: (body: string) => client.prComment(taskId, body),
  });
}

export function usePrReview(taskId: string) {
  const client = useClient();
  return useMutation({
    mutationFn: (vars: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body?: string;
    }) => client.prReview(taskId, vars.event, vars.body),
  });
}

export function usePrMerge(taskId: string) {
  const client = useClient();
  return useMutation({
    mutationFn: (method: "merge" | "squash" | "rebase" = "squash") =>
      client.prMerge(taskId, method),
  });
}
