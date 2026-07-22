/**
 * Claude Memory Pro - Dream Manager
 * 三阶段记忆晋升：light / deep / REM
 *
 * 基于召回频率、最近性、查询多样性的加权评分，
 * 将高频记忆晋升并写入 dream.md（Dream Trail 格式）。
 * Replay-safe 去重：trail state 防止重复晋升。
 *
 * 移植自 OpenClaw memory-enhanced dream-manager。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { MemoryEntry, MemoryStore } from './store.js';
import type { Embedder } from './embedder.js';
import { cleanupStoredMemories } from './memory-cleaner.js';

// ============================================================================
// Types & Config
// ============================================================================

export type DreamPhase = 'light' | 'deep' | 'rem';

export interface DreamThresholds {
  light: { minScore: number; minRecallCount: number; minUniqueQueries: number };
  deep:  { minScore: number; minRecallCount: number; minUniqueQueries: number };
  rem:   { minScore: number; minRecallCount: number; minUniqueQueries: number };
}

export interface DreamConfig {
  mode: 'off' | 'light' | 'deep' | 'rem';
  thresholds: DreamThresholds;
  aging: {
    recencyHalfLifeDays: number;
    maxAgeDays: number;
  };
  dailyReorgHour: number;
}

export interface PromotionCandidate {
  memoryId: string;
  memoryText: string;
  category: string;
  recallCount: number;
  totalRelevance: number;
  uniqueQueries: string[];
  queryDiversity: number;
  avgRelevance: number;
  recencyScore: number;
  promotionScore: number;
  promotionTier: DreamPhase | 'none';
}

export interface PromotionDecision {
  memoryId: string;
  tier: DreamPhase | 'none';
  written: boolean;
  reason: 'promoted' | 'tier_none' | 'already_promoted_same_or_higher';
  existingPhase?: DreamPhase;
}

// 输出路径：~/.claude/memory-pro/
const BASE_DIR = join(homedir(), '.claude', 'memory-pro');
const DREAM_MD_FILE = join(BASE_DIR, 'dream.md');
const TRAIL_STATE_FILE = join(BASE_DIR, 'dream-trail-state.json');
const LAST_RUN_FILE = join(BASE_DIR, 'dream-last-run.json');
const MAX_DREAM_SECTIONS = 100;

export const DEFAULT_CONFIG: DreamConfig = {
  mode: 'light',
  thresholds: {
    light: { minScore: 0.62, minRecallCount: 2, minUniqueQueries: 1 },
    deep:  { minScore: 0.66, minRecallCount: 3, minUniqueQueries: 2 },
    rem:   { minScore: 0.70, minRecallCount: 4, minUniqueQueries: 3 },
  },
  aging: {
    recencyHalfLifeDays: 7,
    maxAgeDays: 30,
  },
  dailyReorgHour: 4,
};

// ============================================================================
// Scoring
// ============================================================================

interface DreamEntry {
  memoryId: string;
  memoryText: string;
  category: string;
  recallCount: number;
  lastRecallAt: number;
  firstRecallAt: number;
}

function memoryEntryToDreamEntry(entry: MemoryEntry): DreamEntry | null {
  if ((entry.recallCount ?? 0) <= 0) return null;
  // 方案 C：task/lesson 不进 dream 晋升
  // task 是临时工作流（completed 后语义无召回价值）
  // lesson 已有 evidenceCount 自合并加权机制，叠 dream 是双重计分
  if (entry.category === 'task' || entry.category === 'lesson') return null;
  return {
    memoryId: entry.id,
    memoryText: entry.text,
    category: entry.category,
    recallCount: entry.recallCount ?? 0,
    lastRecallAt: entry.lastRecallAt ?? entry.timestamp,
    firstRecallAt: entry.timestamp,
  };
}

function scoreCandidate(
  entry: DreamEntry,
  _thresholds: DreamThresholds['light' | 'deep' | 'rem'],
  recencyHalfLifeDays: number
): PromotionCandidate {
  const now = Date.now();
  const daysSince = (now - entry.lastRecallAt) / (1000 * 60 * 60 * 24);
  const recencyScore = Math.exp(-daysSince / recencyHalfLifeDays);
  const queryDiversity = Math.min(entry.recallCount / 10, 1) * 0.5 + recencyScore * 0.5;
  const avgRelevance = 0.7;

  const promotionScore =
    (Math.min(entry.recallCount / 10, 1) * 0.25) +
    (avgRelevance * 0.30) +
    (queryDiversity * 0.20) +
    (recencyScore * 0.25);

  let promotionTier: PromotionCandidate['promotionTier'] = 'none';

  if (promotionScore >= DEFAULT_CONFIG.thresholds.rem.minScore &&
      entry.recallCount >= DEFAULT_CONFIG.thresholds.rem.minRecallCount) {
    promotionTier = 'rem';
  } else if (promotionScore >= DEFAULT_CONFIG.thresholds.deep.minScore &&
             entry.recallCount >= DEFAULT_CONFIG.thresholds.deep.minRecallCount) {
    promotionTier = 'deep';
  } else if (promotionScore >= DEFAULT_CONFIG.thresholds.light.minScore &&
             entry.recallCount >= DEFAULT_CONFIG.thresholds.light.minRecallCount) {
    promotionTier = 'light';
  }

  return {
    memoryId: entry.memoryId,
    memoryText: entry.memoryText,
    category: entry.category,
    recallCount: entry.recallCount,
    totalRelevance: avgRelevance * entry.recallCount,
    uniqueQueries: [],
    queryDiversity,
    avgRelevance,
    recencyScore,
    promotionScore,
    promotionTier,
  };
}

// ============================================================================
// Promotion Candidates
// ============================================================================

export function getPromotionCandidates(
  entries: MemoryEntry[],
  config: DreamConfig = DEFAULT_CONFIG
): PromotionCandidate[] {
  const results: PromotionCandidate[] = [];

  for (const raw of entries) {
    const entry = memoryEntryToDreamEntry(raw);
    if (!entry) continue;

    const daysSince = (Date.now() - entry.lastRecallAt) / (1000 * 60 * 60 * 24);
    if (daysSince > config.aging.maxAgeDays) continue;

    const scored = scoreCandidate(entry, config.thresholds.light, config.aging.recencyHalfLifeDays);
    if (scored.promotionTier !== 'none') {
      results.push(scored);
    }
  }

  return results;
}

// ============================================================================
// Trail State (replay-safe dedup)
// ============================================================================

interface TrailState {
  promoted: Record<string, { phase: DreamPhase; promotedAt: string; promotionScore: number }>;
}

function loadTrailState(): TrailState {
  try {
    if (existsSync(TRAIL_STATE_FILE)) {
      return JSON.parse(readFileSync(TRAIL_STATE_FILE, 'utf8')) as TrailState;
    }
  } catch {}
  return { promoted: {} };
}

function saveTrailState(state: TrailState): void {
  try {
    mkdirSync(dirname(TRAIL_STATE_FILE), { recursive: true });
    writeFileSync(TRAIL_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { console.error(`[claude-memory-pro] dream trail 状态落盘失败: ${err instanceof Error ? err.message : err}`); }
}

// ============================================================================
// Dream Trail 摘要
// ============================================================================

function summarizeDreamText(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 180);
}

// ============================================================================
// Apply Promotions → dream.md
// ============================================================================

export function applyPromotions(
  candidates: PromotionCandidate[],
  config: DreamConfig = DEFAULT_CONFIG
): { written: number; skipped: number; phase: DreamPhase; decisions: PromotionDecision[] } {
  let written = 0;
  let skipped = 0;
  const decisions: PromotionDecision[] = [];

  if (candidates.length === 0) return { written, skipped, phase: config.mode as DreamPhase, decisions };

  const trail = loadTrailState();
  const now = new Date().toISOString();
  const phase = config.mode as DreamPhase;

  const existingContent = existsSync(DREAM_MD_FILE)
    ? readFileSync(DREAM_MD_FILE, 'utf8')
    : '';

  const lines: string[] = [];
  lines.push('');
  lines.push(`## ${phase.toUpperCase()} [${now}]`);

  const tierOrder: Record<DreamPhase, number> = { light: 0, deep: 1, rem: 2 };

  for (const c of candidates) {
    if (c.promotionTier === 'none') {
      decisions.push({ memoryId: c.memoryId, tier: c.promotionTier, written: false, reason: 'tier_none' });
      continue;
    }

    const existing = trail.promoted[c.memoryId];
    if (existing) {
      const existingOrder = tierOrder[existing.phase] ?? 0;
      const newOrder = tierOrder[c.promotionTier] ?? 0;
      if (existingOrder >= newOrder) {
        skipped++;
        decisions.push({
          memoryId: c.memoryId, tier: c.promotionTier, written: false,
          reason: 'already_promoted_same_or_higher', existingPhase: existing.phase,
        });
        continue;
      }
    }

    trail.promoted[c.memoryId] = { phase: c.promotionTier, promotedAt: now, promotionScore: c.promotionScore };

    const marker = `[dream:${c.promotionTier}:${c.memoryId}]`;
    lines.push(`- ${marker} recall=${c.recallCount} | ${summarizeDreamText(c.memoryText)}`);
    lines.push(`  score=${c.promotionScore.toFixed(3)} | recency=${c.recencyScore.toFixed(3)} | category=${c.category}`);
    written++;
    decisions.push({ memoryId: c.memoryId, tier: c.promotionTier, written: true, reason: 'promoted' });
  }

  lines.push('');

  if (written > 0) {
    let updated = existingContent.trimEnd() + '\n' + lines.join('\n');

    // 限制 dream.md 最大段落数
    const sectionCount = (updated.match(/^## (LIGHT|DEEP|REM) \[/gm) || []).length;
    if (sectionCount > MAX_DREAM_SECTIONS) {
      const sectionLines: string[] = [];
      const allLines = updated.split('\n');
      for (const line of allLines) {
        if (/^## (LIGHT|DEEP|REM) \[/.test(line)) sectionLines.push(line);
      }
      const keepSections = new Set(sectionLines.slice(-MAX_DREAM_SECTIONS));
      let filtered = '';
      let inDropped = false;
      for (const line of allLines) {
        if (/^## (LIGHT|DEEP|REM) \[/.test(line)) {
          inDropped = !keepSections.has(line);
        }
        if (!inDropped) filtered += line + '\n';
      }
      updated = filtered.trimEnd();
    }

    mkdirSync(dirname(DREAM_MD_FILE), { recursive: true });
    writeFileSync(DREAM_MD_FILE, updated, 'utf8');
    saveTrailState(trail);
  }

  return { written, skipped, phase, decisions };
}

// ============================================================================
// Core: 从 LanceDB 直接执行晋升
// ============================================================================

export async function promoteMemoriesFromStore(
  store: { getRecallCandidates: (limit?: number) => Promise<MemoryEntry[]> },
  config: DreamConfig = DEFAULT_CONFIG
): Promise<{ candidates: PromotionCandidate[]; written: number; skipped: number; phase: DreamPhase; decisions: PromotionDecision[]; promotedToMemoryMd: number }> {
  const entries = await store.getRecallCandidates(200);
  const candidates = getPromotionCandidates(entries, config);
  const { written, skipped, phase, decisions } = applyPromotions(candidates, config);
  // deep/rem 级晋升同步到 MEMORY.md → 进入系统提示词
  const promotedToMemoryMd = syncPromotedToMemoryMd(candidates);
  if (promotedToMemoryMd > 0) {
    console.error(`[dream] ${promotedToMemoryMd} memories synced to MEMORY.md`);
  }
  return { candidates, written, skipped, phase, decisions, promotedToMemoryMd };
}

// ============================================================================
// Timer Recovery (crash-safe)
// ============================================================================

interface LastRunState {
  light: string | null;
  deep: string | null;
  rem: string | null;
  maintenance?: string | null;
}

export function loadLastRunState(): LastRunState {
  try {
    if (existsSync(LAST_RUN_FILE)) {
      return JSON.parse(readFileSync(LAST_RUN_FILE, 'utf8')) as LastRunState;
    }
  } catch {}
  return { light: null, deep: null, rem: null, maintenance: null };
}

export function saveLastRunState(state: LastRunState): void {
  try {
    mkdirSync(dirname(LAST_RUN_FILE), { recursive: true });
    writeFileSync(LAST_RUN_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { console.error(`[claude-memory-pro] dream last-run 落盘失败（可能致重复晋升）: ${err instanceof Error ? err.message : err}`); }
}

export function needsRecovery(lastRun: string | null, intervalMs: number): boolean {
  if (!lastRun) return true;
  const elapsed = Date.now() - Date.parse(lastRun);
  return elapsed >= intervalMs;
}

export async function recoverMissedPhases(
  store: { getRecallCandidates: (limit?: number) => Promise<MemoryEntry[]> },
  config: DreamConfig = DEFAULT_CONFIG
): Promise<{ recovered: string[] }> {
  const MS_6H = 6 * 60 * 60 * 1000;
  const MS_12H = 12 * 60 * 60 * 1000;
  const MS_24H = 24 * 60 * 60 * 1000;

  const state = loadLastRunState();
  const recovered: string[] = [];

  if (config.mode === 'off') return { recovered };

  if (needsRecovery(state.rem, MS_6H)) {
    const result = await promoteMemoriesFromStore(store, { ...config, mode: 'rem' });
    if (result.written > 0 || result.skipped > 0) recovered.push('rem');
    state.rem = new Date().toISOString();
  }

  if (needsRecovery(state.deep, MS_12H)) {
    const result = await promoteMemoriesFromStore(store, { ...config, mode: 'deep' });
    if (result.written > 0 || result.skipped > 0) recovered.push('deep');
    state.deep = new Date().toISOString();
  }

  if (needsRecovery(state.light, MS_24H)) {
    const result = await promoteMemoriesFromStore(store, { ...config, mode: 'light' });
    if (result.written > 0 || result.skipped > 0) recovered.push('light');
    state.light = new Date().toISOString();
  }

  saveLastRunState(state);
  return { recovered };
}

// ============================================================================
// Dream 维护：定期清理 + 压缩（治记忆噪音与存储膨胀）
// ============================================================================

export interface MaintenanceReport {
  ranAt: string;
  cleanup?: { scanned: number; deleted: number; cleaned: number; deduped: number };
  compact?: { ok: boolean; error?: string };
}

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 默认每日一次

/**
 * 执行一次 dream 维护：
 *  - 清理：删噪音 + 去重（复用 memory-cleaner，不重造）
 *  - 压缩：LanceDB optimize 合并碎片 + 回收旧版本（治"8M 内容撑成上百 M"的索引/版本膨胀）
 * 压缩排在清理之后：清理产生的删除会留下更多可回收的碎片/旧版本。
 * cleanup / compact 可分别关闭。
 */
