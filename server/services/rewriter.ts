// ABOUTME: LLM 语气归一化：消息广播前抹平口头禅、标点习惯、固定句式与情绪痕迹，
// 降低"写作风格指纹"导致的去匿名化风险。支持 OpenAI 兼容接口与本地 Ollama，可开关。
import type { AppConfig } from '../config';

export interface RewriteResult {
  text: string;
  rewritten: boolean;
  reason?: string;
}

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
  constructor(private readonly config: AppConfig['llm']) {}

  /** 改写功能总开关（与是否配置 LLM provider 无关）。 */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** 是否配置了真实 LLM provider；未配置时走确定性本地归一化。 */
  hasProvider(): boolean {
    return this.config.provider !== 'off';
  }

  async normalize(text: string): Promise<RewriteResult> {
    const trimmed = text.trim();
    if (!this.isEnabled()) return { text: trimmed, rewritten: false };

    // 未配置 LLM：使用确定性规则归一化（折叠重复标点/波浪线/空白等机械指纹）。
    // 它无法改写句式与口头禅，但仍能消除最容易被利用的标点习惯，保证开关始终有效。
    if (!this.hasProvider()) {
      const local = localNormalize(trimmed);
      return { text: local, rewritten: local !== trimmed, reason: 'local_rules' };
    }

    try {
      const raw =
        this.config.provider === 'ollama'
          ? await this.callOllama(trimmed)
          : await this.callOpenAiCompatible(trimmed);
      const normalized = this.sanitize(raw, trimmed);
      return { text: normalized, rewritten: normalized !== trimmed };
    } catch (err) {
      console.error('[rewriter] normalization failed:', (err as Error).message);
      if (this.config.onFailure === 'reject') {
        throw new RewriteFailedError((err as Error).message);
      }
      // 默认降级：放行原文，保证可用性
      return { text: trimmed, rewritten: false, reason: 'provider_unavailable_passthrough' };
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

  private async callOpenAiCompatible(input: string): Promise<string> {
    if (!this.config.openaiApiKey && !/localhost|127\.0\.0\.1/.test(this.config.openaiBaseUrl)) {
      throw new Error('LLM_OPENAI_API_KEY is not configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.openaiApiKey ? { Authorization: `Bearer ${this.config.openaiApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.openaiModel,
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
      };
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  private async callOllama(input: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.ollamaModel,
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
      const data = (await response.json()) as { message?: { content?: string } };
      return data.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
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
  text = text.replace(/([？?！!。.…])[？?！!。.～~…]+/g, '$1');
  return text.trim();
}

export class RewriteFailedError extends Error {
  constructor(message: string) {
    super(`语气归一化服务暂不可用：${message}`);
    this.name = 'RewriteFailedError';
  }
}
