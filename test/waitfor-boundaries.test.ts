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
      // Subscription is registered after the (async) past-query; let it settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(spy.live).toBe(1);
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
      const bus = new ClawBus({ adapter: make() });
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
      await new Promise((r) => setTimeout(r, 10));
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
      const bus = new ClawBus({ adapter: make() });
      const pa = bus.waitFor({ to: "planner", parent: "A", kind: "result", timeoutMs: 1000 });
      const pb = bus.waitFor({ to: "planner", parent: "B", kind: "result", timeoutMs: 1000 });
      await new Promise((r) => setTimeout(r, 10));
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
      const bus = new ClawBus({ adapter: make() });
      const p = bus.waitFor({ to: "broadcast", kind: "log", timeoutMs: 1000 });
      await new Promise((r) => setTimeout(r, 10));
      const sent = await bus.send({
        from: "planner",
        to: "broadcast",
        kind: "log",
        payload: { level: "info", text: "hi" },
      });
      expect((await p).id).toBe(sent.id);
      await bus.close();
    });

    // docs/protocol.md §6 documents `waitFor({ parent?, kind?, from?, timeoutMs? })`
    // — i.e. `to` is optional — and says it "resolves with the first matching
    // future message". This pins that documented contract.
    it("waitFor without `to` resolves for a future message addressed to a specific agent", async () => {
      const bus = new ClawBus({ adapter: make() });
      const task = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      const p = bus.waitFor({ parent: task.id, kind: "result", timeoutMs: 300 });
      await new Promise((r) => setTimeout(r, 10));
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

    it("waitFor without `to` stops polling after timeout and after resolution", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      await expect(
        bus.waitFor({ kind: "result", parent: "nope", timeoutMs: 60 }),
      ).rejects.toThrow(/timed out/);
      expect(spy.live).toBe(0);
      const afterTimeout = spy.queryCalls;
      await new Promise((r) => setTimeout(r, 100));
      expect(spy.queryCalls).toBe(afterTimeout);

      const p = bus.waitFor({ kind: "result", parent: "P", timeoutMs: 1000 });
      await new Promise((r) => setTimeout(r, 10));
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: "P",
        payload: { status: "ok", summary: "done" },
      });
      await p;
      const afterResolve = spy.queryCalls;
      await new Promise((r) => setTimeout(r, 100));
      expect(spy.queryCalls).toBe(afterResolve);
      await bus.close();
    });

    it("waitFor without `to` rejects (does not hang or leak a poller) if the bus is closed meanwhile", async () => {
      const spy = new SpyAdapter(make());
      const bus = new ClawBus({ adapter: spy });
      const p = bus.waitFor({ kind: "result", parent: "never" });
      await new Promise((r) => setTimeout(r, 10));
      await bus.close();
      await expect(p).rejects.toThrow(/closed/);
    });
  });
}
