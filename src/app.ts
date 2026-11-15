import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { AiOrchestrator } from './modules/ai/orchestrator.js';
import { OpenAIService } from './modules/ai/openai.service.js';
import { GoogleIntegrationService } from './modules/google/google.service.js';
import { MemoryService } from './modules/memory/memory.service.js';
import { MessagingService } from './modules/messaging/messaging.service.js';
import { UserService } from './modules/user/user.service.js';
import { ApprovalService } from './modules/tools/approval.service.js';
import { ToolRegistry } from './modules/tools/tool-registry.js';
import { WhatsAppService } from './modules/whatsapp/whatsapp.service.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
    ajv: {
      customOptions: { strictSchema: false },
    },
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'Vico AI API',
        description:
          'HTTP API for Vico AI user profiles, messaging, WhatsApp integration, Google OAuth, and AI-assisted responses.',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.port}`,
          description: 'Local development server',
        },
      ],
      tags: [
        { name: 'System', description: 'Service status and available modules.' },
        { name: 'Users', description: 'Create and retrieve Vico AI user profiles.' },
        { name: 'Messaging', description: 'Ingest and send user messages.' },
        { name: 'WhatsApp', description: 'Receive WhatsApp webhook events.' },
        { name: 'Google', description: 'Start and complete Google OAuth authorization.' },
        { name: 'AI', description: 'Process a user message and generate an AI response.' },
      ],
    },
  });
  app.register(swaggerUi, {
    routePrefix: '/documentation',
    staticCSP: true,
  });

  const userService = new UserService();
  const memoryService = new MemoryService();
  const openAiService = new OpenAIService();
  const googleIntegrationService = new GoogleIntegrationService();
  const whatsappService = new WhatsAppService();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'memory_search',
    description: 'Search user memory for personal facts and context.',
    risk: 'low',
    execute: async (input) => ({
      tool: 'memory_search',
      query: input.message ?? '',
      results: [],
    }),
  });
  toolRegistry.register({
    name: 'calendar_lookup',
    description: 'Inspect the user calendar for upcoming events.',
    risk: 'medium',
    execute: async (input) => ({
      tool: 'calendar_lookup',
      userId: input.userId ?? 'unknown',
      events: [],
    }),
  });
  toolRegistry.register({
    name: 'gmail_search',
    description: 'Search a user’s Gmail messages for relevant information.',
    risk: 'high',
    execute: async (input) => ({
      tool: 'gmail_search',
      userId: input.userId ?? 'unknown',
      results: [],
    }),
  });

  const approvalService = new ApprovalService(config.features.approvalsEnabled);
  const messagingService = new MessagingService();
  const aiOrchestrator = new AiOrchestrator({
    memoryService,
    toolRegistry,
    approvalService,
    openAiService,
  });

  const validationErrorResponse = {
    type: 'object',
    description: 'The request did not satisfy the documented input schema.',
    properties: {
      statusCode: { type: 'number', example: 400 },
      code: { type: 'string', example: 'FST_ERR_VALIDATION' },
      error: { type: 'string', example: 'Bad Request' },
      message: { type: 'string', example: 'body/email must match format "email"' },
      validation: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instancePath: { type: 'string', example: '/email' },
            schemaPath: { type: 'string', example: '#/properties/email/format' },
            keyword: { type: 'string', example: 'format' },
            params: { type: 'object', additionalProperties: true },
            message: { type: 'string', example: 'must match format "email"' },
          },
          required: ['instancePath', 'schemaPath', 'keyword', 'params', 'message'],
          additionalProperties: true,
        },
      },
      validationContext: {
        type: 'string',
        enum: ['body', 'params', 'querystring', 'headers'],
        example: 'body',
      },
    },
    required: ['statusCode', 'code', 'error', 'message'],
    example: {
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      error: 'Bad Request',
      message: 'body/email must match format "email"',
      validation: [{
        instancePath: '/email',
        schemaPath: '#/properties/email/format',
        keyword: 'format',
        params: { format: 'email' },
        message: 'must match format "email"',
      }],
      validationContext: 'body',
    },
  } as const;

  const registerApiRoutes = async (api: FastifyInstance) => {
  api.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Check service health',
        description: 'Returns the current health status and application identity.',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              app: { type: 'string', example: 'Vico AI' },
              timestamp: { type: 'string', format: 'date-time' },
            },
            required: ['status', 'app', 'timestamp'],
            example: {
              status: 'ok',
              app: 'Vico AI',
              timestamp: '2026-11-14T12:00:00.000Z',
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok',
      app: config.appName,
      timestamp: new Date().toISOString(),
    }),
  );

  api.get(
    '/api/modules',
    {
      schema: {
        tags: ['System'],
        summary: 'List application modules',
        description: 'Lists the functional modules available in this Vico AI backend.',
        response: {
          200: {
            type: 'object',
            properties: {
              modules: {
                type: 'array',
                items: { type: 'string' },
                example: ['user', 'messaging', 'whatsapp', 'memory', 'ai'],
              },
            },
            required: ['modules'],
            example: {
              modules: [
                'user',
                'messaging',
                'whatsapp',
                'memory',
                'ai',
                'calendars',
                'gmail',
                'approval',
                'audit',
              ],
            },
          },
        },
      },
    },
    async () => ({
      modules: [
        'user',
        'messaging',
        'whatsapp',
        'memory',
        'ai',
        'calendars',
        'gmail',
        'approval',
        'audit',
      ],
    }),
  );

  api.get(
    '/api/users/:userId',
    {
      schema: {
        tags: ['Users'],
        summary: 'Get a user profile',
        description: 'Retrieves the Vico AI profile associated with the supplied user ID.',
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Unique ID of the user.', example: 'usr_123' },
          },
          required: ['userId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'usr_123' },
              status: { type: 'string', example: 'active' },
              profile: {
                type: 'object',
                properties: { fullName: { type: 'string', example: 'Vico User' } },
                required: ['fullName'],
              },
            },
            required: ['id', 'status', 'profile'],
            example: {
              id: 'usr_123',
              status: 'active',
              profile: { fullName: 'Vico User' },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = request.params as { userId: string };
      return userService.getUser(userId);
    },
  );

  const createUserSchema = z.object({
    whatsappPhone: z.string().optional(),
    email: z.string().email().optional(),
    fullName: z.string().optional(),
    displayName: z.string().optional(),
  });

  api.post(
    '/api/users',
    {
      schema: {
        tags: ['Users'],
        summary: 'Create a user profile',
        description:
          'Creates a Vico AI user profile. All profile fields are optional; omitted values are returned as null.',
        body: {
          type: 'object',
          properties: {
            whatsappPhone: {
              type: 'string',
              description: 'User phone number used for WhatsApp messaging.',
              example: '+15551234567',
            },
            email: { type: 'string', format: 'email', description: 'User email address.', example: 'alex@example.com' },
            fullName: { type: 'string', description: 'User full name.', example: 'Alex Morgan' },
            displayName: { type: 'string', description: 'Name to use when addressing the user.', example: 'Alex' },
          },
          example: {
            whatsappPhone: '+15551234567',
            email: 'alex@example.com',
            fullName: 'Alex Morgan',
            displayName: 'Alex',
          },
        },
        response: {
          400: validationErrorResponse,
          200: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Generated unique user ID.', example: 'usr_123' },
              whatsappPhone: { type: ['string', 'null'], example: '+15551234567' },
              email: { type: ['string', 'null'], example: 'alex@example.com' },
              fullName: { type: ['string', 'null'], example: 'Alex Morgan' },
              displayName: { type: ['string', 'null'], example: 'Alex' },
              status: { type: 'string', example: 'active' },
              createdAt: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'whatsappPhone', 'email', 'fullName', 'displayName', 'status', 'createdAt'],
            example: {
              id: 'usr_123',
              whatsappPhone: '+15551234567',
              email: 'alex@example.com',
              fullName: 'Alex Morgan',
              displayName: 'Alex',
              status: 'active',
              createdAt: '2026-11-14T12:00:00.000Z',
            },
          },
        },
      },
    },
    async (request) => {
      const data = createUserSchema.parse(request.body);
      return userService.createUser(data);
    },
  );

  const ingestMessageSchema = z.object({
    userId: z.string().min(1),
    phone: z.string().min(1),
    content: z.string().min(1),
  });

  api.post(
    '/api/messages/ingest',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Ingest an incoming message',
        description:
          'Accepts an incoming message and queues it for processing. The response includes generated message and conversation IDs.',
        body: {
          type: 'object',
          properties: {
            userId: { type: 'string', minLength: 1, description: 'ID of the user who sent the message.', example: 'usr_123' },
            phone: { type: 'string', minLength: 1, description: 'Sender phone number.', example: '+15551234567' },
            content: { type: 'string', minLength: 1, description: 'Text content of the message.', example: 'What is on my calendar today?' },
          },
          required: ['userId', 'phone', 'content'],
          example: {
            userId: 'usr_123',
            phone: '+15551234567',
            content: 'What is on my calendar today?',
          },
        },
        response: {
          400: validationErrorResponse,
          200: {
            type: 'object',
            properties: {
              messageId: { type: 'string', example: 'msg_456' },
              conversationId: { type: 'string', example: 'conv_789' },
              userId: { type: 'string', example: 'usr_123' },
              phone: { type: 'string', example: '+15551234567' },
              content: { type: 'string', example: 'What is on my calendar today?' },
              status: { type: 'string', example: 'queued' },
              createdAt: { type: 'string', format: 'date-time' },
            },
            required: ['messageId', 'conversationId', 'userId', 'phone', 'content', 'status', 'createdAt'],
            example: {
              messageId: 'msg_456',
              conversationId: 'conv_789',
              userId: 'usr_123',
              phone: '+15551234567',
              content: 'What is on my calendar today?',
              status: 'queued',
              createdAt: '2026-11-14T12:00:00.000Z',
            },
          },
        },
      },
    },
    async (request) => {
      const data = ingestMessageSchema.parse(request.body);
      logger.info({ data }, 'Ingesting WhatsApp message');
      return messagingService.ingestMessage(data);
    },
  );

  api.post(
    '/api/messages/send',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Send a WhatsApp text message',
        description:
          'Sends a text message to a WhatsApp phone number using the configured WhatsApp Cloud API credentials.',
        body: {
          type: 'object',
          properties: {
            to: { type: 'string', minLength: 1, description: 'Recipient phone number in international format.', example: '+15551234567' },
            text: { type: 'string', minLength: 1, description: 'Text body to send.', example: 'Hello from Vico AI!' },
          },
          required: ['to', 'text'],
          example: { to: '+254791614036', text: 'Hello from Vico AI!' },
        },
        response: {
          400: validationErrorResponse,
          200: {
            type: 'object',
            properties: {
              sent: {
                type: 'object',
                description: 'Response returned by the WhatsApp Cloud API.',
                additionalProperties: true,
                example: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.example' }] },
              },
            },
            required: ['sent'],
            example: {
              sent: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.example' }] },
            },
          },
          500: {
            type: 'object',
            description: 'The send operation failed or WhatsApp credentials are missing.',
            additionalProperties: true,
            example: { statusCode: 500, error: 'Internal Server Error', message: 'WhatsApp Cloud API credentials are not configured.' },
          },
        },
      },
    },
    async (request) => {
      const data = z.object({ to: z.string().min(1), text: z.string().min(1) }).parse(request.body);
      const sent = await whatsappService.sendTextMessage(data.to, data.text);
      return { sent };
    },
  );

  api.post(
    '/api/webhooks/whatsapp',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'Receive a WhatsApp webhook',
        description:
          'Accepts a WhatsApp Cloud API webhook payload and extracts the first incoming message when present. When webhook signature validation is configured, an invalid signature is rejected.',
        headers: {
          type: 'object',
          properties: {
            'x-hub-signature-256': {
              type: 'string',
              description: 'Optional WhatsApp HMAC-SHA256 signature header.',
              example: 'sha256=abcdef123456',
            },
          },
        },
        body: {
          type: 'object',
          description: 'WhatsApp Cloud API webhook event payload.',
          additionalProperties: true,
          example: {
            object: 'whatsapp_business_account',
            entry: [{
              changes: [{
                value: {
                  messages: [{
                    from: '15551234567',
                    id: 'wamid.example',
                    timestamp: '1731585600',
                    type: 'text',
                    text: { body: 'Hello Vico' },
                  }],
                },
              }],
            }],
          },
        },
        response: {
          400: validationErrorResponse,
          200: {
            type: 'object',
            description: 'Webhook processing result. A message-less event is acknowledged without an incoming message.',
            properties: {
              status: { type: 'string', enum: ['received', 'no_message_payload'] },
              incoming: {
                type: 'object',
                properties: {
                  from: { type: 'string', example: '15551234567' },
                  type: { type: 'string', example: 'text' },
                  text: { type: 'string', example: 'Hello Vico' },
                  id: { type: 'string', example: 'wamid.example' },
                  timestamp: { type: ['string', 'null'], example: '1731585600' },
                  metadata: { type: ['object', 'null'], additionalProperties: true },
                },
                required: ['from', 'type', 'text', 'id', 'timestamp', 'metadata'],
              },
            },
            required: ['status'],
            examples: [
              {
                status: 'received',
                incoming: {
                  from: '15551234567',
                  type: 'text',
                  text: 'Hello Vico',
                  id: 'wamid.example',
                  timestamp: '1731585600',
                  metadata: null,
                },
              },
              { status: 'no_message_payload' },
            ],
          },
          401: {
            type: 'object',
            description: 'The supplied WhatsApp signature is invalid.',
            properties: { error: { type: 'string', example: 'invalid_webhook_signature' } },
            required: ['error'],
            example: { error: 'invalid_webhook_signature' },
          },
        },
      },
    },
    async (request, reply) => {
    const payload = request.body as any;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;

    if (config.whatsappWebhookSecret && signature) {
      const rawBody = JSON.stringify(payload);
      const valid = whatsappService.verifyWebhookSignature(rawBody, signature);
      if (!valid) {
        logger.warn('Invalid WhatsApp webhook signature');
        reply.code(401);
        return { error: 'invalid_webhook_signature' };
      }
    }

    const incoming = whatsappService.parseIncomingMessage(payload);
    if (!incoming) {
      return { status: 'no_message_payload' };
    }

    logger.info({ incoming }, 'WhatsApp webhook received');
    return {
      status: 'received',
      incoming,
    };
    },
  );

  api.get(
    '/api/google/auth-url',
    {
      schema: {
        tags: ['Google'],
        summary: 'Get the Google OAuth authorization URL',
        description:
          'Builds a Google OAuth consent URL requesting offline access to read Gmail, Calendar, Contacts, and Drive.',
        response: {
          200: {
            type: 'object',
            properties: {
              authUrl: {
                type: 'string',
                format: 'uri',
                description: 'Redirect the user to this URL to authorize Google access.',
                example: 'https://accounts.google.com/o/oauth2/v2/auth?...',
              },
            },
            required: ['authUrl'],
            example: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...' },
          },
        },
      },
    },
    async () => ({
      authUrl: googleIntegrationService.buildAuthUrl(),
    }),
  );

  api.get(
    '/api/google/callback',
    {
      schema: {
        tags: ['Google'],
        summary: 'Complete Google OAuth authorization',
        description:
          'Exchanges the authorization code returned by Google for OAuth tokens. If code is omitted, the endpoint responds with a missing-code error.',
        querystring: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'One-time authorization code returned to the configured OAuth redirect URI.',
              example: '4/0AbCD-example-code',
            },
          },
        },
        response: {
          200: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  error: { type: 'string', example: 'missing_oauth_code' },
                },
                required: ['error'],
              },
              {
                type: 'object',
                properties: {
                  tokens: {
                    type: 'object',
                    description: 'OAuth token set returned by Google.',
                    additionalProperties: true,
                    example: {
                      access_token: 'ya29.example',
                      refresh_token: '1//example',
                      token_type: 'Bearer',
                      scope: 'https://www.googleapis.com/auth/gmail.readonly',
                      expiry_date: 1731590000000,
                    },
                  },
                },
                required: ['tokens'],
              },
            ],
            examples: [
              { error: 'missing_oauth_code' },
              { tokens: { access_token: 'ya29.example', token_type: 'Bearer', expiry_date: 1731590000000 } },
            ],
          },
          500: {
            type: 'object',
            description: 'Token exchange failed or Google OAuth credentials are missing.',
            additionalProperties: true,
            example: { statusCode: 500, error: 'Internal Server Error', message: 'Google OAuth client has not been configured.' },
          },
        },
      },
    },
    async (request) => {
      const { code } = request.query as { code?: string };
      if (!code) {
        return { error: 'missing_oauth_code' };
      }

      const tokens = await googleIntegrationService.exchangeCode(code);
      return { tokens };
    },
  );

  const aiRunSchema = z.object({
    userId: z.string().min(1),
    message: z.string().min(1),
  });

  api.post(
    '/api/ai/run',
    {
      schema: {
        tags: ['AI'],
        summary: 'Process a message with Vico AI',
        description:
          'Runs a user message through the AI orchestrator. It searches enabled user memory, evaluates relevant tools and approvals, and returns the generated response with execution context.',
        body: {
          type: 'object',
          properties: {
            userId: { type: 'string', minLength: 1, description: 'ID of the user making the request.', example: 'usr_123' },
            message: { type: 'string', minLength: 1, description: 'User message or question for Vico AI.', example: 'What is on my calendar today?' },
          },
          required: ['userId', 'message'],
          example: { userId: 'usr_123', message: 'What is on my calendar today?' },
        },
        response: {
          400: validationErrorResponse,
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string', example: 'usr_123' },
              intent: { type: 'string', description: 'Detected tool intent, or general-response.', example: 'calendar_lookup' },
              memoryMatches: {
                type: 'array',
                description: 'Memory entries that matched this request.',
                items: { type: 'object', additionalProperties: true },
                example: [],
              },
              toolResult: {
                description: 'Tool output, an approval request, or null when no tool was selected.',
                anyOf: [
                  { type: 'object', additionalProperties: true },
                  { type: 'null' },
                ],
              },
              availableTools: {
                type: 'array',
                description: 'Tools registered and available to the orchestrator.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', example: 'calendar_lookup' },
                    description: { type: 'string', example: 'Inspect the user calendar for upcoming events.' },
                    risk: { type: 'string', enum: ['low', 'medium', 'high'], example: 'medium' },
                  },
                  required: ['name', 'description', 'risk'],
                },
              },
              response: { type: 'string', description: 'Generated assistant response.', example: 'You have two events today.' },
              model: { type: 'string', description: 'Configured AI model name.', example: 'gpt-4o-mini' },
              generatedAt: { type: 'string', format: 'date-time' },
            },
            required: ['userId', 'intent', 'memoryMatches', 'toolResult', 'availableTools', 'response', 'model', 'generatedAt'],
            example: {
              userId: 'usr_123',
              intent: 'calendar_lookup',
              memoryMatches: [],
              toolResult: {
                approvalRequired: true,
                approvalId: 'approval_123',
                message: 'Action calendar_lookup requires explicit user approval before execution.',
              },
              availableTools: [
                { name: 'memory_search', description: 'Search user memory for personal facts and context.', risk: 'low' },
                { name: 'calendar_lookup', description: 'Inspect the user calendar for upcoming events.', risk: 'medium' },
              ],
              response: 'You have two events today.',
              model: 'gpt-4o-mini',
              generatedAt: '2026-11-14T12:00:00.000Z',
            },
          },
          500: {
            type: 'object',
            description: 'AI generation or an upstream integration failed.',
            additionalProperties: true,
            example: {
              statusCode: 500,
              error: 'Internal Server Error',
              message: 'The AI provider could not complete the request.',
            },
          },
        },
      },
    },
    async (request) => {
      const data = aiRunSchema.parse(request.body);
      return aiOrchestrator.process(data);
    },
  );
  };
  app.register(registerApiRoutes);

  return app;
}
