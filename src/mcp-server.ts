#!/usr/bin/env node
/**
 * Claude Memory Pro - MCP Server v2.0.0
 * LanceDB 语义记忆增强 + 知识图谱 + 记忆晋升 + 自动捕获
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { getVectorIssue, MemoryStore, type MemoryEntry, type VectorIssue } from "./store.js";
import { createEmbedder, getVectorDimensions } from "./embedder.js";
import { createRetriever, type RetrievalResult } from "./retriever.js";
import { isNoise } from "./noise-filter.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { refreshMemoryAtlas, getMemoryAtlasStatus, getAtlasHintsForQuery } from "./memory-atlas.js";
import { recordRecallBatch, generateHabitCandidates, buildInstinctContext, getHabitSummary, refreshHabitArtifacts, removeFromHabits } from "./habit-tracker.js";
import { AutoCaptureEngine, llmJsonAnalyze } from "./auto-capture.js";
import { cleanupStoredMemories } from "./memory-cleaner.js";
import { CaptureJournal } from "./capture-journal.js";
import { AuditEngine } from "./audit.js";
import {
  KnowledgeGraphManager,
  setKG,
  getKG,
  isFactKeyCategory,
  metadataWithFactKey,
  normalizeFactKey,
  parseMemoryMetadata,
  type MetadataStance,
} from "./knowledge-graph.js";
import { promoteMemoriesFromStore, recoverMissedPhases, getDreamStats, readDreamTrail, DEFAULT_CONFIG as DREAM_DEFAULT_CONFIG, type DreamConfig } from "./dream-manager.js";
import { runDailyReorganization } from "./memory-daily-reorg.js";

// ============================================================================
// Configuration
// ============================================================================

const DB_PATH = process.env.MEMORY_DB_PATH || join(homedir(), ".claude", "memory-pro", "lancedb");
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "";
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || "https://api.siliconflow.cn/v1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || "0") || undefined;
// 判定/捕获 LLM 默认走智谱免费模型 GLM-4.5-Flash（保留思考，靠 response_format 稳定吐 JSON）；
// key 必须独立配 CAPTURE_API_KEY（智谱与硅基流动 embedding key 不通用）
const CAPTURE_API_KEY = process.env.CAPTURE_API_KEY || "";
const CAPTURE_BASE_URL = process.env.CAPTURE_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const CAPTURE_MODEL = process.env.CAPTURE_MODEL || "glm-4.5-flash";

// ============================================================================
// Initialize Components
// ============================================================================

mkdirSync(DB_PATH, { recursive: true });

const vectorDim = getVectorDimensions(EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
const store = new MemoryStore({ dbPath: DB_PATH, vectorDim });
const embedder = createEmbedder({
  provider: "openai-compatible",
  apiKey: EMBEDDING_API_KEY,
  model: EMBEDDING_MODEL,
  baseURL: EMBEDDING_BASE_URL,
  dimensions: EMBEDDING_DIMENSIONS,
});
const retriever = createRetriever(store, embedder);
const autoCapture = new AutoCaptureEngine(store, embedder);
const captureJournal = new CaptureJournal();
const auditEngine = new AuditEngine(store);
const knowledgeGraph = new KnowledgeGraphManager(store);
setKG(knowledgeGraph);

const CATEGORIES = ["preference", "fact", "decision", "entity", "other", "task", "lesson"] as const;

// ============================================================================
// Helpers
// ============================================================================

function cosineSimVectors(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0, nA = 0, nB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i];
  }
  const norm = Math.sqrt(nA) * Math.sqrt(nB);
  return norm > 0 ? dot / norm : 0;
}

function mmrDedup(scored: RetrievalResult[], limit: number, threshold = 0.85): RetrievalResult[] {
  const selected: RetrievalResult[] = [];
  for (const candidate of scored) {
    const tooSimilar = selected.some(s => {
      const sVec = Array.from(s.entry.vector as Iterable<number>);
      const cVec = Array.from(candidate.entry.vector as Iterable<number>);
      return cosineSimVectors(sVec, cVec) > threshold;
    });
    if (!tooSimilar) selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function clamp01(v: number, fallback = 0.7): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function formatResults(results: RetrievalResult[]): string {
  if (results.length === 0) return "未找到相关记忆。";
  return results.map((r, i) => {
    const sources: string[] = [];
    if (r.sources.vector) sources.push("vector");
    if (r.sources.bm25) sources.push("BM25");
    if (r.sources.reranked) sources.push("reranked");
    let meta: Record<string, any> = {};
    try { if (r.entry.metadata) meta = JSON.parse(r.entry.metadata); } catch { /* ignore */ }
    const metaParts: string[] = [];
    if (meta.taskId) metaParts.push(`task=${meta.taskId}`);
    if (meta.source) metaParts.push(`source=${meta.source}`);
    const metaStr = metaParts.length > 0 ? ` {${metaParts.join(", ")}}` : "";
    return `${i + 1}. [${r.entry.category}:${r.entry.scope}] ${r.entry.text}${metaStr} (${(r.score * 100).toFixed(0)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
  }).join("\n");
}

type VectorHealth = {
  total: number;
  valid: number;
  zero: number;
  badDim: number;
  empty: number;
  coveragePct: number;
};

function newVectorHealth(): VectorHealth {
  return { total: 0, valid: 0, zero: 0, badDim: 0, empty: 0, coveragePct: 100 };
}

function finalizeVectorHealth(health: VectorHealth): VectorHealth {
  health.coveragePct = health.total === 0 ? 100 : Number(((health.valid / health.total) * 100).toFixed(2));
  return health;
}

function tallyVector(entry: MemoryEntry, health: VectorHealth): VectorIssue | null {
  const issue = getVectorIssue(entry.vector, vectorDim);
  health.total += 1;
  if (!issue) {
    health.valid += 1;
    return null;
  }
  health[issue] += 1;
  return issue;
}

async function scanVectorHealth(scope?: string, pageSize = 500): Promise<VectorHealth> {
  const scopeFilter = scope ? [scope] : undefined;
  const totalRows = await store.count(scopeFilter);
  const safePageSize = clampInt(pageSize, 1, 1000);
  const health = newVectorHealth();

  for (let offset = 0; offset < totalRows; offset += safePageSize) {
    const entries = await store.scan(scopeFilter, safePageSize, offset);
    if (entries.length === 0) break;
    for (const entry of entries) {
      tallyVector(entry, health);
    }
  }

  return finalizeVectorHealth(health);
}

function normalizeLLMStance(value: unknown): MetadataStance | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "affirm" || normalized === "positive") return "affirm";
  if (normalized === "negate" || normalized === "negative") return "negate";
  if (normalized === "neutral") return "neutral";
  return null;
}

function hasStanceLLMConfig(): boolean {
  return Boolean(CAPTURE_API_KEY && CAPTURE_BASE_URL && CAPTURE_MODEL);
}

async function scanFactEntries(scope?: string, pageSize = 500): Promise<MemoryEntry[]> {
  const scopeFilter = scope ? [scope] : undefined;
  const totalRows = await store.count(scopeFilter);
  const safePageSize = clampInt(pageSize, 1, 1000);
  const entries: MemoryEntry[] = [];
  for (let offset = 0; offset < totalRows; offset += safePageSize) {
    const batch = await store.scan(scopeFilter, safePageSize, offset);
    if (batch.length === 0) break;
    for (const entry of batch) {
      if (isFactKeyCategory(entry.category)) entries.push(entry);
    }
  }
  return entries;
}

async function findEntriesByFactKey(factKey: string, options: { scope?: string; excludeId?: string } = {}): Promise<MemoryEntry[]> {
  const target = normalizeFactKey(factKey);
  if (!target) return [];
  const entries = await scanFactEntries(options.scope, 500);
  return entries.filter(entry => {
    if (options.excludeId && entry.id === options.excludeId) return false;
    const meta = parseMemoryMetadata(entry);
    return normalizeFactKey(meta.factKey) === target;
  });
}

async function classifyFactStance(
  text: string,
  factKey: string,
  peers: MemoryEntry[]
): Promise<MetadataStance | null> {
  if (!hasStanceLLMConfig()) {
    console.error("[claude-memory-pro] stance LLM 未配置，跳过 metadata.stance 判定");
    return null;
  }

  const references = peers.slice(0, 5).map((entry, index) => {
    const meta = parseMemoryMetadata(entry);
    const stance = typeof meta.stance === "string" ? ` stance=${meta.stance}` : "";
    return `${index + 1}. [${entry.category}:${entry.scope}${stance}] ${entry.text.slice(0, 220)}`;
  }).join("\n");

  const result = await llmJsonAnalyze<{ stance?: string }>({
    apiKey: CAPTURE_API_KEY,
    baseURL: CAPTURE_BASE_URL,
    model: CAPTURE_MODEL,
    systemPrompt: "你是事实立场分类器，只输出 JSON。",
    userPrompt: [
      "判断“当前记忆”对同一 factKey 所描述事实的立场。",
      "只输出 JSON：{\"stance\":\"affirm|negate|neutral\"}",
      "affirm=肯定/确认/采纳/启用/保留该事实或方案成立。",
      "negate=否定/撤回/废弃/推翻/禁用/说明该事实或方案不再成立。",
      "neutral=只是背景、过程、疑问、证据不足或无法判断。",
      `factKey: ${factKey}`,
      references ? `同组参考（仅用于理解主题，不要求立场一致）：\n${references}` : "同组参考：无",
      `当前记忆：${text.slice(0, 900)}`,
    ].join("\n"),
  });

  const stance = normalizeLLMStance(result?.stance);
  if (!stance) {
    console.error(`[claude-memory-pro] stance LLM 判定失败或输出非法，factKey=${factKey}`);
    return null;
  }
  return stance;
}

type ContradictionVerdict = { sameFact: boolean; contradicts: boolean; confidence: number };

async function classifyContradictionPair(a: MemoryEntry, b: MemoryEntry, model = CAPTURE_MODEL): Promise<ContradictionVerdict | null> {
  const result = await llmJsonAnalyze<{ sameFact?: boolean; contradicts?: boolean; confidence?: number }>({
    apiKey: CAPTURE_API_KEY,
    baseURL: CAPTURE_BASE_URL,
    model,
    systemPrompt: "你是记忆矛盾检测器，只输出 JSON。",
    userPrompt: [
      "判断记忆 A 与 B 是否在陈述同一对象的同一属性/结论，以及二者是否相互矛盾。",
      '只输出 JSON：{"sameFact":bool,"contradicts":bool,"confidence":0~1}',
      "sameFact=true 仅当两条针对同一对象的同一属性/结论；不同主题、互补信息或仅同领域=false。",
      "contradicts=true 仅当 sameFact 且结论相反（一个肯定一个否定、数值冲突、方案互斥）。",
      `A：${a.text.slice(0, 700)}`,
      `B：${b.text.slice(0, 700)}`,
    ].join("\n"),
  });
  if (!result) return null;
  const confidence = typeof result.confidence === "number" ? Math.max(0, Math.min(1, result.confidence)) : 0;
  return { sameFact: result.sameFact === true, contradicts: result.contradicts === true, confidence };
}

async function buildWriteMetadataWithFactStance(
  text: string,
  category: MemoryEntry["category"],
  scope: string,
  metadata: Record<string, any>,
  options: { excludeId?: string; collisionScope?: string } = {}
): Promise<Record<string, any>> {
  const withFactKey = metadataWithFactKey({
    text,
    category,
    scope,
    metadata: JSON.stringify(metadata),
  });
  const factKey = normalizeFactKey(withFactKey.factKey);
  if (!factKey) return withFactKey;

  const peers = await findEntriesByFactKey(factKey, {
    scope: options.collisionScope,
    excludeId: options.excludeId,
  });
  if (peers.length === 0) return withFactKey;

  const stance = await classifyFactStance(text, factKey, peers);
  if (!stance) return withFactKey;
  return {
    ...withFactKey,
    stance,
    stanceSource: "llm",
    stanceUpdatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: "claude-memory-pro",
  version: "2.0.0",
});

// -- memory_recall --
server.tool(
  "memory_recall",
  "语义检索长期记忆。KG 多维路由（实体/时间/因果/分类）→ 向量精排。KG 为空时回退到纯向量检索。",
  {
    query: z.string().describe("搜索查询文本"),
    limit: z.number().min(1).max(20).default(5).describe("最大返回数量（默认5）"),
    scope: z.string().optional().describe("限定搜索的记忆域（可选）"),
    category: z.enum(CATEGORIES).optional().describe("限定记忆分类（可选）"),
  },
  async ({ query, limit, scope, category }) => {
    if (shouldSkipRetrieval(query)) {
      return { content: [{ type: "text" as const, text: "查询过短或为系统命令，已跳过检索。" }] };
    }

    const scopeFilter = scope ? [scope] : undefined;
    let results: RetrievalResult[] = [];
    let recallPath = 'fallback';

    // === 主路径：KG 多维路由 → 向量精排 ===
    const kg = getKG();
    if (kg && kg.getStats().totalNodes > 0) {
      const kgCandidates = kg.query(query, { limit: limit * 4 });

      if (kgCandidates.length > 0) {
        recallPath = 'kg_routed';
        const candidateIds = kgCandidates.map(c => c.id);
        const entries = await store.getByIds(candidateIds);
        const entryMap = new Map(entries.map(e => [e.id, e]));
        const queryVector = await embedder.embedQuery(query);

        const scored: RetrievalResult[] = [];
        for (const kgResult of kgCandidates) {
          const entry = entryMap.get(kgResult.id);
          if (!entry) continue;
          if (category && entry.category !== category) continue;
          if (scopeFilter && !scopeFilter.includes(entry.scope)) continue;

          const entryVector = Array.from(entry.vector as Iterable<number>);
          const vectorSim = cosineSimVectors(queryVector, entryVector);
          const combinedScore = Math.min(
            kgResult.score * 0.4 + vectorSim * 0.4 + (entry.importance ?? 0.5) * 0.2,
            1.0
          );

          scored.push({
            entry, score: combinedScore,
            sources: {
              vector: { score: vectorSim, rank: 0 },
              fused: { score: combinedScore },
            },
          });
        }

        scored.sort((a, b) => b.score - a.score);
        results = mmrDedup(scored, limit);
      }
    }

    // === 回退路径：KG 为空（冷启动）→ 纯向量+BM25 检索 ===
    if (results.length === 0) {
      recallPath = 'vector_fallback';
      results = await retriever.retrieve({ query, limit, scopeFilter, category });
    }

    // === 副作用：记录召回频率（暂存层，不影响排序） ===
    if (results.length > 0) {
      recordRecallBatch(results.map(r => ({ id: r.entry.id, text: r.entry.text, category: r.entry.category })));
      store.incrementRecallBatch(results.map(r => r.entry.id)).catch(() => {});
    }

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "未找到相关记忆。" }] };
    }
    const pathLabel = recallPath === 'kg_routed' ? 'KG路由' : '向量回退';
    return { content: [{ type: "text" as const, text: `[${pathLabel}] 找到 ${results.length} 条记忆：\n\n${formatResults(results)}` }] };
  }
);

// -- memory_store --
server.tool(
  "memory_store",
  "保存重要信息到长期记忆。自动去重、噪音过滤，支持分类和重要性评分。",
  {
    text: z.string().describe("要记住的信息内容"),
    importance: z.number().min(0).max(1).default(0.7).describe("重要性评分 0-1（默认0.7）"),
    category: z.enum(CATEGORIES).default("other").describe("记忆分类"),
    scope: z.string().default("global").describe("记忆域（默认global）"),
  },
  async ({ text, importance, category, scope }) => {
    if (isNoise(text)) {
      return { content: [{ type: "text" as const, text: "跳过：文本被识别为噪音" }] };
    }

    const safeImportance = clamp01(importance);
    const vector = await embedder.embedPassage(text.slice(0, 500));

    const existing = await store.vectorSearch(vector, 1, 0.1, [scope]);
    if (existing.length > 0 && existing[0].score > 0.98) {
      return {
        content: [{ type: "text" as const, text: `已存在相似记忆：「${existing[0].entry.text}」（相似度 ${(existing[0].score * 100).toFixed(0)}%）` }],
      };
    }

    const metadata = await buildWriteMetadataWithFactStance(
      text.slice(0, 5000),
      category,
      scope,
      { source: "manual_store", storedAt: new Date().toISOString() }
    );

    const newEntry = await store.store({
      text: text.slice(0, 5000), vector, importance: safeImportance, category, scope,
      metadata: JSON.stringify(metadata),
    });

    // 增量更新 KG
    const kg = getKG();
    if (kg) kg.addNode(newEntry).catch(() => {});

    const journalEntry = captureJournal.append({ content: text.slice(0, 5000), category, importance: safeImportance, context: { source: 'manual_store' } });
    captureJournal.update(journalEntry.id, { status: 'captured' });

    return {
      content: [{ type: "text" as const, text: `已存储：「${text.slice(0, 100)}${text.length > 100 ? "..." : ""}」 → 域 '${scope}'，分类 '${category}'，重要性 ${safeImportance}` }],
    };
  }
);

// -- memory_forget --
server.tool(
  "memory_forget",
  "删除指定记忆。支持按 ID 直接删除或按语义搜索后删除。",
  {
    query: z.string().optional().describe("搜索查询以查找要删除的记忆"),
    memoryId: z.string().optional().describe("直接指定要删除的记忆 ID"),
  },
  async ({ query, memoryId }) => {
    if (memoryId) {
      const deleted = await store.delete(memoryId);
      if (deleted) removeFromHabits(memoryId);
      return { content: [{ type: "text" as const, text: deleted ? `已删除记忆 ${memoryId}` : `未找到记忆 ${memoryId}` }] };
    }
    if (query) {
      const results = await retriever.retrieve({ query, limit: 5 });
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "未找到匹配的记忆。" }] };
      }
      if (results.length === 1 && results[0].score > 0.9) {
        const id = results[0].entry.id;
        await store.delete(id);
        removeFromHabits(id);
        return { content: [{ type: "text" as const, text: `已删除：「${results[0].entry.text}」` }] };
      }
      const list = results.map(r => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}...`).join("\n");
      return { content: [{ type: "text" as const, text: `找到 ${results.length} 条候选，请指定 memoryId：\n${list}` }] };
    }
    return { content: [{ type: "text" as const, text: "请提供 query 或 memoryId。" }] };
  }
);

