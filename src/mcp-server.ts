#!/usr/bin/env node
/**
 * Claude Memory Pro - MCP Server
 * 基于 LanceDB 的语义记忆增强系统，为 Claude Code 提供长期记忆能力
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

const CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;

// ============================================================================
// Helpers
// ============================================================================

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
    const meta = r.entry.metadata ? JSON.parse(r.entry.metadata) : {};
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
  version: "1.0.0",
});

// -- memory_recall --
server.tool(
  "memory_recall",
  "语义检索长期记忆。使用混合检索（向量 + BM25）查找相关记忆，支持时间衰减、重要性加权和 MMR 去重。",
  {
    query: z.string().describe("搜索查询文本"),
    limit: z.number().min(1).max(20).default(5).describe("最大返回数量（默认5）"),
    scope: z.string().optional().describe("限定搜索的记忆域（可选）"),
    category: z.enum(CATEGORIES).optional().describe("限定记忆分类（可选）"),
  },
  async ({ query, limit, scope, category }) => {
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter, category });

    // 更新召回计数
    if (results.length > 0) {
      store.incrementRecallBatch(results.map(r => r.entry.id)).catch(() => {});
    }

    return { content: [{ type: "text", text: `找到 ${results.length} 条记忆：\n\n${formatResults(results)}` }] };
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
      return { content: [{ type: "text", text: "跳过：文本被识别为噪音（问候、模板语句等）" }] };
    }

    const safeImportance = clamp01(importance);
    const vector = await embedder.embedPassage(text.slice(0, 500));

    // 去重检查
    const existing = await store.vectorSearch(vector, 1, 0.1, [scope]);
    if (existing.length > 0 && existing[0].score > 0.98) {
      return {
        content: [{ type: "text", text: `已存在相似记忆：「${existing[0].entry.text}」（相似度 ${(existing[0].score * 100).toFixed(0)}%）` }],
      };
    }

    const entry = await store.store({
      text: text.slice(0, 500),
      vector,
      importance: safeImportance,
      category,
      scope,
      metadata: JSON.stringify({
        source: "manual_store",
        storedAt: new Date().toISOString(),
      }),
    });

    return {
      content: [{ type: "text", text: `已存储：「${text.slice(0, 100)}${text.length > 100 ? "..." : ""}」 → 域 '${scope}'，分类 '${category}'，重要性 ${safeImportance}` }],
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
      return {
        content: [{ type: "text", text: deleted ? `已删除记忆 ${memoryId}` : `未找到记忆 ${memoryId}` }],
      };
    }

    if (query) {
      const results = await retriever.retrieve({ query, limit: 5 });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "未找到匹配的记忆。" }] };
      }
      if (results.length === 1 && results[0].score > 0.9) {
        await store.delete(results[0].entry.id);
        return { content: [{ type: "text", text: `已删除：「${results[0].entry.text}」` }] };
      }
      const list = results.map(r => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}...`).join("\n");
      return { content: [{ type: "text", text: `找到 ${results.length} 条候选记忆，请指定 memoryId 删除：\n${list}` }] };
    }

    return { content: [{ type: "text", text: "请提供 query 或 memoryId 参数。" }] };
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
      return { content: [{ type: "text", text: "至少提供一项更新：text、importance 或 category。" }] };
    }

    const updates: Record<string, any> = {};
    if (text) {
      if (isNoise(text)) {
        return { content: [{ type: "text", text: "跳过：更新文本被识别为噪音。" }] };
      }
      updates.text = text;
      updates.vector = await embedder.embedPassage(text);
    }
    if (importance !== undefined) updates.importance = clamp01(importance);
    if (category) updates.category = category;

    const updated = await store.update(memoryId, updates);
    if (!updated) {
      return { content: [{ type: "text", text: `未找到记忆 ${memoryId}` }] };
    }

    return {
      content: [{ type: "text", text: `已更新记忆 ${updated.id.slice(0, 8)}：「${updated.text.slice(0, 80)}...」` }],
    };
  }
);

// -- memory_list --
server.tool(
  "memory_list",
  "列出最近的记忆，支持按域和分类过滤。",
  {
    limit: z.number().min(1).max(50).default(10).describe("最大数量（默认10）"),
    scope: z.string().optional().describe("按域过滤"),
    category: z.enum(CATEGORIES).optional().describe("按分类过滤"),
    offset: z.number().min(0).default(0).describe("跳过前 N 条"),
  },
  async ({ limit, scope, category, offset }) => {
    const scopeFilter = scope ? [scope] : undefined;
    const entries = await store.list(scopeFilter, category, limit, offset);

    if (entries.length === 0) {
      return { content: [{ type: "text", text: "暂无记忆。" }] };
    }

    const text = entries.map((e, i) => {
      const date = new Date(e.timestamp).toISOString().split("T")[0];
      return `${offset + i + 1}. [${e.category}:${e.scope}] ${e.text.slice(0, 100)}${e.text.length > 100 ? "..." : ""} (${date})`;
    }).join("\n");

    return { content: [{ type: "text", text: `记忆列表（共 ${entries.length} 条）：\n\n${text}` }] };
  }
);

// -- memory_stats --
server.tool(
  "memory_stats",
  "查看记忆系统统计信息：总数、各分类/域分布、检索配置等。",
  {},
  async () => {
    const stats = await store.stats();
    const config = retriever.getConfig();
    const cacheStats = embedder.cacheStats;

    const lines = [
      `记忆统计：`,
      `• 总记忆数：${stats.totalCount}`,
      `• 检索模式：${config.mode}`,
      `• FTS 支持：${store.hasFtsSupport ? "是" : "否"}`,
      `• 嵌入缓存：${cacheStats.size} 条，命中率 ${cacheStats.hitRate}`,
      ``,
      `按域分布：`,
      ...Object.entries(stats.scopeCounts).map(([s, c]) => `  • ${s}: ${c}`),
      ``,
      `按分类分布：`,
      ...Object.entries(stats.categoryCounts).map(([c, n]) => `  • ${c}: ${n}`),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ============================================================================
// Start Server
// ============================================================================

async function main() {
  await store.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[claude-memory-pro] MCP Server started");
  console.error(`[claude-memory-pro] DB: ${DB_PATH}`);
  console.error(`[claude-memory-pro] Model: ${EMBEDDING_MODEL}`);
}

main().catch(err => {
  console.error("[claude-memory-pro] Fatal error:", err);
  process.exit(1);
});
