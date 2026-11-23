import crypto from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

type MetaGraphErrorPayload = {
  error?: {
    message?: string;
    code?: number;
    fbtrace_id?: string;
    error_data?: { details?: string };
  };
};

export class WhatsAppGraphApiError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus: number,
    readonly metaCode?: number,
    readonly fbtraceId?: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'WhatsAppGraphApiError';
  }
}

export class WhatsAppService {
  private readonly phoneNumberId = config.whatsappPhoneNumberId;
  private readonly apiToken = process.env.WHATSAPP_API_TOKEN ?? '';

  constructor(private readonly webhookSecret = config.whatsappWebhookSecret) {}

  private getBusinessAccountId() {
    if (!config.whatsappBusinessAccountId) {
      throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID is not configured.');
    }

    return config.whatsappBusinessAccountId;
  }

  private async requestGraphApi(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    } = {},
  ) {
    if (!this.apiToken) {
      throw new Error('WhatsApp Cloud API credentials are not configured.');
    }

    const url = new URL(
      `https://graph.facebook.com/${config.whatsappApiVersion}/${path}`,
    );
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload: MetaGraphErrorPayload | undefined;
      try {
        payload = JSON.parse(errorText) as MetaGraphErrorPayload;
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
      }

      const metaError = payload?.error;
      throw new WhatsAppGraphApiError(
        metaError?.message ?? 'WhatsApp Graph API request failed.',
        response.status,
        metaError?.code,
        metaError?.fbtrace_id,
        metaError?.error_data?.details,
      );
    }

    return response.json();
  }

  async getMessageTemplates(
    options: {
      fields?: string;
      limit?: number;
      status?: string;
      after?: string;
      before?: string;
    } = {},
  ) {
    const query: Record<string, string> = {};
    if (options.fields) query.fields = options.fields;
    if (options.limit !== undefined) query.limit = String(options.limit);
    if (options.status) query.status = options.status.toLowerCase();
    if (options.after) query.after = options.after;
    if (options.before) query.before = options.before;

    return this.requestGraphApi(
      `${encodeURIComponent(this.getBusinessAccountId())}/message_templates`,
      { query },
    );
  }

  async createMessageTemplate(
    template: Record<string, unknown>,
  ) {
    return this.requestGraphApi(
      `${encodeURIComponent(this.getBusinessAccountId())}/message_templates`,
      { method: 'POST', body: template },
    );
  }

  async editMessageTemplate(
    templateId: string,
    update: Record<string, unknown>,
  ) {
    return this.requestGraphApi(encodeURIComponent(templateId), {
      method: 'POST',
      body: update,
    });
  }

  async deleteMessageTemplates(
    options: { name?: string; hsmId?: string; hsmIds?: string[] },
  ) {
    const query: Record<string, string> = {};
    if (options.name) query.name = options.name;
    if (options.hsmId) query.hsm_id = options.hsmId;
    if (options.hsmIds) query.hsm_ids = JSON.stringify(options.hsmIds);

    return this.requestGraphApi(
      `${encodeURIComponent(this.getBusinessAccountId())}/message_templates`,
      { method: 'DELETE', query },
    );
  }

  async getPhoneNumbers(
    options: { fields?: string; accountMode?: 'SANDBOX' | 'LIVE' } = {},
  ) {
    const query: Record<string, string> = {
      fields:
        options.fields ??
        'id,verified_name,code_verification_status,display_phone_number,quality_rating,platform_type,throughput,webhook_configuration',
    };

    if (options.accountMode) {
      query.filtering = JSON.stringify([
        {
          field: 'account_mode',
          operator: 'EQUAL',
          value: options.accountMode,
        },
      ]);
    }

    return this.requestGraphApi(
      `${encodeURIComponent(this.getBusinessAccountId())}/phone_numbers`,
      { query },
    );
  }

  async getPhoneNumber(phoneNumberId: string, fields?: string) {
    return this.requestGraphApi(encodeURIComponent(phoneNumberId), {
      query: {
        fields:
          fields ??
          'display_phone_number,name_status,new_name_status,last_onboarded_time,code_verification_status',
      },
    });
  }

  async registerPhoneNumber(phoneNumberId: string, pin: string) {
    return this.requestGraphApi(
      `${encodeURIComponent(phoneNumberId)}/register`,
      {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          pin,
        },
      },
    );
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string) {
    if (!this.webhookSecret || !signatureHeader) {
      return false;
    }

    const expected = `sha256=${crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex')}`;

    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(signatureHeader, 'utf8');
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      expectedBuffer,
      providedBuffer,
    );
  }

  async sendTextMessage(to: string, text: string) {
    if (!this.phoneNumberId || !this.apiToken) {
      throw new Error('WhatsApp Cloud API credentials are not configured.');
    }

    this.logMessageRequest({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });

    const response = await fetch(
      `https://graph.facebook.com/${config.whatsappApiVersion}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`WhatsApp send failed: ${errorText}`);
    }

    return response.json();
  }

  async sendTemplateMessage(
    to: string,
    template: {
      name: string;
      language: { code: string };
      components?: Array<Record<string, unknown>>;
    },
  ) {
    if (!this.phoneNumberId || !this.apiToken) {
      throw new Error('WhatsApp Cloud API credentials are not configured.');
    }

    this.logMessageRequest({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template,
    });

    return this.requestGraphApi(`${encodeURIComponent(this.phoneNumberId)}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template,
      },
    });
  }

  async sendDirectMessage(
    message: {
      to: string;
      category: 'utility' | 'authentication';
      type: 'text' | 'interactive';
      recipient_type?: 'individual';
      text?: { body: string };
      interactive?: Record<string, unknown>;
      template_name?: string;
    },
  ) {
    if (!this.phoneNumberId || !this.apiToken) {
      throw new Error('WhatsApp Cloud API credentials are not configured.');
    }

    this.logMessageRequest({
      messaging_product: 'whatsapp',
      ...message,
    });

    return this.requestGraphApi(`${encodeURIComponent(this.phoneNumberId)}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        ...message,
      },
    });
  }

  private logMessageRequest(body: Record<string, unknown>) {
    const text = typeof body.text === 'object' && body.text !== null
      ? (body.text as { body?: unknown }).body
      : undefined;
    logger.info(
      {
        method: 'POST',
        url: `https://graph.facebook.com/${config.whatsappApiVersion}/${this.phoneNumberId}/messages`,
        messageType: body.type,
        ...(typeof text === 'string' ? { textLength: text.length } : {}),
      },
      'WhatsApp Graph API request',
    );
  }

  parseIncomingMessage(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const entry = (payload as { entry?: Array<unknown> }).entry?.[0] as
      | { changes?: Array<unknown> }
      | undefined;
    const change = entry?.changes?.[0] as { value?: unknown } | undefined;
    const value = change?.value as
      | { messages?: Array<unknown>; metadata?: unknown }
      | undefined;
    const message = value?.messages?.[0] as
      | {
          from?: unknown;
          type?: unknown;
          id?: unknown;
          timestamp?: unknown;
          text?: { body?: unknown };
        }
      | undefined;

    if (
      typeof message?.from !== 'string' ||
      typeof message.id !== 'string' ||
      typeof message.type !== 'string'
    ) {
      return null;
    }

    return {
      from: message.from,
      type: message.type,
      text: typeof message.text?.body === 'string' ? message.text.body : '',
      id: message.id,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
      metadata: value?.metadata ?? null,
    };
  }

  isConfiguredWebhookTarget(
    payload: unknown,
    phoneNumberId = config.whatsappPhoneNumberId,
    businessAccountId = config.whatsappBusinessAccountId,
  ) {
    if (
      !phoneNumberId ||
      !businessAccountId ||
      !payload ||
      typeof payload !== 'object'
    ) {
      return false;
    }
    const entries = (payload as {
      entry?: Array<{ id?: unknown; changes?: Array<{ value?: { metadata?: unknown } }> }>;
    }).entry;
    return Array.isArray(entries) &&
      entries.length > 0 &&
      entries.every((entry) =>
        entry.id === businessAccountId &&
        Array.isArray(entry.changes) &&
        entry.changes.length > 0 &&
        entry.changes.every((change) => {
          const metadata = change.value?.metadata;
          return typeof metadata === 'object' &&
            metadata !== null &&
            'phone_number_id' in metadata &&
            metadata.phone_number_id === phoneNumberId;
        }),
      );
  }
}
