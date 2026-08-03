/**
 * Search Backend Abstraction Layer.
 *
 * Defines a unified interface for search operations across different backends
 * (SQLite FTS5, OpenSearch, Qdrant). Enables:
 * - Swappable search backends without changing upper-layer code
 * - RRF (Reciprocal Rank Fusion) over any combination of backends
 * - Gradual migration from SQLite to distributed search
 *
 * Design:
 * - Each backend implements keyword search, vector search, or both
 * - SearchRouter orchestrates multiple backends and applies RRF fusion
 * - Backends are configured via tdai-gateway.yaml `search.*` section
 */

import type { L1SearchResult, L1FtsResult, IsolationFilter } from "./store/types.js";

// ============================
// Backend Interface
// ============================

export interface SearchBackendConfig {
  /** Backend type identifier */
  type: "sqlite" | "opensearch" | "qdrant";
  /** Whether this backend is enabled */
  enabled: boolean;
}

export interface SearchHit {
  /** Record ID */
  record_id: string;
  /** Content text */
  content: string;
  /** Record type (persona, episodic, etc.) */
  type: string;
  /** Priority score */
  priority: number;
  /** Scene name */
  scene_name: string;
  /** Relevance score (0–1, higher is better) */
  score: number;
  /** Timestamp strings */
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  /** Version number */
  version: number;
  /** Session info */
  session_key: string;
  session_id: string;
  /** Isolation dimensions */
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  /** Raw metadata JSON */
  metadata_json: string;
}

/**
 * Abstract search backend interface.
 *
 * Each backend implements at least one of keyword/vector search.
 * The SearchRouter selects available backends and fuses results.
 */
export interface ISearchBackend {
  /** Backend identifier for logging */
  readonly name: string;

  /** Initialize the backend connection */
  init(): Promise<void>;

  /** Whether this backend supports keyword search */
  supportsKeywordSearch(): boolean;

  /** Whether this backend supports vector search */
  supportsVectorSearch(): boolean;

  /** Keyword search (BM25 or equivalent) */
  searchKeyword?(
    query: string,
    limit: number,
    filter?: IsolationFilter,
  ): Promise<SearchHit[]>;

  /** Vector similarity search */
  searchVector?(
    queryEmbedding: Float32Array,
    limit: number,
    filter?: IsolationFilter,
  ): Promise<SearchHit[]>;

  /** Hybrid search (dense + sparse in single call) */
  searchHybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    limit: number;
    filter?: IsolationFilter;
  }): Promise<SearchHit[]>;

  /** Health check */
  healthCheck(): Promise<boolean>;

  /** Cleanup resources */
  close(): Promise<void>;
}

// ============================
// RRF Fusion
// ============================

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: merge results from multiple ranked lists.
 *
 * For each document, RRF score = Σ 1/(k + rank_i + 1)
 * where rank_i is the 0-based position in each list.
 */
export function rrfFuse(
  lists: SearchHit[][],
  k: number = RRF_K,
): SearchHit[] {
  const scoreMap = new Map<string, { hit: SearchHit; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]!;
      const existing = scoreMap.get(hit.record_id);
      const rrfScore = 1 / (k + rank + 1);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(hit.record_id, { hit, score: rrfScore });
      }
    }
  }

  // Sort by RRF score descending
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.hit,
      score: entry.score,
    }));
}

// ============================
// Search Router
// ============================

export interface SearchRouterConfig {
  /** Maximum results to return */
  maxResults: number;
  /** Score threshold (0–1) */
  scoreThreshold: number;
  /** Search timeout in ms */
  timeoutMs: number;
}

const DEFAULT_ROUTER_CONFIG: SearchRouterConfig = {
  maxResults: 10,
  scoreThreshold: 0.3,
  timeoutMs: 5000,
};

/**
 * SearchRouter orchestrates multiple search backends and applies RRF fusion.
 *
 * Strategy:
 * 1. Run keyword + vector searches in parallel across all backends
 * 2. Fuse results using RRF
 * 3. Apply score threshold and limit
 */
export class SearchRouter {
  private backends: ISearchBackend[] = [];
  private config: SearchRouterConfig;
  private logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void };

  constructor(config?: Partial<SearchRouterConfig>, logger?: SearchRouter["logger"]) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.logger = logger;
  }

  /** Register a search backend */
  addBackend(backend: ISearchBackend): void {
    this.backends.push(backend);
  }

  /** Get all registered backends */
  getBackends(): ISearchBackend[] {
    return [...this.backends];
  }

  /**
   * Unified search: runs keyword + vector across all backends, fuses with RRF.
   */
  async search(params: {
    query: string;
    queryEmbedding?: Float32Array;
    limit?: number;
    filter?: IsolationFilter;
  }): Promise<SearchHit[]> {
    const { query, queryEmbedding, filter } = params;
    const limit = params.limit ?? this.config.maxResults;

    if (this.backends.length === 0) {
      this.logger?.warn?.("[SearchRouter] No backends registered");
      return [];
    }

    const lists: SearchHit[][] = [];
    const tasks: Promise<void>[] = [];

    // Collect keyword search results from all backends
    for (const backend of this.backends) {
      if (backend.supportsKeywordSearch() && backend.searchKeyword) {
        tasks.push(
          backend
            .searchKeyword(query, limit * 2, filter)
            .then((results) => {
              if (results.length > 0) lists.push(results);
            })
            .catch((err) => {
              this.logger?.warn?.(`[SearchRouter] Keyword search failed (${backend.name}): ${err instanceof Error ? err.message : String(err)}`);
            }),
        );
      }
    }

    // Collect vector search results from all backends
    if (queryEmbedding) {
      for (const backend of this.backends) {
        if (backend.supportsVectorSearch() && backend.searchVector) {
          tasks.push(
            backend
              .searchVector(queryEmbedding, limit * 2, filter)
              .then((results) => {
                if (results.length > 0) lists.push(results);
              })
              .catch((err) => {
                this.logger?.warn?.(`[SearchRouter] Vector search failed (${backend.name}): ${err instanceof Error ? err.message : String(err)}`);
              }),
          );
        }
      }
    }

    // Wait for all searches with timeout
    await Promise.race([
      Promise.all(tasks),
      new Promise<void>((resolve) => setTimeout(resolve, this.config.timeoutMs)),
    ]);

    if (lists.length === 0) {
      return [];
    }

    // Fuse with RRF
    let fused = rrfFuse(lists);

    // Apply score threshold
    if (this.config.scoreThreshold > 0) {
      fused = fused.filter((h) => h.score >= this.config.scoreThreshold);
    }

    // Apply limit
    return fused.slice(0, limit);
  }

  /**
   * Health check for all backends.
   */
  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const backend of this.backends) {
      try {
        results[backend.name] = await backend.healthCheck();
      } catch {
        results[backend.name] = false;
      }
    }
    return results;
  }

  /** Cleanup all backends */
  async close(): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.close()));
  }
}
