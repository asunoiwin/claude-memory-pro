/**
 * Knowledge Graph Module
 *
 * Multi-dimensional knowledge graph as memory index.
 *
 * Design:
 * - KG nodes: memoryId + summary + entityKey + categories (NO full content)
 * - KG edges: causal / temporal / subject / category / contradicts
 * - Source of truth: LanceDB (full content)
 * - KG lives in memory; built from LanceDB on server start
 * - Incremental updates on new memory store
 *
 * Recall flow:
 *   recall(query) → KG.query() → candidate memoryIds → LanceDB.getByIds() → full entries
 */

import type { MemoryStore, MemoryEntry } from './store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// Types
// ============================================================================

export type RelationType = 'causal' | 'temporal' | 'subject' | 'category' | 'contradicts';

export interface KGNode {
  id: string;
  summary: string;
  entityKey: string | null;
  categories: string[];
  importance: number;
  createdAt: number;
  updatedAt: number;
  superseded: boolean;
}

export interface KGEdge {
  source: string;
  target: string;
  relation: RelationType;
  weight: number;
}

export type RouteDimension = 'entity' | 'category' | 'temporal' | 'causal' | 'text' | 'neighbor';

export interface KGQueryResult {
  id: string;
  summary: string;
  entityKey: string | null;
  importance: number;
  score: number;
  reason: string;
  dimensions: RouteDimension[];
  superseded: boolean;
}

export interface KnowledgeGraphData {
  nodes: Map<string, KGNode>;
  byEntityKey: Map<string, string[]>;
  byCategory: Map<string, string[]>;
  edges: KGEdge[];
  builtAt: string | null;
}

// ============================================================================
// Tokenizer
// ============================================================================

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const spaceTokens = normalized.split(/\s+/).filter(t => t.length > 1);

  // 对中文字符段落补充 bigram，提升中文 entity 匹配精度
  const chineseSegments = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const bigrams: string[] = [];
  for (const seg of chineseSegments) {
    for (let i = 0; i < seg.length - 1; i++) {
      bigrams.push(seg.slice(i, i + 2));
    }
  }

  return [...new Set([...spaceTokens, ...bigrams])];
}

function textOverlap(a: string, b: string, minJaccard = 0.10): boolean {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let intersection = 0;
  for (const t of tokensA) { if (tokensB.has(t)) intersection++; }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union >= minJaccard;
}

function parseMetadata(entry: MemoryEntry): Record<string, any> {
  try { return entry.metadata ? JSON.parse(entry.metadata) : {}; } catch { return {}; }
}

function normalizeHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

function extractHintTokens(entry: MemoryEntry): string[] {
  const meta = parseMetadata(entry);
  const values = [meta.factKey, meta.taskKey, meta.ruleHint, meta.scope, entry.scope, meta.source];
  const tokens = new Set<string>();
  for (const value of values) {
    const normalized = normalizeHint(value);
    if (!normalized) continue;
    tokens.add(normalized);
    for (const token of tokenize(normalized)) tokens.add(token);
  }
  return Array.from(tokens);
}

function hasNegationSignal(text: string): boolean {
  return /(错误|撤回|移除|停用|不应该|不再|不参与|删除|禁用|不要|replace|replaced|revert|reverted|withdrawn|removed|deprecated)/i.test(text);
}

type MemoryStance = 'positive' | 'negative' | 'neutral';

function inferStructuredStance(entry: MemoryEntry): MemoryStance {
  const meta = parseMetadata(entry);
  const fragments = [
    entry.text,
    typeof meta.action === 'string' ? meta.action : '',
    typeof meta.failure === 'string' ? meta.failure : '',
    typeof meta.ruleHint === 'string' ? meta.ruleHint : '',
  ].filter(Boolean).join(' ');
  if (!fragments) return 'neutral';
  if (hasNegationSignal(fragments)) return 'negative';
  if (/(使用|采用|保留|作为|启用|合并|注入|replace with|use |keep |enable |adopt |merge )/i.test(fragments)) return 'positive';
  return 'neutral';
}