export async function runDreamMaintenance(
  store: MemoryStore,
  embedder: Embedder,
  opts: { cleanup?: boolean; compact?: boolean; cleanupLimit?: number } = {}
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { ranAt: new Date().toISOString() };
  if (opts.cleanup !== false) {
    try {
      report.cleanup = await cleanupStoredMemories(store, embedder, { limit: opts.cleanupLimit });
    } catch (err) {
      console.error(`[claude-memory-pro] dream 维护-清理失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (opts.compact !== false) {
    report.compact = await store.optimize();
  }
  return report;
}

/**
 * 到期才跑维护（默认每 24h），并更新 last-run 标记。崩溃安全：跑成才记标记。
 * 返回 null 表示未到期、本次跳过。
 */
export async function maybeRunMaintenance(
  store: MemoryStore,
  embedder: Embedder,
  intervalMs = MAINTENANCE_INTERVAL_MS
): Promise<MaintenanceReport | null> {
  const state = loadLastRunState();
  if (!needsRecovery(state.maintenance ?? null, intervalMs)) return null;
  const report = await runDreamMaintenance(store, embedder);
  state.maintenance = report.ranAt;
  saveLastRunState(state);
  return report;
}

// ============================================================================
// Dream Trail 读取
// ============================================================================

// ============================================================================
// Promote → MEMORY.md（系统提示词层）
// ============================================================================

const MEMORY_DIR = join(homedir(), '.claude', 'projects', '-Users-rico', 'memory');
const MEMORY_INDEX = join(MEMORY_DIR, 'MEMORY.md');
const PROMOTED_FILE = join(MEMORY_DIR, 'dream-promoted.md');

/**
 * 将 promote 级记忆同步到 Claude Code 原生 MEMORY.md 体系。
 * 写入 dream-promoted.md 主题文件，并在 MEMORY.md 索引中注册。
 */
export function syncPromotedToMemoryMd(candidates: PromotionCandidate[]): number {
  const promoted = candidates.filter(c => c.promotionTier === 'rem' || c.promotionTier === 'deep');
  if (promoted.length === 0) return 0;

  mkdirSync(MEMORY_DIR, { recursive: true });

  // 读取已有 promoted 文件，避免重复
  let existingContent = '';
  try {
    if (existsSync(PROMOTED_FILE)) {
      existingContent = readFileSync(PROMOTED_FILE, 'utf8');
    }
  } catch {}

  const existingIds = new Set(
    (existingContent.match(/<!-- id:([a-f0-9-]+) -->/g) || [])
      .map(m => m.replace('<!-- id:', '').replace(' -->', ''))
  );

  const newEntries: string[] = [];
  for (const c of promoted) {
    if (existingIds.has(c.memoryId)) continue;
    const summary = c.memoryText.replace(/\s+/g, ' ').trim().slice(0, 200);
    newEntries.push(`- <!-- id:${c.memoryId} --> [${c.category}] ${summary}`);
  }

  if (newEntries.length === 0) return 0;

  // 写入 dream-promoted.md
  const header = existingContent ? '' : `---
name: dream-promoted
description: Dream 晋升的高频记忆（自动生成，勿手动编辑）
type: feedback
---

# Dream 晋升记忆

以下记忆因高频召回被自动晋升到系统提示词层。

`;
  const updatedContent = (existingContent || header) + newEntries.join('\n') + '\n';
  writeFileSync(PROMOTED_FILE, updatedContent, 'utf8');

  // 确保 MEMORY.md 索引中有 dream-promoted 条目
  try {
    let indexContent = '';
    if (existsSync(MEMORY_INDEX)) {
      indexContent = readFileSync(MEMORY_INDEX, 'utf8');
    }
    if (!indexContent.includes('dream-promoted.md')) {
      const entry = '\n## Dream Promoted\n- [dream-promoted.md](dream-promoted.md) — Dream 晋升的高频记忆（自动同步）\n';
      writeFileSync(MEMORY_INDEX, indexContent.trimEnd() + '\n' + entry, 'utf8');
    }
  } catch (err) { console.error(`[claude-memory-pro] MEMORY 索引更新失败: ${err instanceof Error ? err.message : err}`); }

  return newEntries.length;
}

export function readDreamTrail(): string {
  try {
    if (existsSync(DREAM_MD_FILE)) {
      return readFileSync(DREAM_MD_FILE, 'utf8');
    }
  } catch {}
  return '';
}

export function getDreamStats(): {
  totalSections: number;
  totalPromoted: number;
  lastRunState: LastRunState;
  trailState: TrailState;
} {
  const trail = readDreamTrail();
  const totalSections = (trail.match(/^## (LIGHT|DEEP|REM) \[/gm) || []).length;
  const totalPromoted = (trail.match(/^\- \[dream:/gm) || []).length;
  const lastRunState = loadLastRunState();
  const trailState = loadTrailState();
  return { totalSections, totalPromoted, lastRunState, trailState };
}
