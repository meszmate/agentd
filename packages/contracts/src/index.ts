import { z } from "zod";

export const AgentKind = z.enum(["claude", "codex"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const TaskStatus = z.enum([
  "pending",
  "running",
  "waiting_input",
  "waiting_perm",
  "done",
  "failed",
  "stopped",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  agent: AgentKind,
  repoPath: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  status: TaskStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  templateId: z.string().nullable().optional(),
  scheduleId: z.string().nullable().optional(),
  autoPush: z.boolean().optional(),
  autoPr: z.boolean().optional(),
  prUrl: z.string().nullable().optional(),
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCacheReadTokens: z.number().optional(),
  totalCacheWriteTokens: z.number().optional(),
  totalCostUsd: z.number().nullable().optional(),
});
export type Task = z.infer<typeof Task>;

export const Template = z.object({
  id: z.string(),
  name: z.string(),
  agent: AgentKind,
  repoPath: z.string(),
  baseBranch: z.string(),
  promptTemplate: z.string(),
  autoPush: z.boolean(),
  autoPr: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Template = z.infer<typeof Template>;

export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  templateId: z.string(),
  templateArgs: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  lastTaskId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Schedule = z.infer<typeof Schedule>;

export const Message = z.object({
  id: z.string(),
  taskId: z.string(),
  role: z.enum(["user", "agent", "tool", "system"]),
  content: z.string(),
  ts: z.number(),
});
export type Message = z.infer<typeof Message>;

export const AgentEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    role: z.enum(["agent", "system"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    tool: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
  z.object({
    kind: z.literal("permission_request"),
    id: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal("status"),
    status: TaskStatus,
  }),
  z.object({
    kind: z.literal("raw"),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("exit"),
    code: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("usage"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    costUsd: z.number().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const CreateTaskRequest = z.object({
  agent: AgentKind,
  repoPath: z.string().min(1),
  baseBranch: z.string().default("main"),
  prompt: z.string().min(1),
  title: z.string().optional(),
  autoPush: z.boolean().optional(),
  autoPr: z.boolean().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CreateTemplateRequest = z.object({
  name: z.string().min(1),
  agent: AgentKind,
  repoPath: z.string().min(1),
  baseBranch: z.string().default("main"),
  promptTemplate: z.string().min(1),
  autoPush: z.boolean().default(false),
  autoPr: z.boolean().default(false),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>;

export const RunTemplateRequest = z.object({
  args: z.record(z.string(), z.string()).default({}),
  titleOverride: z.string().optional(),
});
export type RunTemplateRequest = z.infer<typeof RunTemplateRequest>;

export const CreateScheduleRequest = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  templateId: z.string().min(1),
  templateArgs: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const SendInputRequest = z.object({
  text: z.string(),
});
export type SendInputRequest = z.infer<typeof SendInputRequest>;

export const ApprovePermissionRequest = z.object({
  requestId: z.string(),
  decision: z.enum(["allow", "deny", "always"]),
});
export type ApprovePermissionRequest = z.infer<typeof ApprovePermissionRequest>;

export const PairExchangeRequest = z.object({
  pairingToken: z.string(),
  deviceLabel: z.string(),
});
export type PairExchangeRequest = z.infer<typeof PairExchangeRequest>;

export const PairExchangeResponse = z.object({
  sessionToken: z.string(),
  expiresAt: z.number(),
});
export type PairExchangeResponse = z.infer<typeof PairExchangeResponse>;

export const WsServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    taskId: z.string(),
    event: AgentEvent,
    ts: z.number(),
  }),
  z.object({
    type: z.literal("task_updated"),
    task: Task,
  }),
  z.object({
    type: z.literal("hello"),
    serverVersion: z.string(),
  }),
]);
export type WsServerEvent = z.infer<typeof WsServerEvent>;
