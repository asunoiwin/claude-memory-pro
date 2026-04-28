/**
 * Habit Tracker Module
 * Turns repeated memory recall patterns into lightweight instincts.
 * Supports memory promotion tiers: retain -> reinforce -> promote
 * Generates instinct-rollup.md for persistent behavior priors.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface MemoryRecallStats {
  memoryId: string;
  memoryText: string;
  category: string;
  recallCount: number;
  firstRecallAt: string;
  lastRecallAt: string;
  recentRecallDays: number[];
}

export interface HabitCandidate {
  memoryId: string;
  memoryText: string;
  category: string;
  recallCount: number;
  lastRecallAt: string;
  recentRecallVelocity: number;
  promotionTier: 'retain' | 'reinforce' | 'promote';
  reason: string;
}

const BASE_DIR = join(homedir(), '.claude', 'memory-pro');
const HABIT_FILE = join(BASE_DIR, 'habit-candidates.json');
const HABIT_ROLLUP_FILE = join(BASE_DIR, 'instinct-rollup.md');

const VELOCITY_WINDOW_DAYS = 7;
const HABIT_THRESHOLD = 2;
const MAX_TRACKED = 200;

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch { return fallback; }
}

function getDayOffset(dateStr: string): number {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function loadStats(): Map<string, MemoryRecallStats> {
  const data = readJson<{ stats?: MemoryRecallStats[] }>(HABIT_FILE, {});
  if (!Array.isArray(data.stats)) return new Map();
  return new Map(data.stats.map(item => [item.memoryId, item]));
}

function computeVelocity(stats: MemoryRecallStats): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - VELOCITY_WINDOW_DAYS);
  return stats.lastRecallAt >= cutoff.toISOString() ? stats.recallCount : 0;
}

function determinePromotionTier(stats: MemoryRecallStats, velocity: number): 'retain' | 'reinforce' | 'promote' {
  if (velocity >= 5 || stats.recallCount >= 10) return 'promote';
  if (velocity >= HABIT_THRESHOLD) return 'reinforce';
  return 'retain';
}

function buildReason(stats: MemoryRecallStats, tier: 'retain' | 'reinforce' | 'promote'): string {
  const velocity = computeVelocity(stats);
  const daysSince = getDayOffset(stats.lastRecallAt);
  switch (tier) {
    case 'promote':
      return `高频召回（近${VELOCITY_WINDOW_DAYS}天${velocity}次，总计${stats.recallCount}次），建议提升为稳定工作习惯。`;
    case 'reinforce':
      return `稳定召回（近${VELOCITY_WINDOW_DAYS}天${velocity}次），建议优先注入为工作先验。`;
    default:
      return `偶发召回（总${stats.recallCount}次），${daysSince === 0 ? '今日' : `${daysSince}天前`}命中，继续观察。`;
  }
}

function buildCandidatesFromStats(stats: Map<string, MemoryRecallStats>): HabitCandidate[] {
  const candidates: HabitCandidate[] = [];
  for (const [, stat] of stats) {
    const velocity = computeVelocity(stat);
    const tier = determinePromotionTier(stat, velocity);
    candidates.push({
      memoryId: stat.memoryId,
      memoryText: stat.memoryText.slice(0, 220),
      category: stat.category,
      recallCount: stat.recallCount,
      lastRecallAt: stat.lastRecallAt,
      recentRecallVelocity: velocity,
      promotionTier: tier,
      reason: buildReason(stat, tier),
    });
  }

  const tierRank = { promote: 0, reinforce: 1, retain: 2 };
  return candidates.sort((a, b) => {
    const byTier = tierRank[a.promotionTier] - tierRank[b.promotionTier];
    if (byTier !== 0) return byTier;
    return b.recallCount - a.recallCount;
  });
}

function buildRollupMarkdown(stats: Map<string, MemoryRecallStats>): string {
  const recallCandidates = buildCandidatesFromStats(stats)
    .filter(item => item.promotionTier !== 'retain')
    .slice(0, 8);

  const lines = [
    '# Instinct Rollup',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Purpose',
    '',
    '这份文件是轻量"下意识工作先验"，来自高频记忆召回，不等于永久规则，但应在执行前优先参考。',
    '',
    '## Recall Instincts',
    '',
  ];

  if (recallCandidates.length === 0) {
    lines.push('- 暂无高频召回记忆。', '');
  } else {
    for (const item of recallCandidates) {
      lines.push(`- [${item.promotionTier}:${item.category}] ${item.memoryText}`);
      lines.push(`  - recallCount: ${item.recallCount}`);
      lines.push(`  - velocity: ${item.recentRecallVelocity}`);
      lines.push(`  - reason: ${item.reason}`);
    }
    lines.push('');
  }

  lines.push('## Note', '', '这些先验来自真实使用行为，应优先作为执行习惯使用；只有长期稳定后再人工提升为永久规则。', '');
  return lines.join('\n');
}

function saveStats(stats: Map<string, MemoryRecallStats>): void {
  const dir = dirname(HABIT_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = {
    generated_at: new Date().toISOString(),
    version: '2.0',
    stats: Array.from(stats.values()),
  };
  writeFileSync(HABIT_FILE, JSON.stringify(data, null, 2), 'utf-8');
  writeFileSync(HABIT_ROLLUP_FILE, buildRollupMarkdown(stats), 'utf-8');
}

export function recordRecall(memoryId: string, memoryText: string, category: string, timestamp?: string): void {
  // 方案 C：task 不纳入习惯统计（召回 task 是查进度，不代表它高价值）
  if (category === 'task') return;
  const now = timestamp || new Date().toISOString();
  const stats = loadStats();
  const existing = stats.get(memoryId);
  if (existing) {
    existing.recallCount += 1;
    existing.lastRecallAt = now;
    existing.memoryText = memoryText;
  } else {
    if (stats.size >= MAX_TRACKED) {
      let oldestId: string | null = null;
      let oldestTime = now;
      for (const [id, stat] of stats) {
        if (stat.lastRecallAt < oldestTime) { oldestTime = stat.lastRecallAt; oldestId = id; }
      }
      if (oldestId) stats.delete(oldestId);
    }
    stats.set(memoryId, {
      memoryId, memoryText, category,
      recallCount: 1, firstRecallAt: now, lastRecallAt: now, recentRecallDays: [0],
    });
  }
  saveStats(stats);
}

export function recordRecallBatch(results: Array<{ id: string; text: string; category: string }>): void {
  if (!results || results.length === 0) return;
  // 方案 C：批量过滤 task；lesson 与其他 category 通过
  const filtered = results.filter(r => r.category !== 'task');
  if (filtered.length === 0) return;
  const now = new Date().toISOString();
  const stats = loadStats();
  for (const result of filtered) {
    const existing = stats.get(result.id);
    if (existing) {
      existing.recallCount += 1;
      existing.lastRecallAt = now;
      existing.memoryText = result.text;
    } else {
      if (stats.size >= MAX_TRACKED) break;
      stats.set(result.id, {
        memoryId: result.id, memoryText: result.text, category: result.category,
        recallCount: 1, firstRecallAt: now, lastRecallAt: now, recentRecallDays: [0],
      });
    }
  }
  saveStats(stats);
}

export function generateHabitCandidates(): HabitCandidate[] {
  return buildCandidatesFromStats(loadStats());
}

export function buildInstinctContext(maxCandidates = 5): string {
  const recallCandidates = generateHabitCandidates()
    .filter(item => item.promotionTier !== 'retain')
    .slice(0, maxCandidates);
  if (recallCandidates.length === 0) return '';

  const lines = ['\n## 工作先验 (Instincts)\n', '以下内容来自高频记忆召回，默认优先参考：', ''];

  if (recallCandidates.length > 0) {
    lines.push('### 高频召回记忆');
    for (const item of recallCandidates) {
      lines.push(`- [${item.promotionTier}:${item.category}] ${item.memoryText}`);
      lines.push(`  recall=${item.recallCount}, 最近${VELOCITY_WINDOW_DAYS}天=${item.recentRecallVelocity}次, 原因: ${item.reason}`);
    }
    lines.push('');
  }

  lines.push('*这些是轻量下意识能力，不是永久规则。*');
  return lines.join('\n');
}

export function refreshHabitArtifacts(): void {
  saveStats(loadStats());
}

export function getHabitSummary(): {
  total: number; promote: number; reinforce: number; retain: number;
} {
  const candidates = generateHabitCandidates();
  return {
    total: candidates.length,
    promote: candidates.filter(i => i.promotionTier === 'promote').length,
    reinforce: candidates.filter(i => i.promotionTier === 'reinforce').length,
    retain: candidates.filter(i => i.promotionTier === 'retain').length,
  };
}
