import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Adapter, Handler, Unsubscribe } from "../core/adapter.js";
import {
  BROADCAST,
  ClawBusMessageSchema,
  matchesFilter,
  type AgentId,
  type ClawBusMessage,
  type MessageFilter,
} from "../core/types.js";

export interface FileAdapterOptions {
  /** Path to the JSONL file that stores all messages. */
  path: string;
}

/**
 * FileAdapter stores messages as JSONL (one message per line) in a single file.
 * Suitable for local development and tests. In-process only — multiple
 * processes pointing at the same file are not supported.
 */
export class FileAdapter implements Adapter {
  private readonly filePath: string;
  private readonly subscribers = new Map<AgentId, Set<Handler>>();
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: FileAdapterOptions) {
    this.filePath = path.resolve(opts.path);
  }

  async append(msg: ClawBusMessage): Promise<void> {
    if (this.closed) throw new Error("FileAdapter: already closed");
    ClawBusMessageSchema.parse(msg);
    const line = JSON.stringify(msg) + "\n";
    // Serialize writes so concurrent appends don't interleave partial lines.
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    });
    await this.writeChain;
    await this.deliver(msg);
  }

  subscribe(agentId: AgentId, handler: Handler): Unsubscribe {
    if (this.closed) throw new Error("FileAdapter: already closed");
    let set = this.subscribers.get(agentId);
    if (!set) {
      set = new Set();
      this.subscribers.set(agentId, set);
    }
    set.add(handler);
    return () => {
      const s = this.subscribers.get(agentId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.subscribers.delete(agentId);
    };
  }

  async query(filter: MessageFilter): Promise<ClawBusMessage[]> {
    if (this.closed) throw new Error("FileAdapter: already closed");
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: ClawBusMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as ClawBusMessage;
      if (matchesFilter(msg, filter)) out.push(msg);
    }
    // createdAt ascending; ULID-based id also sorts monotonically per ms
    out.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    await this.writeChain;
  }

  private async deliver(msg: ClawBusMessage): Promise<void> {
    const targets: Handler[] = [];
    if (msg.to === BROADCAST) {
      for (const set of this.subscribers.values()) targets.push(...set);
    } else {
      const direct = this.subscribers.get(msg.to);
      if (direct) targets.push(...direct);
      const bcast = this.subscribers.get(BROADCAST);
      if (bcast) targets.push(...bcast);
    }
    for (const h of targets) {
      try {
        await h(msg);
      } catch (err) {
        // Handler errors must not crash the bus.
        // eslint-disable-next-line no-console
        console.error("[clawbus:FileAdapter] handler threw:", err);
      }
    }
  }
}
