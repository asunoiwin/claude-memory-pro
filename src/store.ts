/**
 * LanceDB Storage Layer
 */

import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "task" | "lesson";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
  recallCount?: number;
  lastRecallAt?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
}

export type VectorIssue = "empty" | "badDim" | "zero";

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  return await lancedbImportPromise;
};

// ============================================================================
// Utility
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const MIN_VECTOR_L2_NORM = 1e-6;

function toVectorArray(vector: unknown): number[] | null {
  if (!vector) return null;
  if (Array.isArray(vector)) return vector;
  if (typeof vector === "object" && Symbol.iterator in vector) {
    return Array.from(vector as Iterable<number>);
  }
  return null;
}

export function getVectorIssue(
  vector: unknown,
  vectorDim: number,
  minL2Norm = MIN_VECTOR_L2_NORM
): VectorIssue | null {
  const values = toVectorArray(vector);
  if (!values || values.length === 0) return "empty";
  if (values.length !== vectorDim) return "badDim";

  let normSq = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "badDim";
    normSq += value * value;
  }

  return Math.sqrt(normSq) > minL2Norm ? null : "zero";
}

export function validateVector(vector: unknown, vectorDim: number): asserts vector is number[] {
  const issue = getVectorIssue(vector, vectorDim);
  if (!issue) return;
  throw new Error(
    `Invalid memory vector (${issue}): expected ${vectorDim} dimensions and L2 norm > ${MIN_VECTOR_L2_NORM}`
  );
}

function rowToMemoryEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    vector: Array.from(row.vector || []) as number[],
    category: row.category,
    scope: row.scope,
    importance: row.importance,
    timestamp: row.timestamp,
    metadata: row.metadata,
    recallCount: row.recallCount || 0,
    lastRecallAt: row.lastRecallAt || 0,
  };
}

// ============================================================================
// MemoryStore
// ============================================================================

