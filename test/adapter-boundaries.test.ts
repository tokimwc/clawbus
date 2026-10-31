import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ClawBus,
  FileAdapter,
  SQLiteAdapter,
  type Adapter,
  type ClawBusMessage,
} from "../src/index.js";

const tmpDirs: string[] = [];
function tmpPath(file: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawbus-ab-"));
  tmpDirs.push(dir);
  return path.join(dir, file);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = "2026-01-01T00:00:00.000Z";
function msg(id: string, over: Partial<ClawBusMessage> = {}): ClawBusMessage {
  return {
    id,
    from: "planner",
    to: "worker",
    kind: "task",
    payload: { goal: id },
    createdAt: T0,
    ...over,
  };
}

/** File-backed factories: `make(p)` always opens the same on-disk path `p`. */
const persistent: Array<{ name: string; file: string; make: (p: string) => Adapter }> = [
  { name: "FileAdapter", file: "bus.jsonl", make: (p) => new FileAdapter({ path: p }) },
  { name: "SQLiteAdapter", file: "bus.sqlite", make: (p) => new SQLiteAdapter({ path: p }) },
];

for (const { name, file, make } of persistent) {
  describe(`${name} persistence & lifecycle`, () => {
    it("reopening the same path returns previously appended messages intact", async () => {
      const p = tmpPath(file);
      const first = make(p);
      const full = msg("01A", {
        to: "broadcast",
        kind: "result",
        parent: "01PARENT",
        payload: { status: "ok", summary: "日本語 ✓", nested: { n: [1, 2, null] } },
        meta: { protocolVersion: "0", tag: "x" },
      });
      await first.append(full);
      await first.append(msg("01B", { createdAt: "2026-01-01T00:00:01.000Z" }));
      await first.close();

      const second = make(p);
      const all = await second.query({});
      expect(all.map((m) => m.id)).toEqual(["01A", "01B"]);
      expect(all[0]).toEqual(full);
      await second.close();
    });

    it("an adapter reopened after close accepts new appends after existing ones", async () => {
      const p = tmpPath(file);
      const a = make(p);
      await a.append(msg("01A"));
      await a.close();
      const b = make(p);
      await b.append(msg("01B", { createdAt: "2026-01-01T00:00:01.000Z" }));
      expect((await b.query({})).map((m) => m.id)).toEqual(["01A", "01B"]);
      expect(await b.query({ kind: "result" })).toEqual([]);
      await b.close();
    });

    it("subscriptions do not persist across reopen; only new subscribers get new messages", async () => {
      const p = tmpPath(file);
      const a = make(p);
      let oldCount = 0;
      a.subscribe("worker", () => void oldCount++);
      await a.append(msg("01A"));
      await a.close();

      const b = make(p);
      let newCount = 0;
      b.subscribe("worker", () => void newCount++);
      await b.append(msg("01B", { createdAt: "2026-01-01T00:00:01.000Z" }));
      expect(oldCount).toBe(1);
      expect(newCount).toBe(1); // history is not replayed to new subscribers
      await b.close();
    });

    it("creates missing parent directories and an empty store queries as []", async () => {
      const p = path.join(path.dirname(tmpPath(file)), "deep", "er", file);
      const a = make(p);
      expect(await a.query({})).toEqual([]);
      await a.append(msg("01A"));
      expect(existsSync(p)).toBe(true);
      await a.close();
    });

    it("append / subscribe / query reject or throw after close", async () => {
      const a = make(tmpPath(file));
      await a.append(msg("01A"));
      await a.close();
      await expect(a.append(msg("01B"))).rejects.toThrow(/already closed/);
      await expect(a.query({})).rejects.toThrow(/already closed/);
      expect(() => a.subscribe("worker", () => {})).toThrow(/already closed/);
    });

    it("a rejected append after close is not persisted", async () => {
      const p = tmpPath(file);
      const a = make(p);
      await a.append(msg("01A"));
      await a.close();
      await a.append(msg("01B")).catch(() => {});
      const b = make(p);
      expect((await b.query({})).map((m) => m.id)).toEqual(["01A"]);
      await b.close();
    });

    it("ClawBus.close then ClawBus.send rejects and does not deliver", async () => {
      const bus = new ClawBus({ adapter: make(tmpPath(file)) });
      let delivered = 0;
      bus.subscribe("worker", () => void delivered++);
      await bus.close();
      await expect(
        bus.send({ from: "planner", to: "worker", kind: "task", payload: { goal: "x" } }),
      ).rejects.toThrow(/already closed/);
      expect(delivered).toBe(0);
    });

    it("rejects schema-invalid messages without persisting them", async () => {
      const p = tmpPath(file);
      const a = make(p);
      await expect(a.append(msg("01A", { from: "bad agent!" }))).rejects.toThrow();
      expect(await a.query({})).toEqual([]);
      await a.close();
    });
  });
}

const both: Array<{ name: string; make: () => Adapter }> = [
  { name: "FileAdapter", make: () => new FileAdapter({ path: tmpPath("o.jsonl") }) },
  { name: "SQLiteAdapter", make: () => new SQLiteAdapter({ path: ":memory:" }) },
];

for (const { name, make } of both) {
  describe(`${name} ordering & subscription edge cases`, () => {
    it("concurrent sends at the same timestamp are all stored and returned exactly once", async () => {
      const fixed = new Date(T0);
      const bus = new ClawBus({ adapter: make(), now: () => fixed });
      const sent = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          bus.send({
            from: "planner",
            to: "worker",
            kind: "task",
            payload: { goal: String(i) },
          }),
        ),
      );
      const got = (await bus.query({ to: "worker" })).map((m) => m.id);
      // Order among equal createdAt is not part of the protocol; only presence is.
      expect(got).toHaveLength(50);
      expect([...got].sort()).toEqual(sent.map((m) => m.id).sort());
      await bus.close();
    });

    it("query orders by createdAt ascending even if the clock steps backwards", async () => {
      const times = [
        "2026-01-01T00:00:03.000Z",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
      ];
      let i = 0;
      const bus = new ClawBus({ adapter: make(), now: () => new Date(times[i++]!) });
      for (const g of ["c", "a", "b"]) {
        await bus.send({ from: "planner", to: "worker", kind: "task", payload: { goal: g } });
      }
      const goals = (await bus.query({})).map((m) => (m.payload as { goal: string }).goal);
      expect(goals).toEqual(["a", "b", "c"]);
      await bus.close();
    });

    it("unsubscribe is idempotent and does not affect other handlers of the same agent", async () => {
      const a = make();
      let h1 = 0;
      let h2 = 0;
      const off1 = a.subscribe("worker", () => void h1++);
      a.subscribe("worker", () => void h2++);
      off1();
      off1();
      await a.append(msg("01A"));
      expect([h1, h2]).toEqual([0, 1]);
      await a.close();
    });

    it("a handler may unsubscribe itself during delivery; the rest still run", async () => {
      const a = make();
      const calls: string[] = [];
      const off = a.subscribe("worker", () => {
        calls.push("self");
        off();
      });
      a.subscribe("worker", () => void calls.push("other"));
      await a.append(msg("01A"));
      await a.append(msg("01B", { createdAt: "2026-01-01T00:00:01.000Z" }));
      expect(calls).toEqual(["self", "other", "other"]);
      await a.close();
    });

    it("an async handler that rejects does not block later handlers or the append", async () => {
      const a = make();
      const calls: string[] = [];
      a.subscribe("worker", async () => {
        await Promise.resolve();
        throw new Error("async boom");
      });
      a.subscribe("worker", () => void calls.push("ok"));
      await expect(a.append(msg("01A"))).resolves.toBeUndefined();
      expect(calls).toEqual(["ok"]);
      await a.close();
    });

  });
}

