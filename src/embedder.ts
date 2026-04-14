/**
 * Embedding Abstraction Layer
 * OpenAI-compatible API for various embedding providers
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";

// ============================================================================
// Embedding Cache (LRU with TTL)
// ============================================================================

interface CacheEntry {
  vector: number[];
  createdAt: number;
}

class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  public hits = 0;
  public misses = 0;

  constructor(maxSize = 256, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private key(text: string, task?: string): string {
    return createHash("sha256").update(`${task || ""}:${text}`).digest("hex").slice(0, 24);
  }

  get(text: string, task?: string): number[] | undefined {
    const k = this.key(text, task);
    const entry = this.cache.get(k);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      return undefined;
    }
    this.cache.delete(k);
    this.cache.set(k, entry);
    this.hits++;
    return entry.vector;
  }

  set(text: string, task: string | undefined, vector: number[]): void {
    const k = this.key(text, task);
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(k, { vector, createdAt: Date.now() });
  }

  get size(): number { return this.cache.size; }
  get stats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}

// ============================================================================
// Types & Configuration
// ============================================================================

export interface EmbeddingConfig {
  provider: "openai-compatible";
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;
  taskQuery?: string;
  taskPassage?: string;
  normalized?: boolean;
}

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "BAAI/bge-m3": 1024,
  "all-MiniLM-L6-v2": 384,
  "all-mpnet-base-v2": 768,
  "jina-embeddings-v5-text-small": 1024,
  "jina-embeddings-v5-text-nano": 768,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
};

export function getVectorDimensions(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) return overrideDims;
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}. Set EMBEDDING_DIMENSIONS or configure dimensions.`);
  }
  return dims;
}

// ============================================================================
// Embedder Class
// ============================================================================

export class Embedder {
  private client: OpenAI;
  public readonly dimensions: number;
  private readonly _cache: EmbeddingCache;
  private readonly _model: string;
  private readonly _taskQuery?: string;
  private readonly _taskPassage?: string;
  private readonly _normalized?: boolean;
  private readonly _requestDimensions?: number;

  constructor(config: EmbeddingConfig) {
    this._model = config.model;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._requestDimensions = config.dimensions;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });

    this.dimensions = getVectorDimensions(config.model, config.dimensions);
    this._cache = new EmbeddingCache(256, 30);
  }

  async embed(text: string): Promise<number[]> {
    return this.embedPassage(text);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskQuery);
  }

  async embedPassage(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskPassage);
  }

  private buildPayload(input: string | string[], task?: string): any {
    const payload: any = { model: this._model, input };
    if (task) payload.task = task;
    if (this._normalized !== undefined) payload.normalized = this._normalized;
    if (this._requestDimensions && this._requestDimensions > 0) {
      payload.dimensions = this._requestDimensions;
    }
    return payload;
  }

  private async embedSingle(text: string, task?: string): Promise<number[]> {
    if (!text || text.trim().length === 0) throw new Error("Cannot embed empty text");

    const cached = this._cache.get(text, task);
    if (cached) return cached;

    const response = await this.client.embeddings.create(this.buildPayload(text, task) as any);
    const embedding = response.data[0]?.embedding as number[] | undefined;
    if (!embedding) throw new Error("No embedding returned from provider");
    if (embedding.length !== this.dimensions) {
      throw new Error(`Dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`);
    }

    this._cache.set(text, task, embedding);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) return [];
    const response = await this.client.embeddings.create(
      this.buildPayload(texts.filter(t => t.trim()), this._taskPassage) as any
    );
    return response.data.map(item => item.embedding as number[]);
  }

  get model(): string { return this._model; }

  async test(): Promise<{ success: boolean; error?: string; dimensions?: number }> {
    try {
      const v = await this.embedPassage("test");
      return { success: true, dimensions: v.length };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  get cacheStats() { return this._cache.stats; }
}

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new Embedder(config);
}
