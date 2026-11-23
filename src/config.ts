import * as dotenv from 'dotenv';
import type { AiProviderSettings } from './modules/ai/provider.js';

dotenv.config();

const appBaseUrl = process.env.APP_BASE_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  'http://localhost:3000';
const configuredPublicBaseUrl = process.env.APP_BASE_URL ?? process.env.RENDER_EXTERNAL_URL;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? (
  configuredPublicBaseUrl
    ? new URL('/google/redirect', configuredPublicBaseUrl).toString()
    : 'http://localhost:3020/google/redirect'
);

function positiveInteger(value: string | undefined, defaultValue: number, name: string) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiProviderSettings {
  const aiProvider = env.AI_PROVIDER ?? 'ollama';
  if (aiProvider !== 'ollama' && aiProvider !== 'openai') {
    throw new Error('AI_PROVIDER must be either "ollama" or "openai".');
  }

  const openAiApiKey = env.OPENAI_API_KEY ?? '';
  const openAiModel = env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const ollamaBaseUrl = env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const ollamaModel = env.OLLAMA_MODEL ?? 'phi3';
  const ollamaNumCtx = aiProvider === 'ollama'
    ? positiveInteger(env.OLLAMA_NUM_CTX, 2048, 'OLLAMA_NUM_CTX')
    : 2048;
  const ollamaNumPredict = aiProvider === 'ollama'
    ? positiveInteger(env.OLLAMA_NUM_PREDICT, 200, 'OLLAMA_NUM_PREDICT')
    : 200;
  const ollamaTimeoutMs = aiProvider === 'ollama'
    ? positiveInteger(env.OLLAMA_TIMEOUT_MS, 120_000, 'OLLAMA_TIMEOUT_MS')
    : 120_000;

  if (aiProvider === 'openai') {
    if (!openAiApiKey.trim()) {
      throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai.');
    }
    if (!openAiModel.trim()) {
      throw new Error('OPENAI_MODEL must not be empty when AI_PROVIDER=openai.');
    }
  } else {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(ollamaBaseUrl);
    } catch {
      throw new Error('OLLAMA_BASE_URL must be a valid HTTP(S) URL.');
    }
    if (
      (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new Error('OLLAMA_BASE_URL must be a valid HTTP(S) URL without credentials.');
    }
    if (!ollamaModel.trim()) {
      throw new Error('OLLAMA_MODEL must not be empty when AI_PROVIDER=ollama.');
    }
  }

  return {
    aiProvider,
    openAiApiKey,
    openAiModel,
    ollamaBaseUrl,
    ollamaModel,
    ollamaNumCtx,
    ollamaNumPredict,
    ollamaTimeoutMs,
  };
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/vico_ai',
  redisHost: process.env.REDIS_HOST ?? '127.0.0.1',
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
  appName: process.env.APP_NAME ?? 'Vico AI',
  appBaseUrl,
  ...loadAiConfig(),
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION ?? 'v25.0',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '',
  whatsappWebhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET ?? '',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
  googleRedirectUri,
  googleTokenEncryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'development-secret',
  features: {
    memoryEnabled: (process.env.FEATURE_MEMORY_ENABLED ?? 'true') === 'true',
    approvalsEnabled: (process.env.FEATURE_APPROVALS_ENABLED ?? 'true') === 'true',
  },
  approvalTtlMs: positiveInteger(
    process.env.APPROVAL_TTL_MS,
    10 * 60 * 1000,
    'APPROVAL_TTL_MS',
  ),
  sensitiveEmailKeywords: (process.env.SENSITIVE_EMAIL_KEYWORDS ?? '')
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean),
} as const;
