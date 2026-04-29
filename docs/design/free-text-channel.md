# Design: Free-Text Channel for DiscordAdapter

> Status: **DRAFT** (post-hackathon proposal — do NOT merge to main before judging concludes 2026-04-29 01:00 JST = 2026-04-28 12:00 PM EST)
>
> Related: `docs/discord-adapter-design.md`, `docs/protocol.md`

## Motivation

The current `DiscordAdapter` only accepts ClawBus-formatted Discord messages: a header line plus a JSON code block. Free-text human messages in the channel are silently dropped at `src/adapters/discord.ts` (where `decodeMessage` returns `null`).

This is correct for an **agent-to-agent transport**, but it leaves out a real-world use case: a human typing "summarize my kanban backlog" from a phone, expecting a Worker agent to execute it as a task.

## Goal

Let `DiscordAdapter` optionally watch a **separate** Discord channel for free-text messages from authorized users, translate each message into a `task`-kind `ClawBusMessage`, and append it to the bus. The bus channel itself stays unchanged.

Non-goals:

- Inferring intent (which agent to delegate to). The translation function is supplied by the consumer.
- Threading replies in Discord. Results go through the normal bus channel; how/where they surface is a downstream concern.
- Voice transcription. Discord clients already provide voice-to-text on Android.

## API surface

Extend `DiscordAdapterOptions`:

```ts
export interface DiscordAdapterOptions {
  // ... existing fields unchanged ...

  /**
   * Optional: Discord channel ID to watch for free-text user input.
   * Distinct from `channelId` (bus traffic). When set, messages posted
   * to this channel by allow-listed users are translated to `task` and
   * appended to the bus.
   * Default: undefined (feature disabled, no behavior change).
   */
  freeTextChannelId?: string;

  /**
   * Discord user IDs allowed to send free-text. Empty = nobody.
   * Required when `freeTextChannelId` is set; otherwise ignored.
   */
  freeTextAllowedUserIds?: string[];

  /**
   * User-supplied translation: free-text content → ClawBusMessage.
   * Returning `null` means "ignore this message" (e.g. it's a bot
   * message or fails the consumer's own validation).
   *
   * The handler receives the raw Discord message content and metadata
   * about the sender, and returns a fully-formed ClawBusMessage
   * (typically `kind: "task"`). The adapter calls `append()` and the
   * normal subscriber flow takes over.
   */
  freeTextToMessage?: (input: FreeTextInput) => ClawBusMessage | null;
}

export interface FreeTextInput {
  content: string;        // raw Discord message body, untrimmed
  authorId: string;       // Discord user ID
  authorName: string;     // Discord username (display, not handle)
  messageId: string;      // for debug/audit
  timestamp: Date;        // message createdAt
}
```

## Behavior

### When all three are configured (`freeTextChannelId`, `freeTextAllowedUserIds`, `freeTextToMessage`)

On every `messageCreate`:

1. If `m.channel.id !== freeTextChannelId` → fall through to existing bus handler (no change).
2. If `m.author.bot === true` → ignore.
3. If `!freeTextAllowedUserIds.includes(m.author.id)` → ignore (silent; no error reaction). Log only.
4. Call `freeTextToMessage({ content, authorId, authorName, messageId, timestamp })`.
5. If returns `null` → ignore.
6. Otherwise → `await this.append(returned)`. Subscribers receive it via the existing flow.

### When `freeTextChannelId` is unset

No change to behavior. Existing tests must all pass.

### Validation at construction time

- If `freeTextChannelId` is set but `freeTextAllowedUserIds` is empty or missing → throw with a clear message. **Default-empty allowlist must not silently allow zero senders**, because it suggests user forgot to configure it.
- If `freeTextChannelId === channelId` → throw. Mixing free-text and bus protocol on the same channel breaks parsing.
- If `freeTextChannelId` is set but `freeTextToMessage` is missing → throw. The consumer must own the translation.

## Why a separate channel

Mixing on the same channel was considered and rejected:

| Approach | Pros | Cons |
|---|---|---|
| Same `channelId` for bus + free-text | One channel to configure | Bus protocol assumes JSON-fenced messages; mixing free-text means every `messageCreate` runs both decoders. Risk of false-positive parsing. Discord channel mod tools (slow mode, permissions) need different settings for human vs bot traffic. |
| **Separate `freeTextChannelId`** | Clean separation. Different mod tools per channel. Subscribers can ignore the free-text channel entirely if they don't care. | Two channels to configure. |

The cost (two channel IDs in config) is small and the cleanliness pays off in practice.

## Why a callback function instead of built-in semantics

A built-in `kind: "task" → "worker"` translation would couple the adapter to a specific agent topology. ClawBus core stays adapter-agnostic for a reason: the protocol is five message kinds and an append-only log; everything else is the consumer's choice.

A callback lets consumers:

- Route to different agents based on prefix (`@quick` → fast worker, `@blog` → reviewer)
- Add custom validation (rate limit, length cap, content moderation)
- Attach extra payload context (vault path, session id)
- Drop messages that don't match any known pattern

## Authentication model

