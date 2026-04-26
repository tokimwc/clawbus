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