function contradictionStrength(a: MemoryEntry, b: MemoryEntry): number {
  const metaA = parseMetadata(a);
  const metaB = parseMetadata(b);
  const sameFactKey = normalizeHint(metaA.factKey) && normalizeHint(metaA.factKey) === normalizeHint(metaB.factKey);
  const sameTaskKey = normalizeHint(metaA.taskKey) && normalizeHint(metaA.taskKey) === normalizeHint(metaB.taskKey);
  const sameRuleHint = normalizeHint(metaA.ruleHint) && normalizeHint(metaA.ruleHint) === normalizeHint(metaB.ruleHint);
  if (!sameFactKey && !sameTaskKey) return 0;
  const stanceA = inferStructuredStance(a);
  const stanceB = inferStructuredStance(b);
  if (stanceA === 'neutral' || stanceB === 'neutral') return 0;
  if (stanceA === stanceB) return 0;
  if (sameFactKey) return 0.9;
  if (sameTaskKey && sameRuleHint) return 0.65;
  return 0;
}

function sharedHintStrength(a: MemoryEntry, b: MemoryEntry): number {
  const aHints = new Set(extractHintTokens(a));
  const bHints = new Set(extractHintTokens(b));
  if (aHints.size === 0 || bHints.size === 0) return 0;
  let overlap = 0;
  for (const token of aHints) { if (bHints.has(token)) overlap++; }
  return overlap;
}

function extractEntityKey(entry: MemoryEntry): string | null {
  const meta = parseMetadata(entry);
  const structuredKey = normalizeHint(meta.factKey) || normalizeHint(meta.taskKey) || normalizeHint(meta.ruleHint) || normalizeHint(meta.summary);
  if (structuredKey) return structuredKey;
  const tokens = tokenize(entry.text).slice(0, 5);
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).join('_');
}

function extractSummary(entry: MemoryEntry, maxLen = 120): string {
  try {
    if (entry.metadata) {
      const meta = JSON.parse(entry.metadata);
      if (meta.summary && typeof meta.summary === 'string') return meta.summary.slice(0, maxLen);
      const fragments = [
        typeof meta.factKey === 'string' ? meta.factKey : '',
        typeof meta.taskKey === 'string' ? meta.taskKey : '',
        typeof meta.ruleHint === 'string' ? meta.ruleHint : '',
      ].filter(Boolean);
      if (fragments.length > 0) return fragments.join(' | ').slice(0, maxLen);
    }
  } catch { /* ignore */ }
  return entry.text.slice(0, maxLen);
}

// ============================================================================
// KnowledgeGraphManager
// ============================================================================

export class KnowledgeGraphManager {
  private kg: KnowledgeGraphData;
  private store: MemoryStore;
  private supersededCache: Map<string, string>;

  constructor(store: MemoryStore) {
    this.store = store;
    this.kg = { nodes: new Map(), byEntityKey: new Map(), byCategory: new Map(), edges: [], builtAt: null };
    this.supersededCache = new Map();
  }

