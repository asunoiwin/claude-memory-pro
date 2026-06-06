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
import { metadataWithFactKey } from './knowledge-graph.js';

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

type MemoryCategory = 'preference' | 'fact' | 'decision' | 'entity' | 'other' | 'task' | 'lesson';

// ============================================================================
// LLM 智能分析
// ============================================================================

const CAPTURE_ANALYSIS_PROMPT = `你是记忆分析器。分析用户输入，判断是否包含值得长期记住的信息。

只输出 JSON，不要解释：
- 值得记住：{"capture":true,"type":"preference|fact|decision|entity|context","importance":0.5-1.0,"summary":"一句话摘要（最多100字）"}
- 不值得 / 应走专用工具：{"capture":false,"reason":"chat|task|lesson|other"}

判断标准：
- preference: 用户偏好、习惯、风格要求
- fact: 规则、约束、技术事实、项目信息
- decision: 明确的决定、选择、方案确认
- entity: 人名、项目名、服务名及其属性
- context: 对话中产生的技术结论、排查发现、错误原因定位、功能当前状态、尝试过但失败的方案
- 不记 reason="chat": 纯闲聊、问候、重复查询相同结果
- 不记 reason="task": 跨会话进行中工作、待办事项（应由调用方走 task_create，不能塞进 memory）
- 不记 reason="lesson": 踩坑教训、反模式、避坑经验（应由调用方走 lesson_capture，不能塞进 memory）

用户输入：`;

interface LLMCaptureResult {
  capture: boolean;
  type?: string;
  importance?: number;
  summary?: string;
  reason?: string;
}

export interface LLMJsonRequest {
  apiKey: string;
  baseURL: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CaptureRedirect {
  kind: 'redirect';
  redirect: 'task_create' | 'lesson_capture';
  hint: string;
}

export interface CaptureStored {
  kind: 'stored';
  type: string;
  importance: number;
  llmUsed: boolean;
}

export type CaptureResult = CaptureStored | CaptureRedirect;

export async function llmJsonAnalyze<T = Record<string, unknown>>({
  apiKey,
  baseURL,
  model,
  systemPrompt,
  userPrompt,
  maxTokens = 2048,
  timeoutMs = 20000,
}: LLMJsonRequest): Promise<T | null> {
  if (!apiKey) return null;
  // 失败不再静默吞掉：记录原因 + 对瞬时失败（超时/5xx/429/空content）重试一次（GLM 思考型偶发不收敛）
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timeout: NodeJS.Timeout | null = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        lastReason = `http_${response.status}`;
        if (response.status >= 500 || response.status === 429) continue; // 可重试
        break; // 4xx 等不可重试
      }

      const data = await response.json() as any;
      const finish = data?.choices?.[0]?.finish_reason;
      const content = (data?.choices?.[0]?.message?.content || '').trim();
      if (!content) { lastReason = `empty_content(finish=${finish})`; continue; } // 思考吃光预算，重试

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { lastReason = 'no_json'; continue; }

      try { return JSON.parse(jsonMatch[0]) as T; }
      catch { lastReason = 'json_parse_error'; continue; }
    } catch (e: any) {
      lastReason = e?.name === 'AbortError' ? `timeout(${timeoutMs}ms)` : `fetch_error:${e?.message || e}`;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  console.error(`[claude-memory-pro] llmJsonAnalyze 失败(${model}): ${lastReason}`);
  return null;
}

