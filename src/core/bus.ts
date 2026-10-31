import { monotonicFactory } from "ulid";
import type { Adapter, Handler, Unsubscribe } from "./adapter.js";

// Monotonic ULIDs guarantee that ids generated within the same millisecond
// still sort in generation order — critical for deterministic message
// ordering in adapters that tiebreak by id (e.g. SQLite `ORDER BY id`).
const ulid = monotonicFactory();
import {
  BROADCAST,
  ClawBusMessageSchema,
  matchesFilter,
  type AgentId,
  type AgentIdOrBroadcast,
  type ClawBusMessage,
  type MessageFilter,
  type MessageKind,
} from "./types.js";

export interface SendInput {
  from?: AgentId;
  to: AgentIdOrBroadcast;
  kind: MessageKind;
  payload: unknown;
  parent?: string;
  meta?: Record<string, unknown>;
}

export interface WaitForOptions extends MessageFilter {
  timeoutMs?: number;
}

export interface ClawBusOptions {
  adapter: Adapter;
  defaultFrom?: AgentId;
  now?: () => Date;
}

export class ClawBus {
  readonly adapter: Adapter;
  private readonly defaultFrom: AgentId | undefined;
  private readonly now: () => Date;

  constructor(opts: ClawBusOptions) {
    this.adapter = opts.adapter;
    this.defaultFrom = opts.defaultFrom;
    this.now = opts.now ?? (() => new Date());
  }

  async send(input: SendInput): Promise<ClawBusMessage> {
    const from = input.from ?? this.defaultFrom;
    if (!from) {
      throw new Error(
        "ClawBus.send: `from` is required (or set `defaultFrom` on the bus).",
      );
    }
    if (input.to === "system" || from === "system") {
      throw new Error("agent id `system` is reserved for the bus");
    }
    if (from === BROADCAST) {
      throw new Error("`from` cannot be `broadcast`");
    }
    const msg: ClawBusMessage = {
      id: ulid(),
      from,
      to: input.to,
      kind: input.kind,
      payload: input.payload,
      createdAt: this.now().toISOString(),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
    ClawBusMessageSchema.parse(msg);
    await this.adapter.append(msg);
    return msg;
  }

  subscribe(agentId: AgentId, handler: Handler): Unsubscribe {
    return this.adapter.subscribe(agentId, handler);
  }

  async query(filter: MessageFilter = {}): Promise<ClawBusMessage[]> {
    return this.adapter.query(filter);
  }

  /**
   * Resolve with the first message matching `filter`. Checks past messages
   * first (via `query`) so late callers do not miss responses that already
   * arrived; then waits for future deliveries via a temporary subscription.
   */
  async waitFor(opts: WaitForOptions): Promise<ClawBusMessage> {
    const { timeoutMs, ...filter } = opts;

    const past = await this.adapter.query(filter);
    if (past.length > 0) {
      return past[0]!;
    }

    return new Promise<ClawBusMessage>((resolve, reject) => {
      let settled = false;
      let unsubscribe: Unsubscribe | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (unsubscribe) unsubscribe();
      };

      // Subscribe to whichever agent `to` points at. For broadcast-only filters
      // we need a synthetic agent id that the adapter will still deliver to;
      // by convention use the filter.to, falling back to broadcast.
      const subscribeTarget: AgentId =
        filter.to !== undefined && filter.to !== BROADCAST
          ? filter.to
          : "__waitfor__";

      unsubscribe = this.adapter.subscribe(subscribeTarget, (msg) => {
        if (settled) return;
        if (!matchesFilter(msg, filter)) return;
        settled = true;
        cleanup();
        resolve(msg);
      });

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(
              `ClawBus.waitFor: timed out after ${timeoutMs}ms waiting for ${JSON.stringify(
                filter,
              )}`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}