  async build(): Promise<void> {
    const entries = await this.store.list(undefined, undefined, 10000, 0);
    this.kg = { nodes: new Map(), byEntityKey: new Map(), byCategory: new Map(), edges: [], builtAt: new Date().toISOString() };
    this.supersededCache.clear();

    // Pass 1: build supersedes chain
    const entityKeyChain: Map<string, string[]> = new Map();
    for (const entry of entries) {
      const ek = extractEntityKey(entry);
      if (!ek) continue;
      if (!entityKeyChain.has(ek)) entityKeyChain.set(ek, []);
      entityKeyChain.get(ek)!.push(entry.id);
    }
    for (const [, ids] of entityKeyChain) {
      for (let i = 0; i < ids.length - 1; i++) {
        this.supersededCache.set(ids[i], ids[ids.length - 1]);
      }
    }

    // Pass 2: add nodes
    for (const entry of entries) {
      const ek = extractEntityKey(entry);
      const summary = extractSummary(entry);
      const node: KGNode = {
        id: entry.id, summary, entityKey: ek, categories: [entry.category],
        importance: entry.importance, createdAt: entry.timestamp, updatedAt: entry.timestamp,
        superseded: this.supersededCache.has(entry.id),
      };
      this.kg.nodes.set(entry.id, node);
      if (ek) {
        if (!this.kg.byEntityKey.has(ek)) this.kg.byEntityKey.set(ek, []);
        this.kg.byEntityKey.get(ek)!.push(entry.id);
      }
      if (!this.kg.byCategory.has(entry.category)) this.kg.byCategory.set(entry.category, []);
      this.kg.byCategory.get(entry.category)!.push(entry.id);
    }

    // Pass 3: build edges
    const nodeEntries = Array.from(this.kg.nodes.values());
    const entriesById = new Map(entries.map(e => [e.id, e]));
    for (let i = 0; i < nodeEntries.length; i++) {
      for (let j = i + 1; j < nodeEntries.length; j++) {
        const a = nodeEntries[i], b = nodeEntries[j];
        const entryA = entriesById.get(a.id), entryB = entriesById.get(b.id);
        if (!entryA || !entryB) continue;
        const metaA = parseMetadata(entryA), metaB = parseMetadata(entryB);
        const hintStrength = sharedHintStrength(entryA, entryB);

        // Subject / entity match
        if (a.entityKey && a.entityKey === b.entityKey) {
          this.kg.edges.push({ source: a.id, target: b.id, relation: 'subject', weight: 0.9 });
          if (a.createdAt < b.createdAt) {
            this.kg.edges.push({ source: a.id, target: b.id, relation: 'temporal', weight: 0.5 });
          }
        }

        const sameFactKey = normalizeHint(metaA.factKey) && normalizeHint(metaA.factKey) === normalizeHint(metaB.factKey);
        const sameTaskKey = normalizeHint(metaA.taskKey) && normalizeHint(metaA.taskKey) === normalizeHint(metaB.taskKey);
        if (sameFactKey || sameTaskKey) {
          this.kg.edges.push({ source: a.id, target: b.id, relation: 'subject', weight: 0.85 });
          if (a.createdAt < b.createdAt) {
            this.kg.edges.push({ source: a.id, target: b.id, relation: 'temporal', weight: 0.65 });
          } else if (b.createdAt < a.createdAt) {
            this.kg.edges.push({ source: b.id, target: a.id, relation: 'temporal', weight: 0.65 });
          }
        }

        // Category match
        if (b.categories.some(c => a.categories.includes(c))) {
          this.kg.edges.push({ source: a.id, target: b.id, relation: 'category', weight: 0.3 });
        }

        // Causal: text overlap
        if (textOverlap(a.summary, b.summary, 0.2)) {
          this.kg.edges.push({ source: a.id, target: b.id, relation: 'causal', weight: 0.4 });
        }

        if (hintStrength >= 2) {
          this.kg.edges.push({ source: a.id, target: b.id, relation: 'causal', weight: 0.55 });
        }

        // Contradiction detection
        const contradictionWeight = contradictionStrength(entryA, entryB);
        if (contradictionWeight > 0) {
          this.kg.edges.push({ source: a.id, target: b.id, relation: 'contradicts', weight: contradictionWeight });
        }
      }
    }

    // Pass 4: mark superseded
    for (const [oldId] of this.supersededCache) {
      const node = this.kg.nodes.get(oldId);
      if (node) node.superseded = true;
    }
  }

