import { describe, expect, it } from "vitest";
import { ClawBus, FileAdapter } from "../src/index.js";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function tmpFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawbus-core-"));
  return path.join(dir, "bus.jsonl");
}

describe("ClawBus core semantics", () => {
  it("assigns id and createdAt on send", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
    const msg = await bus.send({
      from: "planner",
      to: "worker",
      kind: "task",
      payload: { goal: "hello" },
    });
    expect(msg.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Date(msg.createdAt).toString()).not.toBe("Invalid Date");
    await bus.close();
  });

  it("rejects send without from and without defaultFrom", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
    await expect(
      bus.send({ to: "worker", kind: "log", payload: { level: "info", text: "hi" } }),
    ).rejects.toThrow(/from.*required/);
    await bus.close();
  });

  it("uses defaultFrom when send.from is omitted", async () => {
    const bus = new ClawBus({
      adapter: new FileAdapter({ path: tmpFile() }),
      defaultFrom: "planner",
    });
    const msg = await bus.send({ to: "worker", kind: "task", payload: { goal: "x" } });
    expect(msg.from).toBe("planner");
    await bus.close();
  });

  it("rejects reserved `system` agent id", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
    await expect(
      bus.send({ from: "system", to: "worker", kind: "log", payload: {} }),
    ).rejects.toThrow(/system/);
    await expect(
      bus.send({ from: "planner", to: "system", kind: "log", payload: {} }),
    ).rejects.toThrow(/system/);
    await bus.close();
  });

  it("rejects `broadcast` as from", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
    await expect(
      bus.send({ from: "broadcast", to: "worker", kind: "log", payload: {} }),
    ).rejects.toThrow(/broadcast/);
    await bus.close();
  });

  it("waitFor resolves to a past message if it already exists", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
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
    const result = await bus.waitFor({
      parent: task.id,
      kind: "result",
      timeoutMs: 100,
    });
    expect(result.kind).toBe("result");
    expect(result.parent).toBe(task.id);
    await bus.close();
  });

  it("waitFor resolves to a future message via subscription", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
    const task = await bus.send({
      from: "planner",
      to: "worker",
      kind: "task",
      payload: { goal: "x" },
    });
    const waitPromise = bus.waitFor({
      to: "planner",
      parent: task.id,
      kind: "result",
      timeoutMs: 1000,
    });
    setTimeout(() => {
      void bus.send({
        from: "worker",
        to: "planner",
        kind: "result",
        parent: task.id,
        payload: { status: "ok", summary: "done" },
      });
    }, 10);
    const result = await waitPromise;
    expect(result.kind).toBe("result");
    await bus.close();
  });

  it("waitFor times out when no match", async () => {
    const bus = new ClawBus({ adapter: new FileAdapter({ path: tmpFile() }) });
    await expect(
      bus.waitFor({ kind: "result", parent: "nope", timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
    await bus.close();
  });
});
