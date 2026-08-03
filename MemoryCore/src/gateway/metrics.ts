/**
 * Prometheus Metrics Collector for TDAI Gateway.
 *
 * Exposes /metrics endpoint in Prometheus text format.
 * Zero-dependency implementation — no prom-client needed.
 *
 * Metrics tracked:
 *   - memory_write_total{layer, agent_id, status}
 *   - memory_search_total{backend, result_count}
 *   - pipeline_runs_total{status}
 *   - llm_calls_total{purpose, status}
 *   - storage_size_bytes{layer}
 *   - request_duration_seconds{method, path, status}
 *   - active_sessions
 *   - rate_limiter_active_keys
 *   - search_backend_health{backend}
 */

const HELP_PREFIX = "# HELP ";
const TYPE_PREFIX = "# TYPE ";
const COUNTER = "counter";
const GAUGE = "gauge";
const HISTOGRAM = "histogram";

interface MetricValue {
  value: number;
  labels: Record<string, string>;
}

interface MetricDef {
  name: string;
  help: string;
  type: typeof COUNTER | typeof GAUGE | typeof HISTOGRAM;
  values: MetricValue[];
}

export class PrometheusMetrics {
  private metrics = new Map<string, MetricDef>();
  private histograms = new Map<string, { buckets: number[]; counts: Map<string, number[]>; sums: Map<string, number> }>();

  // ── Counter helpers ──

  incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
    let def = this.metrics.get(name);
    if (!def) {
      def = { name, help: "", type: COUNTER, values: [] };
      this.metrics.set(name, def);
    }

