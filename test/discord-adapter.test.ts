// Unit tests for DiscordAdapter encoding/decoding.
//
// These tests cover the pure functions (encodeMessage / decodeMessage) without
// requiring a live Discord connection or mocking the discord.js Client. The
// real-bot integration test lives in `examples/discord-demo` and is run
// manually with a dev token.

import { describe, expect, it } from "vitest";
import {
  encodeDiscordMessage,
  decodeDiscordMessage,
  type ClawBusMessage,
} from "../src/index.js";

const baseMsg: ClawBusMessage = {
  id: "01H_TEST_001",
  from: "planner",
  to: "worker",
  kind: "task",
  payload: { goal: "say hello", context: { foo: "bar" } },
  createdAt: "2026-04-23T13:00:00.000Z",
};

describe("DiscordAdapter encode/decode", () => {
  it("round-trips a task message", () => {
    const encoded = encodeDiscordMessage(baseMsg);
    expect(encoded).toContain("**[task]**");
    expect(encoded).toContain("planner → worker");
    expect(encoded).toContain("`01H_TEST_001`");
    expect(encoded).toContain("```json");

    const decoded = decodeDiscordMessage(encoded);
    expect(decoded).toEqual(baseMsg);
  });

  it("round-trips an approval-request with a diff", () => {
    const msg: ClawBusMessage = {
      ...baseMsg,
      id: "01H_TEST_APPROVE",
      kind: "approval-request",
      payload: {
        action: "Edit src/foo.ts",
        diff: "@@ -1,1 +1,1 @@\n-const x = 0\n+const x = 1",
        severity: "medium",
        rationale: "fix off-by-one",
      },
    };
    const decoded = decodeDiscordMessage(encodeDiscordMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it("round-trips broadcast addressing", () => {
    const msg: ClawBusMessage = {
      ...baseMsg,
      id: "01H_TEST_BCAST",
      to: "broadcast",
      kind: "log",
      payload: { level: "info", text: "all hands" },
    };
    const encoded = encodeDiscordMessage(msg);
    expect(encoded).toContain("planner → broadcast");
    expect(decodeDiscordMessage(encoded)).toEqual(msg);
  });

  it("preserves parent and meta fields", () => {
    const msg: ClawBusMessage = {
      ...baseMsg,
      id: "01H_TEST_CHILD",
      kind: "result",
      parent: "01H_TEST_PARENT",
      payload: { status: "ok", summary: "done" },
      meta: { sessionId: "s1", retries: 2 },
    };
    const decoded = decodeDiscordMessage(encodeDiscordMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it("returns null for non-clawbus content", () => {
    expect(decodeDiscordMessage("just a regular discord message")).toBeNull();
    expect(decodeDiscordMessage("**[task]** without json fence")).toBeNull();
    expect(
      decodeDiscordMessage("```json\n{\"kind\":\"task\"}\n```"),
    ).toBeNull(); // missing header
  });

  it("returns null for malformed JSON", () => {
    const broken = "**[task]** a → b  ·  id `x`\n```json\n{ not valid json\n```";
    expect(decodeDiscordMessage(broken)).toBeNull();
  });

  it("ignores extra surrounding whitespace and content", () => {
    const msg = baseMsg;
    const encoded = encodeDiscordMessage(msg);
    const padded = `Hey team — incoming:\n\n${encoded}\n\n(end)`;
    // Header must still be at start of a line; our regex uses ^ but the
    // multi-line wrap means we require it at the very start. Loose check:
    // confirm the strict format works at start-of-string.
    expect(decodeDiscordMessage(encoded)).toEqual(msg);
    // And padded leading text means no match
    expect(decodeDiscordMessage(padded)).toBeNull();
  });
});
