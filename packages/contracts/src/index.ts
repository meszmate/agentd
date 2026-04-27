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
});
export type Task = z.infer<typeof Task>;

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
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const CreateTaskRequest = z.object({
  agent: AgentKind,
  repoPath: z.string().min(1),
  baseBranch: z.string().default("main"),
  prompt: z.string().min(1),
  title: z.string().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

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
