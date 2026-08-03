/**
 * Write-path rate limiter for TDAI Gateway.
 *
 * Protects memory write endpoints (/conversation/add, /atomic/update,
 * /scenario/write, /core/write) from abuse — misbehaving agent loops,
 * duplicate floods, or runaway pipelines.
 *
 * Design:
 * - Sliding window counter per (serviceId + agentId) key
 * - Configurable max writes per minute and dedup window
 * - SHA256 fingerprint dedup for L0 conversation messages
 * - Circuit breaker: temporary 429 + structured error response
 */

import { createHash } from "node:crypto";

export interface RateLimiterConfig {
  /** Max write requests per minute per (serviceId, agentId). Default: 60 */
  maxWritesPerMinute: number;
  /** Dedup window in seconds for fingerprint matching. Default: 300 (5 min) */
  dedupWindowSeconds: number;
  /** Enable fingerprint deduplication. Default: true */
  dedupEnabled: boolean;
  /** Max fingerprint cache size. Default: 10000 */
  maxFingerprints: number;
}

interface WindowEntry {
  timestamps: number[];
}

interface FingerprintEntry {
  hash: string;
  firstSeen: number;
  count: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxWritesPerMinute: 60,
  dedupWindowSeconds: 300,
  dedupEnabled: true,
  maxFingerprints: 10000,
};

export class WriteRateLimiter {
  private config: RateLimiterConfig;
  private windows = new Map<string, WindowEntry>();
  private fingerprints = new Map<string, FingerprintEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a write request is allowed.
   *
   * @param key - Typically "serviceId:agentId" or just agentId
   * @param contentFingerprint - Optional SHA256 of content for dedup
   * @returns { allowed: true } or { allowed: false, reason, retryAfterMs }
   */
  check(
    key: string,
    contentFingerprint?: string,
  ): { allowed: true } | { allowed: false; reason: string; retryAfterMs: number } {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute

    // ── Sliding window rate limit ──
    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Prune timestamps outside the window
    const cutoff = now - windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.config.maxWritesPerMinute) {
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now + 100; // +100ms buffer
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${entry.timestamps.length} writes in last 60s (limit: ${this.config.maxWritesPerMinute})`,
        retryAfterMs: Math.max(retryAfterMs, 1000),
      };
    }

    // ── Fingerprint dedup ──
    if (this.config.dedupEnabled && contentFingerprint) {
      const existing = this.fingerprints.get(contentFingerprint);
      if (existing) {
        const ageMs = now - existing.firstSeen;
        if (ageMs < this.config.dedupWindowSeconds * 1000) {
          existing.count++;
          return {
            allowed: false,
            reason: `Duplicate content detected (fingerprint seen ${existing.count}x in last ${this.config.dedupWindowSeconds}s)`,
            retryAfterMs: 0,
          };
        }
        // Expired — replace
        existing.firstSeen = now;
        existing.count = 1;
      } else {
        // Evict oldest if at capacity
        if (this.fingerprints.size >= this.config.maxFingerprints) {
          const oldest = this.fingerprints.keys().next().value;
          if (oldest) this.fingerprints.delete(oldest);
        }
        this.fingerprints.set(contentFingerprint, {
          hash: contentFingerprint,
          firstSeen: now,
          count: 1,
        });
      }
    }

    // Allowed — record timestamp
    entry.timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Start periodic cleanup of expired entries.
   * Call once after construction; safe to call multiple times.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60_000); // every minute
    // Don't hold the process open
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Stop cleanup timer (for graceful shutdown). */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const windowMs = 60_000;
    const dedupMs = this.config.dedupWindowSeconds * 1000;

    // Clean rate limit windows
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }

    // Clean fingerprints
    for (const [hash, entry] of this.fingerprints) {
      if (now - entry.firstSeen > dedupMs) {
        this.fingerprints.delete(hash);
      }
    }
  }

  /** Get current stats (for /health or metrics). */
  stats(): { activeKeys: number; fingerprintCount: number } {
    return {
      activeKeys: this.windows.size,
      fingerprintCount: this.fingerprints.size,
    };
  }
}

/**
 * Compute SHA256 fingerprint of content for dedup.
 * Normalizes whitespace and takes first 512 chars to avoid
 * expensive hashing of large payloads.
 */
export function computeFingerprint(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").slice(0, 512);
  return createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 32);
}

/**
 * Determine if a pathname targets a write endpoint.
 */
export function isWritePath(pathname: string): boolean {
  const writeSuffixes = [
    "/conversation/add",
    "/atomic/update",
    "/scenario/write",
    "/scenario/rm",
    "/core/write",
    "/conversation/delete",
    "/atomic/delete",
  ];
  // Check both /v2 and /v3 prefixes
  for (const suffix of writeSuffixes) {
    if (pathname === `/v2${suffix}` || pathname === `/v3${suffix}`) {
      return true;
    }
  }
  return false;
}

/**
 * Build the rate-limit key from request auth context.
 * Uses agentId when available (per-agent isolation), falls back to serviceId.
 */
export function buildRateLimitKey(serviceId: string, agentId?: string): string {
  return agentId ? `${serviceId}:${agentId}` : serviceId;
}
