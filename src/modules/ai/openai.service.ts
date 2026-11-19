import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { config } from '../../config.js';

const RESPONSE_CACHE_TTL_MS = 60_000;
const RESPONSE_CACHE_MAX_ENTRIES = 256;
const SYSTEM_PROMPT =
  'You are Vico AI, a personal assistant operating via WhatsApp. You must clearly identify that you are AI-generated. Never pretend to be the human user.';

export class OpenAIService {
  private readonly client: OpenAI | null;
  private readonly responseCache = new Map<
    string,
    { content: string; expiresAt: number }
  >();
  private readonly inFlightRequests = new Map<string, Promise<string>>();

  constructor() {
    this.client = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null;
  }

  async generateReply(input: { userId: string; message: string; context?: string[] }) {
    if (!this.client) {
      return {
        provider: 'fallback',
        content: `I’m ready to help, ${input.userId}. I can process: "${input.message}" once your OpenAI API key is configured.`,
      };
    }

    const contextLines = input.context ?? [];
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify([
          config.openAiModel,
          SYSTEM_PROMPT,
          input.userId,
          input.message,
          contextLines,
        ]),
      )
      .digest('hex');
    const cached = this.responseCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      this.responseCache.delete(cacheKey);
      this.responseCache.set(cacheKey, cached);
      return { provider: 'openai', content: cached.content };
    }

    if (cached) {
      this.responseCache.delete(cacheKey);
    }

    let responsePromise = this.inFlightRequests.get(cacheKey);
    if (!responsePromise) {
      responsePromise = this.requestReply(this.client, input, contextLines, cacheKey);
      this.inFlightRequests.set(cacheKey, responsePromise);
    }

    try {
      return { provider: 'openai', content: await responsePromise };
    } finally {
      if (this.inFlightRequests.get(cacheKey) === responsePromise) {
        this.inFlightRequests.delete(cacheKey);
      }
    }
  }

  private async requestReply(
    client: OpenAI,
    input: { userId: string; message: string; context?: string[] },
    contextLines: string[],
    cacheKey: string,
  ) {
    const contextText = contextLines.length
      ? `\nContext:\n${contextLines.join('\n')}`
      : '';

    const response = await client.responses.create({
      model: config.openAiModel,
      input: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: `${input.message}${contextText}`,
        },
      ],
    });

    const content = response.output_text;
    if (content) {
      this.responseCache.set(cacheKey, {
        content,
        expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
      });

      if (this.responseCache.size > RESPONSE_CACHE_MAX_ENTRIES) {
        const oldestKey = this.responseCache.keys().next().value;
        if (oldestKey) {
          this.responseCache.delete(oldestKey);
        }
      }
    }

    return content ?? 'I could not generate a response right now.';
  }
}
