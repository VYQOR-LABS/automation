import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';

const ownerUserId = '00000000-0000-4000-8000-000000000001';

async function createApp(gmailService: {
  listMessages: (query?: string, maxResults?: number) => Promise<Array<{ id: string; threadId: string }>>;
  getMessage: (id: string) => Promise<Record<string, unknown>>;
  sendMessage: (email: { to: string; cc?: string; bcc?: string; subject: string; body: string }, ownerUserId: string) => Promise<unknown>;
}) {
  return buildApp({
    whatsappPhoneNumberId: 'phone-1',
    whatsappBusinessAccountId: 'business-1',
    whatsappWebhookSecret: 'test-secret',
    ownerUserIdResolver: async () => ownerUserId,
    gmailService,
  });
}

test('Swagger registers Gmail search and send endpoints', async () => {
  const app = await createApp({
    listMessages: async () => [],
    getMessage: async () => ({ id: 'message-1' }),
    sendMessage: async () => ({ id: 'sent-1', threadId: 'thread-1' }),
  });
  await app.ready();
  try {
    const document = app.swagger();
    assert.ok(document.paths?.['/api/google/gmail/messages']);
    assert.ok(document.paths?.['/api/google/gmail/send']);
  } finally {
    await app.close();
  }
});

test('Gmail search returns message metadata and optional bodies', async () => {
  let querySeen: string | undefined;
  let maxResultsSeen: number | undefined;
  const app = await createApp({
    listMessages: async (query, maxResults) => {
      querySeen = query;
      maxResultsSeen = maxResults;
      return [{ id: 'message-1', threadId: 'thread-1' }];
    },
    getMessage: async () => ({
      id: 'message-1',
      threadId: 'thread-1',
      from: 'sender@example.com',
      to: 'owner@example.com',
      subject: 'Server subscription',
      date: 'Tue, 24 Nov 2026 09:00:00 +0000',
      snippet: 'Subscription details',
      body: 'Full subscription details.',
    }),
    sendMessage: async () => ({ id: 'sent-1' }),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/google/gmail/messages?q=subscription&maxResults=3&includeBody=true',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(querySeen, 'subscription');
  assert.equal(maxResultsSeen, 3);
  const payload = response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.tool, 'gmail_search');
  assert.equal(payload.data.messages[0].body, 'Full subscription details.');
  await app.close();
});

test('Gmail send reports ordinary sent messages', async () => {
  let sentOwner: string | undefined;
  const app = await createApp({
    listMessages: async () => [],
    getMessage: async () => ({ id: 'message-1' }),
    sendMessage: async (_email, ownerUserId) => {
      sentOwner = ownerUserId;
      return { id: 'sent-message-1', threadId: 'sent-thread-1' };
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/google/gmail/send',
    payload: {
      to: 'recipient@example.com',
      subject: 'Meeting notes',
      body: 'Here are the notes.',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(sentOwner, ownerUserId);
  assert.deepEqual(response.json(), {
    success: true,
    status: 'sent',
    messageId: 'sent-message-1',
    threadId: 'sent-thread-1',
  });
  await app.close();
});

test('Gmail send distinguishes pending approval from sent email', async () => {
  const app = await createApp({
    listMessages: async () => [],
    getMessage: async () => ({ id: 'message-1' }),
    sendMessage: async () => ({
      status: 'pending',
      approved: false,
      approvalId: 'approval-1',
      approvalEndpoint: '/api/approvals/approval-1/decision',
      message: 'Sensitive email requires approval.',
    }),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/google/gmail/send',
    payload: {
      to: 'recipient@example.com',
      subject: 'Confidential project report',
      body: 'Confidential financial details.',
    },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    success: false,
    status: 'pending',
    approvalRequired: true,
    approvalId: 'approval-1',
    approvalEndpoint: '/api/approvals/approval-1/decision',
    message: 'Sensitive email requires approval.',
  });
  await app.close();
});
