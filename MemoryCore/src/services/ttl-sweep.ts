/**
 * TTL Sweep Service — background job for expiring old memory records.
 *
 * Runs on a configurable interval (default: 24h) and:
 * 1. Soft-deletes L0 records older than l0Days (marks as expired)
 * 2. Soft-deletes L1 records older than l1Days (marks as expired)
 * 3. Hard-deletes records that have been expired for gracePeriodDays
 *
 * Configuration (tdai-gateway.yaml):
 * ```yaml
 * ttl:
 *   enabled: true
 *   l0Days: 30
 *   l1Days: 180
 *   gracePeriodDays: 7
 *   sweepIntervalHours: 24
 *   dryRun: false
 * ```
 */

import type { IMemoryStore } from "../core/store/types.js";
import type { Logger } from "../core/types.js";
import type { TtlConfig } from "../gateway/config.js";
import { getMetrics, METRICS } from "../gateway/metrics.js";

const TAG = "[ttl-sweep]";

export interface TtlSweepResult {
  l0Expired: number;
  l1Expired: number;
  l0HardDeleted: number;
  l1HardDeleted: number;
  durationMs: number;
}

export class TtlSweepService {
  private config: TtlConfig;
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private getStore: () => IMemoryStore | undefined;
  private lastRun: Date | null = null;

  constructor(params: {
    config: TtlConfig;
    logger: Logger;
    getStore: () => IMemoryStore | undefined;
  }) {
    this.config = params.config;
    this.logger = params.logger;
    this.getStore = params.getStore;
  }

  /** Start the periodic sweep timer. */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info(`${TAG} TTL sweep disabled`);
      return;
    }

    const intervalMs = this.config.sweepIntervalHours * 60 * 60 * 1000;
    this.logger.info(
      `${TAG} Starting TTL sweep: interval=${this.config.sweepIntervalHours}h, ` +
      `L0=${this.config.l0Days}d, L1=${this.config.l1Days}d, grace=${this.config.gracePeriodDays}d, ` +
      `dryRun=${this.config.dryRun}`,
    );

    // Run immediately on start (after a short delay to let store initialize)
    setTimeout(() => this.runSweep(), 30_000);

    // Schedule periodic runs
    this.timer = setInterval(() => this.runSweep(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Stop the sweep timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info(`${TAG} TTL sweep stopped`);
  }

  /** Run a single sweep cycle. */
  async runSweep(): Promise<TtlSweepResult> {
    const startMs = Date.now();
    const store = this.getStore();

    if (!store) {
      this.logger.warn(`${TAG} No store available, skipping sweep`);
      return { l0Expired: 0, l1Expired: 0, l0HardDeleted: 0, l1HardDeleted: 0, durationMs: 0 };
    }

    const now = new Date();

    // Calculate cutoff dates
    const l0Cutoff = new Date(now.getTime() - this.config.l0Days * 24 * 60 * 60 * 1000);
    const l1Cutoff = new Date(now.getTime() - this.config.l1Days * 24 * 60 * 60 * 1000);
    const hardDeleteCutoff = new Date(now.getTime() - (this.config.l1Days + this.config.gracePeriodDays) * 24 * 60 * 60 * 1000);

    let l0Expired = 0;
    let l1Expired = 0;
    let l0HardDeleted = 0;
    let l1HardDeleted = 0;

    try {
      // L0 expiry
      if (this.config.l0Days > 0) {
        const l0CutoffIso = l0Cutoff.toISOString();
        if (this.config.dryRun) {
          // Count only
          const allL0 = await store.getAllL0Texts();
          l0Expired = allL0.filter((r) => r.recorded_at < l0CutoffIso).length;
          this.logger.info(`${TAG} [DRY RUN] Would expire ${l0Expired} L0 records (cutoff: ${l0CutoffIso})`);
        } else {
          l0Expired = await store.deleteL0Expired(l0CutoffIso);
          if (l0Expired > 0) {
            this.logger.info(`${TAG} Expired ${l0Expired} L0 records (cutoff: ${l0CutoffIso})`);
          }
        }
      }

      // L1 expiry
      if (this.config.l1Days > 0) {
        const l1CutoffIso = l1Cutoff.toISOString();
        if (this.config.dryRun) {
          const allL1 = await store.getAllL1Texts();
          l1Expired = allL1.filter((r) => r.updated_time < l1CutoffIso).length;
          this.logger.info(`${TAG} [DRY RUN] Would expire ${l1Expired} L1 records (cutoff: ${l1CutoffIso})`);
        } else {
          l1Expired = await store.deleteL1Expired(l1CutoffIso);
          if (l1Expired > 0) {
            this.logger.info(`${TAG} Expired ${l1Expired} L1 records (cutoff: ${l1CutoffIso})`);
          }
        }
      }

      // Hard delete (records expired beyond grace period)
      if (this.config.gracePeriodDays > 0 && !this.config.dryRun) {
        const hardCutoffIso = hardDeleteCutoff.toISOString();
        // These use the same deleteL*Expired which does hard delete
        l0HardDeleted = await store.deleteL0Expired(hardCutoffIso);
        l1HardDeleted = await store.deleteL1Expired(hardCutoffIso);
        if (l0HardDeleted > 0 || l1HardDeleted > 0) {
          this.logger.info(`${TAG} Hard deleted: L0=${l0HardDeleted}, L1=${l1HardDeleted} (cutoff: ${hardCutoffIso})`);
        }
      }
    } catch (err) {
      this.logger.error(`${TAG} Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const durationMs = Date.now() - startMs;
    this.lastRun = now;

    // Update Prometheus metrics
    const metrics = getMetrics();
    metrics.incCounter("tdai_ttl_sweep_total", { status: "success" });
    metrics.incCounter("tdai_ttl_expired_total", { layer: "L0" }, l0Expired);
    metrics.incCounter("tdai_ttl_expired_total", { layer: "L1" }, l1Expired);
    metrics.observeHistogram("tdai_ttl_sweep_duration_seconds", durationMs / 1000);

    if (l0Expired > 0 || l1Expired > 0 || l0HardDeleted > 0 || l1HardDeleted > 0) {
      this.logger.info(
        `${TAG} Sweep complete in ${durationMs}ms: ` +
        `expired(L0=${l0Expired}, L1=${l1Expired}), hardDeleted(L0=${l0HardDeleted}, L1=${l1HardDeleted})`,
      );
    }

    return { l0Expired, l1Expired, l0HardDeleted, l1HardDeleted, durationMs };
  }

  /** Get last run info. */
  getLastRun(): Date | null {
    return this.lastRun;
  }

  /** Get config. */
  getConfig(): TtlConfig {
    return { ...this.config };
  }
}