// -- memory_update --
server.tool(
  "memory_update",
  "更新已有记忆的内容、重要性或分类。保留原始时间戳。",
  {
    memoryId: z.string().describe("要更新的记忆 ID"),
    text: z.string().optional().describe("新的文本内容（触发重新嵌入）"),
    importance: z.number().min(0).max(1).optional().describe("新的重要性评分"),
    category: z.enum(CATEGORIES).optional().describe("新的分类"),
  },
  async ({ memoryId, text, importance, category }) => {
    if (!text && importance === undefined && !category) {
      return { content: [{ type: "text" as const, text: "至少提供一项更新。" }] };
    }
    const updates: Record<string, any> = {};
    if (text) {
      if (isNoise(text)) return { content: [{ type: "text" as const, text: "跳过：噪音文本。" }] };
      updates.text = text;
      updates.vector = await embedder.embedPassage(text);
    }
    if (importance !== undefined) updates.importance = clamp01(importance);
    if (category) updates.category = category;
    if (text || category) {
      const existing = (await store.getByIds([memoryId]))[0];
      if (existing) {
        const nextText = text || existing.text;
        const nextCategory = category || existing.category;
        const nextMeta = await buildWriteMetadataWithFactStance(
          nextText,
          nextCategory,
          existing.scope,
          parseMemoryMetadata(existing),
          { excludeId: existing.id }
        );
        updates.metadata = JSON.stringify(nextMeta);
      }
    }
    const updated = await store.update(memoryId, updates);
    if (!updated) return { content: [{ type: "text" as const, text: `未找到记忆 ${memoryId}` }] };
    return { content: [{ type: "text" as const, text: `已更新 ${updated.id.slice(0, 8)}：「${updated.text.slice(0, 80)}」` }] };
  }
);