export class MemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private config: StoreConfig;
  private _hasFts = false;

  constructor(config: StoreConfig) {
    this.config = config;
  }

  get hasFtsSupport(): boolean { return this._hasFts; }

  async init(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.config.dbPath);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes("memories")) {
      this.table = await this.db.openTable("memories");
    } else {
      const emptyData = [{
        id: "__init__",
        text: "__init__",
        vector: new Array(this.config.vectorDim).fill(0),
        category: "other",
        scope: "system",
        importance: 0,
        timestamp: 0,
        metadata: "{}",
        recallCount: 0,
        lastRecallAt: 0,
      }];
      this.table = await this.db.createTable("memories", emptyData as any);
      await this.table.delete("id = '__init__'");
    }

    // Try to create FTS index
    try {
      await this.table.createIndex("text", { config: lancedb.Index.fts() });
      this._hasFts = true;
    } catch (err) {
      // Index already exists → FTS is available; other errors → FTS unavailable
      const msg = err instanceof Error ? err.message : String(err);
      this._hasFts = /already exists|already indexed/i.test(msg);
      if (!this._hasFts) {
        console.error(`[claude-memory-pro] FTS 索引创建失败，回退到纯向量模式: ${msg}`);
      }
    }
  }

  async store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry> {
    if (!this.table) throw new Error("Store not initialized");
    validateVector(entry.vector, this.config.vectorDim);
    const full: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      recallCount: 0,
      lastRecallAt: 0,
    };
    await this.table.add([full as any]);
    this.bumpStructuralVersion();
    return full;
  }

  async vectorSearch(
    queryVector: number[],
    limit: number,
    minScore: number,
    scopeFilter?: string[]
  ): Promise<MemorySearchResult[]> {
    if (!this.table) throw new Error("Store not initialized");
    const safeLimit = clampInt(limit, 1, 100);

    let query = this.table.search(queryVector).limit(safeLimit);

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter.map(s => `scope = '${escapeSqlLiteral(s)}'`).join(" OR ");
      query = query.where(`(${scopeConditions})`);
    }

    const results = await query.toArray();
    return results
      .map((row: any) => ({
        entry: rowToMemoryEntry(row),
        score: Math.max(0, 1 - (row._distance || 0)),
      }))
      .filter((r: MemorySearchResult) => r.score >= minScore);
  }

  async bm25Search(
    query: string,
    limit: number,
    scopeFilter?: string[]
  ): Promise<MemorySearchResult[]> {
    if (!this.table || !this._hasFts) return [];
    const safeLimit = clampInt(limit, 1, 100);

    try {
      let search = this.table.search(query, "text").limit(safeLimit);

      if (scopeFilter && scopeFilter.length > 0) {
        const scopeConditions = scopeFilter.map(s => `scope = '${escapeSqlLiteral(s)}'`).join(" OR ");
        search = search.where(`(${scopeConditions})`);
      }

      const results = await search.toArray();
      return results.map((row: any) => ({
        entry: rowToMemoryEntry(row),
        score: row._score || 0.5,
      }));
    } catch {
      return [];
    }
  }

  async getByIds(ids: string[]): Promise<MemoryEntry[]> {
    if (!this.table || ids.length === 0) return [];
    const conditions = ids.map(id => `id = '${escapeSqlLiteral(id)}'`).join(" OR ");
    const results = await this.table.search(new Array(this.config.vectorDim).fill(0))
      .where(`(${conditions})`)
      .limit(ids.length)
      .toArray();
    return results.map(rowToMemoryEntry);
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    if (!this.table) return false;
    try {
      let condition = `id = '${escapeSqlLiteral(id)}'`;
      if (scopeFilter && scopeFilter.length > 0) {
        const scopeConditions = scopeFilter.map(s => `scope = '${escapeSqlLiteral(s)}'`).join(" OR ");
        condition += ` AND (${scopeConditions})`;
      }
      // 真删到才算成功：删 0 行（id 不存在 / 域不匹配）返回 false，避免假"已删除"确认
      const matched = await this.table.countRows(condition);
      if (matched === 0) return false;
      await this.table.delete(condition);
      this.bumpStructuralVersion();
      return true;
    } catch {
      return false;
    }
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryEntry, "text" | "vector" | "importance" | "category" | "metadata">>,
    scopeFilter?: string[]
  ): Promise<MemoryEntry | null> {
    if (!this.table) return null;
    if ("vector" in updates) {
      validateVector(updates.vector, this.config.vectorDim);
    }
    // LanceDB doesn't have native update, so we read-delete-insert
    const existing = await this.getByIds([id]);
    if (existing.length === 0) return null;

    const entry = existing[0];
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(entry.scope)) return null;

    const updated: MemoryEntry = {
      ...entry,
      ...updates,
      id: entry.id,
      timestamp: entry.timestamp,
    };

    // 原子 upsert（按 id 合并）：避免"先删后加"中途失败丢记忆 / 并发回滚
    await this.table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([updated as any]);
    this.bumpStructuralVersion();
    return updated;
  }

  private structuralVersionFile(): string {
    return join(dirname(this.config.dbPath), "structural-version");
  }

  /**
   * "结构版本"：只在结构性写（store/update/delete）时推进，召回计数(incrementRecallBatch)不推进。
   * 与全局表版本解耦，避免"召回计数把版本推高→图谱误重建/或掩盖结构写"。跨进程经此 sidecar 文件共享。
   */
  structuralVersion(): number {
    try { return parseInt(readFileSync(this.structuralVersionFile(), "utf8"), 10) || 0; }
    catch { return 0; }
  }

  private bumpStructuralVersion(): void {
    // 用自增计数器而非时间戳：并发写至多"少加"(折叠)，绝不会与 build 读到的旧值相等，故永不掩盖结构写。
    // bump 在数据写之后调用：若 build 的 listAll 看到了新数据但还没读到 bump，下次 ensureFresh 也会因值变化而重建。
    try {
      const next = this.structuralVersion() + 1;
      writeFileSync(this.structuralVersionFile(), String(next));
    } catch { /* 标记写失败不阻断主写 */ }
  }

  async count(scopeFilter?: string[]): Promise<number> {
    if (!this.table) return 0;
    if (!scopeFilter || scopeFilter.length === 0) return await this.table.countRows();
    const scopeConditions = scopeFilter.map(s => `scope = '${escapeSqlLiteral(s)}'`).join(" OR ");
    return await this.table.countRows(`(${scopeConditions})`);
  }

  async scan(
    scopeFilter?: string[],
    limit = 500,
    offset = 0
  ): Promise<MemoryEntry[]> {
    if (!this.table) return [];
    const safeLimit = clampInt(limit, 1, 5000);
    const safeOffset = clampInt(offset, 0, Number.MAX_SAFE_INTEGER);

    let query = this.table.query().limit(safeLimit).offset(safeOffset);
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter.map(s => `scope = '${escapeSqlLiteral(s)}'`).join(" OR ");
      query = query.where(`(${scopeConditions})`);
    }

    const results = await query.toArray();
    return results.map(rowToMemoryEntry);
  }

  async incrementRecallBatch(ids: string[]): Promise<void> {
    if (!this.table || ids.length === 0) return;
    const now = Date.now();
    const inList = ids.map(id => `'${escapeSqlLiteral(id)}'`).join(", ");
    try {
      // DB 端原子自增（valuesSql 在引擎内对每行算 recallCount+1），避免 read-modify-write 并发丢计数
      await this.table.update({
        where: `id IN (${inList})`,
        valuesSql: { recallCount: "coalesce(recallCount, 0) + 1", lastRecallAt: String(now) },
      });
    } catch (err) {
      console.error(`[claude-memory-pro] incrementRecallBatch 失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 10,
    offset = 0
  ): Promise<MemoryEntry[]> {
    // 基于 listAll 真分页（原零向量搜索是假分页，连"最新N条"都不可靠：先取任意窗口再排序）
    const safeLimit = clampInt(limit, 1, 500);
    const all = await this.listAll(scopeFilter, category);
    return all.slice(offset, offset + safeLimit);
  }

  async getRecallCandidates(limit = 200): Promise<MemoryEntry[]> {
    // 全量里按召回次数取 top，而非"最新N条里挑高频"（否则老的高频记忆永进不了候选）
    const entries = (await this.listAll()).filter(e => (e.recallCount ?? 0) > 0);
    entries.sort((a, b) => (b.recallCount || 0) - (a.recallCount || 0));
    return entries.slice(0, clampInt(limit, 1, 5000));
  }

  /** 分页捞全量（绕过 list 单页 500 上限），用于 KG/atlas/cleaner 等需完整视图的场景。按时间倒序。 */
  async listAll(scopeFilter?: string[], category?: string): Promise<MemoryEntry[]> {
    const total = await this.count(scopeFilter);
    // scan 无保证顺序，offset 分页在多页时可能重叠/遗漏：能一次取全就一次取全；
    // 超过单次上限才分页，并按 id 去重兜底防重叠。
    let rows: MemoryEntry[];
    if (total <= 5000) {
      rows = await this.scan(scopeFilter, Math.max(total, 1), 0);
    } else {
      const byId = new Map<string, MemoryEntry>();
      for (let offset = 0; offset < total * 2 && byId.size < total; offset += 5000) {
        const batch = await this.scan(scopeFilter, 5000, offset);
        if (batch.length === 0) break;
        for (const e of batch) byId.set(e.id, e);
      }
      rows = [...byId.values()];
    }
    const filtered = category ? rows.filter(e => e.category === category) : rows;
    filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return filtered;
  }

  async updateEntrySupersedes(id: string, supersedesId: string): Promise<void> {
    const entries = await this.getByIds([id]);
    if (entries.length === 0) return;
    const entry = entries[0];
    let meta: Record<string, any> = {};
    try { if (entry.metadata) meta = JSON.parse(entry.metadata); } catch {}
    meta.supersededBy = supersedesId;
    meta.supersededAt = new Date().toISOString();
    await this.update(id, { metadata: JSON.stringify(meta) });
  }

  async updateEntryExpired(id: string): Promise<void> {
    const entries = await this.getByIds([id]);
    if (entries.length === 0) return;
    const entry = entries[0];
    let meta: Record<string, any> = {};
    try { if (entry.metadata) meta = JSON.parse(entry.metadata); } catch {}
    meta.expired = true;
    meta.expiredAt = new Date().toISOString();
    await this.update(id, { metadata: JSON.stringify(meta) });
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }> {
    const [totalCount, entries] = await Promise.all([
      this.count(scopeFilter),
      this.listAll(scopeFilter),
    ]);
    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    for (const entry of entries) {
      scopeCounts[entry.scope] = (scopeCounts[entry.scope] || 0) + 1;
      categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1;
    }
    return { totalCount, scopeCounts, categoryCounts };
  }
}
