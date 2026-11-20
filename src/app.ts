import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { AiOrchestrator } from './modules/ai/orchestrator.js';
import { createAiProvider } from './modules/ai/provider.factory.js';
import {
  GoogleAuthError,
  GoogleAuthService,
  GOOGLE_SCOPES,
} from './modules/google/google.service.js';
import { CalendarService } from './modules/google/calendar.service.js';
import { GmailService } from './modules/google/gmail.service.js';
import { MemoryService } from './modules/memory/memory.service.js';
import { MessagingService } from './modules/messaging/messaging.service.js';
import { UserService } from './modules/user/user.service.js';
import { ApprovalService } from './modules/tools/approval.service.js';
import { ToolRegistry } from './modules/tools/tool-registry.js';
import {
  WhatsAppGraphApiError,
  WhatsAppService,
} from './modules/whatsapp/whatsapp.service.js';

function formatResponseBody(payload: string | Buffer | null) {
  if (payload === null) {
    return null;
  }

  const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return body;
    }
    throw error;
  }
}

function googleFailure(
  error: unknown,
  tool: 'calendar_lookup' | 'gmail_search',
) {
  const properties = typeof error === 'object' && error !== null
    ? error as { response?: { status?: unknown } | null }
    : {};
  const status = properties.response?.status;
  if (error instanceof GoogleAuthError) {
    const statusCode = error.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED'
      ? 401
      : error.code === 'GOOGLE_OAUTH_STATE_INVALID'
        ? 400
        : error.code === 'GOOGLE_ACCOUNT_ALREADY_CONNECTED'
          ? 409
          : error.code === 'GOOGLE_TOKEN_STORAGE_NOT_CONFIGURED' ||
              error.code === 'GOOGLE_AUTH_NOT_CONFIGURED'
            ? 500
          : error.code === 'GOOGLE_MISSING_PERMISSIONS' ||
              error.code === 'GOOGLE_AUTHORIZATION_REVOKED'
            ? 403
            : 502;
    return {
      statusCode,
      result: {
        success: false,
        tool,
        error: {
          code: error.code,
          message: error.message,
        },
      },
    };
  }
  if (status === 401) {
    return {
      statusCode: 401,
      result: {
        success: false,
        tool,
        error: {
          code: 'GOOGLE_AUTHENTICATION_ERROR',
          message: 'Google authorization failed. Reconnect the Google account.',
        },
      },
    };
  }
  if (status === 403) {
    return {
      statusCode: 403,
      result: {
        success: false,
        tool,
        error: {
          code: 'GOOGLE_AUTHORIZATION_ERROR',
          message: 'Google access is missing a required permission.',
        },
      },
    };
  }
  return {
    statusCode: 502,
    result: {
      success: false,
      tool,
      error: {
        code: 'GOOGLE_API_ERROR',
        message: 'Unable to complete the Google API request.',
      },
    },
  };
}

function getOAuthStateCookie(request: FastifyRequest) {
  const cookie = request.headers.cookie;
  const value = cookie?.split(';')
  .map((part) => part.trim())
  .find((part) => part.startsWith('google_oauth_state='))
  ?.slice('google_oauth_state='.length);
  return value ? decodeURIComponent(value) : undefined;
}

function buildOAuthStateCookie(state: string, secure: boolean, clear = false) {
  return [
  `google_oauth_state=${clear ? '' : encodeURIComponent(state)}`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  secure ? 'Secure' : '',
  clear ? 'Max-Age=0' : 'Max-Age=600',
  ].filter(Boolean).join('; ');
}

type GoogleAuthServiceContract = Pick<
  GoogleAuthService,
  | 'beginAuthorization'
  | 'completeAuthorization'
  | 'validateAuthorizationState'
  | 'getAuthenticatedClient'
>;

