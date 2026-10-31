import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ClawBus,
  FileAdapter,
  SQLiteAdapter,
  type Adapter,
  type Handler,
  type Unsubscribe,
} from "../src/index.js";

const tmpDirs: string[] = [];
function tmpFile(name = "bus.jsonl"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawbus-wf-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Resolves once `pred()` is true (polled each macrotask); fails loudly instead of sleeping blind. */
async function until(pred: () => boolean, what: string, limitMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > limitMs) throw new Error(`until: timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** Wraps an adapter and tracks how many subscriptions are currently live. */
class SpyAdapter implements Adapter {
  live = 0;
  queryCalls = 0;
  subscribeCalls: string[] = [];
  constructor(private readonly inner: Adapter) {}
  append: Adapter["append"] = (m) => this.inner.append(m);
  query: Adapter["query"] = (f) => {
    this.queryCalls++;
    return this.inner.query(f);
  };
  close: Adapter["close"] = () => this.inner.close();
  subscribe(agentId: string, handler: Handler): Unsubscribe {
    this.subscribeCalls.push(agentId);
    this.live++;
    const off = this.inner.subscribe(agentId, handler);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.live--;
      }
      off();
    };
  }
}

const factories: Array<{ name: string; make: () => Adapter }> = [
  { name: "FileAdapter", make: () => new FileAdapter({ path: tmpFile() }) },
  { name: "SQLiteAdapter", make: () => new SQLiteAdapter({ path: ":memory:" }) },
];

for (const { name, make } of factories) {
  describe(`ClawBus.waitFor boundaries (${name})`, () => {
    it("timeout rejects and releases its temporary subscription", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      await expect(
        bus.waitFor({ to: "planner", kind: "result", parent: "nope", timeoutMs: 30 }),
      ).rejects.toThrow(/timed out after 30ms/);
      expect(spy.subscribeCalls).toEqual(["planner"]);
      expect(spy.live).toBe(0);
      await bus.close();
    });

    it("a message arriving after the timeout is ignored without error", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      await expect(
        bus.waitFor({ to: "planner", kind: "result", timeoutMs: 20 }),
      ).rejects.toThrow(/timed out/);
      await expect(
        bus.send({
          from: "worker",
          to: "planner",
          kind: "result",
          payload: { status: "ok", summary: "late" },
        }),
      ).resolves.toMatchObject({ kind: "result" });
      expect(spy.live).toBe(0);
      await bus.close();
    });

    it("resolving on a future message releases its subscription and ignores later matches", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const p = bus.waitFor({ to: "planner", kind: "result", timeoutMs: 1000 });
      // The subscription is registered only after the (async) past-query.
      await until(() => spy.live === 1, "waitFor subscription");
      const first = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        payload: { status: "ok", summary: "first" },
      });
      const got = await p;
      expect(got.id).toBe(first.id);
      expect(spy.live).toBe(0);
      // A second matching message after completion must not throw or re-resolve.
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        payload: { status: "ok", summary: "second" },
      });
      expect((await p).id).toBe(first.id);
      await bus.close();
    });

    it("future wait skips non-matching messages and resolves on the first match", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const task = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      const p = bus.waitFor({
        to: "planner",
        kind: "result",
        parent: task.id,
        timeoutMs: 1000,
      });
      await until(() => spy.live === 1, "waitFor subscription");
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "log",
        parent: task.id,
        payload: { level: "info", text: "wrong kind" },
      });
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: "someone-else",
        payload: { status: "ok", summary: "wrong parent" },
      });
      const right = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: task.id,
        payload: { status: "ok", summary: "right" },
      });
      expect((await p).id).toBe(right.id);
      await bus.close();
    });

    it("past match wins over later ones and does not subscribe at all", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const a = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        payload: { status: "ok", summary: "a" },
      });
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        payload: { status: "ok", summary: "b" },
      });
      const got = await bus.waitFor({ to: "planner", kind: "result", timeoutMs: 50 });
      expect(got.id).toBe(a.id);
      expect(spy.subscribeCalls).toEqual([]);
      await bus.close();
    });

    it("concurrent waiters with different parents each get their own result", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const pa = bus.waitFor({ to: "planner", parent: "A", kind: "result", timeoutMs: 1000 });
      const pb = bus.waitFor({ to: "planner", parent: "B", kind: "result", timeoutMs: 1000 });
      await until(() => spy.live === 2, "both waitFor subscriptions");
      const b = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: "B",
        payload: { status: "ok", summary: "b" },
      });
      const a = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: "A",
        payload: { status: "ok", summary: "a" },
      });
      expect((await pa).id).toBe(a.id);
      expect((await pb).id).toBe(b.id);
      await bus.close();
    });

    it("waitFor on `to: broadcast` resolves for a future broadcast", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const p = bus.waitFor({ to: "broadcast", kind: "log", timeoutMs: 1000 });
      await until(() => spy.live === 1, "waitFor subscription");
      const sent = await bus.send({
        from: "planner",
        to: "broadcast",
        kind: "log",
        payload: { level: "info", text: "hi" },
      });
      expect((await p).id).toBe(sent.id);
      await bus.close();
    });

    // ---- waitFor without `to` -------------------------------------------
    // docs/protocol.md §6 lists `waitFor({ parent?, kind?, from?, timeoutMs? })`
    // (no `to`) and says it "resolves with the first matching future message".
    // It does not say whether "future message" includes direct messages to an
    // arbitrary agent, so only the parts that follow from §5/§6 are asserted
    // here; the rest is a known failure (below) or a todo.

    it("waitFor without `to` resolves from a past message addressed to any agent", async () => {
      const bus = new ClawBus({ adapter: make() });
      const task = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      const res = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: task.id,
        payload: { status: "ok", summary: "done" },
      });
      await expect(
        bus.waitFor({ parent: task.id, kind: "result", timeoutMs: 300 }),
      ).resolves.toMatchObject({ id: res.id });
      await bus.close();
    });

    it("waitFor without `to` times out and releases its subscription", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      await expect(
        bus.waitFor({ kind: "result", parent: "nope", timeoutMs: 40 }),
      ).rejects.toThrow(/timed out after 40ms/);
      expect(spy.live).toBe(0);
      await bus.close();
    });

    // Known failure, NOT a passing contract: §6 suggests this should resolve,
    // but only subscriptions are used, and a synthetic subscriber sees
    // broadcasts only. `it.fails` passes while the gap exists and starts
    // failing (prompting removal of the marker) once it is fixed.
    // (An earlier revision polled `query` every 25ms to cover this; that was
    // reverted because it kept the process alive and rescanned the whole store.)
    it.fails("KNOWN FAILURE: waitFor without `to` should resolve for a future direct message", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const task = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      const p = bus.waitFor({ parent: task.id, kind: "result", timeoutMs: 300 });
      await until(() => spy.live === 1, "waitFor subscription");
      const res = await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: task.id,
        payload: { status: "ok", summary: "done" },
      });
      await expect(p).resolves.toMatchObject({ id: res.id });
      await bus.close();
    });
  });

  // Observation of how the current code behaves; it is not derived from the
  // protocol text and may change without a spec change.
  describe(`ClawBus.waitFor implementation observations, non-normative (${name})`, () => {
    it("waitFor without `to` currently sees a future broadcast (via a synthetic subscriber)", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const p = bus.waitFor({ kind: "log", timeoutMs: 1000 });
      await until(() => spy.live === 1, "waitFor subscription");
      const sent = await bus.send({
        from: "planner",
        to: "broadcast",
        kind: "log",
        payload: { level: "info", text: "hi" },
      });
      expect((await p).id).toBe(sent.id);
      expect(spy.live).toBe(0);
      await bus.close();
    });
  });
}

describe("waitFor unconfirmed behaviours (spec is silent — not asserted)", () => {
  it.todo("waitFor without `to`: whether a future direct message to any agent must resolve (§6 signature omits `to`; see KNOWN FAILURE above)");
  it.todo("bus.close() while a waitFor is pending: the wait is never settled (no timeout) — with or without `to`; whether it should reject is unspecified");
  it.todo("a waitFor with no/zero timeout holds only a subscription, no timer, so it does not keep the Node process alive — liveness is unspecified");
  it.todo("waitFor without `to`, direct message then broadcast: resolves with the broadcast (the direct one is not observed) — also unspecified");
});