    const key = JSON.stringify(labels);
    const existing = def.values.find((v) => JSON.stringify(v.labels) === key);
    if (existing) {
      existing.value += value;
    } else {
      def.values.push({ value, labels });
    }
  }

  // ── Gauge helpers ──

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    let def = this.metrics.get(name);
    if (!def) {
      def = { name, help: "", type: GAUGE, values: [] };
      this.metrics.set(name, def);
    }

    const key = JSON.stringify(labels);
    const existing = def.values.find((v) => JSON.stringify(v.labels) === key);
    if (existing) {
      existing.value = value;
    } else {
      def.values.push({ value, labels });
    }
  }

  // ── Histogram helpers ──

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}, buckets?: number[]): void {
    const defaultBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    const bucketBounds = buckets ?? defaultBuckets;

    let hist = this.histograms.get(name);
    if (!hist) {
      hist = { buckets: bucketBounds, counts: new Map(), sums: new Map() };
      this.histograms.set(name, hist);
    }

    const key = JSON.stringify(labels);
    let counts = hist.counts.get(key);
    if (!counts) {
      counts = new Array(bucketBounds.length + 1).fill(0);
      hist.counts.set(key, counts);
    }

    // Find the right bucket
    let placed = false;
    for (let i = 0; i < bucketBounds.length; i++) {
      if (value <= bucketBounds[i]!) {
        counts[i]!++;
        placed = true;
        break;
      }
    }
    if (!placed) {
      counts[bucketBounds.length]!++; // +Inf bucket
    }

    // Update sum
    const currentSum = hist.sums.get(key) ?? 0;
    hist.sums.set(key, currentSum + value);
  }

  // ── Metric registration ──

  registerMetric(name: string, help: string, type: MetricDef["type"]): void {
    const existing = this.metrics.get(name);
    if (existing) {
      existing.help = help;
      existing.type = type;
    } else {
      this.metrics.set(name, { name, help, type, values: [] });
    }
  }

  // ── Render Prometheus text format ──

  render(): string {
    const lines: string[] = [];

    // Render regular metrics
    for (const def of this.metrics.values()) {
      if (def.help) lines.push(`${HELP_PREFIX}${def.name} ${def.help}`);
      lines.push(`${TYPE_PREFIX}${def.name} ${def.type}`);

      for (const val of def.values) {
        const labelStr = Object.entries(val.labels)
          .map(([k, v]) => `${k}="${this.escapeLabel(v)}"`)
          .join(",");
        const suffix = labelStr ? `{${labelStr}}` : "";
        lines.push(`${def.name}${suffix} ${val.value}`);
      }
    }

    // Render histograms
    for (const [name, hist] of this.histograms) {
      lines.push(`${HELP_PREFIX}${name} ${name} histogram`);
      lines.push(`${TYPE_PREFIX}${name} ${HISTOGRAM}`);

      for (const [key, counts] of hist.counts) {
        const labels = key === "{}" ? {} : JSON.parse(key);
        const labelStr = Object.entries(labels as Record<string, string>)
          .map(([k, v]) => `${k}="${this.escapeLabel(v)}"`)
          .join(",");
        const prefix = labelStr ? `{${labelStr},` : "{";

        let cumulative = 0;
        for (let i = 0; i < hist.buckets.length; i++) {
          cumulative += counts[i]!;
          lines.push(`${name}_bucket${prefix}le="${hist.buckets[i]}"} ${cumulative}`);
        }
        cumulative += counts[hist.buckets.length]!;
        lines.push(`${name}_bucket${prefix}le="+Inf"} ${cumulative}`);
        lines.push(`${name}_sum${labelStr ? `{${labelStr}}` : ""} ${hist.sums.get(key) ?? 0}`);
        lines.push(`${name}_count${labelStr ? `{${labelStr}}` : ""} ${cumulative}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  // ── Reset (for testing) ──

  reset(): void {
    this.metrics.clear();
    this.histograms.clear();
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }
}

// ============================
// Pre-defined metric names
// ============================

export const METRICS = {
  // Memory operations
  MEMORY_WRITE_TOTAL: "tdai_memory_write_total",
  MEMORY_SEARCH_TOTAL: "tdai_memory_search_total",

  // Pipeline
  PIPELINE_RUNS_TOTAL: "tdai_pipeline_runs_total",

  // LLM
  LLM_CALLS_TOTAL: "tdai_llm_calls_total",

  // Storage
  STORAGE_SIZE_BYTES: "tdai_storage_size_bytes",

  // HTTP requests
  REQUEST_DURATION_SECONDS: "tdai_request_duration_seconds",

  // Sessions
  ACTIVE_SESSIONS: "tdai_active_sessions",

  // Rate limiter
  RATE_LIMITER_ACTIVE_KEYS: "tdai_rate_limiter_active_keys",
  RATE_LIMITER_FINGERPRINTS: "tdai_rate_limiter_fingerprints",

  // Search backends
  SEARCH_BACKEND_HEALTH: "tdai_search_backend_health",

  // General
  UPTIME_SECONDS: "tdai_uptime_seconds",
} as const;

// ============================
// Singleton instance
// ============================

let _instance: PrometheusMetrics | null = null;

export function getMetrics(): PrometheusMetrics {
  if (!_instance) {
    _instance = new PrometheusMetrics();
    // Register standard metrics
    _instance.registerMetric(METRICS.MEMORY_WRITE_TOTAL, "Total memory write operations", COUNTER);
    _instance.registerMetric(METRICS.MEMORY_SEARCH_TOTAL, "Total memory search operations", COUNTER);
    _instance.registerMetric(METRICS.PIPELINE_RUNS_TOTAL, "Total pipeline runs", COUNTER);
    _instance.registerMetric(METRICS.LLM_CALLS_TOTAL, "Total LLM API calls", COUNTER);
    _instance.registerMetric(METRICS.STORAGE_SIZE_BYTES, "Storage size in bytes", GAUGE);
    _instance.registerMetric(METRICS.ACTIVE_SESSIONS, "Number of active sessions", GAUGE);
    _instance.registerMetric(METRICS.RATE_LIMITER_ACTIVE_KEYS, "Active rate limiter keys", GAUGE);
    _instance.registerMetric(METRICS.RATE_LIMITER_FINGERPRINTS, "Fingerprint cache size", GAUGE);
    _instance.registerMetric(METRICS.SEARCH_BACKEND_HEALTH, "Search backend health status", GAUGE);
    _instance.registerMetric(METRICS.UPTIME_SECONDS, "Gateway uptime in seconds", GAUGE);
  }
  return _instance;
}
