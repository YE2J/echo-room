// ABOUTME: LLM 语气归一化：消息广播前抹平口头禅、标点习惯、固定句式与情绪痕迹，
// 降低"写作风格指纹"导致的去匿名化风险。支持 OpenAI 兼容接口、本地 Ollama 与扣子
// 部署智能体（coze，async_run + task 轮询），可开关。
// 每次调用前从 settings 热解析配置（settings > env > 默认），管理后台改配无需重启；
// 每次真实 LLM 调用后向 llm_usage 记一条用量（token 数据来自响应字段，取不到记 NULL，
// 失败同样记一条 ok=false + error 摘要），不编造数据。
import type { AppConfig } from '../config';
import type { DatabaseClient } from '../db';
import { resolveLlmConfig, type ResolvedLlmConfig } from './llm-config';

export interface LlmUsageSample {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface RewriteResult {
  text: string;
  rewritten: boolean;
  reason?: string;
  usage?: LlmUsageSample | null;
}

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  latencyMs: number;
  sample?: string;
  usage?: LlmUsageSample | null;
  error?: string;
}

/** 连通性测试的固定样例：无个人风格、不涉及真实用户内容。 */
export const LLM_TEST_SAMPLE = '这个提议挺不错的，我觉得可以试试看！！！';

/**
 * 扣子编程项目 ID（19 位，超出 Number.MAX_SAFE_INTEGER）。
 * 用 BigInt 保持精确，并在提交时以数字字面量（无引号）序列化进 JSON body。
 */
const COZE_PROJECT_ID = 7697949201044504619n;

const SYSTEM_PROMPT = [
  '你是一个中文匿名通讯系统的文本风格归一化器。任务是改写用户消息以抹除可识别个人身份的写作风格，但完整保留事实、观点与诉求。',
  '规则：',
  '1. 去除口头禅、重复语气词、个人标志性标点（如连续感叹号、波浪号、特殊颜文字）、固定开场白与结尾语；',
  '2. 统一为中性、简洁、书面化的陈述句；不使用方言词汇；',
  '3. 不得增删事实信息、不得改变褒贬立场与诉求、不得脑补；',
  '4. 保持原意，纠正明显错别字；不要润色得过度正式或华丽；',
  '5. 绝不输出解释、前后缀或引号，只输出改写后的正文；',
  '6. 如果原文已经是中性通用表达，原样返回。',
].join('\n');

export class Rewriter {
  constructor(
    private readonly config: AppConfig,
    private readonly db: DatabaseClient,
  ) {}

  /** 改写功能总开关（与是否配置 LLM provider 无关）。 */
  isEnabled(): boolean {
    return this.config.llm.enabled;
  }

  /** 是否配置了真实 LLM provider；未配置时走确定性本地归一化。 */
  hasProvider(): boolean {
    return this.config.llm.provider !== 'off';
  }

  /**
   * 归一化一条消息。每次调用实时解析 settings 中的 LLM 配置（热生效）。
   * 无真实 provider 时走确定性本地规则（不记 usage）。
   */
  async normalize(text: string): Promise<RewriteResult> {
    const llm = await resolveLlmConfig(this.config, this.db);
    const trimmed = text.trim();
    if (!llm.enabled) return { text: trimmed, rewritten: false, usage: null };

    // 未配置 LLM：使用确定性规则归一化（折叠重复标点/波浪线/空白等机械指纹）。
    // 它无法改写句式与口头禅，但仍能消除最容易被利用的标点习惯，保证开关始终有效。
    if (llm.provider === 'off' || !llm.baseUrl) {
      const local = localNormalize(trimmed);
      return { text: local, rewritten: local !== trimmed, reason: 'local_rules', usage: null };
    }

    const startedAt = Date.now();
    try {
      const raw = await this.callProvider(llm, trimmed);
      const latencyMs = Date.now() - startedAt;
      await this.recordUsage(llm, { ok: true, latencyMs, usage: raw.usage });
      const normalized = this.sanitize(raw.text, trimmed);
      return { text: normalized, rewritten: normalized !== trimmed, usage: raw.usage };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      await this.recordUsage(llm, { ok: false, latencyMs, usage: null, error: (err as Error).message });
      if (llm.onFailure === 'reject') {
        throw new RewriteFailedError((err as Error).message);
      }
      // 默认降级：放行原文，保证可用性
      return { text: trimmed, rewritten: false, reason: 'provider_unavailable_passthrough', usage: null };
    }
  }