  async addNode(entry: MemoryEntry): Promise<void> {
    const ek = extractEntityKey(entry);
    const summary = extractSummary(entry);
    const node: KGNode = {
      id: entry.id, summary, entityKey: ek, categories: [entry.category],
      importance: entry.importance, createdAt: entry.timestamp, updatedAt: entry.timestamp, superseded: false,
    };
    this.kg.nodes.set(entry.id, node);
    if (ek) {
      if (!this.kg.byEntityKey.has(ek)) this.kg.byEntityKey.set(ek, []);
      this.kg.byEntityKey.get(ek)!.unshift(entry.id);
    }
    if (!this.kg.byCategory.has(entry.category)) this.kg.byCategory.set(entry.category, []);
    this.kg.byCategory.get(entry.category)!.unshift(entry.id);

    // Supersede older entries with same entityKey
    if (ek) {
      const existing = this.kg.byEntityKey.get(ek) || [];
      for (const oldId of existing) {
        if (oldId === entry.id) continue;
        this.supersededCache.set(oldId, entry.id);
        const oldNode = this.kg.nodes.get(oldId);
        if (oldNode) oldNode.superseded = true;
        this.kg.edges.push({ source: entry.id, target: oldId, relation: 'subject', weight: 0.9 });
      }
    }
  }

  /**
   * 多维路由查询。
   * KG 是多维索引，从 entity/category/temporal/causal/text 多个维度
   * 对同一条记忆做索引，返回候选 ID 及命中维度。
   * 向量数据库负责后续精排。
   */
  query(
    rawQuery: string,
    options: { limit?: number; includeSuperseded?: boolean } = {}
  ): KGQueryResult[] {
    const { limit = 10, includeSuperseded = false } = options;
    const queryTokens = new Set(tokenize(rawQuery));

    // 候选收集器：同一 ID 可被多个维度命中，分数和维度累加
    const candidates = new Map<string, { score: number; dimensions: Set<RouteDimension>; reason: string[] }>();

    const addCandidate = (id: string, score: number, dim: RouteDimension, reason: string) => {
      const node = this.kg.nodes.get(id);
      if (!node) return;
      if (!includeSuperseded && node.superseded) return;
      const existing = candidates.get(id);
      if (existing) {
        existing.score = Math.max(existing.score, score); // 取最高维度分
        existing.dimensions.add(dim);
        if (!existing.reason.includes(reason)) existing.reason.push(reason);
      } else {
        candidates.set(id, { score, dimensions: new Set([dim]), reason: [reason] });
      }
    };

    // === 维度 1：实体匹配（subject） ===
    const queryEntityKey = Array.from(queryTokens).slice(0, 3).join('_');
    for (const id of (this.kg.byEntityKey.get(queryEntityKey) || [])) {
      addCandidate(id, 1.0, 'entity', 'entity_key_match');
    }
    // 模糊实体匹配：遍历所有 entityKey，看 token 重叠
    for (const [ek, ids] of this.kg.byEntityKey) {
      const ekTokens = new Set(tokenize(ek));
      let overlap = 0;
      for (const t of queryTokens) { if (ekTokens.has(t)) overlap++; }
      if (overlap > 0 && overlap / Math.max(ekTokens.size, 1) >= 0.5) {
        for (const id of ids) {
          addCandidate(id, 0.85, 'entity', 'entity_fuzzy');
        }
      }
    }

    // === 维度 2：分类匹配 ===
    for (const [category, ids] of this.kg.byCategory) {
      if (!queryTokens.has(category)) continue;
      for (const id of ids) {
        addCandidate(id, 0.6, 'category', `category:${category}`);
      }
    }

    // === 维度 3：文本/token 重叠 ===
    for (const [id, node] of this.kg.nodes) {
      const nodeTokens = new Set(tokenize(node.summary));
      let overlap = 0;
      for (const t of queryTokens) { if (nodeTokens.has(t)) overlap++; }
      if (overlap === 0) continue;
      const score = (overlap / Math.max(queryTokens.size, 1)) * 0.7;
      if (score >= 0.2) {
        addCandidate(id, score, 'text', 'text_overlap');
      }
    }

    // === 维度 4：邻居扩展（通过 causal/temporal/subject 边） ===
    // 已命中的节点，沿关系边扩展邻居
    const directHits = new Set(candidates.keys());
    for (const edge of this.kg.edges) {
      if (edge.relation === 'category' || edge.relation === 'contradicts') continue;
      const dim: RouteDimension = edge.relation === 'temporal' ? 'temporal'
        : edge.relation === 'causal' ? 'causal' : 'neighbor';

      if (directHits.has(edge.source) && !directHits.has(edge.target)) {
        addCandidate(edge.target, edge.weight * 0.5, dim, `${edge.relation}_neighbor`);
      }
      if (directHits.has(edge.target) && !directHits.has(edge.source)) {
        addCandidate(edge.source, edge.weight * 0.5, dim, `${edge.relation}_neighbor`);
      }
    }

    // 组装结果：多维度命中加权 bonus
    const results: KGQueryResult[] = [];
    for (const [id, cand] of candidates) {
      const node = this.kg.nodes.get(id)!;
      // 多维度命中 bonus：每多一个维度 +0.1（最多 +0.3）
      const dimBonus = Math.min((cand.dimensions.size - 1) * 0.1, 0.3);
      const finalScore = Math.min(cand.score + dimBonus, 1.0);
      results.push({
        id: node.id, summary: node.summary, entityKey: node.entityKey,
        importance: node.importance, score: finalScore,
        reason: cand.reason.join('+'),
        dimensions: Array.from(cand.dimensions),
        superseded: node.superseded,
      });
    }

    results.sort((a, b) => b.score !== a.score ? b.score - a.score : b.importance - a.importance);
    return results.slice(0, limit);
  }

