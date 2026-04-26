// DiscordAdapter — distributed transport over a single Discord channel.
//
// Wraps an internal SQLiteAdapter for local query speed; uses discord.js v14
// for transport. Each ClawBusMessage becomes a Discord message: a human
// header line plus a JSON code block.
//
// Approval flow: when an `approval-request` is sent, the bot adds ✅ and ❌
// reactions. Reactions from authorized reviewer Discord user IDs are
// translated into `approval-decision` messages and re-posted to the bus.
//
// See docs/discord-adapter-design.md for the full design note.

import { mkdirSync } from "node:fs";
import * as path from "node:path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type User,
} from "discord.js";
import type { Adapter, Handler, Unsubscribe } from "../core/adapter.js";
import {
  BROADCAST,
  ClawBusMessageSchema,
  type AgentId,
  type ClawBusMessage,
  type MessageFilter,
  type ApprovalDecisionPayload,
} from "../core/types.js";
import { SQLiteAdapter } from "./sqlite.js";

export interface DiscordAdapterOptions {
  /** Bot token (NEVER commit). Read from env in production. */
  token: string;
  /** Target channel for all bus traffic. */
  channelId: string;
  /** Optional: local cache path. Defaults to `.clawbus/discord-cache.sqlite`. */
  cachePath?: string;
  /**
   * Optional: list of Discord user IDs allowed to react with approval/reject.
   * Reactions from anyone else are ignored. Default: empty (no one allowed).
   */
  reviewerIds?: string[];
  /** Approval reactions (defaults: ✅ ❌). */
  approveEmoji?: string;
  rejectEmoji?: string;
  /**
   * Optional: separate Discord channel ID to watch for free-text user input.
   * Distinct from `channelId` (bus traffic). When set, messages posted here
   * by allow-listed users are translated via `freeTextToMessage` and
   * appended to the bus.
   * Default: undefined (feature disabled, no behavior change).
   * See docs/design/free-text-channel.md.
   */
  freeTextChannelId?: string;
  /**
   * Discord user IDs allowed to send free-text. Empty = nobody.
   * Required (non-empty) when `freeTextChannelId` is set.
   */
  freeTextAllowedUserIds?: string[];
  /**
   * User-supplied translator: free-text content → ClawBusMessage.
   * Returning `null` means "ignore this message".
   * Required when `freeTextChannelId` is set.
   */
  freeTextToMessage?: (input: FreeTextInput) => ClawBusMessage | null;
}

/** Input passed to the free-text translator callback. */
export interface FreeTextInput {
  /** Raw Discord message body, untrimmed. */
  content: string;
  /** Discord user ID of the sender. */
  authorId: string;
  /** Discord username (display name, not handle). */
  authorName: string;
  /** Discord message ID, useful for audit/dedup. */
  messageId: string;
  /** Message creation timestamp from Discord. */
  timestamp: Date;
}

