import { z } from "zod";

export type AgentId = string;
export const BROADCAST = "broadcast" as const;
export type AgentIdOrBroadcast = AgentId | typeof BROADCAST;

export const MESSAGE_KINDS = [
  "task",
  "result",
  "approval-request",
  "approval-decision",
  "log",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface ClawBusMessage {
  id: string;
  from: AgentId;
  to: AgentIdOrBroadcast;
  kind: MessageKind;
  payload: unknown;
  parent?: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface TaskPayload {
  goal: string;
  context?: unknown;
  deadline?: string;
  budget?: { tokens?: number; steps?: number };
}

export interface ResultPayload {
  status: "ok" | "failed" | "partial";
  summary: string;
  artifacts?: Array<{ kind: string; ref: string }>;
  error?: { message: string; code?: string };
}

export interface ApprovalRequestPayload {
  action: string;
  diff?: string;
  severity: "low" | "medium" | "high";
  rationale: string;
  defaultDeny?: boolean;
  timeoutMs?: number;
}

export interface ApprovalDecisionPayload {
  decision: "approve" | "reject";
  reviewer: string;
  note?: string;
}

export interface LogPayload {
  level: "debug" | "info" | "warn" | "error";
  text: string;
  data?: unknown;
}

const AgentIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, "agent id must match [A-Za-z0-9_-]+");

const AgentIdOrBroadcastSchema = z.union([
  AgentIdSchema,
  z.literal(BROADCAST),
]);

export const ClawBusMessageSchema = z.object({
  id: z.string().min(1),
  from: AgentIdSchema,
  to: AgentIdOrBroadcastSchema,
  kind: z.enum(MESSAGE_KINDS),
  payload: z.unknown(),
  parent: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  meta: z.record(z.unknown()).optional(),
});

export type MessageFilter = Partial<
  Pick<ClawBusMessage, "from" | "to" | "kind" | "parent">
>;

export function matchesFilter(
  msg: ClawBusMessage,
  filter: MessageFilter,
): boolean {
  if (filter.from !== undefined && msg.from !== filter.from) return false;
  if (filter.to !== undefined && msg.to !== filter.to) return false;
  if (filter.kind !== undefined && msg.kind !== filter.kind) return false;
  if (filter.parent !== undefined && msg.parent !== filter.parent) return false;
  return true;
}