// -- memory_list --
server.tool(
  "memory_list",
  "列出最近的记忆，支持按域和分类过滤。",
  {
    limit: z.number().min(1).max(50).default(10).describe("最大数量"),
    scope: z.string().optional().describe("按域过滤"),
    category: z.enum(CATEGORIES).optional().describe("按分类过滤"),
    offset: z.number().min(0).default(0).describe("跳过前 N 条"),
  },
  async ({ limit, scope, category, offset }) => {
    const scopeFilter = scope ? [scope] : undefined;
    const entries = await store.list(scopeFilter, category, limit, offset);
    if (entries.length === 0) return { content: [{ type: "text" as const, text: "暂无记忆。" }] };
    const text = entries.map((e, i) => {
      const date = new Date(e.timestamp).toISOString().split("T")[0];
      return `${offset + i + 1}. [${e.category}:${e.scope}] ${e.text.slice(0, 100)}${e.text.length > 100 ? "..." : ""} (${date})`;
    }).join("\n");
    return { content: [{ type: "text" as const, text: `记忆列表（${entries.length}条）：\n\n${text}` }] };
  }
);

// -- memory_stats --
server.tool(
  "memory_stats",
  "查看记忆系统完整统计：总数、分布、习惯追踪、知识图谱、捕获队列。",
  {},
  async () => {
    const stats = await store.stats();
    const vectorHealth = await scanVectorHealth();
    const config = retriever.getConfig();
    const cacheStats = embedder.cacheStats;
    const habitSummary = getHabitSummary();
    const atlasStatus = getMemoryAtlasStatus();
    const journalStats = captureJournal.stats();

    const lines = [
      `记忆统计：`,
      `• 总记忆数：${stats.totalCount}`,
      `• 检索模式：${config.mode}`,
      `• FTS 支持：${store.hasFtsSupport ? "是" : "否"}`,
      `• 嵌入缓存（进程内临时缓存，非存量覆盖率）：${cacheStats.size} 条，命中率 ${cacheStats.hitRate}`,
      `• vectorHealth: { total: ${vectorHealth.total}, valid: ${vectorHealth.valid}, zero: ${vectorHealth.zero}, badDim: ${vectorHealth.badDim}, empty: ${vectorHealth.empty}, coveragePct: ${vectorHealth.coveragePct} }`,
      ``, `按域分布：`,
      ...Object.entries(stats.scopeCounts).map(([s, c]) => `  • ${s}: ${c}`),
      ``, `按分类分布：`,
      ...Object.entries(stats.categoryCounts).map(([c, n]) => `  • ${c}: ${n}`),
      ``, `习惯追踪：`,
      `  • 总追踪：${habitSummary.total}，promote: ${habitSummary.promote}，reinforce: ${habitSummary.reinforce}，retain: ${habitSummary.retain}`,
      ``, `知识图谱：${atlasStatus ? `已生成（${atlasStatus.totalIndexed || 0}条，${Array.isArray(atlasStatus.clusters) ? atlasStatus.clusters.length : 0}个聚类）` : '未生成'}`,
      ``, `捕获队列：总计${journalStats.total}，待处理${journalStats.pending}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// -- memory_reindex --
server.tool(
  "memory_reindex",
  "诊断并修复存量记忆的向量健康。dryRun 默认只统计真实 LanceDB 覆盖率，不写入。",
  {
    dryRun: z.boolean().default(true).describe("true=只报告不写入；false=对坏向量重新嵌入并回填"),
    batchSize: z.number().min(1).max(500).default(50).describe("扫描和回填批大小（默认50）"),
    scope: z.string().optional().describe("限定记忆域（可选）"),
  },
  async ({ dryRun, batchSize, scope }) => {
    const scopeFilter = scope ? [scope] : undefined;
    const safeBatchSize = clampInt(batchSize, 1, 500);
    const totalRows = await store.count(scopeFilter);
    const health = newVectorHealth();
    const badEntries: Array<{ entry: MemoryEntry; issue: VectorIssue }> = [];

    for (let offset = 0; offset < totalRows; offset += safeBatchSize) {
      const entries = await store.scan(scopeFilter, safeBatchSize, offset);
      if (entries.length === 0) break;
      for (const entry of entries) {
        const issue = tallyVector(entry, health);
        if (issue) badEntries.push({ entry, issue });
      }
    }
    finalizeVectorHealth(health);

    let repaired = 0;
    let failed = 0;
    const failedIds: string[] = [];

    if (!dryRun) {
      for (let i = 0; i < badEntries.length; i += safeBatchSize) {
        const batch = badEntries.slice(i, i + safeBatchSize);
        for (const { entry } of batch) {
          try {
            const vector = await embedder.embedPassage(entry.text.slice(0, 500));
            const updated = await store.update(entry.id, { vector });
            if (updated) {
              repaired += 1;
            } else {
              failed += 1;
              failedIds.push(entry.id);
            }
          } catch {
            failed += 1;
            failedIds.push(entry.id);
          }
        }
      }
    }

    const lines = [
      `memory_reindex ${dryRun ? "dryRun" : "执行"} 完成：`,
      `• scope：${scope || "全部"}`,
      `• 总数：${health.total}`,
      `• 有效：${health.valid}（coveragePct=${health.coveragePct}）`,
      `• 坏向量：${badEntries.length}（zero=${health.zero}, badDim=${health.badDim}, empty=${health.empty}）`,
      `• 本次回填数：${repaired}`,
      `• 失败数：${failed}`,
    ];
    if (failedIds.length > 0) {
      lines.push(`• 失败ID：${failedIds.slice(0, 20).map(id => id.slice(0, 8)).join(", ")}${failedIds.length > 20 ? " ..." : ""}`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// -- memory_backfill_facts --
server.tool(
  "memory_backfill_facts",
  "为存量 decision/lesson/fact 记忆回填 metadata.factKey；同 factKey 分组成员>=2 时用轻量 LLM 回填 metadata.stance。dryRun 默认只报告。",
  {
    dryRun: z.boolean().default(true).describe("true=只报告分组和预计 LLM 调用；false=写回 factKey/stance"),
    batchSize: z.number().min(1).max(500).default(50).describe("扫描和回填批大小（默认50）"),
    scope: z.string().optional().describe("限定记忆域（可选）"),
  },
  async ({ dryRun, batchSize, scope }) => {
    const safeBatchSize = clampInt(batchSize, 1, 500);
    const entries = await scanFactEntries(scope, safeBatchSize);
    const plans: Array<{ entry: MemoryEntry; meta: Record<string, any>; factKey: string; hadFactKey: boolean }> = [];
    let noFactKey = 0;
    let generatedFactKey = 0;

    for (const entry of entries) {
      const before = parseMemoryMetadata(entry);
      const hadFactKey = Boolean(normalizeFactKey(before.factKey));
      const meta = metadataWithFactKey(entry);
      const factKey = normalizeFactKey(meta.factKey);
      if (!factKey) {
        noFactKey += 1;
        continue;
      }
      if (!hadFactKey) generatedFactKey += 1;
      plans.push({ entry, meta, factKey, hadFactKey });
    }

    const groups = new Map<string, Array<{ entry: MemoryEntry; meta: Record<string, any>; factKey: string; hadFactKey: boolean }>>();
    for (const plan of plans) {
      if (!groups.has(plan.factKey)) groups.set(plan.factKey, []);
      groups.get(plan.factKey)!.push(plan);
    }
    const collisionGroups = Array.from(groups.entries()).filter(([, members]) => members.length >= 2);
    const llmCallCount = collisionGroups.reduce((sum, [, members]) => sum + members.length, 0);
    const previewGroups = collisionGroups
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .map(([factKey, members]) => `  • ${factKey}：${members.length} 条`);

    let factKeyWritten = 0;
    let stanceWritten = 0;
    let stanceSkipped = 0;
    let failed = 0;
    const failedIds: string[] = [];

    if (!dryRun) {
      for (let i = 0; i < plans.length; i += safeBatchSize) {
        const batch = plans.slice(i, i + safeBatchSize);
        for (const plan of batch) {
          if (plan.hadFactKey) continue;
          try {
            const updated = await store.update(plan.entry.id, { metadata: JSON.stringify(plan.meta) });
            if (updated) {
              factKeyWritten += 1;
            } else {
              failed += 1;
              failedIds.push(plan.entry.id);
            }
          } catch (error) {
            console.error(`[claude-memory-pro] factKey 回填失败 id=${plan.entry.id}:`, error instanceof Error ? error.message : String(error));
            failed += 1;
            failedIds.push(plan.entry.id);
          }
        }
      }

      if (!hasStanceLLMConfig() && llmCallCount > 0) {
        console.error("[claude-memory-pro] stance LLM 未配置，跳过所有 metadata.stance 回填");
        stanceSkipped = llmCallCount;
      } else {
        for (const [, members] of collisionGroups) {
          for (const member of members) {
            const peers = members.filter(other => other.entry.id !== member.entry.id).map(other => other.entry);
            const stance = await classifyFactStance(member.entry.text, member.factKey, peers);
            if (!stance) {
              failed += 1;
              failedIds.push(member.entry.id);
              continue;
            }
            const nextMeta = {
              ...member.meta,
              stance,
              stanceSource: "llm",
              stanceUpdatedAt: new Date().toISOString(),
            };
            try {
              const updated = await store.update(member.entry.id, { metadata: JSON.stringify(nextMeta) });
              if (updated) {
                stanceWritten += 1;
              } else {
                failed += 1;
                failedIds.push(member.entry.id);
              }
            } catch (error) {
              console.error(`[claude-memory-pro] stance 回填失败 id=${member.entry.id}:`, error instanceof Error ? error.message : String(error));
              failed += 1;
              failedIds.push(member.entry.id);
            }
          }
        }
      }

      const kg = getKG();
      if (kg) {
        try {
          await kg.build();
        } catch (error) {
          console.error("[claude-memory-pro] fact 回填后 KG 重建失败:", error instanceof Error ? error.message : String(error));
        }
      }
    }

    const lines = [
      `memory_backfill_facts ${dryRun ? "dryRun" : "执行"} 完成：`,
      `• scope：${scope || "全部"}`,
      `• 扫描 decision/lesson/fact：${entries.length}`,
      `• 可用 factKey：${plans.length}`,
      `• 规则新生成 factKey：${generatedFactKey}`,
      `• 无法生成 factKey：${noFactKey}`,
      `• factKey 分组：${groups.size}`,
      `• 碰撞分组（成员>=2）：${collisionGroups.length}`,
      `• 预计/实际 stance LLM 调用：${llmCallCount}`,
      `• 本次写入 factKey：${factKeyWritten}`,
      `• 本次写入 stance：${stanceWritten}`,
      `• stance 跳过：${stanceSkipped}`,
      `• 失败数：${failed}`,
    ];
    if (previewGroups.length > 0) {
      lines.push("", "碰撞分组预览：", ...previewGroups);
    }
    if (failedIds.length > 0) {
      lines.push(`• 失败ID：${failedIds.slice(0, 30).map(id => id.slice(0, 8)).join(", ")}${failedIds.length > 30 ? " ..." : ""}`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// -- memory_scan_contradictions --
server.tool(
  "memory_scan_contradictions",
  "用向量近邻召回疑似讲同一事实的记忆对，再用 LLM 判定是否真矛盾。绕开 factKey 精确碰撞死结。dryRun 默认只报告候选规模，不写库。",
  {
    dryRun: z.boolean().default(true).describe("true=只报告候选对规模与预计 LLM 次数；false=真调 LLM 判定并列出矛盾对（仍不写库）"),
    topK: z.number().min(1).max(20).default(8).describe("每条记忆取多少向量近邻（默认8）"),
    minScore: z.number().min(0).max(1).default(0.62).describe("近邻相似度下限（默认0.62；真矛盾常落在0.62-0.72，设太高会漏）"),
    minConfidence: z.number().min(0).max(1).default(0.75).describe("判定为矛盾的最低置信度（默认0.75）"),
    crossScope: z.boolean().default(false).describe("是否允许跨记忆域配对（默认否，只在同域内找）"),
    maxPairs: z.number().min(1).max(2000).default(200).describe("非 dryRun 时最多判定多少对，控制 LLM 成本（默认200）"),
    judgeModel: z.string().optional().describe("矛盾判定用的 LLM（默认 CAPTURE_MODEL=GLM-4.5-Flash；7B 级漏判率高，建议用 GLM-4.5-Flash 或更强）"),
    scope: z.string().optional().describe("限定记忆域（可选）"),
    persist: z.boolean().default(false).describe("true 且非 dryRun 时，把每对里较旧的一条标为被较新一条取代（写 supersededBy）；重建 KG 后召回即过滤"),
  },
  async ({ dryRun, topK, minScore, minConfidence, crossScope, maxPairs, judgeModel, scope, persist }) => {
    const entries = await scanFactEntries(scope, 500);
    const byId = new Map(entries.map(e => [e.id, e]));

    const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    const seen = new Set<string>();
    const candidates: Array<{ a: MemoryEntry; b: MemoryEntry; score: number }> = [];

    for (const entry of entries) {
      if (!entry.vector || entry.vector.length === 0) continue;
      const scopeFilter = crossScope ? undefined : [entry.scope];
      const neighbors = await store.vectorSearch(entry.vector, topK + 1, minScore, scopeFilter);
      for (const n of neighbors) {
        if (n.entry.id === entry.id) continue;
        const other = byId.get(n.entry.id);
        if (!other) continue;
        const key = pairKey(entry.id, other.id);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ a: entry, b: other, score: n.score });
      }
    }
    candidates.sort((x, y) => y.score - x.score);

    const buckets = { high: 0, mid: 0, low: 0 };
    for (const c of candidates) {
      if (c.score >= 0.9) buckets.high += 1;
      else if (c.score >= 0.8) buckets.mid += 1;
      else buckets.low += 1;
    }

    const lines: string[] = [
      `memory_scan_contradictions ${dryRun ? "dryRun" : "执行"} 完成：`,
      `• scope：${scope || "全部"}${crossScope ? "（跨域配对）" : "（仅同域）"}`,
      `• 扫描 fact 类记忆：${entries.length}`,
      `• 向量候选对（去重后）：${candidates.length}`,
      `• 相似度分布：0.9+ ${buckets.high} / 0.8-0.9 ${buckets.mid} / ${minScore}-0.8 ${buckets.low}`,
    ];

    if (dryRun) {
      lines.push(`• 预计 LLM 判定次数：${Math.min(candidates.length, maxPairs)}（上限 ${maxPairs}）`);
      const preview = candidates.slice(0, 10).map((c, i) =>
        `  ${i + 1}. [${c.score.toFixed(3)}] ${c.a.scope} | ${c.a.text.slice(0, 40)} ↔ ${c.b.text.slice(0, 40)}`);
      if (preview.length > 0) lines.push("", "候选对预览（相似度Top10）：", ...preview);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    if (!hasStanceLLMConfig()) {
      lines.push("", "⚠️ LLM 未配置（CAPTURE_API_KEY/BASE_URL/MODEL），无法执行判定。");
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    const toJudge = candidates.slice(0, maxPairs);
    let judged = 0;
    let failed = 0;
    const contradictions: Array<{ a: MemoryEntry; b: MemoryEntry; score: number; confidence: number }> = [];
    for (const c of toJudge) {
      const verdict = await classifyContradictionPair(c.a, c.b, judgeModel || CAPTURE_MODEL);
      if (!verdict) { failed += 1; continue; }
      judged += 1;
      if (verdict.sameFact && verdict.contradicts && verdict.confidence >= minConfidence) {
        contradictions.push({ a: c.a, b: c.b, score: c.score, confidence: verdict.confidence });
      }
    }

    let superseded = 0;
    if (persist) {
      for (const c of contradictions) {
        const [older, newer] = c.a.timestamp <= c.b.timestamp ? [c.a, c.b] : [c.b, c.a];
        await store.updateEntrySupersedes(older.id, newer.id);
        superseded += 1;
      }
      const kg = getKG();
      if (kg) await kg.build();
    }

    lines.push(
      `• 实际 LLM 判定：${judged}（失败 ${failed}）`,
      `• 确认矛盾对（sameFact 且 contradicts 且置信≥${minConfidence}）：${contradictions.length}`,
      persist
        ? `• 已标废较旧记忆：${superseded} 条（newer-wins，已重建 KG，召回即过滤）`
        : "（本工具仅验证收益，不写库；加 persist=true 可标废较旧的一条）",
    );
    if (contradictions.length > 0) {
      const detail = contradictions.slice(0, 20).map((c, i) =>
        `  ${i + 1}. [置信${c.confidence.toFixed(2)} 相似${c.score.toFixed(2)}]\n     A(${c.a.scope}): ${c.a.text.slice(0, 90)}\n     B(${c.b.scope}): ${c.b.text.slice(0, 90)}`);
      lines.push("", "矛盾对：", ...detail);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ============================================================================
// 新工具：知识图谱、习惯追踪、自动捕获、清理、审计
// ============================================================================

// -- memory_atlas (知识图谱) --
server.tool(
  "memory_atlas",
  "构建或查看记忆知识图谱。分析记忆生成聚类、锚点和关联边。",
  {
    action: z.enum(["refresh", "status", "query"]).default("status").describe("refresh=重建，status=查看，query=查询聚类"),
    query: z.string().optional().describe("查询文本（action=query时）"),
  },
  async ({ action, query }) => {
    if (action === "refresh") {
      const atlas = await refreshMemoryAtlas(store);
      const clusters = Array.isArray(atlas.clusters) ? atlas.clusters : [];
      const edges = Array.isArray(atlas.edges) ? atlas.edges : [];
      const lines = [
        `知识图谱已刷新：`,
        `• 索引：${atlas.totalIndexed}，聚类：${clusters.length}，边：${edges.length}`,
        ``, `主要聚类：`,
        ...clusters.slice(0, 10).map((c: any) => `  • ${c.label} (${c.count}条) — ${c.topTokens?.slice(0, 5).join(', ')}`),
        ``, `关联：`,
        ...edges.slice(0, 10).map((e: any) => `  • ${e.from} <-> ${e.to} (${e.weight}, ${e.reason})`),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
    if (action === "query" && query) {
      const hints = getAtlasHintsForQuery(query);
      if (hints.clusterKeys.length === 0) {
        return { content: [{ type: "text" as const, text: "未找到相关聚类。先 refresh 生成图谱。" }] };
      }
      return { content: [{ type: "text" as const, text: `查询「${query}」：\n• 聚类：${hints.summary.join(', ')}\n• 关联ID：${hints.anchorIds.slice(0, 5).map(id => id.slice(0, 8)).join(', ')}` }] };
    }
    const atlas = getMemoryAtlasStatus();
    if (!atlas) return { content: [{ type: "text" as const, text: "知识图谱未生成。用 action='refresh' 构建。" }] };
    const clusters = Array.isArray(atlas.clusters) ? atlas.clusters : [];
    return { content: [{ type: "text" as const, text: `知识图谱：${atlas.generatedAt}\n• ${atlas.totalIndexed}条，${clusters.length}个聚类\n${clusters.slice(0, 8).map((c: any) => `  • ${c.label} (${c.count})`).join('\n')}` }] };
  }
);

// -- memory_habits (记忆晋升) --
server.tool(
  "memory_habits",
  "记忆晋升系统。追踪高频召回，按 retain->reinforce->promote 晋升，写入 instinct-rollup.md。",
  {
    action: z.enum(["status", "candidates", "instincts", "refresh"]).default("status").describe("status/candidates/instincts/refresh"),
  },
  async ({ action }) => {
    if (action === "refresh") {
      refreshHabitArtifacts();
      const s = getHabitSummary();
      return { content: [{ type: "text" as const, text: `已刷新 instinct-rollup.md\n• 总: ${s.total}, promote: ${s.promote}, reinforce: ${s.reinforce}` }] };
    }
    if (action === "candidates") {
      const c = generateHabitCandidates();
      if (c.length === 0) return { content: [{ type: "text" as const, text: "暂无候选。" }] };
      const lines = c.slice(0, 20).map((x, i) => `${i + 1}. [${x.promotionTier}:${x.category}] ${x.memoryText}\n   ${x.recallCount}次, v=${x.recentRecallVelocity}, ${x.reason}`);
      return { content: [{ type: "text" as const, text: `候选（${c.length}）：\n${lines.join("\n")}` }] };
    }
    if (action === "instincts") {
      const ctx = buildInstinctContext();
      return { content: [{ type: "text" as const, text: ctx || "暂无工作先验。" }] };
    }
    const s = getHabitSummary();
    return { content: [{ type: "text" as const, text: `习惯追踪：总${s.total}, promote=${s.promote}, reinforce=${s.reinforce}, retain=${s.retain}` }] };
  }
);

// -- memory_capture (自动捕获) --
server.tool(
  "memory_capture",
  "自动分析并捕获重要内容。关键词匹配分类（task/rule/decision/correction/preference）。",
  {
    text: z.string().describe("要分析的文本"),
    category: z.string().optional().describe("强制分类"),
    importance: z.number().min(0).max(1).optional().describe("强制重要性"),
    scope: z.string().default("global").describe("记忆域"),
  },
  async ({ text, category, importance, scope }) => {
    const result = await autoCapture.capture(text, category, importance, { scope });
    if (!result) return { content: [{ type: "text" as const, text: "未触发捕获。" }] };
    if (result.kind === 'redirect') {
      return { content: [{ type: "text" as const, text: `⚠️ 已拒绝（${result.redirect}）：${result.hint}` }] };
    }
    const method = result.llmUsed ? '（LLM 分析）' : '（关键词匹配）';
    return { content: [{ type: "text" as const, text: `已捕获${method}：${result.type}，重要性=${result.importance}` }] };
  }
);

// -- memory_cleanup --
server.tool(
  "memory_cleanup",
  "清理记忆：删噪音、去重、摘要压缩。",
  {
    limit: z.number().min(20).max(500).default(200).describe("压缩次数上限（删噪/去重全量扫，压缩烧 embedding 用此封顶）"),
    maxAgeDays: z.number().min(1).max(365).default(90).describe("压缩范围（天，仅压缩此范围内的新记忆）"),
  },
  async ({ limit, maxAgeDays }) => {
    const r = await cleanupStoredMemories(store, embedder, { limit, maxAgeDays });
    return { content: [{ type: "text" as const, text: `清理完成：扫描${r.scanned}，删噪${r.deleted}，去重${r.deduped}，压缩${r.cleaned}` }] };
  }
);

// -- memory_audit --
server.tool(
  "memory_audit",
  "记忆系统健康审计。",
  {},
  async () => {
    const r = await auditEngine.runAudit();
    return { content: [{ type: "text" as const, text: `审计：总${r.stats.total_memories}，问题${r.stats.issues}` }] };
  }
);

// -- memory_journal (捕获队列) --
server.tool(
  "memory_journal",
  "捕获队列管理：查看待处理条目和统计。",
  {
    action: z.enum(["stats", "pending", "prune"]).default("stats").describe("stats/pending/prune"),
  },
  async ({ action }) => {
    if (action === "pending") {
      const p = captureJournal.listPending(20);
      if (p.length === 0) return { content: [{ type: "text" as const, text: "无待处理。" }] };
      return { content: [{ type: "text" as const, text: `待处理(${p.length})：\n${p.map((e, i) => `${i + 1}. ${e.content.slice(0, 80)}...`).join("\n")}` }] };
    }
    if (action === "prune") {
      captureJournal.prune();
      return { content: [{ type: "text" as const, text: "已清理。" }] };
    }
    const s = captureJournal.stats();
    return { content: [{ type: "text" as const, text: `队列：总${s.total}，待处理${s.pending}，已捕获${s.captured}` }] };
  }
);

// -- memory_kg (Knowledge Graph) --
server.tool(
  "memory_kg",
  "知识图谱（KG）管理。KG 是记忆的结构化索引，包含实体节点、5种关系边（causal/temporal/subject/category/contradicts）和矛盾检测。",
  {
    action: z.enum(["stats", "rebuild", "query", "contradictions", "debug"]).default("stats").describe("stats/rebuild/query/contradictions/debug"),
    query: z.string().optional().describe("查询文本（action=query时）"),
    memoryIds: z.array(z.string()).optional().describe("记忆ID列表（action=contradictions时）"),
  },
  async ({ action, query, memoryIds }) => {
    const kg = getKG();
    if (!kg) return { content: [{ type: "text" as const, text: "KG 未初始化。" }] };

    if (action === "rebuild") {
      await kg.build();
      const s = kg.getStats();
      return { content: [{ type: "text" as const, text: `KG 已重建：\n• 节点：${s.totalNodes}\n• 边：${s.totalEdges}\n• 实体：${s.entityKeys}\n• 分类：${s.categories}\n• 被取代：${s.supersededNodes}\n• 边分布：subject=${s.edgesByRelation.subject}, temporal=${s.edgesByRelation.temporal}, causal=${s.edgesByRelation.causal}, category=${s.edgesByRelation.category}, contradicts=${s.edgesByRelation.contradicts}` }] };
    }

    if (action === "query" && query) {
      const results = kg.query(query, { limit: 10 });
      if (results.length === 0) return { content: [{ type: "text" as const, text: "KG 中未找到匹配。" }] };
      const lines = results.map((r, i) => `${i + 1}. [${r.reason}] ${r.summary.slice(0, 100)} (score=${r.score.toFixed(2)}, imp=${r.importance}, entity=${r.entityKey || 'N/A'}${r.superseded ? ' [已取代]' : ''})`);
      return { content: [{ type: "text" as const, text: `KG 查询「${query}」（${results.length}条）：\n${lines.join("\n")}` }] };
    }

    if (action === "contradictions") {
      const ids = memoryIds || [];
      if (ids.length === 0) return { content: [{ type: "text" as const, text: "请提供 memoryIds 列表。" }] };
      const contradictions = kg.getContradictions(ids);
      if (contradictions.length === 0) return { content: [{ type: "text" as const, text: "未检测到矛盾。" }] };
      const lines = contradictions.map(c => `• ${c.a.slice(0, 8)} <-> ${c.b.slice(0, 8)} (权重: ${c.weight})`);
      return { content: [{ type: "text" as const, text: `检测到 ${contradictions.length} 对矛盾：\n${lines.join("\n")}` }] };
    }

    if (action === "debug") {
      const path = kg.writeDebugSnapshot();
      return { content: [{ type: "text" as const, text: `KG 调试快照已写入：${path}` }] };
    }

    // stats
    const s = kg.getStats();
    return { content: [{ type: "text" as const, text: `KG 状态：\n• 节点：${s.totalNodes}（${s.supersededNodes} 被取代）\n• 边：${s.totalEdges}\n• 实体：${s.entityKeys}\n• 分类：${s.categories}\n• 构建时间：${s.builtAt || '未构建'}\n• 边分布：subject=${s.edgesByRelation.subject}, temporal=${s.edgesByRelation.temporal}, causal=${s.edgesByRelation.causal}, category=${s.edgesByRelation.category}, contradicts=${s.edgesByRelation.contradicts}` }] };
  }
);

// -- memory_dream (Dream 记忆晋升) --
server.tool(
  "memory_dream",
  "Dream 记忆晋升系统。三阶段晋升（light/deep/REM），基于召回频率自动提升记忆，写入 dream.md。支持手动触发、查看 trail、日常整理。",
  {
    action: z.enum(["status", "run", "trail", "recover", "reorg"]).default("status")
      .describe("status=查看状态，run=执行晋升，trail=查看dream.md，recover=恢复错过的阶段，reorg=日常整理"),
    phase: z.enum(["light", "deep", "rem"]).optional()
      .describe("晋升阶段（action=run时，默认light）"),
  },
  async ({ action, phase }) => {
    if (action === "run") {
      const mode = phase || "light";
      const config: DreamConfig = { ...DREAM_DEFAULT_CONFIG, mode };
      const result = await promoteMemoriesFromStore(store, config);
      const lines = [
        `Dream 晋升完成（${mode.toUpperCase()}）：`,
        `• 候选：${result.candidates.length}`,
        `• 写入：${result.written}`,
        `• 跳过（已晋升）：${result.skipped}`,
      ];
      if (result.decisions.length > 0) {
        lines.push(``, `决策详情：`);
        for (const d of result.decisions.slice(0, 15)) {
          const status = d.written ? '✓' : d.reason === 'already_promoted_same_or_higher' ? `跳过(已${d.existingPhase})` : '✗';
          lines.push(`  ${status} ${d.memoryId.slice(0, 8)} → ${d.tier}`);
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    if (action === "trail") {
      const trail = readDreamTrail();
      if (!trail.trim()) return { content: [{ type: "text" as const, text: "dream.md 为空，尚无晋升记录。" }] };
      // 只返回最后 2000 字符
      const truncated = trail.length > 2000 ? '...\n' + trail.slice(-2000) : trail;
      return { content: [{ type: "text" as const, text: truncated }] };
    }

    if (action === "recover") {
      const result = await recoverMissedPhases(store, DREAM_DEFAULT_CONFIG);
      if (result.recovered.length === 0) {
        return { content: [{ type: "text" as const, text: "无需恢复，所有阶段均在有效期内。" }] };
      }
      return { content: [{ type: "text" as const, text: `已恢复错过的阶段：${result.recovered.join(', ')}` }] };
    }

    if (action === "reorg") {
      const kg = getKG();
      const result = await runDailyReorganization(
        store,
        async (s) => refreshMemoryAtlas(s),
        kg ? async () => { await kg.build(); } : undefined
      );
      return { content: [{ type: "text" as const, text: `日常整理完成（${result.duration}ms）：\n• Atlas: ${result.atlasRebuilt ? `已重建(${result.atlasEntries}条)` : '跳过'}\n• KG: ${result.kgRebuilt ? '已重建' : '跳过'}\n• 实体组: ${result.entityGroups}\n• 矛盾: ${result.contradictions}\n• 取代: ${result.superseded}\n• 过期: ${result.expiredMarked}` }] };
    }

    // status
    const stats = getDreamStats();
    const lastRun = stats.lastRunState;
    const promotedCount = Object.keys(stats.trailState.promoted).length;
    const lines = [
      `Dream 状态：`,
      `• trail 段落：${stats.totalSections}`,
      `• 累计晋升：${promotedCount} 条记忆`,
      `• 上次 LIGHT：${lastRun.light || '从未'}`,
      `• 上次 DEEP：${lastRun.deep || '从未'}`,
      `• 上次 REM：${lastRun.rem || '从未'}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ============================================================================
// 三维扩展：Task / Lesson 专用工具（v2 增强：精确去重 + 阈值控制 + 噪声白名单）
// ============================================================================

// -- task_create --
server.tool(
  "task_create",
  "创建/更新跨会话持久化任务。同 project 同 subject 未完成任务自动覆盖（不新建）。",
  {
    subject: z.string().min(4).describe("任务标题（>=4 字，太短拒绝）"),
    project: z.string().describe("所属项目（必填，作为 scope 隔离）"),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).default("in_progress"),
    importance: z.number().min(0).max(1).default(0.7),
    parentTaskId: z.string().optional().describe("父任务 ID（构建任务依赖树）"),
    description: z.string().optional().describe("任务详情（可选）"),
  },
  async ({ subject, project, status, importance, parentTaskId, description }) => {
    const scope = `task:${project}`;
    const text = `[TASK:${status}] ${subject}${description ? " — " + description : ""}`;

    // 精确去重：仅在 open 任务（pending/in_progress）中找同 subject。
    // 终态（completed/cancelled）保留为历史，不被新调用静默覆盖；
    // 这样"再次以同名启动一个新任务"会建新条目而非把历史记录改回 in_progress。
    const existing = (await store.listAll([scope], "task")).find(e => {
      try {
        const m = JSON.parse(e.metadata || "{}");
        const open = m.status === "pending" || m.status === "in_progress";
        return open && m.subject === subject;
      } catch { return false; }
    });

    if (existing) {
      const meta = { ...JSON.parse(existing.metadata || "{}"), subject, project, status, parentTaskId, description, type: "task", updatedAt: new Date().toISOString() };
      const updates: Record<string, any> = { text, metadata: JSON.stringify(meta) };
      if (existing.text !== text) {
        updates.vector = await embedder.embedPassage(text.slice(0, 500));
      }
      await store.update(existing.id, updates);
      return { content: [{ type: "text" as const, text: `已更新任务 [${existing.id.slice(0, 8)}]：${subject} → ${status}` }] };
    }

    const vector = await embedder.embedPassage(text.slice(0, 500));
    const meta = { subject, project, status, parentTaskId, description, type: "task", createdAt: new Date().toISOString() };
    const newEntry = await store.store({
      text: text.slice(0, 5000), vector, importance: clamp01(importance), category: "task", scope,
      metadata: JSON.stringify(meta),
    });
    return { content: [{ type: "text" as const, text: `已创建任务 [${newEntry.id.slice(0, 8)}]：${subject}（${status}，project=${project}）` }] };
  }
);

// -- task_list --
server.tool(
  "task_list",
  "列出指定项目的任务。按状态过滤，默认只返未完成。",
  {
    project: z.string().describe("项目名"),
    status: z.enum(["pending", "in_progress", "completed", "cancelled", "all", "open"]).default("open").describe("open=pending+in_progress（默认）"),
    limit: z.number().min(1).max(100).default(30),
  },
  async ({ project, status, limit }) => {
    const scope = `task:${project}`;
    const all = await store.listAll([scope], "task");
    const filtered = all.filter(e => {
      if (status === "all") return true;
      try {
        const s = JSON.parse(e.metadata || "{}").status;
        if (status === "open") return s === "pending" || s === "in_progress";
        return s === status;
      } catch { return false; }
    }).slice(0, limit);
    if (filtered.length === 0) return { content: [{ type: "text" as const, text: `项目 ${project} 无 ${status} 任务` }] };
    const lines = filtered.map((e, i) => {
      const m = JSON.parse(e.metadata || "{}");
      return `${i + 1}. [${m.status}] ${m.subject}${m.description ? " — " + m.description : ""} (${e.id.slice(0, 8)})`;
    });
    return { content: [{ type: "text" as const, text: `项目 ${project} 任务（${filtered.length}）：\n${lines.join("\n")}` }] };
  }
);

// -- lesson_capture --
server.tool(
  "lesson_capture",
  "记录踩过的坑/反模式/避坑教训。同类教训自动合并 evidence（向量阈值 0.85，比 memory 宽松）。",
  {
    pitfall: z.string().min(10).describe("踩了什么坑（>=10 字，必须具体）"),
    solution: z.string().min(5).describe("正确做法/避免方式"),
    triggerKeywords: z.array(z.string()).min(1).describe("触发关键词（>=1 个，用于下次自动 recall）"),
    project: z.string().describe("项目名（lesson:project scope）"),
    evidence: z.string().optional().describe("证据/原因（如错误信息、commit 链接）"),
    importance: z.number().min(0).max(1).default(0.85).describe("默认 0.85，教训通常很重要"),
  },
  async ({ pitfall, solution, triggerKeywords, project, evidence, importance }) => {
    const scope = `lesson:${project}`;
    const text = `[LESSON] 坑：${pitfall}\n避坑：${solution}\n触发词：${triggerKeywords.join(", ")}`;
    const vector = await embedder.embedPassage(text.slice(0, 500));

    // 双信号合并：向量相似度 >= 0.78 OR triggerKeywords 重叠 >=2
    // 单纯向量 0.85 偏严会让"同教训不同表述"漏合并；关键词重叠是更强的人类语义信号
    const candidates = await store.vectorSearch(vector, 5, 0.1, [scope]);
    const newKwSet = new Set(triggerKeywords.map(k => k.toLowerCase()));
    const matched = candidates
      .map(c => {
        const m = JSON.parse(c.entry.metadata || "{}");
        const oldKw: string[] = m.triggerKeywords || [];
        const overlap = oldKw.filter(k => newKwSet.has(k.toLowerCase())).length;
        return { c, overlap };
      })
      .filter(x => x.c.score >= 0.78 || x.overlap >= 2)
      .sort((a, b) => (b.c.score + b.overlap * 0.05) - (a.c.score + a.overlap * 0.05))[0];
    if (matched) {
      const similar = [matched.c];
      const m = JSON.parse(similar[0].entry.metadata || "{}");
      const mergedKeywords = [...new Set([...(m.triggerKeywords || []), ...triggerKeywords])];
      const mergedEvidence = [m.lastEvidence, evidence].filter(Boolean).slice(-3);
      const newMetaBase = {
        ...m, pitfall, solution,
        triggerKeywords: mergedKeywords,
        evidenceCount: (m.evidenceCount || 1) + 1,
        lastEvidence: evidence || m.lastEvidence,
        evidenceHistory: mergedEvidence,
        lastSeenAt: new Date().toISOString(),
      };
      const newMeta = metadataWithFactKey({
        text,
        category: "lesson",
        scope,
        metadata: JSON.stringify(newMetaBase),
      });
      await store.update(similar[0].entry.id, { metadata: JSON.stringify(newMeta), importance: Math.min(1, (similar[0].entry.importance || 0.85) + 0.05) });
      return { content: [{ type: "text" as const, text: `已合并到已有教训 [${similar[0].entry.id.slice(0, 8)}]（相似度 ${(similar[0].score * 100).toFixed(0)}%）。证据次数：${newMeta.evidenceCount}` }] };
    }

    const metaBase = {
      pitfall, solution, triggerKeywords, evidence, evidenceCount: 1,
      type: "lesson", project, capturedAt: new Date().toISOString(),
      summary: pitfall.slice(0, 100),
    };
    const meta = await buildWriteMetadataWithFactStance(
      text.slice(0, 5000),
      "lesson",
      scope,
      metaBase
    );
    const newEntry = await store.store({
      text: text.slice(0, 5000), vector, importance: clamp01(importance), category: "lesson", scope,
      metadata: JSON.stringify(meta),
    });

    // 方案 C：lesson 入 KG，让相关 memory 跨类型路由到（task 不入图）
    try { const kg = getKG(); if (kg) kg.addNode(newEntry).catch(() => {}); } catch {}

    return { content: [{ type: "text" as const, text: `已记录新教训 [${newEntry.id.slice(0, 8)}]：${pitfall.slice(0, 60)}...` }] };
  }
);

// -- lesson_recall --
server.tool(
  "lesson_recall",
  "按关键词召回项目教训。优先返回 triggerKeywords 命中的，其次向量相似。",
  {
    keywords: z.array(z.string()).min(1).describe("查询关键词"),
    project: z.string().optional().describe("项目名，缺省全局搜"),
    limit: z.number().min(1).max(20).default(5),
  },
  async ({ keywords, project, limit }) => {
    const scope = project ? `lesson:${project}` : undefined;
    // 先关键词精确命中
    const candidates = await store.listAll(scope ? [scope] : undefined, "lesson");
    const matched = candidates.filter(e => {
      try {
        const m = JSON.parse(e.metadata || "{}");
        const triggers = (m.triggerKeywords || []).map((s: string) => s.toLowerCase());
        return keywords.some(k => triggers.some((t: string) => t.includes(k.toLowerCase()) || k.toLowerCase().includes(t)));
      } catch { return false; }
    }).slice(0, limit);

    if (matched.length === 0) {
      // 关键词没命中 → 向量召回
      const query = keywords.join(" ");
      const vector = await embedder.embedPassage(query);
      const vec = await store.vectorSearch(vector, limit, 0.5, scope ? [scope] : undefined);
      const filtered = vec.filter(r => r.entry.category === "lesson");
      if (filtered.length === 0) return { content: [{ type: "text" as const, text: `无相关教训（关键词：${keywords.join(",")}）` }] };
      // 方案 C：lesson 召回纳入 habit 频率统计（task 不纳入）
      try { recordRecallBatch(filtered.map(r => ({ id: r.entry.id, text: r.entry.text, category: r.entry.category }))); } catch {}
      const lines = filtered.map((r, i) => {
        const m = JSON.parse(r.entry.metadata || "{}");
        return `${i + 1}. ${m.pitfall} → ${m.solution} (向量相似 ${(r.score * 100).toFixed(0)}%, 证据${m.evidenceCount}次)`;
      });
      return { content: [{ type: "text" as const, text: `教训命中（向量回退，${filtered.length}）：\n${lines.join("\n")}` }] };
    }

    try { recordRecallBatch(matched.map(e => ({ id: e.id, text: e.text, category: e.category }))); } catch {}
    const lines = matched.map((e, i) => {
      const m = JSON.parse(e.metadata || "{}");
      return `${i + 1}. ${m.pitfall} → ${m.solution} (触发词命中, 证据${m.evidenceCount || 1}次)`;
    });
    return { content: [{ type: "text" as const, text: `教训命中（关键词精确，${matched.length}）：\n${lines.join("\n")}` }] };
  }
);

// ============================================================================
// Start
// ============================================================================

async function main() {
  if (!EMBEDDING_API_KEY) {
    console.error("[claude-memory-pro] 警告：EMBEDDING_API_KEY 未设置");
  }
  await store.init();

  // 构建知识图谱
  try {
    await knowledgeGraph.build();
    const kgStats = knowledgeGraph.getStats();
    console.error(`[claude-memory-pro] KG built: ${kgStats.totalNodes} nodes, ${kgStats.totalEdges} edges, ${kgStats.entityKeys} entities`);
  } catch (err) {
    console.error(`[claude-memory-pro] KG build failed: ${err}`);
  }

  // Dream 恢复：补偿离线期间错过的晋升
  try {
    const dreamRecovery = await recoverMissedPhases(store, DREAM_DEFAULT_CONFIG);
    if (dreamRecovery.recovered.length > 0) {
      console.error(`[claude-memory-pro] Dream recovery: ${dreamRecovery.recovered.join(', ')}`);
    }
  } catch (err) {
    console.error(`[claude-memory-pro] Dream recovery failed: ${err}`);
  }

  // Dream 定时器：运行期间每 30 分钟自动执行 light 晋升
  const DREAM_INTERVAL_MS = 30 * 60 * 1000; // 30 min
  setInterval(async () => {
    try {
      const result = await promoteMemoriesFromStore(store, { ...DREAM_DEFAULT_CONFIG, mode: 'light' });
      if (result.written > 0) {
        console.error(`[claude-memory-pro] Dream auto-promote: ${result.written} written, ${result.skipped} skipped`);
      }
    } catch (err) {
      console.error(`[claude-memory-pro] Dream auto-promote failed: ${err}`);
    }
  }, DREAM_INTERVAL_MS);
  console.error(`[claude-memory-pro] Dream timer: light promotion every 30min`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claude-memory-pro] MCP Server v2.0.0 started");
  console.error(`[claude-memory-pro] DB: ${DB_PATH}, Model: ${EMBEDDING_MODEL}`);
  console.error(`[claude-memory-pro] Features: atlas, habits, capture${autoCapture.isLLMEnabled ? `(LLM:${autoCapture.captureModel})` : '(keyword-only)'}, cleanup, journal, audit, dream`);
}

main().catch(err => {
  console.error("[claude-memory-pro] Fatal:", err);
  process.exit(1);
});

// 优雅退出兜底：终端关闭/Ctrl+C 时刷新 habit + dream 状态
function gracefulShutdown(signal: string) {
  console.error(`[claude-memory-pro] ${signal} received, flushing state...`);
  try {
    // 同步刷新 habit 产物
    refreshHabitArtifacts();
    // 更新 dream last-run 标记
    const { saveLastRunState, loadLastRunState } = require('./dream-manager.js');
    const state = loadLastRunState();
    (state as any)._lastSessionEnd = new Date().toISOString();
    saveLastRunState(state);
  } catch (err) {
    console.error(`[claude-memory-pro] Shutdown flush failed: ${err}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
