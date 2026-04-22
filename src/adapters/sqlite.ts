// Load node:sqlite via createRequire at runtime. Vite/Vitest's static import
// resolver does not yet list `node:sqlite` as a built-in, but the Node runtime
// absolutely has it (22.5+). createRequire sidesteps the bundler entirely.
import { createRequire } from "node:module";
import * as path from "node:path";
import { mkdirSync } from "node:fs";
import type { Adapter, Handler, Unsubscribe } from "../core/adapter.js";

const nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;
type StatementSyncType = ReturnType<DatabaseSyncType["prepare"]>;
import {
  BROADCAST,
  ClawBusMessageSchema,
  type AgentId,
  type ClawBusMessage,
  type MessageFilter,
} from "../core/types.js";

export interface SQLiteAdapterOptions {
  /** Path to the SQLite file. `:memory:` works for tests. */
  path: string;
}

/**
 * SQLiteAdapter persists messages to a single SQLite file using Node's built-in
 * `node:sqlite` (available in Node 22.5+, no native compile step). Writes are
 * synchronous for durability; deliveries are async.
 */
export class SQLiteAdapter implements Adapter {
  private readonly db: DatabaseSyncType;
  private readonly insertStmt: StatementSyncType;
  private readonly subscribers = new Map<AgentId, Set<Handler>>();
  private closed = false;

  constructor(opts: SQLiteAdapterOptions) {
    if (opts.path !== ":memory:") {
      const abs = path.resolve(opts.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      this.db = new DatabaseSync(abs);
    } else {
      this.db = new DatabaseSync(":memory:");
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        parent TEXT,
        created_at TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);
      CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind);
      CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO messages (id, from_id, to_id, kind, payload, parent, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  async append(msg: ClawBusMessage): Promise<void> {
    if (this.closed) throw new Error("SQLiteAdapter: already closed");
    ClawBusMessageSchema.parse(msg);
    this.insertStmt.run(
      msg.id,
      msg.from,
      msg.to,
      msg.kind,
      JSON.stringify(msg.payload ?? null),
      msg.parent ?? null,
      msg.createdAt,
      msg.meta ? JSON.stringify(msg.meta) : null,
    );
    await this.deliver(msg);
  }

  subscribe(agentId: AgentId, handler: Handler): Unsubscribe {
    if (this.closed) throw new Error("SQLiteAdapter: already closed");
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
    if (this.closed) throw new Error("SQLiteAdapter: already closed");
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.from !== undefined) {
      clauses.push("from_id = ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      clauses.push("to_id = ?");
      params.push(filter.to);
    }
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.parent !== undefined) {
      clauses.push("parent = ?");
      params.push(filter.parent);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, from_id, to_id, kind, payload, parent, created_at, meta
         FROM messages ${where}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...params) as Array<{
      id: string;
      from_id: string;
      to_id: string;
      kind: ClawBusMessage["kind"];
      payload: string;
      parent: string | null;
      created_at: string;
      meta: string | null;
    }>;
    return rows.map((r) => {
      const msg: ClawBusMessage = {
        id: r.id,
        from: r.from_id,
        to: r.to_id,
        kind: r.kind,
        payload: JSON.parse(r.payload),
        createdAt: r.created_at,
      };
      if (r.parent) msg.parent = r.parent;
      if (r.meta) msg.meta = JSON.parse(r.meta);
      return msg;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    this.db.close();
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
        // eslint-disable-next-line no-console
        console.error("[clawbus:SQLiteAdapter] handler threw:", err);
      }
    }
  }
}
