import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface RunOptions extends Omit<Options, "abortController"> {
  /** Optional callback invoked for every SDK message (for live logging). */
  onMessage?: (msg: SDKMessage) => void;
}

/**
 * Run a one-shot Claude Agent SDK query and return the final assistant text
 * (the `result` field of the final `result` message). Throws on any error
 * result so callers can surface failures cleanly.
 */
export async function runSdkQuery(
  prompt: string,
  options: RunOptions = {},
): Promise<{ text: string; costUsd: number; numTurns: number }> {
  const { onMessage, ...sdkOptions } = options;
  const q = query({ prompt, options: sdkOptions });

  let finalText = "";
  let costUsd = 0;
  let numTurns = 0;

  for await (const msg of q) {
    onMessage?.(msg);
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = msg.result;
        costUsd = msg.total_cost_usd;
        numTurns = msg.num_turns;
      } else {
        throw new Error(
          `SDK query failed: subtype=${msg.subtype}${
            "api_error_status" in msg && msg.api_error_status
              ? ` api_error_status=${msg.api_error_status}`
              : ""
          }`,
        );
      }
    }
  }

  return { text: finalText, costUsd, numTurns };
}

/**
 * Pull a fenced JSON block out of an assistant's final text. Returns `null`
 * if no valid JSON block is found. Accepts both ```json fenced blocks and a
 * raw object at the end of the text.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      // fall through
    }
  }
  // Try to parse the last {...} or [...] block in the text.
  const lastBrace = Math.max(text.lastIndexOf("{"), text.lastIndexOf("["));
  if (lastBrace < 0) return null;
  const candidate = text.slice(lastBrace).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
