import { ChatOpenAI } from '@langchain/openai';

export function getAiMode() {
  return process.env.AI_MODE || (process.env.OPENAI_API_KEY ? 'openai' : 'free');
}

export function isAiEnabled() {
  const mode = getAiMode();
  return mode === 'ollama' || (mode === 'openai' && Boolean(process.env.OPENAI_API_KEY));
}

export function createChatModel({ temperature = 0 } = {}) {
  const mode = getAiMode();
  if (mode === 'ollama') {
    return new ChatOpenAI({
      model: process.env.OLLAMA_MODEL || 'llama3.2', apiKey: 'ollama-local', temperature, maxRetries: 0, timeout: 180_000,
      configuration: { baseURL: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '') }
    });
  }
  if (mode === 'openai' && process.env.OPENAI_API_KEY) {
    const config = { model: process.env.OPENAI_MODEL || 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY, temperature, maxRetries: 2, timeout: 90_000 };
    if (/gpt-oss|o\d|reason/i.test(config.model)) {
      config.maxTokens = Number(process.env.OPENAI_MAX_TOKENS || 8192);
      config.modelKwargs = { reasoning_effort: process.env.OPENAI_REASONING_EFFORT || 'low' };
    }
    if (process.env.OPENAI_BASE_URL) config.configuration = { baseURL: process.env.OPENAI_BASE_URL.replace(/\/$/, '') };
    return withRateLimitRetry(new ChatOpenAI({ ...config, maxRetries: 0 }));
  }
  throw new Error('AI is not configured (set AI_MODE and OPENAI_API_KEY, or AI_MODE=ollama).');
}

// Free tiers (e.g. Groq 8k tokens/min) answer bursts with 429 "try again in Xs": wait and retry.
function withRateLimitRetry(model, attempts = 6) {
  const invoke = model.invoke.bind(model);
  model.invoke = async (input, options) => {
    for (let i = 1; ; i++) {
      try {
        return await invoke(input, options);
      } catch (error) {
        const msg = String(error?.message || '');
        if (i >= attempts || !(error?.status === 429 || /\b429\b|rate limit/i.test(msg))) throw error;
        const hinted = Number(msg.match(/try again in ([\d.]+)s/i)?.[1]);
        await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(hinted) ? hinted * 1000 + 1000 : 15_000, 60_000)));
      }
    }
  };
  return model;
}

export const textOf = (response) => (typeof response.content === 'string' ? response.content : response.content.map((x) => x.text || '').join(''));