  /** 连通性测试：用当前生效配置真发一条改写，返回耗时、token 用量与改写样例。失败返回错误摘要。 */
  async runTest(sample: string = LLM_TEST_SAMPLE): Promise<LlmTestResult> {
    const llm = await resolveLlmConfig(this.config, this.db);
    if (llm.provider === 'off' || !llm.baseUrl) {
      return {
        ok: false,
        provider: llm.provider,
        model: llm.model,
        latencyMs: 0,
        error: '未配置 LLM 服务（provider 为 off 或缺少 baseUrl），请先选择模型服务',
      };
    }
    const startedAt = Date.now();
    try {
      const raw = await this.callProvider(llm, sample);
      const latencyMs = Date.now() - startedAt;
      await this.recordUsage(llm, { ok: true, latencyMs, usage: raw.usage });
      return {
        ok: true,
        provider: llm.provider,
        model: llm.model,
        latencyMs,
        sample: this.sanitize(raw.text, sample),
        usage: raw.usage,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      await this.recordUsage(llm, { ok: false, latencyMs, usage: null, error: (err as Error).message });
      return {
        ok: false,
        provider: llm.provider,
        model: llm.model,
        latencyMs,
        error: (err as Error).message,
        usage: null,
      };
    }
  }

  /** 防止模型幻觉导致输出膨胀或夹带解释：超长/为空时回退原文。 */
  private sanitize(output: string, original: string): string {
    let result = output.trim();
    // 去掉模型可能加上的成对引号
    if (
      (result.startsWith('“') && result.endsWith('”')) ||
      (result.startsWith('"') && result.endsWith('"'))
    ) {
      result = result.slice(1, -1).trim();
    }
    if (!result) return original;
    const maxAllowed = Math.max(original.length * 2 + 100, 2000);
    if (result.length > maxAllowed) return original;
    return result;
  }

  /** 按 provider 分发真实模型调用，并附带 token 用量（响应里取不到即为 null）。 */
  private callProvider(
    llm: ResolvedLlmConfig,
    input: string,
  ): Promise<{ text: string; usage: LlmUsageSample | null }> {
    if (llm.provider === 'ollama') return this.callOllama(llm, input);
    if (llm.provider === 'coze') return this.callCoze(llm, input);
    return this.callOpenAiCompatible(llm, input);
  }

  private async callOpenAiCompatible(
    llm: ResolvedLlmConfig,
    input: string,
  ): Promise<{ text: string; usage: LlmUsageSample | null }> {
    if (!llm.apiKey && !/localhost|127\.0\.0\.1/.test(llm.baseUrl ?? '')) {
      throw new Error('LLM API Key is not configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), llm.timeoutMs);
    try {
      const response = await fetch(`${(llm.baseUrl ?? '').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llm.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`openai-compatible provider HTTP ${response.status}: ${detail.slice(0, 200)}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const u = data.usage;
      const usage: LlmUsageSample | null = u
        ? {
            inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
            outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
            totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : null,
          }
        : null;
      return { text: content, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  private async callOllama(
    llm: ResolvedLlmConfig,
    input: string,
  ): Promise<{ text: string; usage: LlmUsageSample | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), llm.timeoutMs);
    try {
      const response = await fetch(`${(llm.baseUrl ?? '').replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          stream: false,
          options: { temperature: 0.2 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`ollama HTTP ${response.status}: ${detail.slice(0, 200)}`);
      }
      const data = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const pe = typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null;
      const ec = typeof data.eval_count === 'number' ? data.eval_count : null;
      return {
        text: data.message?.content ?? '',
        usage: {
          inputTokens: pe,
          outputTokens: ec,
          totalTokens: pe !== null || ec !== null ? (pe ?? 0) + (ec ?? 0) : null,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 扣子部署的「匿名语气改写智能体」：先 POST /async_run 提交异步任务，
   * 再轮询 GET /task/{task_id}，completed 时从 result 取 answer。
   * 提交与轮询整体不超过 timeoutMs；failed/timeout/网络错误抛出，交给 onFailure 处理。
   */
  private async callCoze(
    llm: ResolvedLlmConfig,
    input: string,
  ): Promise<{ text: string; usage: LlmUsageSample | null }> {
    if (!llm.apiKey) {
      throw new Error('coze API Token is not configured');
    }
    const base = (llm.baseUrl ?? '').replace(/\/$/, '');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    } as const;
    const deadline = Date.now() + llm.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), llm.timeoutMs);

    try {
      // 1) 提交异步执行（project_id 为 19 位整数，用占位符替换以保证精度不丢）
      const body = JSON.stringify({
        content: {
          query: { prompt: [{ type: 'text', content: { text: input } }] },
        },
        type: 'query',
        session_id: 'echo-rewrite',
        project_id: '__COZE_PROJECT_ID__',
      }).replace('"__COZE_PROJECT_ID__"', COZE_PROJECT_ID.toString());
      const submitRes = await fetch(`${base}/async_run`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!submitRes.ok) {
        const detail = await submitRes.text().catch(() => '');
        throw new Error(`coze async_run HTTP ${submitRes.status}: ${detail.slice(0, 200)}`);
      }
      const submitted = (await submitRes.json()) as { task_id?: string; code?: number; msg?: string };
      const taskId = submitted.task_id;
      if (!taskId) {
        throw new Error(
          `coze async_run missing task_id${submitted.msg ? `: ${submitted.msg}` : ''}`,
        );
      }

      // 2) 轮询任务结果（每秒一次，总时长不超过 timeoutMs）
      const POLL_INTERVAL_MS = 1000;
      for (;;) {
        if (Date.now() + POLL_INTERVAL_MS > deadline) {
          throw new Error(`coze task ${taskId} timed out after ${llm.timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const pollRes = await fetch(`${base}/task/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: { Authorization: headers.Authorization },
          signal: controller.signal,
        });
        if (!pollRes.ok) {
          const detail = await pollRes.text().catch(() => '');
          throw new Error(`coze task HTTP ${pollRes.status}: ${detail.slice(0, 200)}`);
        }
        const task = (await pollRes.json()) as {
          status?: string;
          result?: unknown;
          code?: number;
          msg?: string;
          error?: string | null;
        };

        const status = (task.status || '').toLowerCase();
        if (status === 'completed' || status === 'success') {
          return this.extractCozeResult(task.result);
        }
        if (status === 'failed' || status === 'error') {
          const reason = task.error || task.msg;
          throw new Error(`coze task failed${reason ? `: ${String(reason).slice(0, 200)}` : ''}`);
        }
        // queued / running / in_progress / pending 等：继续轮询
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 兼容多种扣子智能体任务结果形态：
   *  - 对象：{ answer: string } / { data: string }，或 LangChain 消息结构
   *    { messages: Array<{ type, content, usage_metadata? }> }（取最后一个 type==='ai' 的文本）；
   *  - JSON 字符串：解析后按上述对象规则处理；
   *  - 纯文本：智能体直接返回改写正文。
   * 同时从 messages 中最后一个 ai 消息提取 usage_metadata（input/output/total_tokens）。
   */
  private extractCozeResult(result: unknown): { text: string; usage: LlmUsageSample | null } {
    if (result === undefined || result === null || result === '') {
      throw new Error('coze task completed with empty result');
    }
    if (typeof result === 'string') {
      const trimmed = result.trim();
      // 可能是 JSON 字符串
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return this.extractCozeResult(JSON.parse(trimmed) as unknown);
        } catch {
          // 非法 JSON：按纯文本结果处理
          return { text: trimmed, usage: null };
        }
      }
      return { text: trimmed, usage: null };
    }
    const obj = result as Record<string, unknown>;
    if (typeof obj.answer === 'string' && obj.answer) {
      return { text: obj.answer, usage: this.cozeUsageFromMessages(obj.messages) };
    }
    if (typeof obj.data === 'string' && obj.data) {
      return { text: obj.data, usage: this.cozeUsageFromMessages(obj.messages) };
    }
    const text = extractAiText(obj.messages);
    if (text) return { text, usage: this.cozeUsageFromMessages(obj.messages) };
    throw new Error('coze result has no answer field');
  }

  /** 从 LangChain 风格 messages 中取最后一个 ai 消息的 usage_metadata（取不到返回 null）。 */
  private cozeUsageFromMessages(messages: unknown): LlmUsageSample | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { type?: string; usage_metadata?: unknown };
      if (msg?.type !== 'ai') continue;
      const um = msg.usage_metadata as
        | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
        | undefined;
      if (!um) return null;
      return {
        inputTokens: typeof um.input_tokens === 'number' ? um.input_tokens : null,
        outputTokens: typeof um.output_tokens === 'number' ? um.output_tokens : null,
        totalTokens: typeof um.total_tokens === 'number' ? um.total_tokens : null,
      };
    }
    return null;
  }

  /** 尽力而为的用量落库：任何失败只进服务日志，不打断改写主流程。 */
  private async recordUsage(
    llm: ResolvedLlmConfig,
    row: { ok: boolean; latencyMs: number; usage: LlmUsageSample | null; error?: string },
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO llm_usage (provider, model, input_tokens, output_tokens, total_tokens, latency_ms, ok, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          llm.provider,
          llm.model ?? '',
          row.usage?.inputTokens ?? null,
          row.usage?.outputTokens ?? null,
          row.usage?.totalTokens ?? null,
          row.latencyMs,
          row.ok,
          row.ok ? null : (row.error ?? 'unknown').slice(0, 500),
          Date.now(),
        ],
      );
    } catch (err) {
      console.error('[rewriter] recordUsage failed:', (err as Error).message);
    }
  }
}

/**
 * 从扣子部署返回的 LangChain 风格 messages 数组中提取最后一条 AI 文本。
 * content 可能是字符串，或 [{ type:'text', text:string }, ...] 结构。
 */
function extractAiText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { type?: string; content?: unknown };
    if (msg?.type !== 'ai') continue;
    const content = msg.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      // 拼接同一 AI 消息里的文本块（通常只有一个）
      const text = content
        .map((part) => {
          if (typeof part === 'string') return part;
          const p = part as { type?: string; text?: unknown };
          return p && (p.type === 'text' || p.type === undefined) && typeof p.text === 'string'
            ? p.text
            : '';
        })
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * 确定性本地归一化（无 LLM 时的兜底）：
 * 仅做不改变语义的机械处理，消除最易被利用的标点/空白风格指纹。
 * 1) 折叠连续标点为单个；2) 统一省略号；3) 去除波浪线/颜文字风格的连续符号；
 * 4) 合并多余空白；5) 去掉句末重复语气标点。
 */
export function localNormalize(input: string): string {
  let text = input.replace(/\s+/g, ' ').trim();
  // 连续波浪线 / 多个同类型标点折叠为一个
  text = text.replace(/[~～～]{2,}/g, '～');
  text = text.replace(/！{2,}/g, '！');
  text = text.replace(/!{2,}/g, '!');
  text = text.replace(/？{2,}/g, '？');
  text = text.replace(/\?{2,}/g, '?');
  text = text.replace(/。{2,}/g, '。');
  text = text.replace(/\.{3,}/g, '…');
  text = text.replace(/，{2,}/g, '，');
  text = text.replace(/,{2,}/g, ',');
  // 混合重复的句末标点（如 ？？！！ / ??!）归一为首个标点
  text = text.replace(/([？?！!。.。..…])[？?！!。.～~…]+/g, '$1');
  return text.trim();
}

export class RewriteFailedError extends Error {
  constructor(message: string) {
    super(`语气归一化服务暂不可用：${message}`);
    this.name = 'RewriteFailedError';
  }
}