/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import { filterNoise } from "./noise-filter.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  recencyHalfLifeDays: number;
  recencyWeight: number;
  filterNoise: boolean;
  rerankApiKey?: string;
  rerankModel?: string;
  rerankEndpoint?: string;
  lengthNormAnchor: number;
  hardMinScore: number;
  timeDecayHalfLifeDays: number;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Defaults & Utilities
// ============================================================================

const BM25_BOOST_FACTOR = 0.15;

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "lightweight",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.10,
  filterNoise: true,
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
};

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const norm = Math.sqrt(nA) * Math.sqrt(nB);
  return norm === 0 ? 0 : dot / norm;
}

// ============================================================================
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
  ) {}

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, category } = context;
    const safeLimit = clampInt(limit, 1, 20);

    if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
      return this.vectorOnlyRetrieval(query, safeLimit, scopeFilter, category);
    }
    return this.hybridRetrieval(query, safeLimit, scopeFilter, category);
  }

  private async vectorOnlyRetrieval(
    query: string, limit: number, scopeFilter?: string[], category?: string
  ): Promise<RetrievalResult[]> {
    const queryVector = await this.embedder.embedQuery(query);
    const results = await this.store.vectorSearch(queryVector, limit * 2, this.config.minScore, scopeFilter);

    const filtered = category ? results.filter(r => r.entry.category === category) : results;
    const mapped: RetrievalResult[] = filtered.map((r, i) => ({
      ...r,
      sources: { vector: { score: r.score, rank: i + 1 } },
    }));

    return this.postProcess(mapped, limit);
  }

  private async hybridRetrieval(
    query: string, limit: number, scopeFilter?: string[], category?: string
  ): Promise<RetrievalResult[]> {
    const poolSize = Math.max(this.config.candidatePoolSize, limit * 2);
    const queryVector = await this.embedder.embedQuery(query);

    const [vectorResults, bm25Results] = await Promise.all([
      this.store.vectorSearch(queryVector, poolSize, 0.1, scopeFilter),
      this.store.bm25Search(query, poolSize, scopeFilter),
    ]);

    const vFiltered = category ? vectorResults.filter(r => r.entry.category === category) : vectorResults;
    const bFiltered = category ? bm25Results.filter(r => r.entry.category === category) : bm25Results;

    // Fuse with RRF
    const vectorMap = new Map(vFiltered.map((r, i) => [r.entry.id, { ...r, rank: i + 1 }]));
    const bm25Map = new Map(bFiltered.map((r, i) => [r.entry.id, { ...r, rank: i + 1 }]));
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);

    const fused: RetrievalResult[] = [];
    for (const id of allIds) {
      const vr = vectorMap.get(id);
      const br = bm25Map.get(id);
      const base = vr || br!;
      const vectorScore = vr ? vr.score : 0;
      const bm25Hit = br ? 1 : 0;
      const fusedScore = vr
        ? clamp01(vectorScore + bm25Hit * BM25_BOOST_FACTOR * vectorScore, 0.1)
        : clamp01(Math.max(br!.score, 0.5), 0.1);

      fused.push({
        entry: base.entry,
        score: fusedScore,
        sources: {
          vector: vr ? { score: vr.score, rank: vr.rank } : undefined,
          bm25: br ? { score: br.score, rank: br.rank } : undefined,
          fused: { score: fusedScore },
        },
      });
    }

    fused.sort((a, b) => b.score - a.score);
    const aboveMin = fused.filter(r => r.score >= this.config.minScore);

    // Rerank with cosine similarity
    const reranked = aboveMin.slice(0, limit * 2).map(r => {
      const cos = cosineSimilarity(queryVector, r.entry.vector);
      const combined = r.score * 0.7 + cos * 0.3;
      return {
        ...r,
        score: clamp01(combined, r.score),
        sources: { ...r.sources, reranked: { score: cos } },
      };
    });
    reranked.sort((a, b) => b.score - a.score);

    return this.postProcess(reranked, limit);
  }

  private postProcess(results: RetrievalResult[], limit: number): RetrievalResult[] {
    let processed = this.applyRecencyBoost(results);
    processed = this.applyImportanceWeight(processed);
    processed = this.applyTimeDecay(processed);
    processed = this.applyLengthNorm(processed);
    processed = processed.filter(r => r.score >= this.config.hardMinScore);
    if (this.config.filterNoise) {
      processed = filterNoise(processed, r => r.entry.text);
    }
    processed = this.applyMMR(processed);
    return processed.slice(0, limit);
  }

  private applyRecencyBoost(results: RetrievalResult[]): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0) return results;
    const now = Date.now();
    return results.map(r => {
      const ts = r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      return { ...r, score: clamp01(r.score + boost, r.score) };
    }).sort((a, b) => b.score - a.score);
  }

  private applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[] {
    return results.map(r => {
      const importance = r.entry.importance ?? 0.7;
      const factor = 0.7 + 0.3 * importance;
      return { ...r, score: clamp01(r.score * factor, r.score * 0.7) };
    }).sort((a, b) => b.score - a.score);
  }

  private applyTimeDecay(results: RetrievalResult[]): RetrievalResult[] {
    const halfLife = this.config.timeDecayHalfLifeDays;
    if (!halfLife || halfLife <= 0) return results;
    const now = Date.now();
    return results.map(r => {
      const ts = r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const factor = 0.5 + 0.5 * Math.exp(-ageDays / halfLife);
      return { ...r, score: clamp01(r.score * factor, r.score * 0.5) };
    }).sort((a, b) => b.score - a.score);
  }

  private applyLengthNorm(results: RetrievalResult[]): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;
    return results.map(r => {
      const ratio = r.entry.text.length / anchor;
      const logRatio = Math.log2(Math.max(ratio, 1));
      const factor = 1 / (1 + 0.5 * logRatio);
      return { ...r, score: clamp01(r.score * factor, r.score * 0.35) };
    }).sort((a, b) => b.score - a.score);
  }

  private applyMMR(results: RetrievalResult[], threshold = 0.85): RetrievalResult[] {
    if (results.length <= 1) return results;
    const selected: RetrievalResult[] = [];
    const deferred: RetrievalResult[] = [];
    for (const candidate of results) {
      const tooSimilar = selected.some(s => {
        if (!s.entry.vector?.length || !candidate.entry.vector?.length) return false;
        return cosineSimilarity(
          Array.from(s.entry.vector as Iterable<number>),
          Array.from(candidate.entry.vector as Iterable<number>)
        ) > threshold;
      });
      (tooSimilar ? deferred : selected).push(candidate);
    }
    return [...selected, ...deferred];
  }

  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig(): RetrievalConfig { return { ...this.config }; }
}

export function createRetriever(
  store: MemoryStore, embedder: Embedder, config?: Partial<RetrievalConfig>
): MemoryRetriever {
  return new MemoryRetriever(store, embedder, { ...DEFAULT_RETRIEVAL_CONFIG, ...config });
}
