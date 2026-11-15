import crypto from 'node:crypto';
import { config } from '../../config.js';

export class WhatsAppService {
  private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  private readonly apiToken = process.env.WHATSAPP_API_TOKEN ?? '';

  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string) {
    if (!config.whatsappWebhookSecret || !signatureHeader) {
      return false;
    }

    const expected = `sha256=${crypto
      .createHmac('sha256', config.whatsappWebhookSecret)
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

    const response = await fetch(
      `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`,
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
}
