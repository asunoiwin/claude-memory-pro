/**
 * Claude Memory Pro - Daily Reorganization Module
 *
 * 空闲时段自动整理（默认凌晨 4 点）：
 * 1. 重建 Atlas 和 KG
 * 2. 按 entityKey 分组检测碰撞
 * 3. 矛盾检测（KG contradicts 边 + 文本相似度）
 * 4. 标记过期记忆（> maxAgeDays）
 *
 * 移植自 OpenClaw memory-daily-reorg，去掉外部 LLM 依赖，
 * 改用内置 KG 矛盾检测。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { normalizeFactKey } from './knowledge-graph.js';

// ============================================================================
// Types
// ============================================================================

interface MemoryEntry {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
  recallCount?: number;
}

interface EntityGroup {
  entityKey: string;
  memoryIds: string[];
  memories: MemoryEntry[];
  conflicts: ConflictPair[];
}

interface ConflictPair {
  newerId: string;
  olderId: string;
  newerText: string;
  olderText: string;
  resolution: 'superseded' | 'keep_both';
  reason: string;
}

export interface ReorgResult {
  atlasRebuilt: boolean;
  kgRebuilt: boolean;
  atlasEntries: number;
  entityGroups: number;
  contradictions: number;
  superseded: number;
  expiredMarked: number;
  duration: number;
}

const BASE_DIR = join(homedir(), '.claude', 'memory-pro');
const MERGE_LOG_FILE = join(BASE_DIR, 'merge-log.json');
const MAX_AGE_DAYS = 30;

// ============================================================================
// Entity Grouping
// ============================================================================

function extractEntityKey(entry: MemoryEntry): string | null {
  try {
    const meta = entry.metadata ? JSON.parse(entry.metadata) : {};
    // 与 KG 口径对齐：系统实际写的是 factKey（旧 entityKey 作兼容回退）
    return normalizeFactKey(meta.factKey) || (typeof meta.entityKey === 'string' ? meta.entityKey : null);
  } catch {}
  return null;
}

function groupByEntityKey(entries: MemoryEntry[]): EntityGroup[] {
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of entries) {
    const entityKey = extractEntityKey(entry);
    if (!entityKey) continue;
    const existing = groups.get(entityKey) || [];
    existing.push(entry);
    groups.set(entityKey, existing);
  }

  const result: EntityGroup[] = [];
  for (const [entityKey, memories] of groups) {
    const sorted = memories.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    result.push({
      entityKey,
      memoryIds: sorted.map(m => m.id),
      memories: sorted,
      conflicts: [],
    });
  }

  return result;
}

// ============================================================================
// 简易矛盾检测（无需外部 LLM，仅认最干净的否定矛盾，从严避免误判）
// ============================================================================

// 去掉否定词(不/别/勿/未/无)与空白、转小写，用于"除否定外是否完全相同"的比对
function stripForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[不别勿未无]/g, '');
}
function negatorCount(s: string): number {
  return (s.match(/[不别勿未无]/g) || []).length;
}

export function detectSimpleContradiction(newer: string, older: string): boolean {
  // 只认最干净的"否定矛盾"：去掉否定词后两句完全相同，且否定词数量奇偶不同（即 "X" vs "不X"）。
  // 天然排除：内容不同(费用≠计用、falsey≠true)、双重否定(奇偶相同视为肯定)。
  // 反义词类(开启/关闭)与细微矛盾交给 GLM 扫描器——文本启发式误判会错误隐藏记忆，故从严。
  const a = stripForCompare(newer), b = stripForCompare(older);
  if (!a || a !== b) return false;
  return (negatorCount(newer) % 2) !== (negatorCount(older) % 2);
}

// ============================================================================
// Process Entity Groups
// ============================================================================

async function processEntityGroups(
  groups: EntityGroup[],
  store: { updateEntrySupersedes: (id: string, supersedesId: string) => Promise<void> }
): Promise<{ contradictions: number; superseded: number }> {
  let contradictions = 0;
  let superseded = 0;

  for (const group of groups) {
    if (group.memories.length < 2) continue;

    // 组内按时间降序，两两比对（不止"最新 vs 各较旧"，旧记忆之间的矛盾也要抓）
    const mems = group.memories;
    for (let j = 1; j < mems.length; j++) {
      const older = mems[j];
      for (let i = 0; i < j; i++) {
        const newer = mems[i];
        if (detectSimpleContradiction(newer.text, older.text)) {
          contradictions++;
          group.conflicts.push({
            newerId: newer.id,
            olderId: older.id,
            newerText: newer.text,
            olderText: older.text,
            resolution: 'superseded',
            reason: '文本矛盾检测：newer-wins',
          });
          await store.updateEntrySupersedes(older.id, newer.id);
          superseded++;
          break; // older 被它矛盾的最新一条取代即可
        }
      }
    }
  }

  return { contradictions, superseded };
}

// ============================================================================
// Expiry Detection
// ============================================================================

function findExpiredMemories(entries: MemoryEntry[]): string[] {
  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return entries
    .filter(e => {
      // 有召回记录的不过期（热记忆保护）
      if ((e.recallCount ?? 0) > 0) return false;
      try {
        if (e.metadata) {
          const meta = JSON.parse(e.metadata);
          if (meta.expired) return false; // 已标记
        }
      } catch {}
      return (now - (e.timestamp || 0)) > maxAgeMs;
    })
    .map(e => e.id);
}

// ============================================================================
// Merge Log
// ============================================================================

function appendMergeLog(result: ReorgResult, conflicts: ConflictPair[]): void {
  try {
    let log: any[] = [];
    if (existsSync(MERGE_LOG_FILE)) {
      try { log = JSON.parse(readFileSync(MERGE_LOG_FILE, 'utf8')); } catch {}
    }
    log.push({
      timestamp: new Date().toISOString(),
      results: {
        entityGroups: result.entityGroups,
        contradictions: result.contradictions,
        superseded: result.superseded,
        expiredMarked: result.expiredMarked,
      },
      conflicts: conflicts.slice(0, 20),
    });
    mkdirSync(dirname(MERGE_LOG_FILE), { recursive: true });
    writeFileSync(MERGE_LOG_FILE, JSON.stringify(log.slice(-30), null, 2), 'utf8');
  } catch {}
}

// ============================================================================
// Store Interface
// ============================================================================

interface StoreForReorg {
  listAll(scopeFilter?: string[], category?: string): Promise<MemoryEntry[]>;
  updateEntrySupersedes(id: string, supersedesId: string): Promise<void>;
  updateEntryExpired(id: string): Promise<void>;
}

// ============================================================================
// Main Daily Reorganization
// ============================================================================

export async function runDailyReorganization(
  store: StoreForReorg,
  atlasBuildFn?: (store: any) => Promise<any>,
  kgBuildFn?: () => Promise<void>
): Promise<ReorgResult> {
  const start = Date.now();

  // Step 1: Rebuild Atlas
  let atlasRebuilt = false;
  let atlasEntries = 0;
  if (atlasBuildFn) {
    try {
      const buildResult = await atlasBuildFn(store);
      atlasRebuilt = true;
      atlasEntries = buildResult?.total ?? buildResult?.totalIndexed ?? 0;
    } catch (error) {
      console.warn('[daily-reorg] Atlas rebuild failed:', error instanceof Error ? error.message : String(error));
    }
  }

  // Step 2: Fetch all entries（listAll 真分页全量，去掉原假分页+5000硬截致的重复/漏读）
  const allEntries = await store.listAll();

  // Step 3: Group by entityKey
  const groups = groupByEntityKey(allEntries);

  // Step 4: Detect contradictions
  const { contradictions, superseded } = await processEntityGroups(groups, store);

  // Step 5: Mark expired
  const expiredIds = findExpiredMemories(allEntries);
  for (const id of expiredIds) {
    try { await store.updateEntryExpired(id); } catch {}
  }

  // Step 5b: Rebuild KG（放在取代/过期写库之后，确保本轮裁定当轮就进图谱）
  let kgRebuilt = false;
  if (kgBuildFn) {
    try {
      await kgBuildFn();
      kgRebuilt = true;
    } catch (error) {
      console.warn('[daily-reorg] KG rebuild failed:', error instanceof Error ? error.message : String(error));
    }
  }

  // Step 6: Log
  const allConflicts = groups.flatMap(g => g.conflicts);
  const result: ReorgResult = {
    atlasRebuilt, kgRebuilt, atlasEntries,
    entityGroups: groups.length,
    contradictions, superseded,
    expiredMarked: expiredIds.length,
    duration: Date.now() - start,
  };
  appendMergeLog(result, allConflicts);

  console.info(
    `[daily-reorg] 完成 ${result.duration}ms: ` +
    `atlas=${atlasEntries}, KG=${kgRebuilt}, ` +
    `${groups.length} 实体组, ` +
    `${contradictions} 矛盾, ${superseded} 取代, ${expiredIds.length} 过期`
  );

  return result;
}
