import OpenAI from 'openai';
import { config } from '../../config.js';

export class OpenAIService {
  private readonly client: OpenAI | null;

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
    const contextText = contextLines.length
      ? `\nContext:\n${contextLines.join('\n')}`
      : '';

    const response = await this.client.responses.create({
      model: config.openAiModel,
      input: [
        {
          role: 'system',
          content: 'You are Vico AI, a personal assistant operating via WhatsApp. You must clearly identify that you are AI-generated. Never pretend to be the human user.',
        },
        {
          role: 'user',
          content: `${input.message}${contextText}`,
        },
      ],
    });

    return {
      provider: 'openai',
      content: response.output_text ?? 'I could not generate a response right now.',
      raw: response,
    };
  }
}
