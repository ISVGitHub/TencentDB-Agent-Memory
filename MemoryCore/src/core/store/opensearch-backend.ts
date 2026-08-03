/**
 * OpenSearch Backend — search implementation for OpenSearch (Elasticsearch-compatible).
 *
 * Uses OpenSearch's BM25 for keyword search and k-NN plugin for vector search.
 * Compatible with any OpenSearch 2.x+ instance.
 *
 * Configuration (tdai-gateway.yaml):
 * ```yaml
 * search:
 *   backends:
 *     - type: opensearch
 *       enabled: true
 *       url: "http://127.0.0.1:9200"
 *       index: "tdai-l1"
 *       username: ""  # optional
 *       password: ""  # optional
 * ```
 */

import type { ISearchBackend, SearchBackendConfig, SearchHit } from "./search-backend.js";
import type { IsolationFilter } from "./types.js";

export interface OpenSearchBackendConfig extends SearchBackendConfig {
  type: "opensearch";
  /** OpenSearch URL (e.g., http://127.0.0.1:9200) */
  url: string;
  /** Index name for L1 memories */
  index: string;
  /** Optional basic auth username */
  username?: string;
  /** Optional basic auth password */
  password?: string;
  /** Vector dimensions (must match embedding model) */
  vectorDimensions?: number;
}

export class OpenSearchBackend implements ISearchBackend {
  readonly name = "opensearch";
  private config: OpenSearchBackendConfig;
  private logger?: { debug?: (msg: string) => void; info?: (msg: string) => void; warn?: (msg: string) => void };
  private initialized = false;

