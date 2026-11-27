import { gmail } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../../config.js';
import { ApprovalService } from '../tools/approval.service.js';
import { GoogleAuthService } from './google.service.js';
import { logGoogleApiRequest } from './google-api-logger.js';

type GmailMessageInput = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
};

type GmailMessagePart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailMessagePart[] | null;
};

type GmailClient = ReturnType<typeof gmail>;
type GmailClientFactory = (authClient: OAuth2Client) => GmailClient;

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getMimeBody(
  part: GmailMessagePart | undefined,
  mimeType: 'text/plain' | 'text/html',
): string | undefined {
  if (!part) {
    return undefined;
  }
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const body = getMimeBody(child, mimeType);
    if (body !== undefined) {
      return body;
    }
  }
  return undefined;
}

export class GmailService {
  constructor(
    private readonly approvalService = new ApprovalService(
      config.features.approvalsEnabled,
      config.approvalTtlMs,
    ),
    private readonly googleAuthService: Pick<GoogleAuthService, 'getAuthenticatedGoogleClient'> =
      new GoogleAuthService(),
    private readonly createGmailClient: GmailClientFactory = (authClient) =>
      gmail({ version: 'v1', auth: authClient }),
  ) {}

  async sendMessage(input: GmailMessageInput, ownerUserId: string) {
    const policy = await this.approvalService.evaluateEmailSend({
      userId: ownerUserId,
      email: input,
    });
    if (!policy.approved) {
      return policy;
    }

    return this.sendValidatedMessage(input, ownerUserId);
  }

  private async sendValidatedMessage(input: GmailMessageInput, ownerUserId: string) {
    if (
      /[\r\n]/.test(input.to) ||
      /[\r\n]/.test(input.cc ?? '') ||
      /[\r\n]/.test(input.bcc ?? '') ||
      /[\r\n]/.test(input.subject)
    ) {
      throw new Error('Email recipients and subject must not contain line breaks.');
    }

    const authClient = await this.googleAuthService.getAuthenticatedGoogleClient();
    const gmailClient = this.createGmailClient(authClient);
    const message = [
      `To: ${input.to}`,
      ...(input.cc ? [`Cc: ${input.cc}`] : []),
      ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
      `Subject: ${input.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.body,
    ].join('\r\n');

    const response = await logGoogleApiRequest({
      service: 'gmail',
      operation: 'users.messages.send',
      request: () => gmailClient.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: Buffer.from(message, 'utf8').toString('base64url'),
        },
      }),
    });

    return response.data;
  }

  async listMessages(query = 'in:inbox', maxResults = 5) {
    const authClient = await this.googleAuthService.getAuthenticatedGoogleClient();
    const gmailClient = this.createGmailClient(authClient);
    const response = await logGoogleApiRequest({
      service: 'gmail',
      operation: 'users.messages.list',
      request: () => gmailClient.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
      }),
      getResultCount: (data) => data.messages?.length ?? 0,
    });

    return response.data.messages ?? [];
  }

  async getMessage(messageId: string, includeBody = true) {
    const authClient = await this.googleAuthService.getAuthenticatedGoogleClient();
    const gmailClient = this.createGmailClient(authClient);
    const response = await logGoogleApiRequest({
      service: 'gmail',
      operation: 'users.messages.get',
      request: () => gmailClient.users.messages.get({
        userId: 'me',
        id: messageId,
        format: includeBody ? 'full' : 'metadata',
        ...(!includeBody ? { metadataHeaders: ['From', 'To', 'Subject', 'Date'] } : {}),
      }),
    });
    const message = response.data;
    const headers = message.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((item) => item.name?.toLowerCase() === name)?.value;
    return {
      id: message.id,
      threadId: message.threadId,
      snippet: message.snippet,
      internalDate: message.internalDate,
      from: header('from'),
      to: header('to'),
      subject: header('subject'),
      date: header('date'),
      ...(includeBody
        ? {
            body: getMimeBody(message.payload, 'text/plain') ??
              getMimeBody(message.payload, 'text/html'),
          }
        : {}),
    };
  }
}
