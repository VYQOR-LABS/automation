import * as dotenv from 'dotenv';

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/vico_ai',
  redisHost: process.env.REDIS_HOST ?? '127.0.0.1',
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
  appName: process.env.APP_NAME ?? 'Vico AI',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION ?? 'v25.0',
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '',
  whatsappWebhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET ?? '',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/auth/google/callback',
  jwtSecret: process.env.JWT_SECRET ?? 'development-secret',
  features: {
    memoryEnabled: (process.env.FEATURE_MEMORY_ENABLED ?? 'true') === 'true',
    approvalsEnabled: (process.env.FEATURE_APPROVALS_ENABLED ?? 'true') === 'true',
  },
} as const;
