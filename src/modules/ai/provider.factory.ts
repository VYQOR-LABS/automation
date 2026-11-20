import { config } from '../../config.js';
import { OllamaService } from './ollama.service.js';
import { OpenAIService } from './openai.service.js';
import type { AiProvider, AiProviderSettings } from './provider.js';

export function createAiProvider(
  settings: AiProviderSettings = config,
): AiProvider {
  if (settings.aiProvider === 'ollama') {
    return new OllamaService(settings);
  }

  if (!settings.openAiApiKey.trim()) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai.');
  }

  return new OpenAIService(settings);
}
