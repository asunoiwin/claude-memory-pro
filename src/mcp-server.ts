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

import { MemoryStore } from "./store.js";
import { createEmbedder, getVectorDimensions } from "./embedder.js";
import { createRetriever, type RetrievalResult } from "./retriever.js";
import { isNoise } from "./noise-filter.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { refreshMemoryAtlas, getMemoryAtlasStatus, getAtlasHintsForQuery } from "./memory-atlas.js";
import { recordRecallBatch, generateHabitCandidates, buildInstinctContext, getHabitSummary, refreshHabitArtifacts } from "./habit-tracker.js";
import { AutoCaptureEngine } from "./auto-capture.js";
import { cleanupStoredMemories } from "./memory-cleaner.js";
import { CaptureJournal } from "./capture-journal.js";
import { AuditEngine } from "./audit.js";
import { KnowledgeGraphManager, setKG, getKG } from "./knowledge-graph.js";
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

const CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;

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

    const newEntry = await store.store({
      text: text.slice(0, 500), vector, importance: safeImportance, category, scope,
      metadata: JSON.stringify({ source: "manual_store", storedAt: new Date().toISOString() }),
    });

    // 增量更新 KG
    const kg = getKG();
    if (kg) kg.addNode(newEntry).catch(() => {});

    const journalEntry = captureJournal.append({ content: text.slice(0, 500), category, importance: safeImportance, context: { source: 'manual_store' } });
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
      return { content: [{ type: "text" as const, text: deleted ? `已删除记忆 ${memoryId}` : `未找到记忆 ${memoryId}` }] };
    }
    if (query) {
      const results = await retriever.retrieve({ query, limit: 5 });
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "未找到匹配的记忆。" }] };
      }
      if (results.length === 1 && results[0].score > 0.9) {
        await store.delete(results[0].entry.id);
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
      `• 嵌入缓存：${cacheStats.size} 条，命中率 ${cacheStats.hitRate}`,
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
    const method = result.llmUsed ? '（LLM 分析）' : '（关键词匹配）';
    return { content: [{ type: "text" as const, text: `已捕获${method}：${result.type}，重要性=${result.importance}` }] };
  }
);

// -- memory_cleanup --
server.tool(
  "memory_cleanup",
  "清理记忆：删噪音、去重、摘要压缩。",
  {
    limit: z.number().min(20).max(500).default(200).describe("扫描上限"),
    maxAgeDays: z.number().min(1).max(365).default(90).describe("清理范围（天）"),
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
