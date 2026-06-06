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
// 简易矛盾检测（基于文本相似度，无需外部 LLM）
// ============================================================================

// 字符 2-gram：中文无空格，按空格分词会把整句当一个 token 致相似度恒为0
function charBigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, '');
  const grams = new Set<string>();
  if (t.length === 1) { grams.add(t); return grams; }
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

function jaccard(a: string, b: string): number {
  const setA = charBigrams(a), setB = charBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const g of setA) if (setB.has(g)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

const NEGATORS = /[不别勿未无]/;
// word 在 text 中是否以"被否定/被肯定"形式出现（看紧邻前 2 字是否有否定词）
function occursWith(text: string, word: string, wantNegated: boolean): boolean {
  let i = text.indexOf(word);
  while (i >= 0) {
    const before = text.slice(Math.max(0, i - 2), i);
    if (NEGATORS.test(before) === wantNegated) return true;
    i = text.indexOf(word, i + 1);
  }
  return false;
}
// "只以肯定/只以否定形式出现"——避免同一字既在肯定词又在否定词里（如"能"同时在"功能"和"不能"）造成误判
const clearlyAsserts = (t: string, w: string) => occursWith(t, w, false) && !occursWith(t, w, true);
const clearlyNegates = (t: string, w: string) => occursWith(t, w, true) && !occursWith(t, w, false);

export function detectSimpleContradiction(newer: string, older: string): boolean {
  const similarity = jaccard(newer, older);
  if (similarity < 0.3) return false;

  // 源 A：同一动作词，一句只否定、另一句只肯定（"不要X"vs"要X"、"不允许"vs"允许"、"别开启"vs"开启"）。
  const directives = ['要', '用', '能', '开启', '关闭', '允许', '禁止', '添加', '移除', '登录', '启用', '停用'];
  for (const w of directives) {
    if ((clearlyNegates(newer, w) && clearlyAsserts(older, w)) ||
        (clearlyNegates(older, w) && clearlyAsserts(newer, w))) return true;
  }
  // 源 B：反义词对各自被"肯定"地出现（被否定的不算，故"不能开启"vs"不能关闭"不触发）。
  const antonyms: Array<[string, string]> = [['开启', '关闭'], ['允许', '禁止'], ['添加', '移除'], ['启用', '停用'], ['false', 'true']];
  for (const [a, b] of antonyms) {
    if ((clearlyAsserts(newer, a) && clearlyAsserts(older, b)) ||
        (clearlyAsserts(newer, b) && clearlyAsserts(older, a))) return true;
  }
  return false;
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
