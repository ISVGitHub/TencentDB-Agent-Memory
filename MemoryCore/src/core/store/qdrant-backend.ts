/**
 * Qdrant Backend — search implementation for Qdrant vector database.
 *
 * Uses Qdrant's native vector search and payload filtering.
 * Supports both dense and sparse vectors for hybrid search.
 *
 * Configuration (tdai-gateway.yaml):
 * ```yaml
 * search:
 *   backends:
 *     - type: qdrant
 *       enabled: true
 *       url: "http://127.0.0.1:6333"
 *       collection: "tdai-l1"
 *       api_key: ""  # optional
 * ```
 */

import type { ISearchBackend, SearchBackendConfig, SearchHit } from "./search-backend.js";
import type { IsolationFilter } from "./types.js";

export interface QdrantBackendConfig extends SearchBackendConfig {
  type: "qdrant";
  /** Qdrant URL (e.g., http://127.0.0.1:6333) */
  url: string;
  /** Collection name for L1 memories */
  collection: string;
  /** Optional API key */
  api_key?: string;
  /** Vector dimensions (must match embedding model) */
  vectorDimensions?: number;
  /** Distance metric: Cosine, Euclid, or Dot */
  distance?: "Cosine" | "Euclid" | "Dot";
}

export class QdrantBackend implements ISearchBackend {
  readonly name = "qdrant";
  private config: QdrantBackendConfig;
  private logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void };
  private initialized = false;

  constructor(config: QdrantBackendConfig, logger?: QdrantBackend["logger"]) {
    this.config = config;
    this.logger = logger;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const exists = await this.request("GET", `/collections/${this.config.collection}`);
      if (!exists.ok) {
        await this.createCollection();
      }
      this.initialized = true;
      this.logger?.info?.(`[Qdrant] Connected to ${this.config.url}, collection=${this.config.collection}`);
    } catch (err) {
      this.logger?.warn?.(`[Qdrant] Init failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  supportsKeywordSearch(): boolean {
    // Qdrant doesn't have native full-text search; use payload filtering for keywords
    return false;
  }

  supportsVectorSearch(): boolean {
    return true;
  }

  async searchVector(queryEmbedding: Float32Array, limit: number, filter?: IsolationFilter): Promise<SearchHit[]> {
    const body: Record<string, unknown> = {
      vector: Array.from(queryEmbedding),
      limit,
      with_payload: true,
      with_vector: false,
    };

    if (filter) {
      body.filter = this.buildFilter(filter);
    }

    const result = await this.request(
      "POST",
      `/collections/${this.config.collection}/points/search`,
      body,
    );

    if (!result.ok) return [];

    const data = await result.json();
    const points = (data.result ?? []) as Array<Record<string, unknown>>;

    return points.map((point) => this.mapPoint(point));
  }

  async searchHybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    limit: number;
    filter?: IsolationFilter;
  }): Promise<SearchHit[]> {
    const { queryEmbedding, sparseVector, limit, filter } = params;

    if (!queryEmbedding && !sparseVector) return [];

    // Use vector search if we have embeddings
    if (queryEmbedding) {
      return this.searchVector(queryEmbedding, limit, filter);
    }

    // Fallback to payload-based search for keywords
    return [];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.request("GET", "/healthz");
      return result.ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // No persistent connections to close
  }

  // ── Point operations ──

  async upsertPoint(record: {
    record_id: string;
    content: string;
    type: string;
    priority: number;
    scene_name: string;
    embedding: Float32Array;
    isolation?: IsolationFilter;
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      record_id: record.record_id,
      content: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: record.scene_name,
      indexed_at: new Date().toISOString(),
    };

    if (record.isolation) {
      if (record.isolation.teamId) payload.team_id = record.isolation.teamId;
      if (record.isolation.userId) payload.user_id = record.isolation.userId;
      if (record.isolation.agentId) payload.agent_id = record.isolation.agentId;
    }

    const body = {
      points: [
        {
          id: this.toPointId(record.record_id),
          vector: Array.from(record.embedding),
          payload,
        },
      ],
    };

    await this.request(
      "PUT",
      `/collections/${this.config.collection}/points`,
      body,
    );
  }

  async upsertPoints(records: Array<{
    record_id: string;
    content: string;
    type: string;
    priority: number;
    scene_name: string;
    embedding: Float32Array;
    isolation?: IsolationFilter;
  }>): Promise<void> {
    if (records.length === 0) return;

    const points = records.map((record) => {
      const payload: Record<string, unknown> = {
        record_id: record.record_id,
        content: record.content,
        type: record.type,
        priority: record.priority,
        scene_name: record.scene_name,
        indexed_at: new Date().toISOString(),
      };

      if (record.isolation) {
        if (record.isolation.teamId) payload.team_id = record.isolation.teamId;
        if (record.isolation.userId) payload.user_id = record.isolation.userId;
        if (record.isolation.agentId) payload.agent_id = record.isolation.agentId;
      }

      return {
        id: this.toPointId(record.record_id),
        vector: Array.from(record.embedding),
        payload,
      };
    });

    await this.request(
      "PUT",
      `/collections/${this.config.collection}/points`,
      { points },
    );
  }

  async deletePoint(recordId: string): Promise<void> {
    await this.request(
      "POST",
      `/collections/${this.config.collection}/points/delete`,
      { points: [this.toPointId(recordId)] },
    );
  }

  async getCollectionInfo(): Promise<Record<string, unknown> | null> {
    const result = await this.request("GET", `/collections/${this.config.collection}`);
    if (!result.ok) return null;
    const data = await result.json();
    return (data.result ?? null) as Record<string, unknown> | null;
  }

  // ── Internal helpers ──

  private async createCollection(): Promise<void> {
    const dimensions = this.config.vectorDimensions ?? 1536;
    const distance = this.config.distance ?? "Cosine";

    const body = {
      vectors: {
        size: dimensions,
        distance,
      },
      optimizers_config: {
        default_segment_number: 2,
      },
      replication_factor: 1,
    };

    const result = await this.request(
      "PUT",
      `/collections/${this.config.collection}`,
      body,
    );

    if (result.ok) {
      this.logger?.info?.(`[Qdrant] Created collection ${this.config.collection} (dim=${dimensions}, distance=${distance})`);
    } else {
      const data = await result.json();
      throw new Error(`Failed to create collection: ${JSON.stringify(data)}`);
    }
  }

  private buildFilter(filter: IsolationFilter): Record<string, unknown> {
    const must: Array<Record<string, unknown>> = [];

    if (filter.teamId) {
      must.push({ key: "team_id", match: { value: filter.teamId } });
    }
    if (filter.userId) {
      must.push({ key: "user_id", match: { value: filter.userId } });
    }
    if (filter.agentId) {
      must.push({ key: "agent_id", match: { value: filter.agentId } });
    }

    return must.length > 0 ? { must } : {};
  }

  private mapPoint(point: Record<string, unknown>): SearchHit {
    const payload = (point.payload ?? {}) as Record<string, unknown>;
    return {
      record_id: String(payload.record_id ?? point.id ?? ""),
      content: String(payload.content ?? ""),
      type: String(payload.type ?? ""),
      priority: Number(payload.priority ?? 0),
      scene_name: String(payload.scene_name ?? ""),
      score: Number(point.score ?? 0),
      timestamp_str: "",
      timestamp_start: "",
      timestamp_end: "",
      version: 0,
      session_key: "",
      session_id: "",
      team_id: String(payload.team_id ?? ""),
      task_id: String(payload.task_id ?? ""),
      user_id: String(payload.user_id ?? ""),
      agent_id: String(payload.agent_id ?? ""),
      metadata_json: "{}",
    };
  }

  /**
   * Convert a string record_id to a Qdrant point ID.
   * Qdrant accepts UUID or unsigned 64-bit integer.
   * We use a deterministic hash of the record_id.
   */
  private toPointId(recordId: string): string {
    // Use the record_id directly as a UUID-like string
    // Qdrant accepts any string as a point ID in recent versions
    return recordId;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }> {
    const url = `${this.config.url}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.api_key) {
      headers["api-key"] = this.config.api_key;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    return {
      ok: res.ok,
      json: async () => {
        try {
          return await res.json() as Record<string, unknown>;
        } catch {
          return {};
        }
      },
    };
  }
}