export async function buildApp(
  dependencies: { googleAuthService?: GoogleAuthServiceContract } = {},
) {
  const app = Fastify({
    logger: {
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url.split('?')[0],
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        }),
      },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: Boolean(process.stdout.isTTY),
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    },
    ajv: {
      customOptions: { strictSchema: false },
    },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WhatsAppGraphApiError) {
      const message = error.message.includes('nonexisting field (message_templates)')
        ? 'Meta could not find the message_templates edge for this ID. Use the WhatsApp Business Account (WABA) ID, not a business portfolio ID or phone number ID, and ensure the access token has whatsapp_business_management permission and access to that WABA.'
        : error.message;

      request.log.error(
        {
          upstreamStatus: error.upstreamStatus,
          metaCode: error.metaCode,
          fbtraceId: error.fbtraceId,
          details: error.details,
        },
        'WhatsApp Graph API request failed',
      );

      return reply.code(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'WHATSAPP_GRAPH_API_ERROR',
        message,
        metaCode: error.metaCode,
        fbtraceId: error.fbtraceId,
      });
    }

    const errorProperties = typeof error === 'object' && error !== null
      ? error as {
          statusCode?: unknown;
          code?: unknown;
          validation?: unknown;
          validationContext?: unknown;
        }
      : {};
    const statusCode = typeof errorProperties.statusCode === 'number' &&
      errorProperties.statusCode >= 400 &&
      errorProperties.statusCode < 600
      ? errorProperties.statusCode
      : 500;
    const message = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Error';
    const errorLabel = statusCode === 400
      ? 'Bad Request'
      : statusCode === 401
        ? 'Unauthorized'
        : statusCode === 403
          ? 'Forbidden'
          : statusCode === 404
            ? 'Not Found'
            : statusCode === 500
              ? 'Internal Server Error'
              : errorName;
    request.log.error({ err: error }, message);
    return reply.code(statusCode).send({
      statusCode,
      error: errorLabel,
      code: errorProperties.code,
      message,
      ...(errorProperties.validation ? { validation: errorProperties.validation } : {}),
      ...(errorProperties.validationContext
        ? { validationContext: errorProperties.validationContext }
        : {}),
    });
  });

  app.addHook('preValidation', async (request) => {
    request.log.info(
      {
        method: request.method,
        url: request.url.split('?')[0],
        requestBody: request.body ?? null,
      },
      'HTTP request body',
    );
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const callbackPath = request.url.split('?')[0];
    const isGoogleOAuthCallback =
      callbackPath === '/google/redirect' ||
      callbackPath === '/api/google/callback';
    const isGoogleOAuthStart =
      callbackPath === '/api/google/connect' ||
      callbackPath === '/api/google/auth-url';
    const containsPrivateGoogleData =
      callbackPath === '/api/google/calendar/events' ||
      callbackPath.startsWith('/api/google/gmail/') ||
      callbackPath === '/api/ai/run';
    const responseBody = isGoogleOAuthCallback || isGoogleOAuthStart
      ? '[redacted OAuth response]'
      : containsPrivateGoogleData
        ? '[redacted private integration response]'
        : typeof payload === 'string' || Buffer.isBuffer(payload)
          ? formatResponseBody(payload)
          : payload === null
            ? null
            : '[stream response body not buffered]';

    request.log.info(
      {
        method: request.method,
        url: request.url.split('?')[0],
        statusCode: reply.statusCode,
        responseBody,
      },
      'HTTP response body',
    );
    return payload;
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
        {
          name: 'WhatsApp',
          description:
            'Receive webhook events and manage business phone numbers. Use a dedicated number: numbers in the consumer WhatsApp app are unsupported, while WhatsApp Business app numbers can be onboarded through the supported migration flow. Choose the production display name during Embedded Signup because changing it later can be difficult.',
        },
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
  const aiProvider = createAiProvider();
  const approvalService = new ApprovalService(
    config.features.approvalsEnabled,
    config.approvalTtlMs,
  );
  const googleAuthService = dependencies.googleAuthService ?? new GoogleAuthService();
  const calendarService = new CalendarService(approvalService, googleAuthService);
  const gmailService = new GmailService(approvalService, googleAuthService);
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
    risk: 'low',
    execute: async (input) => {
      const message = typeof input.message === 'string' ? input.message.toLowerCase() : '';
      const period = message.includes('tomorrow')
        ? 'tomorrow'
        : message.includes('this week') || message.includes('week')
          ? 'this_week'
          : message.includes('today')
            ? 'today'
            : 'upcoming';
      try {
        const events = await calendarService.listEvents(
          { period },
          2500,
          typeof input.userId === 'string' ? input.userId : undefined,
        );
        return {
          success: true,
          tool: 'calendar_lookup',
          data: { events },
        };
      } catch (error) {
        return googleFailure(error, 'calendar_lookup').result;
      }
    },
  });
  toolRegistry.register({
    name: 'gmail_search',
    description: 'Search a user’s Gmail messages for relevant information.',
    risk: 'low',
    execute: async (input) => {
      try {
        const messages = await gmailService.listMessages(
          typeof input.message === 'string' ? input.message : 'in:inbox',
          5,
          typeof input.userId === 'string' ? input.userId : 'shared',
        );
        return {
          success: true,
          tool: 'gmail_search',
          data: { messages },
        };
      } catch (error) {
        return googleFailure(error, 'gmail_search').result;
      }
    },
  });

  const messagingService = new MessagingService();
  const aiOrchestrator = new AiOrchestrator({
    memoryService,
    toolRegistry,
    approvalService,
    aiProvider,
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
        summary: 'Send a WhatsApp text, template, or Direct Send message',
        description:
          'Sends a regular text message, an approved template, or a Direct Send utility/authentication message. Direct Send requires Meta account eligibility; ineligible accounts should use an approved template. Authentication Direct Send is an alpha feature.',
        body: {
          oneOf: [
            {
              type: 'object',
              properties: {
                to: { type: 'string', minLength: 1, description: 'Recipient phone number in international format.', example: '+15551234567' },
                text: { type: 'string', minLength: 1, description: 'Text body to send.', example: 'Hello from Vico AI!' },
              },
              required: ['to', 'text'],
              example: { to: '+254791614036', text: 'Hello from Vico AI!' },
            },
            {
              type: 'object',
              properties: {
                to: { type: 'string', minLength: 1, description: 'Recipient phone number in international format.', example: '+254791614036' },
                type: { type: 'string', enum: ['template'], example: 'template' },
                template: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', minLength: 1, example: 'hello_world' },
                    language: {
                      type: 'object',
                      properties: {
                        code: { type: 'string', minLength: 1, example: 'en_US' },
                      },
                      required: ['code'],
                    },
                    components: {
                      type: 'array',
                      items: { type: 'object', additionalProperties: true },
                    },
                  },
                  required: ['name', 'language'],
                },
              },
              required: ['to', 'type', 'template'],
              example: {
                to: '+254791614036',
                type: 'template',
                template: {
                  name: 'hello_world',
                  language: { code: 'en_US' },
                },
              },
            },
            {
              type: 'object',
              description:
                'Direct Send message. Requires an eligible Meta business account. Utility supports text messages; authentication supports text and interactive OTP messages.',
              properties: {
                messaging_product: {
                  type: 'string',
                  enum: ['whatsapp'],
                  default: 'whatsapp',
                  example: 'whatsapp',
                },
                recipient_type: {
                  type: 'string',
                  enum: ['individual'],
                  example: 'individual',
                },
                to: {
                  type: 'string',
                  minLength: 1,
                  description: 'Recipient phone number in international format.',
                  example: '254791614036',
                },
                type: {
                  type: 'string',
                  enum: ['text', 'interactive'],
                },
                category: {
                  type: 'string',
                  enum: ['utility', 'authentication'],
                  description: 'Direct Send message category.',
                },
                text: {
                  type: 'object',
                  properties: {
                    body: { type: 'string', minLength: 1, example: 'Your order has shipped.' },
                  },
                  required: ['body'],
                },
                interactive: {
                  type: 'object',
                  description: 'Interactive authentication OTP payload supported by Meta.',
                  additionalProperties: true,
                },
                template_name: {
                  type: 'string',
                  minLength: 1,
                  description: 'Optional Direct Send template name for message attribution.',
                },
              },
              required: ['to', 'type', 'category'],
              oneOf: [
                {
                  properties: {
                    type: { const: 'text' },
                    text: { type: 'object' },
                  },
                  required: ['text'],
                },
                {
                  properties: {
                    type: { const: 'interactive' },
                    category: { const: 'authentication' },
                    interactive: { type: 'object' },
                  },
                  required: ['interactive'],
                },
              ],
              example: {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: '254791614036',
                type: 'text',
                text: { body: 'Your order has shipped.' },
                category: 'utility',
              },
            },
          ],
          example: {
            to: '254791614036',
            type: 'template',
            template: {
              name: 'hello_world',
              language: { code: 'en_US' },
            },
          },
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
            description:
              'The send operation failed, credentials are missing, or Meta rejected Direct Send because the business account is not eligible. In that case, send an approved template instead.',
            additionalProperties: true,
            example: { statusCode: 500, error: 'Internal Server Error', message: 'WhatsApp Cloud API credentials are not configured.' },
          },
        },
      },
    },
    async (request) => {
      const data = z.union([
        z.object({
          to: z.string().min(1),
          text: z.string().min(1),
        }),
        z.object({
          to: z.string().min(1),
          type: z.literal('template'),
          template: z.object({
            name: z.string().min(1),
            language: z.object({ code: z.string().min(1) }),
            components: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        }),
        z.object({
          messaging_product: z.literal('whatsapp').optional(),
          recipient_type: z.literal('individual').optional(),
          to: z.string().min(1),
          category: z.enum(['utility', 'authentication']),
          type: z.enum(['text', 'interactive']),
          text: z.object({ body: z.string().min(1) }).optional(),
          interactive: z.record(z.string(), z.unknown()).optional(),
          template_name: z.string().min(1).optional(),
        }).superRefine((data, context) => {
          if (data.type === 'text' && !data.text) {
            context.addIssue({
              code: 'custom',
              path: ['text'],
              message: 'text.body is required for Direct Send text messages.',
            });
          }
          if (data.type === 'interactive' && !data.interactive) {
            context.addIssue({
              code: 'custom',
              path: ['interactive'],
              message: 'interactive payload is required for Direct Send interactive messages.',
            });
          }
          if (data.type === 'text' && data.interactive) {
            context.addIssue({
              code: 'custom',
              path: ['interactive'],
              message: 'interactive can only be used with type "interactive".',
            });
          }
          if (data.type === 'interactive' && data.text) {
            context.addIssue({
              code: 'custom',
              path: ['text'],
              message: 'text can only be used with type "text".',
            });
          }
        }),
      ]).parse(request.body);

      const sent = 'template' in data
        ? await whatsappService.sendTemplateMessage(data.to, data.template)
        : 'category' in data
          ? await whatsappService.sendDirectMessage(data)
          : await whatsappService.sendTextMessage(data.to, data.text);
      return { sent };
    },
  );

  api.get(
    '/api/whatsapp/message-templates',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'List WhatsApp message templates',
        description:
          'Lists templates belonging to the WhatsApp Business Account configured by WHATSAPP_BUSINESS_ACCOUNT_ID. Supports field selection, status filtering, page size, and Graph API cursor pagination.',
        querystring: {
          type: 'object',
          properties: {
            fields: {
              type: 'string',
              description: 'Comma-separated template fields.',
              example: 'name,category,status',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              description: 'Maximum number of templates in this page.',
              example: 5,
            },
            status: {
              type: 'string',
              enum: ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'],
              description: 'Filter by template status.',
              example: 'APPROVED',
            },
            after: {
              type: 'string',
              description: 'Graph API cursor for the next page.',
            },
            before: {
              type: 'string',
              description: 'Graph API cursor for the previous page.',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            description: 'Templates and pagination information returned by Meta.',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: '1387372356726668' },
                    name: { type: 'string', example: 'reservation_confirmation' },
                    language: { type: 'string', example: 'en_US' },
                    category: {
                      type: 'string',
                      enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
                    },
                    status: { type: 'string', example: 'APPROVED' },
                    parameter_format: { type: 'string', example: 'NAMED' },
                    components: {
                      type: 'array',
                      items: { type: 'object', additionalProperties: true },
                    },
                  },
                  additionalProperties: true,
                },
              },
              paging: { type: 'object', additionalProperties: true },
            },
            required: ['data'],
            additionalProperties: true,
          },
          400: validationErrorResponse,
          502: {
            type: 'object',
            description:
              'Meta does not recognize the message_templates edge for the configured WhatsApp Business Account ID. Verify that WHATSAPP_BUSINESS_ACCOUNT_ID is the WABA ID and that the token has whatsapp_business_management access to it.',
            properties: {
              statusCode: { type: 'number', example: 502 },
              error: { type: 'string', example: 'Bad Gateway' },
              code: { type: 'string', example: 'WHATSAPP_GRAPH_API_ERROR' },
              message: { type: 'string' },
              metaCode: { type: 'number', example: 100 },
              fbtraceId: { type: 'string', example: 'AuI8fI1a9aPpliT-CcMFr8h' },
            },
            required: ['statusCode', 'error', 'code', 'message'],
          },
          500: {
            type: 'object',
            description: 'The Meta Graph API request failed or credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request) => {
      const query = z.object({
        fields: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        status: z.enum([
          'APPROVED',
          'PENDING',
          'REJECTED',
          'PAUSED',
          'DISABLED',
          'IN_APPEAL',
          'PENDING_DELETION',
        ]).optional(),
        after: z.string().min(1).optional(),
        before: z.string().min(1).optional(),
      }).parse(request.query);
      return whatsappService.getMessageTemplates(query);
    },
  );

  api.post(
    '/api/whatsapp/message-templates',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'Create a WhatsApp message template',
        description:
          'Submits a template for Meta review to the WhatsApp Business Account configured by WHATSAPP_BUSINESS_ACCOUNT_ID. Names must use lowercase letters, numbers, and underscores (up to 512 characters), and must be unique for each language in the account. Template components are passed through to Meta for validation.',
        body: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 512,
              pattern: '^[a-z0-9_]+$',
              example: 'reservation_confirmation',
            },
            language: { type: 'string', minLength: 1, example: 'en_US' },
            category: {
              type: 'string',
              enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
              example: 'UTILITY',
            },
            parameter_format: {
              type: 'string',
              enum: ['POSITIONAL', 'NAMED'],
              example: 'NAMED',
            },
            components: {
              type: 'array',
              minItems: 1,
              items: { type: 'object', additionalProperties: true },
            },
            allow_category_change: { type: 'boolean' },
            message_send_ttl_seconds: { type: 'integer', minimum: 1 },
          },
          required: ['name', 'language', 'category', 'components'],
          additionalProperties: true,
          example: {
            name: 'reservation_confirmation',
            language: 'en_US',
            category: 'UTILITY',
            parameter_format: 'NAMED',
            components: [
              {
                type: 'BODY',
                text: 'Your reservation for {{guest_count}} at {{time}} is confirmed.',
              },
            ],
          },
        },
        response: {
          200: {
            type: 'object',
            description: 'Template creation result returned by Meta.',
            properties: {
              id: { type: 'string', example: '1387372356726668' },
              status: { type: 'string', example: 'PENDING' },
              category: { type: 'string', example: 'UTILITY' },
            },
            additionalProperties: true,
          },
          400: validationErrorResponse,
          500: {
            type: 'object',
            description: 'Template creation failed or credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request) => {
      const body = z.object({
        name: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/),
        language: z.string().min(1),
        category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
        parameter_format: z.enum(['POSITIONAL', 'NAMED']).optional(),
        components: z.array(z.record(z.string(), z.unknown())).min(1),
        allow_category_change: z.boolean().optional(),
        message_send_ttl_seconds: z.number().int().positive().optional(),
      }).passthrough().parse(request.body);
      return whatsappService.createMessageTemplate(body);
    },
  );

  api.post(
    '/api/whatsapp/message-templates/:templateId',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'Edit a WhatsApp message template',
        description:
          'Updates a template category, all of its components, and/or its time-to-live. Components are replaced as a whole, not edited individually. Meta permits edits only for APPROVED, REJECTED, or PAUSED templates; an approved template category cannot be changed.',
        params: {
          type: 'object',
          properties: {
            templateId: { type: 'string', minLength: 1, example: '1387372356726668' },
          },
          required: ['templateId'],
        },
        body: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
              example: 'MARKETING',
            },
            components: {
              type: 'array',
              minItems: 1,
              items: { type: 'object', additionalProperties: true },
              description: 'Replaces the complete component list.',
            },
            message_send_ttl_seconds: { type: 'integer', minimum: 1 },
          },
          minProperties: 1,
          additionalProperties: false,
          example: { category: 'MARKETING' },
        },
        response: {
          200: {
            type: 'object',
            description: 'Template update result returned by Meta.',
            properties: { success: { type: 'boolean', example: true } },
            additionalProperties: true,
          },
          400: validationErrorResponse,
          500: {
            type: 'object',
            description: 'Template update failed or credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request) => {
      const params = z.object({ templateId: z.string().min(1) }).parse(request.params);
      const body = z.object({
        category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
        components: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
        message_send_ttl_seconds: z.number().int().positive().optional(),
      }).strict().refine(
        (value) => Object.values(value).some((item) => item !== undefined),
        'At least one template field must be provided.',
      ).parse(request.body);
      return whatsappService.editMessageTemplate(params.templateId, body);
    },
  );

  api.delete(
    '/api/whatsapp/message-templates',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'Delete WhatsApp message templates',
        description:
          'Deletes templates from the WhatsApp Business Account configured by WHATSAPP_BUSINESS_ACCOUNT_ID. Deletes by name, by a matching template ID and name, or by up to 100 template IDs. Deleting by name removes every language variant with that name. Bulk IDs cannot be combined with name or a single ID. Requires the whatsapp_business_management permission.',
        querystring: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              description: 'Template name; deletes all language variants with this name unless hsmId is also specified.',
              example: 'order_confirmation',
            },
            hsmId: {
              type: 'string',
              minLength: 1,
              description: 'Template ID. Must be used together with name.',
              example: '1407680676729941',
            },
            hsmIds: {
              type: 'string',
              description: 'Comma-separated template IDs, up to 100.',
              example: '1387372356726668,1304694804498707',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            description: 'Deletion result returned by Meta.',
            properties: { success: { type: 'boolean', example: true } },
            additionalProperties: true,
          },
          400: validationErrorResponse,
          500: {
            type: 'object',
            description: 'Template deletion failed or credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const querySchema = z.object({
        name: z.string().min(1).optional(),
        hsmId: z.string().min(1).optional(),
        hsmIds: z.string().min(1).optional(),
      }).strict().superRefine((value, context) => {
        if (value.hsmIds) {
          if (value.name || value.hsmId) {
            context.addIssue({
              code: 'custom',
              message: 'hsmIds cannot be combined with name or hsmId.',
            });
          }
          const ids = value.hsmIds.split(',').map((id) => id.trim());
          if (ids.length > 100 || ids.some((id) => !id)) {
            context.addIssue({
              code: 'custom',
              message: 'hsmIds must contain between 1 and 100 non-empty IDs.',
            });
          }
        } else if (!value.name) {
          context.addIssue({
            code: 'custom',
            message: 'Provide name or hsmIds to identify templates to delete.',
          });
        }
        if (value.hsmId && !value.name) {
          context.addIssue({
            code: 'custom',
            message: 'hsmId must be used together with name.',
          });
        }
      });
      const parsedQuery = querySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply.code(400).send({
          statusCode: 400,
          code: 'FST_ERR_VALIDATION',
          error: 'Bad Request',
          message: parsedQuery.error.issues.map((issue) => issue.message).join('; '),
        });
      }
      const query = parsedQuery.data;

      return whatsappService.deleteMessageTemplates({
        name: query.name,
        hsmId: query.hsmId,
        hsmIds: query.hsmIds?.split(',').map((id) => id.trim()),
      });
    },
  );

  api.get(
    '/api/whatsapp/phone-numbers',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'List WhatsApp business phone numbers',
        description:
          'Gets phone numbers associated with the WhatsApp Business Account configured by WHATSAPP_BUSINESS_ACCOUNT_ID. The optional accountMode filter selects SANDBOX or LIVE numbers.',
        querystring: {
          type: 'object',
          properties: {
            fields: {
              type: 'string',
              minLength: 1,
              description: 'Comma-separated Graph API fields to return.',
              example: 'id,display_phone_number,code_verification_status',
            },
            accountMode: {
              type: 'string',
              enum: ['SANDBOX', 'LIVE'],
              description: 'Filter numbers by account mode.',
              example: 'LIVE',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            description: 'Phone numbers and pagination cursors returned by Meta.',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: '1972385232742141' },
                    verified_name: { type: 'string', example: "John's Cake Shop" },
                    code_verification_status: {
                      type: 'string',
                      enum: ['VERIFIED', 'NOT_VERIFIED'],
                      example: 'VERIFIED',
                    },
                    display_phone_number: {
                      type: 'string',
                      example: '+1 631-555-1111',
                    },
                    quality_rating: { type: 'string', example: 'GREEN' },
                    platform_type: { type: 'string', example: 'CLOUD_API' },
                    throughput: { type: 'object', additionalProperties: true },
                    webhook_configuration: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                  additionalProperties: true,
                },
              },
              paging: { type: 'object', additionalProperties: true },
            },
            required: ['data'],
            additionalProperties: true,
          },
          400: validationErrorResponse,
          500: {
            type: 'object',
            description: 'The Meta Graph API request failed or WhatsApp credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request) => {
      const query = z.object({
        fields: z.string().min(1).optional(),
        accountMode: z.enum(['SANDBOX', 'LIVE']).optional(),
      }).parse(request.query);
      return whatsappService.getPhoneNumbers(query);
    },
  );

  api.get(
    '/api/whatsapp/phone-numbers/:phoneNumberId',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'Get WhatsApp phone number metadata',
        description:
          'Gets phone number metadata, including display-name review status and OTP verification status. code_verification_status is VERIFIED or NOT_VERIFIED.',
        params: {
          type: 'object',
          properties: {
            phoneNumberId: {
              type: 'string',
              minLength: 1,
              description: 'WhatsApp business phone number ID.',
              example: '1972385232742141',
            },
          },
          required: ['phoneNumberId'],
        },
        querystring: {
          type: 'object',
          properties: {
            fields: {
              type: 'string',
              minLength: 1,
              description: 'Comma-separated Graph API fields to return.',
              example: 'display_phone_number,name_status,new_name_status,code_verification_status',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string', example: '1972385232742141' },
              display_phone_number: {
                type: 'string',
                example: '+1 631-555-1111',
              },
              last_onboarded_time: {
                type: 'string',
                example: '2023-08-22T19:05:53+0000',
              },
              code_verification_status: {
                type: 'string',
                enum: ['VERIFIED', 'NOT_VERIFIED'],
                example: 'VERIFIED',
              },
              name_status: {
                type: 'string',
                enum: ['APPROVED', 'DECLINED', 'EXPIRED', 'PENDING_REVIEW', 'NONE'],
                example: 'APPROVED',
              },
              new_name_status: {
                type: 'string',
                enum: ['APPROVED', 'DECLINED', 'EXPIRED', 'PENDING_REVIEW', 'NONE'],
                example: 'APPROVED',
              },
            },
            additionalProperties: true,
          },
          400: validationErrorResponse,
          500: {
            type: 'object',
            description: 'The Meta Graph API request failed or WhatsApp credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request) => {
      const params = z.object({ phoneNumberId: z.string().min(1) }).parse(request.params);
      const query = z.object({ fields: z.string().min(1).optional() }).parse(request.query);
      return whatsappService.getPhoneNumber(params.phoneNumberId, query.fields);
    },
  );

  api.post(
    '/api/whatsapp/phone-numbers/:phoneNumberId/register',
    {
      schema: {
        tags: ['WhatsApp'],
        summary: 'Register a WhatsApp phone number',
        description:
          'Registers a verified number for Cloud API use. Call this within 14 days after Embedded Signup; otherwise the number must go through Embedded Signup again. The PIN is the six-digit two-step verification PIN.',
        params: {
          type: 'object',
          properties: {
            phoneNumberId: {
              type: 'string',
              minLength: 1,
              description: 'WhatsApp business phone number ID.',
              example: '1972385232742141',
            },
          },
          required: ['phoneNumberId'],
        },
        body: {
          type: 'object',
          properties: {
            pin: {
              type: 'string',
              pattern: '^\\d{6}$',
              description: 'Six-digit two-step verification PIN.',
              example: '123456',
            },
          },
          required: ['pin'],
        },
        response: {
          200: {
            type: 'object',
            description: 'Registration result returned by Meta.',
            additionalProperties: true,
            example: { success: true },
          },
          400: validationErrorResponse,
          500: {
            type: 'object',
            description: 'Registration failed or WhatsApp credentials are missing.',
            additionalProperties: true,
          },
        },
      },
    },
    async (request) => {
      const params = z.object({ phoneNumberId: z.string().min(1) }).parse(request.params);
      const body = z.object({ pin: z.string().regex(/^\d{6}$/) }).parse(request.body);
      return whatsappService.registerPhoneNumber(params.phoneNumberId, body.pin);
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
      const rawBody = Buffer.from(JSON.stringify(payload));
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
    '/api/google/calendar/events',
    {
      schema: {
        tags: ['Google'],
        summary: 'List events from the primary Google Calendar',
        description:
          'Reads Calendar events using the connected shared Google account. Defaults to upcoming events and Africa/Nairobi timezone.',
        querystring: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'tomorrow', 'this_week', 'upcoming'],
              default: 'upcoming',
            },
            timeZone: {
              type: 'string',
              default: 'Africa/Nairobi',
              example: 'Africa/Nairobi',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              tool: { type: 'string', example: 'calendar_lookup' },
              data: {
                type: 'object',
                properties: {
                  events: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: 'abc123' },
                        summary: { type: 'string', example: 'Project review' },
                        description: { type: 'string', example: 'Weekly project review.' },
                        start: { type: 'string', example: '2026-11-21T09:00:00+03:00' },
                        end: { type: 'string', example: '2026-11-21T10:00:00+03:00' },
                        location: { type: 'string', example: 'Nairobi' },
                        status: { type: 'string', example: 'confirmed' },
                      },
                      required: ['id'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['events'],
              },
            },
            required: ['success', 'tool', 'data'],
          },
          '4xx': {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              tool: { type: 'string', example: 'calendar_lookup' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'GOOGLE_AUTHENTICATION_ERROR' },
                  message: { type: 'string', example: 'Google authorization failed.' },
                },
                required: ['code', 'message'],
              },
            },
            required: ['success', 'tool', 'error'],
          },
          502: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              tool: { type: 'string', example: 'calendar_lookup' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'GOOGLE_CALENDAR_ERROR' },
                  message: { type: 'string', example: 'Unable to retrieve calendar events.' },
                },
                required: ['code', 'message'],
              },
            },
            required: ['success', 'tool', 'error'],
          },
        },
      },
    },
    async (request, reply) => {
      const query = z.object({
        period: z.enum(['today', 'tomorrow', 'this_week', 'upcoming']).default('upcoming'),
        timeZone: z.string().min(1).default('Africa/Nairobi'),
      }).parse(request.query);
      try {
        new Intl.DateTimeFormat('en', { timeZone: query.timeZone }).format(new Date());
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        return reply.code(400).send({
          success: false,
          tool: 'calendar_lookup',
          error: {
            code: 'INVALID_TIME_ZONE',
            message: 'The requested time zone is not valid.',
          },
        });
      }
      try {
        const events = await calendarService.listEvents(query);
        return {
          success: true,
          tool: 'calendar_lookup',
          data: { events },
        };
      } catch (error) {
        const failure = googleFailure(error, 'calendar_lookup');
        return reply.code(failure.statusCode).send(failure.result);
      }
    },
  );

  const googleConnectHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    const { state, authUrl } = googleAuthService.beginAuthorization();
    reply.header(
      'set-cookie',
      buildOAuthStateCookie(state, config.nodeEnv === 'production'),
    );
    logger.info(
      {
        operation: 'oauth.authorization_url',
        scopeCount: GOOGLE_SCOPES.length,
        offlineAccess: true,
      },
      'Google OAuth connection started',
    );
    return { authUrl };
  };

  const connectRouteSchema = {
    tags: ['Google'],
    summary: 'Connect the shared Google account',
    description:
      'Starts offline Google OAuth authorization. A short-lived HttpOnly state cookie binds the callback to this browser. The shared Google connection cannot be replaced through a second callback.',
    response: {
      200: {
        type: 'object',
        properties: {
          authUrl: {
            type: 'string',
            format: 'uri',
            description: 'Open this URL to authorize the shared Google account.',
          },
        },
        required: ['authUrl'],
      },
    },
  };

  api.get('/api/google/connect', { schema: connectRouteSchema }, googleConnectHandler);
  api.get('/api/google/auth-url', { schema: connectRouteSchema }, googleConnectHandler);

  const googleOAuthCallbackHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const query = z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }).parse(request.query);
    const cookieState = getOAuthStateCookie(request);
    reply.header(
      'set-cookie',
      buildOAuthStateCookie('', config.nodeEnv === 'production', true),
    );

    try {
      googleAuthService.validateAuthorizationState(query.state, cookieState);
      if (query.error || !query.code) {
        return reply.code(400).send({
          success: false,
          error: {
            code: query.error === 'access_denied'
              ? 'GOOGLE_CONSENT_DENIED'
              : 'GOOGLE_OAUTH_CODE_MISSING',
            message: query.error === 'access_denied'
              ? 'Google authorization was not granted.'
              : 'Google did not return an authorization code.',
          },
        });
      }

      const result = await googleAuthService.completeAuthorization({
        code: query.code,
        state: query.state!,
        cookieState,
      });
      logger.info(
        {
          operation: 'oauth.callback',
          connected: result.connected,
          scopeCount: GOOGLE_SCOPES.length,
        },
        'Google OAuth connection completed',
      );
      return result;
    } catch (error) {
      const failure = googleFailure(error, 'calendar_lookup');
      logger.warn(
        {
          operation: 'oauth.callback',
          code: failure.result.error.code,
          statusCode: failure.statusCode,
        },
        'Google OAuth callback failed',
      );
      return reply.code(failure.statusCode).send({
        success: false,
        error: failure.result.error,
      });
    }
  };

  const googleCallbackOptions = {
    schema: {
      tags: ['Google'],
      summary: 'Complete Google OAuth authorization',
      description:
        'Validates the one-time browser state, exchanges the authorization code, and stores encrypted shared-account credentials. Tokens are never returned.',
      querystring: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'One-time Google authorization code.' },
          state: { type: 'string', description: 'OAuth state returned by Google.' },
          error: { type: 'string', description: 'OAuth consent error, if any.' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            connected: { type: 'boolean', example: true },
          },
          required: ['connected'],
        },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
        502: { type: 'object', additionalProperties: true },
      },
    },
  };
  api.get('/google/redirect', googleCallbackOptions, googleOAuthCallbackHandler);
  api.get('/api/google/callback', googleCallbackOptions, googleOAuthCallbackHandler);

  api.post(
    '/api/approvals/:approvalId/decision',
    {
      schema: {
        tags: ['AI'],
        summary: 'Approve or reject a pending action',
        description:
          'Resolves an approval owned by the supplied user ID. The caller must be authenticated upstream and provide that authenticated user ID; this endpoint does not establish identity itself.',
        params: {
          type: 'object',
          properties: {
            approvalId: { type: 'string', format: 'uuid' },
          },
          required: ['approvalId'],
        },
        body: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
            decision: { type: 'string', enum: ['approve', 'reject'] },
          },
          required: ['userId', 'decision'],
        },
      },
    },
    async (request, reply) => {
      const { approvalId } = z.object({
        approvalId: z.string().uuid(),
      }).parse(request.params);
      const { userId, decision } = z.object({
        userId: z.string().uuid(),
        decision: z.enum(['approve', 'reject']),
      }).parse(request.body);

      const result = await approvalService.decide({
        approvalId,
        userId,
        decision,
      });

      if (result.status === 'not_found') {
        return reply.code(404).send({
          status: 'not_found',
          message: 'Approval request was not found.',
        });
      }

      const approvedAction = result.status === 'approved' && result.newlyDecided
        ? result.action
        : undefined;
      const approvedPayload = result.status === 'approved' && result.newlyDecided
        ? result.payload
        : undefined;
      if (
        !approvedAction ||
        !approvedPayload
      ) {
        return {
          approvalId,
          status: result.status,
          executed: false,
          ...(result.message ? { message: result.message } : {}),
        };
      }

      let actionResult: unknown;
      try {
        actionResult = await toolRegistry.execute(approvedAction, {
          ...approvedPayload,
          userId,
        });
      } catch (error) {
        await approvalService.recordExecution({
          approvalId,
          userId,
          actionType: approvedAction,
          payload: approvedPayload,
          success: false,
        });
        throw error;
      }

      await approvalService.recordExecution({
        approvalId,
        userId,
        actionType: approvedAction,
        payload: approvedPayload,
        success: true,
      });

      return {
        approvalId,
        status: result.status,
        executed: true,
        result: actionResult,
      };
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
          'Runs a user message through the AI orchestrator. It searches enabled user memory, evaluates relevant tools and approvals, and returns the generated response with execution context. Google credentials are loaded from the shared OAuth connection.',
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
                    risk: { type: 'string', enum: ['low', 'medium', 'high'], example: 'low' },
                  },
                  required: ['name', 'description', 'risk'],
                },
              },
              response: { type: 'string', description: 'Generated assistant response.', example: 'You have two events today.' },
              provider: { type: 'string', description: 'Active AI provider.', example: 'ollama' },
              model: { type: 'string', description: 'Configured AI model name.', example: 'phi3' },
              generatedAt: { type: 'string', format: 'date-time' },
            },
            required: ['userId', 'intent', 'memoryMatches', 'toolResult', 'availableTools', 'response', 'provider', 'model', 'generatedAt'],
            example: {
              userId: 'usr_123',
              intent: 'calendar_lookup',
              memoryMatches: [],
              toolResult: { events: [{ summary: 'Project sync' }] },
              availableTools: [
                { name: 'memory_search', description: 'Search user memory for personal facts and context.', risk: 'low' },
                { name: 'calendar_lookup', description: 'Inspect the user calendar for upcoming events.', risk: 'low' },
              ],
              response: 'You have two events today.',
              provider: 'ollama',
              model: 'phi3',
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