describe("FileAdapter append concurrency", () => {
  it("many concurrent appends yield one intact JSON line each", async () => {
    const p = tmpPath("c.jsonl");
    const a = new FileAdapter({ path: p });
    const N = 100;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        a.append(msg(`01${String(i).padStart(3, "0")}`, { payload: { goal: "x".repeat(5000) } })),
      ),
    );
    const all = await a.query({});
    expect(all).toHaveLength(N);
    expect(new Set(all.map((m) => m.id)).size).toBe(N);
    await a.close();
  });
});

// Behaviour of the current implementation that the protocol text does not
// promise. Kept as passing observations (so a change is noticed), not as contract.
for (const { name, make } of both) {
  describe(`${name} implementation observations, non-normative`, () => {
    it("equal-createdAt messages currently come back in send (monotonic ULID) order", async () => {
      const fixed = new Date(T0);
      const bus = new ClawBus({ adapter: make(), now: () => fixed });
      const sent: string[] = [];
      for (let i = 0; i < 30; i++) {
        const m = await bus.send({
          from: "planner",
          to: "worker",
          kind: "task",
          payload: { goal: String(i) },
        });
        sent.push(m.id);
      }
      expect((await bus.query({})).map((m) => m.id)).toEqual(sent);
      await bus.close();
    });

    it("concurrent equal-createdAt sends currently come back in id order", async () => {
      const fixed = new Date(T0);
      const bus = new ClawBus({ adapter: make(), now: () => fixed });
      try {
        const sent = await Promise.all(
          Array.from({ length: 50 }, () =>
            bus.send({ from: "planner", to: "worker", kind: "task", payload: {} }),
          ),
        );
        const got = (await bus.query({ to: "worker" })).map((m) => m.id);
        expect(got).toEqual(sent.map((m) => m.id));
      } finally {
        await bus.close();
      }
    });
  });
}

describe("unconfirmed behaviours (spec is silent — not asserted)", () => {
  it.todo("duplicate message id: FileAdapter appends a second line, SQLiteAdapter rejects with a UNIQUE-constraint error — protocol.md does not say which is right, nor the error text");
  it.todo("an adapter subscribed under the agent id \"broadcast\" also receives direct messages to other agents (both adapters) — §3/§5 do not define subscribing as \"broadcast\"");
  it.todo("order of equal-createdAt messages from query() is not part of the protocol (§5 only promises createdAt ascending); see the non-normative observations above");
  it.todo("SQLiteAdapter.close() twice throws 'database is not open' while FileAdapter.close() twice is a no-op — idempotent close is unspecified");
  it.todo("waitFor({ timeoutMs: 0 }) is currently treated as 'no timeout' — protocol.md does not define 0");
  it.todo("FileAdapter.query on a file with a truncated/corrupt JSONL line throws SyntaxError — recovery policy is unspecified");
  it.todo("protocol.md §5 says handler errors should be logged as system→log messages; adapters only console.error today");
  it.todo("protocol.md invariant 4 (parent must reference an existing message) is not enforced by bus or adapters");
});
