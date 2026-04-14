/**
 * Memory Atlas - Knowledge Graph Module
 * Builds a cluster-based knowledge map from stored memories.
 * Generates anchors, clusters, and edges for memory navigation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MemoryStore, MemoryEntry } from './store.js';
import { isNoise } from './noise-filter.js';

const ATLAS_FILE = join(homedir(), '.claude', 'memory-pro', 'memory-atlas.json');

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function tokenize(text: string): string[] {
  const normalized = String(text || '').toLowerCase();
  const chineseTokens = [...(normalized.match(/[\u4e00-\u9fff]{2,}/g) || [])];
  const expandedChineseTokens = chineseTokens.flatMap((token) => {
    if (token.length <= 4) return [token];
    const parts = new Set<string>([token]);
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i <= token.length - size; i++) {
        parts.add(token.slice(i, i + size));
      }
    }
    return [...parts];
  });
  const tokens = [
    ...(normalized.match(/[a-z0-9][a-z0-9-_]{1,}/g) || []),
    ...expandedChineseTokens,
  ];
  return [...new Set(tokens)].slice(0, 24);
}

function compact(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function normalizeText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isOperationalRecap(text: string): boolean {
  const normalized = normalizeText(text);
  return /Task progress for task-/i.test(normalized) || /已完成任务[:：]/.test(normalized);
}

function qualityScore(entry: MemoryEntry, source: string): number {
  const text = normalizeText(entry.text);
  const lengthScore = Math.min(text.length / 160, 1);
  const importanceScore = Math.max(0, Math.min(Number(entry.importance || 0), 1));
  const sourcePenalty = /task_progress|unknown/i.test(source) ? 0.15 : 0;
  const recapPenalty = isOperationalRecap(text) ? 0.45 : 0;
  return Math.max(0, (importanceScore * 0.6) + (lengthScore * 0.4) - sourcePenalty - recapPenalty);
}

function parseMetadata(entry: MemoryEntry): Record<string, unknown> {
  try { return JSON.parse(String(entry.metadata || '{}')); } catch { return {}; }
}

export type AtlasAnchor = {
  id: string;
  category: string;
  source: string;
  importance: number;
  timestamp: number;
  preview: string;
  tokens: string[];
  quality: number;
  clusterKey: string;
};

export type AtlasCluster = {
  key: string;
  label: string;
  count: number;
  categories: Record<string, number>;
  sources: Record<string, number>;
  anchorIds: string[];
  topTokens: string[];
  lastSeen: number;
};

export type AtlasEdge = {
  from: string;
  to: string;
  weight: number;
  reason: string;
};

function pickClusterKey(entry: MemoryEntry, source: string, tokens: string[]): string {
  const metadata = parseMetadata(entry);
  const scope = String(entry.scope || metadata.scope || '').trim();
  const taskId = String(metadata.taskId || '').trim();
  if (taskId) return `task:${taskId}`;
  if (scope && scope !== 'global') return `scope:${scope}`;
  if (source && source !== 'unknown') return `source:${source}`;
  if (tokens.length > 0) return `topic:${tokens.slice(0, 2).join('+')}`;
  return `category:${entry.category}`;
}

function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let hits = 0;
  for (const token of b) {
    if (setA.has(token) || a.some(left => left.includes(token) || token.includes(left))) hits++;
  }
  return hits / Math.max(a.length, b.length);
}

function buildClusterLabel(key: string, tokens: string[]): string {
  if (key.startsWith('task:')) return key.replace(/^task:/, 'task ');
  if (key.startsWith('scope:')) return key.replace(/^scope:/, 'scope ');
  if (key.startsWith('source:')) return key.replace(/^source:/, '');
  if (key.startsWith('topic:')) return key.replace(/^topic:/, '');
  return tokens.slice(0, 3).join(' / ') || key;
}

export function getMemoryAtlasStatus(): Record<string, unknown> | null {
  if (!existsSync(ATLAS_FILE)) return null;
  try { return JSON.parse(readFileSync(ATLAS_FILE, 'utf8')); } catch { return null; }
}

export function getAtlasHintsForQuery(
  query: string,
  atlas = getMemoryAtlasStatus()
): { clusterKeys: string[]; anchorIds: string[]; summary: string[] } {
  if (!atlas || !query) return { clusterKeys: [], anchorIds: [], summary: [] };
  const queryTokens = tokenize(query);
  const clusters = Array.isArray(atlas.clusters) ? atlas.clusters : [];
  const ranked = clusters
    .map((cluster: any) => ({
      cluster,
      score: overlapRatio(queryTokens, Array.isArray(cluster.topTokens) ? cluster.topTokens : []),
    }))
    .filter((e: any) => e.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 2);

  return {
    clusterKeys: ranked.map((e: any) => String(e.cluster.key)),
    anchorIds: [...new Set(ranked.flatMap((e: any) => Array.isArray(e.cluster.anchorIds) ? e.cluster.anchorIds.slice(0, 6) : []))],
    summary: ranked.map((e: any) => `${e.cluster.label} (${e.cluster.count})`),
  };
}

export async function refreshMemoryAtlas(store: MemoryStore, limit = 400): Promise<Record<string, unknown>> {
  const entries = await store.list(undefined, undefined, limit, 0);
  const categories = new Map<string, number>();
  const sources = new Map<string, number>();
  const anchors: AtlasAnchor[] = [];
  const clusterMap = new Map<string, {
    key: string; label: string;
    categories: Map<string, number>; sources: Map<string, number>;
    anchorIds: string[]; tokens: Map<string, number>; lastSeen: number;
  }>();

  for (const entry of entries) {
    if (isNoise(entry.text) || isOperationalRecap(entry.text)) continue;
    const metadata = parseMetadata(entry);
    const source = String(metadata.source || 'unknown');
    categories.set(entry.category, (categories.get(entry.category) || 0) + 1);
    sources.set(source, (sources.get(source) || 0) + 1);
    const entryTokens = tokenize(entry.text);
    const clusterKey = pickClusterKey(entry, source, entryTokens);
    const quality = qualityScore(entry, source);

    anchors.push({
      id: entry.id, category: entry.category, source, importance: entry.importance,
      timestamp: entry.timestamp, preview: compact(entry.text),
      tokens: entryTokens, quality, clusterKey,
    });

    let cluster = clusterMap.get(clusterKey);
    if (!cluster) {
      cluster = {
        key: clusterKey, label: buildClusterLabel(clusterKey, entryTokens),
        categories: new Map(), sources: new Map(),
        anchorIds: [], tokens: new Map(), lastSeen: entry.timestamp,
      };
      clusterMap.set(clusterKey, cluster);
    }
    cluster.categories.set(entry.category, (cluster.categories.get(entry.category) || 0) + 1);
    cluster.sources.set(source, (cluster.sources.get(source) || 0) + 1);
    cluster.anchorIds.push(entry.id);
    cluster.lastSeen = Math.max(cluster.lastSeen, entry.timestamp);
    for (const token of entryTokens.slice(0, 8)) {
      cluster.tokens.set(token, (cluster.tokens.get(token) || 0) + 1);
    }
  }

  anchors.sort((a, b) => (b.quality - a.quality) || (b.importance - a.importance));
  const clusters: AtlasCluster[] = [...clusterMap.values()]
    .map(cluster => ({
      key: cluster.key,
      label: cluster.label,
      count: cluster.anchorIds.length,
      categories: Object.fromEntries(cluster.categories),
      sources: Object.fromEntries(cluster.sources),
      anchorIds: cluster.anchorIds.slice(0, 12),
      topTokens: [...cluster.tokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t),
      lastSeen: cluster.lastSeen,
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, 20);

  const edges: AtlasEdge[] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      const tokenOverlap = overlapRatio(a.topTokens, b.topTokens);
      const sharedSource = Object.keys(a.sources).find(s => s in b.sources);
      const weight = tokenOverlap + (sharedSource ? 0.1 : 0);
      if (weight >= 0.18) {
        edges.push({
          from: a.key, to: b.key,
          weight: Number(weight.toFixed(2)),
          reason: sharedSource ? `token+source:${sharedSource}` : 'token-overlap',
        });
      }
    }
  }
  edges.sort((a, b) => b.weight - a.weight);

  const atlas = {
    generatedAt: new Date().toISOString(),
    totalIndexed: anchors.length,
    categories: Object.fromEntries(categories),
    sources: Object.fromEntries(sources),
    anchors: anchors.slice(0, 50),
    clusters,
    edges: edges.slice(0, 40),
  };
  ensureDir(ATLAS_FILE);
  writeFileSync(ATLAS_FILE, JSON.stringify(atlas, null, 2), 'utf8');
  return atlas;
}
