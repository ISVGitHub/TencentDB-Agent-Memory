/**
 * Memory Compression Service — progressive summarization for long-running sessions.
 *
 * Compresses old L0 messages into L1 summaries to reduce context window usage.
 * Uses a sliding window approach:
 * - Keep recent N messages in full (L0)
 * - Compress older messages into a single L1 summary
 * - Inject summary + recent messages into context
 *
 * Configuration:
 * ```yaml
 * memory:
 *   compression:
 *     enabled: true
 *     windowSize: 20        # Keep last 20 messages in full
 *     compressAfter: 50     # Start compressing after 50 messages
 *     strategy: "progressive"  # progressive | aggressive
 * ```
 */

import type { Logger } from "../core/types.js";

const TAG = "[memory-compression]";

export interface CompressionConfig {
  /** Whether compression is enabled. Default: false */
  enabled: boolean;
  /** Number of recent messages to keep in full. Default: 20 */
  windowSize: number;
  /** Start compressing after this many messages. Default: 50 */
  compressAfter: number;
  /** Compression strategy. Default: "progressive" */
  strategy: "progressive" | "aggressive";
}

export interface CompressionResult {
  /** Original message count */
  originalCount: number;
  /** Compressed message count */
  compressedCount: number;
  /** Summary of compressed messages */
  summary: string;
  /** Tokens saved (estimate) */
  tokensSaved: number;
  /** Whether compression was applied */
  applied: boolean;
}

export interface MessageForCompression {
  role: string;
  content: string;
  timestamp?: number;
}

/**
 * Compress a list of messages using the sliding window approach.
 *
 * @param messages - Full message history
 * @param config - Compression configuration
 * @param summarizeFn - Function to summarize messages (LLM call)
 * @returns Compression result with summary and recent messages
 */
export async function compressMessages(
  messages: MessageForCompression[],
  config: CompressionConfig,
  summarizeFn: (messages: MessageForCompression[]) => Promise<string>,
  logger?: Logger,
): Promise<CompressionResult> {
  if (!config.enabled || messages.length <= config.compressAfter) {
    return {
      originalCount: messages.length,
      compressedCount: messages.length,
      summary: "",
      tokensSaved: 0,
      applied: false,
    };
  }

  const windowSize = config.windowSize;
  const splitIndex = messages.length - windowSize;

  // Messages to compress (older)
  const toCompress = messages.slice(0, splitIndex);
  // Messages to keep (recent)
  const toKeep = messages.slice(splitIndex);

  logger?.info?.(
    `${TAG} Compressing ${toCompress.length} messages, keeping ${toKeep.length} recent messages`,
  );

  // Generate summary
  let summary: string;
  try {
    summary = await summarizeFn(toCompress);
  } catch (err) {
    logger?.warn?.(`${TAG} Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      originalCount: messages.length,
      compressedCount: messages.length,
      summary: "",
      tokensSaved: 0,
      applied: false,
    };
  }

  // Estimate tokens saved (rough: 1 token per 4 chars)
  const originalChars = toCompress.reduce((sum, m) => sum + m.content.length, 0);
  const summaryChars = summary.length;
  const tokensSaved = Math.max(0, Math.floor((originalChars - summaryChars) / 4));

  logger?.info?.(
    `${TAG} Compression complete: ${toCompress.length} messages → 1 summary (${tokensSaved} tokens saved)`,
  );

  return {
    originalCount: messages.length,
    compressedCount: toKeep.length + 1, // summary + recent messages
    summary,
    tokensSaved,
    applied: true,
  };
}

/**
 * Build compressed context for injection into LLM prompt.
 *
 * @param summary - Summary of old messages
 * @param recentMessages - Recent messages to keep in full
 * @returns Messages array with summary prepended
 */
export function buildCompressedContext(
  summary: string,
  recentMessages: MessageForCompression[],
): MessageForCompression[] {
  if (!summary) return recentMessages;

  return [
    {
      role: "system",
      content: `[Conversation Summary]\n${summary}`,
    },
    ...recentMessages,
  ];
}

/**
 * Estimate compression ratio for a message list.
 * Useful for deciding whether to compress.
 */
export function estimateCompressionRatio(
  messages: MessageForCompression[],
  windowSize: number,
): number {
  if (messages.length <= windowSize) return 1.0;

  const toCompress = messages.slice(0, messages.length - windowSize);
  const totalChars = toCompress.reduce((sum, m) => sum + m.content.length, 0);

  // Rough estimate: summary is ~10% of original
  const summaryChars = Math.floor(totalChars * 0.1);
  return summaryChars / totalChars;
}

/**
 * Default compression configuration.
 */
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  enabled: false,
  windowSize: 20,
  compressAfter: 50,
  strategy: "progressive",
};
