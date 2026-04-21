/**
 * Auto Capture Module v2
 *
 * 两级捕获策略：
 * 1. 关键词快速匹配（零延迟，不调用 LLM）
 * 2. LLM 智能分析（用 SiliconFlow 上的轻量模型，~200 token/次）
 *
 * LLM 分析只在关键词未命中时触发，避免无意义开销。
 */

import type { MemoryStore } from './store.js';
import type { Embedder } from './embedder.js';
import { summarizeContextualMemory } from './memory-cleaner.js';

// ============================================================================
// Types
// ============================================================================

export interface CaptureConfig {
  enabled: boolean;
  llmEnabled: boolean;
  patterns: {
    task: string[];
    rule: string[];
    decision: string[];
    correction: string[];
    preference: string[];
    context: string[];
  };
  importance: {
    task: number;
    rule: number;
    decision: number;
    correction: number;
    preference: number;
    context: number;
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

// ============================================================================
// LLM 智能分析
// ============================================================================

const CAPTURE_ANALYSIS_PROMPT = `你是记忆分析器。分析用户输入，判断是否包含值得长期记住的信息。

只输出 JSON，不要解释：
- 如果值得记住：{"capture":true,"type":"preference|fact|decision|entity|context","importance":0.5-1.0,"summary":"一句话摘要（最多100字）"}
- 如果不值得：{"capture":false}

判断标准：
- preference: 用户偏好、习惯、风格要求
- fact: 规则、约束、技术事实、项目信息
- decision: 明确的决定、选择、方案确认
- entity: 人名、项目名、服务名及其属性
- context: 对话中产生的技术结论、排查发现、错误原因定位、功能当前状态、尝试过但失败的方案
- 不记：纯闲聊、问候、重复查询相同结果

用户输入：`;

interface LLMCaptureResult {
  capture: boolean;
  type?: string;
  importance?: number;
  summary?: string;
}

async function llmAnalyze(
  text: string,
  apiKey: string,
  baseURL: string,
  model: string
): Promise<LLMCaptureResult | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是记忆分析器，只输出 JSON。' },
          { role: 'user', content: CAPTURE_ANALYSIS_PROMPT + text.slice(0, 500) },
        ],
        temperature: 0.1,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as any;
    const content = (data?.choices?.[0]?.message?.content || '').trim();

    // 提取 JSON（兼容 markdown code block）
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as LLMCaptureResult;
  } catch {
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isCaptureNoise(content: string, source?: string): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (source === 'before_agent_start' || source === 'session_start') return true;
  if (/^Current time:/i.test(normalized)) return true;
  if (/^Relevant memory:/i.test(normalized)) return true;
  if (/\[Internal task completion event\]/i.test(normalized)) return true;
  // 太短的内容不值得分析
  if (normalized.length < 10) return true;
  return false;
}

function normalizeMemoryCategory(category?: string): MemoryCategory {
  switch ((category || '').toLowerCase()) {
    case 'preference': return 'preference';
    case 'decision': return 'decision';
    case 'entity': return 'entity';
    case 'task': case 'rule': case 'correction': case 'fact': return 'fact';
    case 'context': return 'other';
    default: return 'other';
  }
}

function buildCaptureText(content: string, context?: CaptureContext): string {
  return summarizeContextualMemory(content, {
    recentContext: Array.isArray(context?.recentContext) ? context.recentContext : [],
    maxChars: 520,
  });
}

// ============================================================================
// Engine
// ============================================================================

export class AutoCaptureEngine {
  private store: MemoryStore;
  private embedder: Embedder;
  private config: CaptureConfig;
  private context: CaptureContext = { sessionId: 'unknown', scope: 'global' };

  // LLM 配置（从环境变量读取）
  private llmApiKey: string;
  private llmBaseURL: string;
  private llmModel: string;

