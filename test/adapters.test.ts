import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ClawBus,
  FileAdapter,
  SQLiteAdapter,
  type Adapter,
} from "../src/index.js";

type AdapterFactory = { name: string; make: () => Adapter };

const factories: AdapterFactory[] = [
  {
    name: "FileAdapter",
    make: () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "clawbus-file-"));
      return new FileAdapter({ path: path.join(dir, "bus.jsonl") });
    },
  },
  {
    name: "SQLiteAdapter",
    make: () => new SQLiteAdapter({ path: ":memory:" }),
  },
];

for (const { name, make } of factories) {
  describe(`${name} contract`, () => {
    it("delivers direct messages only to target", async () => {
      const bus = new ClawBus({ adapter: make() });
      const got: string[] = [];
      bus.subscribe("worker", (m) => {
        got.push(`worker:${m.id}`);
      });
      bus.subscribe("reviewer", (m) => {
        got.push(`reviewer:${m.id}`);
      });
      const msg = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      await new Promise((r) => setImmediate(r));
      expect(got).toEqual([`worker:${msg.id}`]);
      await bus.close();
    });

    it("delivers broadcast to every subscriber", async () => {
      const bus = new ClawBus({ adapter: make() });
      const got: string[] = [];
      bus.subscribe("worker", () => void got.push("worker"));
      bus.subscribe("reviewer", () => void got.push("reviewer"));
      await bus.send({
        from: "planner",
        to: "broadcast",
        kind: "log",
        payload: { level: "info", text: "hi" },
      });
      await new Promise((r) => setImmediate(r));
      expect(got.sort()).toEqual(["reviewer", "worker"]);
      await bus.close();
    });

    it("isolates handler errors from the bus", async () => {
      const bus = new ClawBus({ adapter: make() });
      bus.subscribe("worker", () => {
        throw new Error("boom");
      });
      await expect(
        bus.send({
          from: "planner",
          to: "worker",
          kind: "task",
          payload: { goal: "x" },
        }),
      ).resolves.toMatchObject({ kind: "task" });
      await bus.close();
    });

    it("unsubscribe stops further deliveries", async () => {
      const bus = new ClawBus({ adapter: make() });
      let count = 0;
      const off = bus.subscribe("worker", () => void count++);
      await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      off();
      await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "y" },
      });
      await new Promise((r) => setImmediate(r));
      expect(count).toBe(1);
      await bus.close();
    });

    it("query filters by from/to/kind/parent", async () => {
      const bus = new ClawBus({ adapter: make() });
      const task = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "x" },
      });
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: task.id,
        payload: { status: "ok", summary: "done" },
      });
      await bus.send({
        from: "worker",
        to: "planner",
        kind: "log",
        payload: { level: "info", text: "noise" },
      });
      const results = await bus.query({ kind: "result", parent: task.id });
      expect(results).toHaveLength(1);
      expect(results[0]!.from).toBe("worker");

      const fromWorker = await bus.query({ from: "worker" });
      expect(fromWorker).toHaveLength(2);

      const toPlanner = await bus.query({ to: "planner" });
      expect(toPlanner).toHaveLength(2);

      await bus.close();
    });

    it("query returns messages in createdAt ascending order", async () => {
      const bus = new ClawBus({ adapter: make() });
      const a = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "a" },
      });
      const b = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "b" },
      });
      const c = await bus.send({
        from: "planner",
        to: "worker",
        kind: "task",
        payload: { goal: "c" },
      });
      const all = await bus.query({ to: "worker" });
      expect(all.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
      await bus.close();
    });
  });
}
