import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { WhatsAppService } from '../src/modules/whatsapp/whatsapp.service.js';

const webhookSecret = 'test-webhook-secret';
const phoneNumberId = 'phone-number-id-1';
const businessAccountId = 'business-account-id-1';

function signedBody(body: string, secret = webhookSecret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function webhookPayload(
  sender: string,
  targetPhoneNumberId = phoneNumberId,
  targetBusinessAccountId = businessAccountId,
) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: targetBusinessAccountId,
      changes: [{
        value: {
          metadata: { phone_number_id: targetPhoneNumberId },
          messages: [{
            from: sender,
            id: 'wamid.test-message',
            timestamp: '1795250000',
            type: 'text',
            text: { body: 'Owner message' },
          }],
        },
      }],
    }],
  };
}

function createTestApp(options: { accountIdsConfigured?: boolean } = {}) {
  return buildApp({
    whatsappPhoneNumberId: options.accountIdsConfigured === false ? '' : phoneNumberId,
    whatsappBusinessAccountId:
      options.accountIdsConfigured === false ? '' : businessAccountId,
    whatsappWebhookSecret: webhookSecret,
    whatsappVerifyToken: 'test-verify-token',
    ownerUserIdResolver: async () => '00000000-0000-4000-8000-000000000001',
    googleAuthService: {
      beginAuthorization: async () => ({ state: 'test-state', authUrl: 'https://accounts.google.com/' }),
      completeAuthorization: async () => ({ connected: true }),
      validateAuthorizationState: () => undefined,
      getAuthenticatedGoogleClient: async () => {
        throw new Error('Google auth is not used in this test.');
      },
    },
  });
}

test('WhatsApp webhook target matches the configured phone number and business account IDs', () => {
  const service = new WhatsAppService(webhookSecret);
  assert.equal(
    service.isConfiguredWebhookTarget(
      webhookPayload('254700000001'),
      phoneNumberId,
      businessAccountId,
    ),
    true,
  );
  assert.equal(
    service.isConfiguredWebhookTarget(
      webhookPayload('254700000001', 'different-phone-id'),
      phoneNumberId,
      businessAccountId,
    ),
    false,
  );
  assert.equal(
    service.isConfiguredWebhookTarget(
      webhookPayload('254700000001', phoneNumberId, 'different-business-id'),
      phoneNumberId,
      businessAccountId,
    ),
    false,
  );
});

test('Meta webhook verification returns only the valid challenge', async () => {
  const app = await createTestApp();
  try {
    const accepted = await app.inject({
      method: 'GET',
      url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-value',
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body, 'challenge-value');

    const rejected = await app.inject({
      method: 'GET',
      url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-value',
    });
    assert.equal(rejected.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('webhook accepts signed messages from any sender at the configured business number', async () => {
  const app = await createTestApp();
  try {
    const payload = JSON.stringify(webhookPayload('254700000001'));
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signedBody(payload),
      },
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().status, 'received');

    const otherSenderPayload = JSON.stringify(webhookPayload('254700000002'));
    const otherSender = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signedBody(otherSenderPayload),
      },
      payload: otherSenderPayload,
    });
    assert.equal(otherSender.statusCode, 200);
    assert.equal(otherSender.json().status, 'received');

    const wrongTargetPayload = JSON.stringify(
      webhookPayload('254700000001', 'different-phone-id'),
    );
    const wrongTarget = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signedBody(wrongTargetPayload),
      },
      payload: wrongTargetPayload,
    });
    assert.equal(wrongTarget.statusCode, 403);
    assert.deepEqual(wrongTarget.json(), { error: 'whatsapp_target_mismatch' });
  } finally {
    await app.close();
  }
});

test('webhook rejects missing or invalid Meta signatures', async () => {
  const app = await createTestApp();
  try {
    const payload = JSON.stringify(webhookPayload('254700000001'));
    const missing = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalid',
      },
      payload,
    });
    assert.equal(invalid.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('AI owner identity is derived from configured WhatsApp IDs, not request input or env UUID', async (t) => {
  let ownerResolverCalled = false;
  const app = await buildApp({
    whatsappPhoneNumberId: phoneNumberId,
    whatsappBusinessAccountId: businessAccountId,
    whatsappWebhookSecret: webhookSecret,
    ownerUserIdResolver: async () => {
      ownerResolverCalled = true;
      throw Object.assign(new Error('owner resolution test'), {
        statusCode: 503,
        code: 'OWNER_RESOLUTION_TEST',
      });
    },
    googleAuthService: {
      beginAuthorization: async () => ({ state: 'test-state', authUrl: 'https://accounts.google.com/' }),
      completeAuthorization: async () => ({ connected: true }),
      validateAuthorizationState: () => undefined,
      getAuthenticatedGoogleClient: async () => {
        throw new Error('Google auth is not used in this test.');
      },
    },
  });
  try {
    const users = await app.inject({ method: 'POST', url: '/api/users', payload: {} });
    assert.equal(users.statusCode, 404);

    const aiRun = await app.inject({
      method: 'POST',
      url: '/api/ai/run',
      payload: { userId: 'attacker-selected-id', message: 'Hello' },
    });
    assert.equal(aiRun.statusCode, 503);
    assert.equal(aiRun.json().code, 'OWNER_RESOLUTION_TEST');
    assert.equal(ownerResolverCalled, true);
  } finally {
    await app.close();
  }
});

test('missing WhatsApp IDs blocks resolving the owner user', async () => {
  const app = await createTestApp({ accountIdsConfigured: false });
  try {
    const aiRun = await app.inject({
      method: 'POST',
      url: '/api/ai/run',
      payload: { message: 'Hello' },
    });
    assert.equal(aiRun.statusCode, 503);
    assert.equal(aiRun.json().code, 'WHATSAPP_OWNER_NOT_CONFIGURED');
  } finally {
    await app.close();
  }
});