  constructor(store: MemoryStore, embedder: Embedder, config?: Partial<CaptureConfig>) {
    const defaultConfig: CaptureConfig = {
      enabled: true,
      llmEnabled: true,
      patterns: {
        task: ['帮我', '帮我做', 'task', '任务', '做一下', '处理一下'],
        rule: ['必须', '禁止', '以后都', '记住', 'always', 'never', 'must'],
        decision: ['好', '可以', '用这个', '确定', 'ok', 'yes', 'use this'],
        correction: ['不对', '错了', '应该是', '不是', 'wrong', 'should be'],
        preference: ['我喜欢', '我偏好', 'i prefer', 'i like'],
        context: ['发现原因', '排查出', '根本原因', '解决了', '失败了', '不可行', '结论是', '目前状态', '当前进度', '尝试过', '报错是', '问题在于'],
      },
      importance: { task: 0.9, rule: 1.0, decision: 0.8, correction: 0.95, preference: 0.7, context: 0.7 },
    };
    this.config = {
      ...defaultConfig,
      ...config,
      patterns: { ...defaultConfig.patterns, ...(config?.patterns || {}) },
      importance: { ...defaultConfig.importance, ...(config?.importance || {}) },
    };
    this.store = store;
    this.embedder = embedder;

    // LLM 配置：复用 embedding API key，单独指定 chat model
    this.llmApiKey = process.env.CAPTURE_API_KEY || process.env.EMBEDDING_API_KEY || '';
    this.llmBaseURL = process.env.CAPTURE_BASE_URL || process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
    this.llmModel = process.env.CAPTURE_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

    if (!this.llmApiKey) {
      this.config.llmEnabled = false;
    }
  }

  async capture(
    content: string,
    category?: string,
    importance?: number,
    overrides?: CaptureContext
  ): Promise<{ type: string; importance: number; llmUsed: boolean } | null> {
    if (!this.config.enabled || !content?.trim()) return null;
    const normalizedContent = content.trim().slice(0, 5000);
    if (isCaptureNoise(normalizedContent, overrides?.source || this.context.source)) return null;

    const lower = normalizedContent.toLowerCase();
    const effectiveContext = { ...this.context, ...(overrides || {}) };
    const scope = effectiveContext.scope || 'global';

    const buildMetadata = (captureKind: string, llmUsed: boolean) => JSON.stringify({
      sessionId: effectiveContext.sessionId || 'unknown',
      taskId: effectiveContext.taskId || null,
      source: effectiveContext.source || 'auto-capture',
      actorRole: effectiveContext.actorRole || 'main',
      captureKind,
      llmUsed,
      capturedAt: new Date().toISOString(),
    });

    // 路径 1：强制指定 category
    if (category) {
      const imp = importance || this.config.importance[category as keyof typeof this.config.importance] || 0.5;
      const memoryText = buildCaptureText(normalizedContent, effectiveContext);
      const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
      await this.store.store({ text: memoryText.slice(0, 500), vector, category: normalizeMemoryCategory(category), importance: imp, scope, metadata: buildMetadata(category, false) });
      return { type: category, importance: imp, llmUsed: false };
    }

    // 路径 2：关键词快速匹配
    for (const [type, patterns] of Object.entries(this.config.patterns)) {
      for (const pattern of patterns) {
        if (lower.includes(pattern.toLowerCase())) {
          const imp = this.config.importance[type as keyof typeof this.config.importance] || 0.5;
          const memoryText = buildCaptureText(normalizedContent, effectiveContext);
          const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
          await this.store.store({ text: memoryText.slice(0, 500), vector, category: normalizeMemoryCategory(type), importance: imp, scope, metadata: buildMetadata(type, false) });
          return { type, importance: imp, llmUsed: false };
        }
      }
    }

    // 路径 3：LLM 智能分析（关键词未命中时）
    if (this.config.llmEnabled && normalizedContent.length >= 20) {
      const analysis = await llmAnalyze(normalizedContent, this.llmApiKey, this.llmBaseURL, this.llmModel);
      if (analysis?.capture && analysis.type && analysis.summary) {
        const imp = analysis.importance ?? 0.7;
        const memoryText = analysis.summary.slice(0, 500);
        const vector = await this.embedder.embedPassage(memoryText);
        await this.store.store({
          text: memoryText, vector,
          category: normalizeMemoryCategory(analysis.type),
          importance: imp, scope,
          metadata: buildMetadata(`llm:${analysis.type}`, true),
        });
        return { type: analysis.type, importance: imp, llmUsed: true };
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

  get isLLMEnabled(): boolean {
    return this.config.llmEnabled;
  }

  get captureModel(): string {
    return this.llmModel;
  }
}

export default AutoCaptureEngine;
