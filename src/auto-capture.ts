/**
 * Auto Capture Module
 * Automatically detects and stores important content via keyword matching.
 */

import type { MemoryStore } from './store.js';
import type { Embedder } from './embedder.js';
import { summarizeContextualMemory } from './memory-cleaner.js';

export interface CaptureConfig {
  enabled: boolean;
  patterns: {
    task: string[];
    rule: string[];
    decision: string[];
    correction: string[];
    preference: string[];
  };
  importance: {
    task: number;
    rule: number;
    decision: number;
    correction: number;
    preference: number;
  };
}

export interface CaptureContext {
  sessionId?: string;
  taskId?: string;
  source?: string;
  actorRole?: string;
  scope?: string;
  metadata?: Record<string, unknown>;
  recentContext?: string[];
}

type MemoryCategory = 'preference' | 'fact' | 'decision' | 'entity' | 'other';

function isCaptureNoise(content: string, source?: string): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (source === 'before_agent_start' || source === 'session_start') return true;
  if (/^Current time:/i.test(normalized)) return true;
  if (/^Relevant memory:/i.test(normalized)) return true;
  if (/\[Internal task completion event\]/i.test(normalized)) return true;
  return false;
}

function normalizeMemoryCategory(category?: string): MemoryCategory {
  switch ((category || '').toLowerCase()) {
    case 'preference': return 'preference';
    case 'decision': return 'decision';
    case 'entity': return 'entity';
    case 'task': case 'rule': case 'correction': case 'fact': return 'fact';
    default: return 'other';
  }
}

function buildCaptureText(content: string, context?: CaptureContext): string {
  return summarizeContextualMemory(content, {
    recentContext: Array.isArray(context?.recentContext) ? context.recentContext : [],
    maxChars: 520,
  });
}

export class AutoCaptureEngine {
  private store: MemoryStore;
  private embedder: Embedder;
  private config: CaptureConfig;
  private context: CaptureContext = { sessionId: 'unknown', scope: 'global' };

  constructor(store: MemoryStore, embedder: Embedder, config?: Partial<CaptureConfig>) {
    const defaultConfig: CaptureConfig = {
      enabled: true,
      patterns: {
        task: ['帮我', '帮我做', 'task', '任务', '做一下', '处理一下'],
        rule: ['必须', '禁止', '以后都', '记住', 'always', 'never', 'must'],
        decision: ['好', '可以', '用这个', '确定', 'ok', 'yes', 'use this'],
        correction: ['不对', '错了', '应该是', '不是', 'wrong', 'should be'],
        preference: ['我喜欢', '我偏好', 'i prefer', 'i like'],
      },
      importance: { task: 0.9, rule: 1.0, decision: 0.8, correction: 0.95, preference: 0.7 },
    };
    this.config = {
      ...defaultConfig,
      ...config,
      patterns: { ...defaultConfig.patterns, ...(config?.patterns || {}) },
      importance: { ...defaultConfig.importance, ...(config?.importance || {}) },
    };
    this.store = store;
    this.embedder = embedder;
  }

  async capture(
    content: string,
    category?: string,
    importance?: number,
    overrides?: CaptureContext
  ): Promise<{ type: string; importance: number } | null> {
    if (!this.config.enabled || !content?.trim()) return null;
    const normalizedContent = content.trim().slice(0, 5000);
    if (isCaptureNoise(normalizedContent, overrides?.source || this.context.source)) return null;

    const lower = normalizedContent.toLowerCase();
    const effectiveContext = { ...this.context, ...(overrides || {}) };
    const memoryText = buildCaptureText(normalizedContent, effectiveContext);
    const scope = effectiveContext.scope || 'global';

    const buildMetadata = (captureKind: string) => JSON.stringify({
      sessionId: effectiveContext.sessionId || 'unknown',
      taskId: effectiveContext.taskId || null,
      source: effectiveContext.source || 'auto-capture',
      actorRole: effectiveContext.actorRole || 'main',
      captureKind,
      capturedAt: new Date().toISOString(),
    });

    if (category) {
      const imp = importance || this.config.importance[category as keyof typeof this.config.importance] || 0.5;
      const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
      await this.store.store({ text: memoryText.slice(0, 500), vector, category: normalizeMemoryCategory(category), importance: imp, scope, metadata: buildMetadata(category) });
      return { type: category, importance: imp };
    }

    for (const [type, patterns] of Object.entries(this.config.patterns)) {
      for (const pattern of patterns) {
        if (lower.includes(pattern.toLowerCase())) {
          const imp = this.config.importance[type as keyof typeof this.config.importance] || 0.5;
          const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
          await this.store.store({ text: memoryText.slice(0, 500), vector, category: normalizeMemoryCategory(type), importance: imp, scope, metadata: buildMetadata(type) });
          return { type, importance: imp };
        }
      }
    }
    return null;
  }

  analyze(content: string): { type: string; importance: number } | null {
    if (!content) return null;
    const lower = content.toLowerCase();
    for (const [type, patterns] of Object.entries(this.config.patterns)) {
      for (const pattern of patterns) {
        if (lower.includes(pattern.toLowerCase())) {
          return { type, importance: this.config.importance[type as keyof typeof this.config.importance] || 0.5 };
        }
      }
    }
    return null;
  }

  setContext(context: CaptureContext): void {
    this.context = { ...this.context, ...context };
  }
}

export default AutoCaptureEngine;
