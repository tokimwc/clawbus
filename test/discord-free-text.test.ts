// Unit tests for DiscordAdapter free-text channel feature.
//
// These tests cover the **construction-time validation** for the new
// freeTextChannelId / freeTextAllowedUserIds / freeTextToMessage options.
// Runtime behavior (routeIncomingMessage + handleFreeTextMessage) requires
// a Discord client mock or extracting a pure helper; covered in a later iteration.
//
// See docs/design/free-text-channel.md.

import { describe, expect, it } from "vitest";
import {
  DiscordAdapter,
  type DiscordAdapterOptions,
  type ClawBusMessage,
  type FreeTextInput,
  type FreeTextDecisionInput,
  prepareFreeTextMessage,
} from "../src/index.js";

const baseOpts: DiscordAdapterOptions = {
  token: "test-token-not-real",
  channelId: "111111111111111111",
  cachePath: ":memory:",
};

const validTranslator = (_: FreeTextInput): ClawBusMessage => ({
  id: "01H_TEST_FREETEXT",
  from: "user",
  to: "worker",
  kind: "task",
  payload: { goal: "test" },
  createdAt: "2026-04-26T07:00:00.000Z",
});

describe("DiscordAdapter free-text channel — construction validation", () => {
  it("does not throw when freeTextChannelId is unset (backward compatible)", () => {
    expect(() => new DiscordAdapter(baseOpts)).not.toThrow();
  });

  it("throws when freeTextChannelId equals channelId (channel collision)", () => {
    expect(
      () =>
        new DiscordAdapter({
          ...baseOpts,
          freeTextChannelId: baseOpts.channelId,
          freeTextAllowedUserIds: ["222222222222222222"],
          freeTextToMessage: validTranslator,
        }),
    ).toThrow(/freeTextChannelId must differ from channelId/);
  });

  it("throws when freeTextAllowedUserIds is missing", () => {
    expect(
      () =>
        new DiscordAdapter({
          ...baseOpts,
          freeTextChannelId: "333333333333333333",
          freeTextToMessage: validTranslator,
        } as DiscordAdapterOptions),
    ).toThrow(/freeTextAllowedUserIds must be a non-empty array/);
  });

  it("throws when freeTextAllowedUserIds is empty (silent zero-sender footgun)", () => {
    expect(
      () =>
        new DiscordAdapter({
          ...baseOpts,
          freeTextChannelId: "333333333333333333",
          freeTextAllowedUserIds: [],
          freeTextToMessage: validTranslator,
        }),
    ).toThrow(/freeTextAllowedUserIds must be a non-empty array/);
  });

  it("throws when freeTextToMessage is missing", () => {
    expect(
      () =>
        new DiscordAdapter({
          ...baseOpts,
          freeTextChannelId: "333333333333333333",
          freeTextAllowedUserIds: ["222222222222222222"],
        } as DiscordAdapterOptions),
    ).toThrow(/freeTextToMessage callback is required/);
  });

  it("does not throw when all three free-text fields are valid", () => {
    expect(
      () =>
        new DiscordAdapter({
          ...baseOpts,
          freeTextChannelId: "333333333333333333",
          freeTextAllowedUserIds: ["222222222222222222"],
          freeTextToMessage: validTranslator,
        }),
    ).not.toThrow();
  });
});

const baseInput: FreeTextDecisionInput = {
  content: "summarize my kanban backlog",
  authorId: "222222222222222222",
  authorName: "toki",
  authorIsBot: false,
  messageId: "999999999999999999",
  timestamp: new Date("2026-04-26T07:00:00.000Z"),
};

const allowed = ["222222222222222222"] as const;

describe("prepareFreeTextMessage — runtime decision logic", () => {
  it("ignores bot authors with reason 'bot'", () => {
    const decision = prepareFreeTextMessage(
      { ...baseInput, authorIsBot: true },
      allowed,
      validTranslator,
    );
    expect(decision).toEqual({ action: "ignore", reason: "bot" });
  });

  it("ignores authors not in the allowlist with reason 'not-allowed'", () => {
    const decision = prepareFreeTextMessage(
      { ...baseInput, authorId: "888888888888888888" },
      allowed,
      validTranslator,
    );
    expect(decision).toEqual({ action: "ignore", reason: "not-allowed" });
  });

  it("ignores when the translator throws, capturing the error", () => {
    const boom = new Error("translator boom");
    const decision = prepareFreeTextMessage(
      baseInput,
      allowed,
      () => {
        throw boom;
      },
    );
    expect(decision).toMatchObject({
      action: "ignore",
      reason: "translator-threw",
      error: boom,
    });
  });

  it("ignores when the translator returns null with reason 'translator-null'", () => {
    const decision = prepareFreeTextMessage(
      baseInput,
      allowed,
      () => null,
    );
    expect(decision).toEqual({ action: "ignore", reason: "translator-null" });
  });

  it("ignores when the translator returns a malformed ClawBusMessage", () => {
    const decision = prepareFreeTextMessage(
      baseInput,
      allowed,
      // @ts-expect-error deliberately invalid for this test
      () => ({ id: "x", from: "user", to: "worker" }), // missing kind, payload, createdAt
    );
    expect(decision.action).toBe("ignore");
    if (decision.action === "ignore") {
      expect(decision.reason).toBe("invalid-schema");
    }
  });

  it("returns 'append' with the validated ClawBusMessage on the happy path", () => {
    const decision = prepareFreeTextMessage(
      baseInput,
      allowed,
      validTranslator,
    );
    expect(decision.action).toBe("append");
    if (decision.action === "append") {
      expect(decision.message.kind).toBe("task");
      expect(decision.message.from).toBe("user");
      expect(decision.message.to).toBe("worker");
    }
  });
});