  constructor(config: OpenSearchBackendConfig, logger?: OpenSearchBackend["logger"]) {
    this.config = config;
    this.logger = logger;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure index exists
    try {
      const exists = await this.request("HEAD", `/${this.config.index}`);
      if (!exists.ok) {
        await this.createIndex();
      }
      this.initialized = true;
      this.logger?.info?.(`[OpenSearch] Connected to ${this.config.url}, index=${this.config.index}`);
    } catch (err) {
      this.logger?.warn?.(`[OpenSearch] Init failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  supportsKeywordSearch(): boolean {
    return true;
  }

  supportsVectorSearch(): boolean {
    return true;
  }

  async searchKeyword(query: string, limit: number, filter?: IsolationFilter): Promise<SearchHit[]> {
    const must: unknown[] = [
      {
        multi_match: {
          query,
          fields: ["content^2", "scene_name", "type"],
          type: "best_fields",
          fuzziness: "AUTO",
        },
      },
    ];

    this.addIsolationFilter(must, filter);

    const body = {
      size: limit,
      query: { bool: { must } },
      _source: true,
    };

    const result = await this.request("POST", `/${this.config.index}/_search`, body);
    if (!result.ok) return [];

    const data = await result.json();
    return (data.hits?.hits ?? []).map((hit: Record<string, unknown>) => this.mapHit(hit));
  }

  async searchVector(queryEmbedding: Float32Array, limit: number, filter?: IsolationFilter): Promise<SearchHit[]> {
    const must: unknown[] = [];

    this.addIsolationFilter(must, filter);

    const body = {
      size: limit,
      query: {
        bool: {
          must: must.length > 0 ? must : [{ match_all: {} }],
          should: [
            {
              knn: {
                embedding: {
                  vector: Array.from(queryEmbedding),
                  k: limit,
                },
              },
            },
          ],
        },
      },
      _source: true,
    };

    const result = await this.request("POST", `/${this.config.index}/_search`, body);
    if (!result.ok) return [];

    const data = await result.json();
    return (data.hits?.hits ?? []).map((hit: Record<string, unknown>) => this.mapHit(hit));
  }

  async searchHybrid(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    limit: number;
    filter?: IsolationFilter;
  }): Promise<SearchHit[]> {
    const { query, queryEmbedding, limit, filter } = params;
    const must: unknown[] = [];
    const should: unknown[] = [];

    if (query) {
      must.push({
        multi_match: {
          query,
          fields: ["content^2", "scene_name"],
          type: "best_fields",
        },
      });
    }

    if (queryEmbedding) {
      should.push({
        knn: {
          embedding: {
            vector: Array.from(queryEmbedding),
            k: limit,
          },
        },
      });
    }

    this.addIsolationFilter(must, filter);

    const body = {
      size: limit,
      query: {
        bool: {
          must: must.length > 0 ? must : [{ match_all: {} }],
          should,
          minimum_should_match: should.length > 0 ? 1 : 0,
        },
      },
      _source: true,
    };

    const result = await this.request("POST", `/${this.config.index}/_search`, body);
    if (!result.ok) return [];

    const data = await result.json();
    return (data.hits?.hits ?? []).map((hit: Record<string, unknown>) => this.mapHit(hit));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.request("GET", "/_cluster/health");
      return result.ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // No persistent connections to close
  }

  // ── Index a L1 record ──

  async indexL1(record: {
    record_id: string;
    content: string;
    type: string;
    priority: number;
    scene_name: string;
    embedding?: Float32Array;
    isolation?: IsolationFilter;
  }): Promise<void> {
    const doc: Record<string, unknown> = {
      record_id: record.record_id,
      content: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: record.scene_name,
      indexed_at: new Date().toISOString(),
    };

    if (record.embedding) {
      doc.embedding = Array.from(record.embedding);
    }

    if (record.isolation) {
      if (record.isolation.teamId) doc.team_id = record.isolation.teamId;
      if (record.isolation.userId) doc.user_id = record.isolation.userId;
      if (record.isolation.agentId) doc.agent_id = record.isolation.agentId;
    }

    await this.request("PUT", `/${this.config.index}/_doc/${record.record_id}`, doc);
  }

  // ── Bulk index ──

  async bulkIndex(records: Array<{
    record_id: string;
    content: string;
    type: string;
    priority: number;
    scene_name: string;
    embedding?: Float32Array;
    isolation?: IsolationFilter;
  }>): Promise<void> {
    if (records.length === 0) return;

    const body: string[] = [];
    for (const record of records) {
      body.push(JSON.stringify({ index: { _index: this.config.index, _id: record.record_id } }));
      const doc: Record<string, unknown> = {
        record_id: record.record_id,
        content: record.content,
        type: record.type,
        priority: record.priority,
        scene_name: record.scene_name,
        indexed_at: new Date().toISOString(),
      };
      if (record.embedding) doc.embedding = Array.from(record.embedding);
      if (record.isolation) {
        if (record.isolation.teamId) doc.team_id = record.isolation.teamId;
        if (record.isolation.userId) doc.user_id = record.isolation.userId;
        if (record.isolation.agentId) doc.agent_id = record.isolation.agentId;
      }
      body.push(JSON.stringify(doc));
    }

    await this.request("POST", `/_bulk`, body.join("\n") + "\n", "application/x-ndjson");
  }

  // ── Delete by ID ──

  async deleteL1(recordId: string): Promise<void> {
    await this.request("DELETE", `/${this.config.index}/_doc/${recordId}`);
  }

  // ── Internal helpers ──

  private async createIndex(): Promise<void> {
    const dimensions = this.config.vectorDimensions ?? 1536;
    const indexBody = {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        "index.knn": true,
      },
      mappings: {
        properties: {
          record_id: { type: "keyword" },
          content: { type: "text", analyzer: "standard" },
          type: { type: "keyword" },
          priority: { type: "integer" },
          scene_name: { type: "text", analyzer: "standard" },
          team_id: { type: "keyword" },
          user_id: { type: "keyword" },
          agent_id: { type: "keyword" },
          indexed_at: { type: "date" },
          embedding: {
            type: "knn_vector",
            dimension: dimensions,
            method: {
              name: "hnsw",
              space_type: "cosinesimil",
              engine: "nmslib",
            },
          },
        },
      },
    };

    await this.request("PUT", `/${this.config.index}`, indexBody);
    this.logger?.info?.(`[OpenSearch] Created index ${this.config.index} (vector dim=${dimensions})`);
  }

  private addIsolationFilter(must: unknown[], filter?: IsolationFilter): void {
    if (!filter) return;
    if (filter.teamId) must.push({ term: { team_id: filter.teamId } });
    if (filter.userId) must.push({ term: { user_id: filter.userId } });
    if (filter.agentId) must.push({ term: { agent_id: filter.agentId } });
  }

  private mapHit(hit: Record<string, unknown>): SearchHit {
    const source = (hit._source ?? {}) as Record<string, unknown>;
    return {
      record_id: String(source.record_id ?? hit._id ?? ""),
      content: String(source.content ?? ""),
      type: String(source.type ?? ""),
      priority: Number(source.priority ?? 0),
      scene_name: String(source.scene_name ?? ""),
      score: Number(hit._score ?? 0),
      timestamp_str: "",
      timestamp_start: "",
      timestamp_end: "",
      version: 0,
      session_key: "",
      session_id: "",
      team_id: String(source.team_id ?? ""),
      task_id: String(source.task_id ?? ""),
      user_id: String(source.user_id ?? ""),
      agent_id: String(source.agent_id ?? ""),
      metadata_json: "{}",
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
  ): Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }> {
    const url = `${this.config.url}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": contentType ?? "application/json",
    };

    if (this.config.username && this.config.password) {
      const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
      headers["Authorization"] = `Basic ${auth}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
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