/** Discord-message header pattern, used for parsing inbound messages. */
const HEADER_RE = /^\*\*\[(?<kind>[a-z-]+)\]\*\* (?<from>[A-Za-z0-9_-]+) → (?<to>[A-Za-z0-9_-]+|broadcast)\s+·\s+id `(?<id>[^`]+)`/;

/** Code-fence pattern that wraps the JSON payload. */
const JSON_FENCE_RE = /```json\n([\s\S]*?)\n```/;

const APPROVE_DEFAULT = "✅";
const REJECT_DEFAULT = "❌";

export class DiscordAdapter implements Adapter {
  private readonly cache: SQLiteAdapter;
  private readonly client: Client;
  private readonly opts: Required<
    Pick<
      DiscordAdapterOptions,
      "channelId" | "approveEmoji" | "rejectEmoji" | "reviewerIds"
    >
  > &
    DiscordAdapterOptions;
  private channel: TextChannel | null = null;
  private readonly subscribers = new Map<AgentId, Set<Handler>>();
  private ready = false;
  private closed = false;
  /** Maps Discord message ID → ClawBus message ID for approval-request handling. */
  private readonly approvalRequestMap = new Map<string, ClawBusMessage>();

  constructor(opts: DiscordAdapterOptions) {
    this.opts = {
      ...opts,
      approveEmoji: opts.approveEmoji ?? APPROVE_DEFAULT,
      rejectEmoji: opts.rejectEmoji ?? REJECT_DEFAULT,
      reviewerIds: opts.reviewerIds ?? [],
    };
    // Validate free-text feature configuration (fail-fast at construction).
    if (opts.freeTextChannelId !== undefined) {
      if (opts.freeTextChannelId === opts.channelId) {
        throw new Error(
          "DiscordAdapter: freeTextChannelId must differ from channelId (mixing free-text and bus protocol on one channel breaks parsing)",
        );
      }
      if (!opts.freeTextAllowedUserIds || opts.freeTextAllowedUserIds.length === 0) {
        throw new Error(
          "DiscordAdapter: freeTextAllowedUserIds must be a non-empty array when freeTextChannelId is set (empty allowlist would silently allow zero senders)",
        );
      }
      if (typeof opts.freeTextToMessage !== "function") {
        throw new Error(
          "DiscordAdapter: freeTextToMessage callback is required when freeTextChannelId is set",
        );
      }
    }
    const cachePath = opts.cachePath ?? ".clawbus/discord-cache.sqlite";
    if (cachePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(cachePath)), { recursive: true });
    }
    this.cache = new SQLiteAdapter({ path: cachePath });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });

    this.client.on("messageCreate", (m) => {
      void this.routeIncomingMessage(m);
    });
    this.client.on("messageReactionAdd", (reaction, user) => {
      void this.handleReaction(reaction, user);
    });
  }

  /**
   * Connect to Discord and resolve when the bot is ready and the target
   * channel has been fetched. Must be called before append/subscribe.
   */
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.closed) throw new Error("DiscordAdapter: already closed");
    await this.client.login(this.opts.token);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) resolve();
      else this.client.once("clientReady", () => resolve());
    });
    const ch = await this.client.channels.fetch(this.opts.channelId);
    if (!ch || !ch.isTextBased() || !("send" in ch)) {
      throw new Error(
        `DiscordAdapter: channel ${this.opts.channelId} is not a sendable text channel`,
      );
    }
    this.channel = ch as TextChannel;
    this.ready = true;
  }

  async append(msg: ClawBusMessage): Promise<void> {
    if (this.closed) throw new Error("DiscordAdapter: already closed");
    if (!this.ready || !this.channel)
      throw new Error("DiscordAdapter: call connect() first");
    ClawBusMessageSchema.parse(msg);

    // 1. Persist to local cache and deliver to local subscribers immediately
    await this.cache.append(msg);
    await this.deliver(msg);

    // 2. Post to Discord transport
    const content = encodeMessage(msg);
    const sent = await this.channel.send({ content });

    // 3. If approval-request, attach reactions and remember mapping
    if (msg.kind === "approval-request") {
      this.approvalRequestMap.set(sent.id, msg);
      try {
        await sent.react(this.opts.approveEmoji);
        await sent.react(this.opts.rejectEmoji);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[clawbus:DiscordAdapter] reaction add failed:", err);
      }
    }
  }

  subscribe(agentId: AgentId, handler: Handler): Unsubscribe {
    if (this.closed) throw new Error("DiscordAdapter: already closed");
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

  query(filter: MessageFilter): Promise<ClawBusMessage[]> {
    return this.cache.query(filter);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    this.approvalRequestMap.clear();
    await this.cache.close();
    if (this.client.isReady()) {
      await this.client.destroy();
    }
  }

  /** Internal: dispatch a message to local subscribers (mirrors SQLiteAdapter). */
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
        console.error("[clawbus:DiscordAdapter] handler threw:", err);
      }
    }
  }

  /**
   * Route inbound Discord messages: free-text channel goes through the
   * translator callback; everything else falls through to the bus parser.
   * See docs/design/free-text-channel.md.
   */
  private async routeIncomingMessage(m: Message): Promise<void> {
    if (
      this.opts.freeTextChannelId !== undefined &&
      m.channelId === this.opts.freeTextChannelId
    ) {
      await this.handleFreeTextMessage(m);
      return;
    }
    await this.handleIncomingMessage(m);
  }

  /** Inbound free-text message → translate → append to bus. */
  private async handleFreeTextMessage(m: Message): Promise<void> {
    if (m.author.bot) return;
    if (m.author.id === this.client.user?.id) return;
    const allowed = this.opts.freeTextAllowedUserIds ?? [];
    if (!allowed.includes(m.author.id)) return;
    const translator = this.opts.freeTextToMessage;
    if (typeof translator !== "function") return;
    let translated: ClawBusMessage | null;
    try {
      translated = translator({
        content: m.content,
        authorId: m.author.id,
        authorName: m.author.username,
        messageId: m.id,
        timestamp: m.createdAt,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[clawbus:DiscordAdapter] freeTextToMessage threw:", err);
      return;
    }
    if (translated === null || translated === undefined) return;
    try {
      ClawBusMessageSchema.parse(translated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[clawbus:DiscordAdapter] freeTextToMessage returned an invalid ClawBusMessage:",
        err,
      );
      return;
    }
    await this.append(translated);
  }

  /** Inbound Discord message → parse → cache → deliver. */
  private async handleIncomingMessage(m: Message): Promise<void> {
    if (m.channelId !== this.opts.channelId) return;
    if (m.author.id === this.client.user?.id) return; // ignore our own posts (already cached)
    const parsed = decodeMessage(m.content);
    if (!parsed) return; // not a clawbus-formatted message
    try {
      ClawBusMessageSchema.parse(parsed);
    } catch {
      return;
    }
    // Idempotent: skip if we've already seen this message id
    const existing = await this.cache.query({ kind: parsed.kind });
    if (existing.some((e) => e.id === parsed.id)) return;
    await this.cache.append(parsed);
    await this.deliver(parsed);
  }

  /** Inbound reaction → if matches an approval-request, synthesize approval-decision. */
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot) return;
    if (this.opts.reviewerIds.length > 0 && !this.opts.reviewerIds.includes(user.id)) {
      return;
    }
    let fullReaction: MessageReaction;
    if (reaction.partial) {
      try {
        fullReaction = await reaction.fetch();
      } catch {
        return;
      }
    } else {
      fullReaction = reaction;
    }
    const original = this.approvalRequestMap.get(fullReaction.message.id);
    if (!original) return;
    const emoji = fullReaction.emoji.name;
    let decision: ApprovalDecisionPayload["decision"];
    if (emoji === this.opts.approveEmoji) decision = "approve";
    else if (emoji === this.opts.rejectEmoji) decision = "reject";
    else return;

    const payload: ApprovalDecisionPayload = {
      decision,
      reviewer: user.id,
      note: `via Discord reaction ${emoji}`,
    };
    const decisionMsg: ClawBusMessage = {
      id: `dec_${original.id}_${Date.now()}`,
      from: "human",
      to: original.from,
      kind: "approval-decision",
      payload,
      parent: original.id,
      createdAt: new Date().toISOString(),
    };
    // Remove the mapping so duplicate reactions don't spam decisions
    this.approvalRequestMap.delete(reaction.message.id);
    await this.append(decisionMsg);
  }
}

// ---- encoding / decoding ----

/** Encode a ClawBusMessage as a Discord message body. */
export function encodeMessage(msg: ClawBusMessage): string {
  const header = `**[${msg.kind}]** ${msg.from} → ${msg.to}  ·  id \`${msg.id}\``;
  const json = JSON.stringify(msg, null, 2);
  return `${header}\n\`\`\`json\n${json}\n\`\`\``;
}

/** Decode a Discord message body. Returns null if it's not a clawbus message. */
export function decodeMessage(content: string): ClawBusMessage | null {
  const headerMatch = content.match(HEADER_RE);
  if (!headerMatch) return null;
  const fenceMatch = content.match(JSON_FENCE_RE);
  if (!fenceMatch) return null;
  try {
    const parsed = JSON.parse(fenceMatch[1] as string) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ClawBusMessage;
  } catch {
    return null;
  }
}