Allowlist by Discord user ID. Discord IDs are 17-20 digit snowflakes; they don't change when a user renames or rejoins the server. This is standard.

We deliberately do **not**:

- Use server roles. They change. They give different surface area than "this user can send tasks."
- Use channel permissions alone. A misconfigured channel could expose to more users than intended; the adapter-level allowlist is defense in depth.

The empty-allowlist-throws rule (above) prevents the "I forgot to configure it" footgun.

## Backward compatibility

- All three new fields default to `undefined`.
- The constructor's runtime check only fires if `freeTextChannelId` is set.
- The existing test suite (`discord.test.ts` etc.) continues to pass without modification.
- A new test file `discord-free-text.test.ts` covers the new path.

## Test plan

### Unit (DiscordAdapter, mock Discord client)

| Case | Expected |
|---|---|
| `freeTextChannelId` unset, message in regular bus channel | parses as ClawBus message (existing) |
| `freeTextChannelId` set, message in bus channel | parses as ClawBus message (no regression) |
| `freeTextChannelId` set, message in free-text channel from allowed user, callback returns task | `task` appended to cache; subscribers receive |
| `freeTextChannelId` set, message in free-text channel from disallowed user | ignored; no append, no error |
| `freeTextChannelId` set, message in free-text channel, callback returns `null` | ignored |
| `freeTextChannelId` set, bot message | ignored |
| `freeTextChannelId === channelId` at construction | throws |
| `freeTextChannelId` set, `freeTextAllowedUserIds: []` | throws |
| `freeTextChannelId` set, `freeTextToMessage` missing | throws |

### Real E2E (manual, post-judging)

Run `examples/discord-free-text-demo.mjs` (new):

1. Bot connects to a real test guild
2. Authorized user posts "summarize my kanban backlog" in `#user-instructions`
3. `freeTextToMessage` translates to `task` with `to: "worker"`
4. A local Worker subscriber picks up the task
5. Worker invokes Claude Agent SDK
6. Result posts to bus channel
7. Audit log shows the full trail

Capture as `docs/scenarios/free-text-handshake.md` mirroring the existing `discord-handshake.md` style.

## Out of scope (deferred)

| Idea | Why deferred |
|---|---|
| Discord slash commands (`/task ...`) | Adds intent surface complexity; free-text is enough for V1 |
| Reply threading (results as Discord threads) | Channel topology decision; consumer can do it via custom subscriber |
| Multi-line / attachment support | Core path first; attachments need their own design (storage, base64 limits) |
| Voice clip transcription | Discord client already does voice-to-text on Android; no need to embed Whisper here |

## Migration / rollout

This is purely additive. Once merged:

- Existing users: no action needed.
- New users wanting Android chat: set the three fields, supply a translation callback.
- Document under a new "Mobile / Free-Text Input" section in README.
- Add to `docs/judging-guide.md` as an "after the hackathon" capability (only if reviewers come back later).

## Implementation skeleton

Single source change is `src/adapters/discord.ts`:

```ts
// In constructor, after existing validation:
if (this.opts.freeTextChannelId !== undefined) {
  if (this.opts.freeTextChannelId === this.opts.channelId) {
    throw new Error("DiscordAdapter: freeTextChannelId must differ from channelId");
  }
  if (!this.opts.freeTextAllowedUserIds || this.opts.freeTextAllowedUserIds.length === 0) {
    throw new Error("DiscordAdapter: freeTextAllowedUserIds is required and non-empty when freeTextChannelId is set");
  }
  if (typeof this.opts.freeTextToMessage !== "function") {
    throw new Error("DiscordAdapter: freeTextToMessage callback is required when freeTextChannelId is set");
  }
}

// Replace the existing messageCreate handler with:
this.client.on("messageCreate", (m) => {
  void this.routeIncomingMessage(m);
});

// New private method:
private async routeIncomingMessage(m: Message): Promise<void> {
  // Path 1: free-text channel
  if (this.opts.freeTextChannelId && m.channel.id === this.opts.freeTextChannelId) {
    if (m.author.bot) return;
    if (!this.opts.freeTextAllowedUserIds!.includes(m.author.id)) return;
    const task = this.opts.freeTextToMessage!({
      content: m.content,
      authorId: m.author.id,
      authorName: m.author.username,
      messageId: m.id,
      timestamp: m.createdAt,
    });
    if (task === null) return;
    await this.append(task);
    return;
  }
  // Path 2: regular bus channel — existing behavior
  await this.handleIncomingMessage(m);
}
```

Estimated diff: ~40 lines source + ~120 lines new test file. Total ≤ 200 lines.

## Open questions

1. **Should `freeTextToMessage` be allowed to return an array** (one user message → multiple bus messages, e.g. a planner task + a log entry)? **Tentative**: no for V1. Single message keeps the contract obvious.
2. **Should we record the original Discord message ID in the task payload** for traceability? **Tentative**: yes, as a top-level field on `FreeTextInput` (already in the proposal). Consumers can stuff it into payload metadata if they want.
3. **Rate limit at adapter level?** **Tentative**: no. Consumer can drop messages by returning `null` from the callback. Adapter-level rate limit would be opinion.
