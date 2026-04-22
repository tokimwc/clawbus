import type { AgentId, ClawBusMessage, MessageFilter } from "./types.js";

export type Unsubscribe = () => void;

export type Handler = (msg: ClawBusMessage) => void | Promise<void>;

export interface Adapter {
  append(msg: ClawBusMessage): Promise<void>;
  subscribe(agentId: AgentId, handler: Handler): Unsubscribe;
  query(filter: MessageFilter): Promise<ClawBusMessage[]>;
  close(): Promise<void>;
}
