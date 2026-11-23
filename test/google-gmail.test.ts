import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gmail } from '@googleapis/gmail';
import { google } from 'googleapis';
import { GmailService } from '../src/modules/google/gmail.service.js';
import { ApprovalService } from '../src/modules/tools/approval.service.js';

function createGmailService() {
  const authClient = new google.auth.OAuth2(
    'test-client-id',
    'test-client-secret',
    'http://localhost:3020/google/redirect',
  );
  const gmailClient = gmail({ version: 'v1', auth: authClient });
  const service = new GmailService(
    new ApprovalService(true),
    {
      async getAuthenticatedGoogleClient() {
        return authClient;
      },
    },
    () => gmailClient,
  );
  return {
    authClient,
    gmailClient,
    service,
  };
}

test('Gmail search uses the shared authenticated client and returns actual message/thread IDs', async (t) => {
  const { gmailClient, service } = createGmailService();
  let requestQuery: string | null | undefined;
  t.mock.method(gmailClient.users.messages, 'list', async (params) => {
    requestQuery = params.q;
    return {
      status: 200,
      data: {
        messages: [
          { id: 'message-1', threadId: 'thread-1' },
          { id: 'message-2', threadId: 'thread-2' },
        ],
      },
    };
  });

  const messages = await service.listMessages('from:example.com subject:invoice', 10);
  assert.equal(requestQuery, 'from:example.com subject:invoice');
  assert.deepEqual(messages, [
    { id: 'message-1', threadId: 'thread-1' },
    { id: 'message-2', threadId: 'thread-2' },
  ]);
});

test('Gmail read decodes the text/plain MIME part and returns message metadata', async (t) => {
  const { gmailClient, service } = createGmailService();
  const text = 'Hello from a nested MIME message.';
  t.mock.method(gmailClient.users.messages, 'get', async () => ({
    status: 200,
    data: {
      id: 'message-1',
      threadId: 'thread-1',
      snippet: 'Hello from a nested message.',
      internalDate: '1795190000000',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'recipient@example.com' },
          { name: 'Subject', value: 'A test message' },
          { name: 'Date', value: 'Fri, 20 Nov 2026 10:00:00 +0000' },
        ],
        parts: [
          {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>HTML</p>').toString('base64url') },
          },
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from(text).toString('base64url') },
          },
        ],
      },
    },
  }));

  assert.deepEqual(await service.getMessage('message-1'), {
    id: 'message-1',
    threadId: 'thread-1',
    snippet: 'Hello from a nested message.',
    internalDate: '1795190000000',
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'A test message',
    date: 'Fri, 20 Nov 2026 10:00:00 +0000',
    body: text,
  });
});

test('ordinary Gmail send submits a MIME-encoded message without approval', async (t) => {
  const { gmailClient, service } = createGmailService();
  let sentRaw: string | undefined;
  t.mock.method(gmailClient.users.messages, 'send', async (params) => {
    sentRaw = params.requestBody?.raw ?? undefined;
    return { status: 200, data: { id: 'sent-message-1', threadId: 'sent-thread-1' } };
  });

  const result = await service.sendMessage(
    {
      to: 'recipient@example.com',
      cc: 'copy@example.com',
      bcc: 'blindcopy@example.com',
      subject: 'Meeting notes',
      body: 'Here are the notes.',
    },
    'app-user',
  );

  assert.deepEqual(result, { id: 'sent-message-1', threadId: 'sent-thread-1' });
  assert.ok(sentRaw);
  const raw = Buffer.from(sentRaw, 'base64url').toString('utf8');
  assert.match(raw, /To: recipient@example\.com/);
  assert.match(raw, /Cc: copy@example\.com/);
  assert.match(raw, /Bcc: blindcopy@example\.com/);
  assert.match(raw, /Subject: Meeting notes/);
  assert.match(raw, /Here are the notes\./);
});