  getContradictions(memoryIds: string[]): Array<{ a: string; b: string; weight: number }> {
    const idSet = new Set(memoryIds);
    const result: Array<{ a: string; b: string; weight: number }> = [];
    for (const edge of this.kg.edges) {
      if (edge.relation !== 'contradicts') continue;
      if (idSet.has(edge.source) && idSet.has(edge.target)) {
        result.push({ a: edge.source, b: edge.target, weight: edge.weight });
      }
    }
    return result;
  }

  getStats() {
    return {
      totalNodes: this.kg.nodes.size,
      totalEdges: this.kg.edges.length,
      supersededNodes: Array.from(this.kg.nodes.values()).filter(n => n.superseded).length,
      entityKeys: this.kg.byEntityKey.size,
      categories: this.kg.byCategory.size,
      builtAt: this.kg.builtAt,
      edgesByRelation: {
        causal: this.kg.edges.filter(e => e.relation === 'causal').length,
        temporal: this.kg.edges.filter(e => e.relation === 'temporal').length,
        subject: this.kg.edges.filter(e => e.relation === 'subject').length,
        category: this.kg.edges.filter(e => e.relation === 'category').length,
        contradicts: this.kg.edges.filter(e => e.relation === 'contradicts').length,
      },
    };
  }

  getDebugSnapshot(limit = 50) {
    return {
      generatedAt: new Date().toISOString(),
      stats: this.getStats(),
      nodes: Array.from(this.kg.nodes.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
      edges: this.kg.edges.slice(0, Math.max(limit * 2, 100)),
      byEntityKey: Object.fromEntries(Array.from(this.kg.byEntityKey.entries()).slice(0, limit)),
      byCategory: Object.fromEntries(Array.from(this.kg.byCategory.entries()).slice(0, limit)),
    };
  }

  writeDebugSnapshot(filePath = join(homedir(), '.claude', 'memory-pro', 'kg-debug-latest.json')): string {
    const payload = this.getDebugSnapshot();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return filePath;
  }
}

// Module-level singleton
let _kgInstance: KnowledgeGraphManager | null = null;

export function setKG(kg: KnowledgeGraphManager): void { _kgInstance = kg; }
export function getKG(): KnowledgeGraphManager | null { return _kgInstance; }
