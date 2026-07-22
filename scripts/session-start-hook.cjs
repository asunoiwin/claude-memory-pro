#!/usr/bin/env node
/**
 * SessionStart Hook
 * 会话开始时注入工作先验（instinct-rollup.md）和习惯追踪摘要。
 */

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const BASE_DIR = join(homedir(), '.claude', 'memory-pro');
const ROLLUP_FILE = join(BASE_DIR, 'instinct-rollup.md');
const HABIT_FILE = join(BASE_DIR, 'habit-candidates.json');
const ATLAS_FILE = join(BASE_DIR, 'memory-atlas.json');
const DREAM_FILE = join(BASE_DIR, 'dream.md');
const DREAM_LAST_RUN = join(BASE_DIR, 'dream-last-run.json');

function readFile(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; }
}

function readJson(path) {
  const raw = readFile(path);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function main() {
  const parts = ['[claude-memory-pro v2.0] 语义记忆系统已就绪。'];

  // 注入工作先验
  const rollup = readFile(ROLLUP_FILE);
  if (rollup && rollup.includes('promote') || rollup && rollup.includes('reinforce')) {
    parts.push('');
    parts.push('--- 工作先验（来自高频记忆召回）---');
    // 只提取 promote 和 reinforce 级别
    const lines = rollup.split('\n');
    for (const line of lines) {
      if (line.includes('[promote:') || line.includes('[reinforce:')) {
        parts.push(line);
      }
    }
  }

  // 习惯追踪摘要
  const habits = readJson(HABIT_FILE);
  if (habits && Array.isArray(habits.stats) && habits.stats.length > 0) {
    const promoteCount = habits.stats.filter(s => s.recallCount >= 10).length;
    const reinforceCount = habits.stats.filter(s => s.recallCount >= 2 && s.recallCount < 10).length;
    if (promoteCount > 0 || reinforceCount > 0) {
      parts.push(`\n习惯追踪：${promoteCount} 条待晋升，${reinforceCount} 条待强化。`);
    }
  }

  // 知识图谱状态
  const atlas = readJson(ATLAS_FILE);
  if (atlas && atlas.clusters && atlas.clusters.length > 0) {
    parts.push(`知识图谱：${atlas.totalIndexed || 0} 条记忆，${atlas.clusters.length} 个主题聚类。`);
  }

  // Dream 状态
  const dreamLastRun = readJson(DREAM_LAST_RUN);
  if (dreamLastRun) {
    const phases = [];
    if (dreamLastRun.light) phases.push(`light=${dreamLastRun.light.split('T')[0]}`);
    if (dreamLastRun.deep) phases.push(`deep=${dreamLastRun.deep.split('T')[0]}`);
    if (dreamLastRun.rem) phases.push(`rem=${dreamLastRun.rem.split('T')[0]}`);
    if (phases.length > 0) {
      parts.push(`Dream 晋升：${phases.join('，')}`);
    }
  }

  // 注入 dream.md 中的 promote/deep/rem 级晋升摘要
  const dreamContent = readFile(DREAM_FILE);
  if (dreamContent && dreamContent.trim()) {
    const dreamLines = dreamContent.split('\n').filter(l => l.startsWith('- [dream:'));
    const recentDream = dreamLines.slice(-5);
    if (recentDream.length > 0) {
      parts.push('');
      parts.push('--- Dream Trail（近期晋升）---');
      for (const line of recentDream) {
        parts.push(line);
      }
    }
  }

  parts.push('');
  parts.push('可用工具：memory_recall / memory_store / memory_atlas / memory_habits / memory_capture / memory_cleanup / memory_audit / memory_journal / memory_kg / memory_dream');

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: parts.join('\n'),
    },
  };
  console.log(JSON.stringify(output));
}

main();
