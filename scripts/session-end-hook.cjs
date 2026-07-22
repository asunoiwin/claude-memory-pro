#!/usr/bin/env node
/**
 * SessionEnd / Stop Hook
 * 会话结束时刷新习惯数据和知识图谱。
 */

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');

const BASE_DIR = join(homedir(), '.claude', 'memory-pro');
const HABIT_FILE = join(BASE_DIR, 'habit-candidates.json');
const ROLLUP_FILE = join(BASE_DIR, 'instinct-rollup.md');
const DREAM_LAST_RUN = join(BASE_DIR, 'dream-last-run.json');

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

function main() {
  // 重新生成 instinct-rollup.md
  const habits = readJson(HABIT_FILE);
  if (!habits || !Array.isArray(habits.stats)) {
    process.exit(0);
    return;
  }

  const VELOCITY_WINDOW_DAYS = 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - VELOCITY_WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString();

  const candidates = habits.stats
    .map(stat => {
      const velocity = stat.lastRecallAt >= cutoffStr ? stat.recallCount : 0;
      let tier = 'retain';
      if (velocity >= 5 || stat.recallCount >= 10) tier = 'promote';
      else if (velocity >= 2) tier = 'reinforce';
      return { ...stat, velocity, tier };
    })
    .filter(c => c.tier !== 'retain')
    .sort((a, b) => {
      const rank = { promote: 0, reinforce: 1 };
      return (rank[a.tier] || 2) - (rank[b.tier] || 2) || b.recallCount - a.recallCount;
    })
    .slice(0, 8);

  if (candidates.length === 0) {
    process.exit(0);
    return;
  }

  const lines = [
    '# Instinct Rollup',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Purpose',
    '',
    '轻量工作先验，来自高频记忆召回，优先参考但非永久规则。',
    '',
    '## Recall Instincts',
    '',
  ];

  for (const c of candidates) {
    lines.push(`- [${c.tier}:${c.category}] ${(c.memoryText || '').slice(0, 220)}`);
    lines.push(`  - recallCount: ${c.recallCount}, velocity: ${c.velocity}`);
  }

  lines.push('', '## Note', '', '这些先验来自真实使用，长期稳定后再人工提升为永久规则。', '');

  mkdirSync(dirname(ROLLUP_FILE), { recursive: true });
  writeFileSync(ROLLUP_FILE, lines.join('\n'), 'utf-8');

  // 更新 dream-last-run.json 记录本次会话时间
  // （实际晋升由 MCP server 启动时的 recoverMissedPhases 和手动 memory_dream run 执行）
  try {
    let dreamState = { light: null, deep: null, rem: null };
    if (existsSync(DREAM_LAST_RUN)) {
      try { dreamState = JSON.parse(readFileSync(DREAM_LAST_RUN, 'utf8')); } catch {}
    }
    // 标记会话活跃时间，便于下次启动判断是否需要恢复
    dreamState._lastSessionEnd = new Date().toISOString();
    mkdirSync(dirname(DREAM_LAST_RUN), { recursive: true });
    writeFileSync(DREAM_LAST_RUN, JSON.stringify(dreamState, null, 2), 'utf8');
  } catch {}
}

main();