async function llmAnalyze(
  text: string,
  apiKey: string,
  baseURL: string,
  model: string
): Promise<LLMCaptureResult | null> {
  return llmJsonAnalyze<LLMCaptureResult>({
    apiKey,
    baseURL,
    model,
    systemPrompt: '你是记忆分析器，只输出 JSON。',
    userPrompt: CAPTURE_ANALYSIS_PROMPT + text.slice(0, 500),
  });
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
    case 'rule': case 'correction': case 'fact': return 'fact';
    case 'context': return 'other';
    // task / lesson 是结构化维度（需 subject/project 或 pitfall/solution/triggerKeywords），
    // 不能从无结构内容路由进来；若强行传入，降级为 other 并依赖元数据标记。
    case 'task': case 'lesson': return 'other';
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
    this.llmBaseURL = process.env.CAPTURE_BASE_URL || process.env.EMBEDDING_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    this.llmModel = process.env.CAPTURE_MODEL || 'glm-4.5-flash';

    if (!this.llmApiKey) {
      this.config.llmEnabled = false;
    }
  }

  async capture(
    content: string,
    category?: string,
    importance?: number,
    overrides?: CaptureContext
  ): Promise<CaptureResult | null> {
    if (!this.config.enabled || !content?.trim()) return null;
    const normalizedContent = content.trim().slice(0, 5000);

    // 三维边界硬隔离：task/lesson 必须走专用工具，先于噪音过滤判定，避免噪音文本配
    // category=task/lesson 被静默丢弃而看不到 redirect 提示
    if (category === 'task') {
      return { kind: 'redirect', redirect: 'task_create', hint: 'task 内容不进 memory，请改用 task_create(subject, project, status)' };
    }
    if (category === 'lesson') {
      return { kind: 'redirect', redirect: 'lesson_capture', hint: 'lesson 内容不进 memory，请改用 lesson_capture(pitfall, solution, triggerKeywords, project)' };
    }

    if (isCaptureNoise(normalizedContent, overrides?.source || this.context.source)) return null;

    const lower = normalizedContent.toLowerCase();
    const effectiveContext = { ...this.context, ...(overrides || {}) };
    const scope = effectiveContext.scope || 'global';

    const buildMetadata = (captureKind: string, llmUsed: boolean, textForKey: string, memoryCategory: MemoryCategory) => JSON.stringify(metadataWithFactKey({
      text: textForKey,
      category: memoryCategory,
      scope,
      metadata: JSON.stringify({
        sessionId: effectiveContext.sessionId || 'unknown',
        taskId: effectiveContext.taskId || null,
        source: effectiveContext.source || 'auto-capture',
        actorRole: effectiveContext.actorRole || 'main',
        captureKind,
        llmUsed,
        capturedAt: new Date().toISOString(),
      }),
    }));

    // 路径 1：强制指定 category
    if (category) {
      const imp = importance || this.config.importance[category as keyof typeof this.config.importance] || 0.5;
      const memoryText = buildCaptureText(normalizedContent, effectiveContext);
      const memoryCategory = normalizeMemoryCategory(category);
      try {
        const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
        await this.store.store({ text: memoryText.slice(0, 5000), vector, category: memoryCategory, importance: imp, scope, metadata: buildMetadata(category, false, memoryText, memoryCategory) });
        return { kind: 'stored', type: category, importance: imp, llmUsed: false };
      } catch (err) {
        console.error(`[claude-memory-pro] 自动捕获写库失败(${category}): ${err instanceof Error ? err.message : err}`);
        return null;
      }
    }

    // 路径 2：关键词快速匹配
    for (const [type, patterns] of Object.entries(this.config.patterns)) {
      for (const pattern of patterns) {
        if (lower.includes(pattern.toLowerCase())) {
          const imp = this.config.importance[type as keyof typeof this.config.importance] || 0.5;
          const memoryText = buildCaptureText(normalizedContent, effectiveContext);
          const memoryCategory = normalizeMemoryCategory(type);
          try {
            const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
            await this.store.store({ text: memoryText.slice(0, 5000), vector, category: memoryCategory, importance: imp, scope, metadata: buildMetadata(type, false, memoryText, memoryCategory) });
            return { kind: 'stored', type, importance: imp, llmUsed: false };
          } catch (err) {
            console.error(`[claude-memory-pro] 自动捕获写库失败(${type}): ${err instanceof Error ? err.message : err}`);
            return null;
          }
        }
      }
    }

    // 路径 3：LLM 智能分析（关键词未命中时）
    if (this.config.llmEnabled && normalizedContent.length >= 20) {
      const analysis = await llmAnalyze(normalizedContent, this.llmApiKey, this.llmBaseURL, this.llmModel);
      // LLM 判定是 task/lesson 语义 → 回传 redirect 而非静默丢弃
      if (analysis && !analysis.capture && (analysis.reason === 'task' || analysis.reason === 'lesson')) {
        const redirect = analysis.reason === 'task' ? 'task_create' : 'lesson_capture';
        const hint = analysis.reason === 'task'
          ? 'LLM 判定为任务语义，请改用 task_create(subject, project, status)'
          : 'LLM 判定为教训语义，请改用 lesson_capture(pitfall, solution, triggerKeywords, project)';
        return { kind: 'redirect', redirect, hint };
      }
      if (analysis?.capture && analysis.type && analysis.summary) {
        const imp = analysis.importance ?? 0.7;
        const memoryText = analysis.summary.slice(0, 5000);
        const memoryCategory = normalizeMemoryCategory(analysis.type);
        try {
          const vector = await this.embedder.embedPassage(memoryText.slice(0, 500));
          await this.store.store({
            text: memoryText, vector,
            category: memoryCategory,
            importance: imp, scope,
            metadata: buildMetadata(`llm:${analysis.type}`, true, memoryText, memoryCategory),
          });
          return { kind: 'stored', type: analysis.type, importance: imp, llmUsed: true };
        } catch (err) {
          console.error(`[claude-memory-pro] 自动捕获写库失败(llm:${analysis.type}): ${err instanceof Error ? err.message : err}`);
          return null;
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

  get isLLMEnabled(): boolean {
    return this.config.llmEnabled;
  }

  get captureModel(): string {
    return this.llmModel;
  }
}

export default AutoCaptureEngine;
