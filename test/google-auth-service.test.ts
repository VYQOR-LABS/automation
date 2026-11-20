import assert from 'node:assert/strict';
import { test } from 'node:test';
import { google } from 'googleapis';
import { GoogleAuthError, GoogleAuthService, GOOGLE_SCOPES } from '../src/modules/google/google.service.js';
import {
  decryptGoogleToken,
  encryptGoogleToken,
} from '../src/modules/google/google-token-crypto.js';
import {
  GoogleAccountAlreadyConnectedError,
  GoogleTokenRepository,
  type EncryptedGoogleTokens,
  type StoredGoogleTokens,
} from '../src/modules/google/google-token.repository.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const futureExpiry = new Date(Date.now() + 60 * 60 * 1000);

class InMemoryGoogleTokenRepository extends GoogleTokenRepository {
  tokens: StoredGoogleTokens | null = null;
  revoked = false;
  refreshCount = 0;

  override async findSharedTokens() {
    return this.tokens;
  }

  override async createSharedTokens(tokens: EncryptedGoogleTokens) {
    if (this.tokens) {
      throw new GoogleAccountAlreadyConnectedError();
    }
    this.tokens = {
      ...tokens,
      accountId: 'shared-google-account',
      refreshTokenEncrypted: tokens.refreshTokenEncrypted ?? null,
    };
  }

  override async refreshSharedTokens(
    refresh: (tokens: StoredGoogleTokens) => Promise<EncryptedGoogleTokens>,
  ) {
    if (!this.tokens) {
      throw new Error('Google account is not connected.');
    }
    this.refreshCount += 1;
    const updated = await refresh(this.tokens);
    this.tokens = {
      ...this.tokens,
      ...updated,
      refreshTokenEncrypted: updated.refreshTokenEncrypted ??
        this.tokens.refreshTokenEncrypted,
    };
    return this.tokens;
  }

  override async markSharedAccountRevoked() {
    this.revoked = true;
    this.tokens = null;
  }
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    'test-client-id',
    'test-client-secret',
    'http://localhost:3020/google/redirect',
  );
}

test('OAuth authorization URL requests offline access and the required Google scopes', () => {
  const service = new GoogleAuthService(
    new InMemoryGoogleTokenRepository(),
    createOAuthClient,
    encryptionKey,
  );
  const { state, authUrl } = service.beginAuthorization();
  const url = new URL(authUrl);

  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), state);
  assert.deepEqual(url.searchParams.get('scope')?.split(' ').sort(), [...GOOGLE_SCOPES].sort());
});

test('OAuth callback validates state and persists encrypted access and refresh tokens', async (t) => {
  const repository = new InMemoryGoogleTokenRepository();
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {
      access_token: 'plain-access-token',
      refresh_token: 'plain-refresh-token',
      expiry_date: futureExpiry.getTime(),
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const service = new GoogleAuthService(
    repository,
    () => oauthClient,
    encryptionKey,
  );
  const { state } = service.beginAuthorization();

  assert.deepEqual(
    await service.completeAuthorization({
      code: 'one-time-code',
      state,
      cookieState: state,
    }),
    { connected: true },
  );
  assert.ok(repository.tokens);
  assert.notEqual(repository.tokens.accessTokenEncrypted, 'plain-access-token');
  assert.notEqual(repository.tokens.refreshTokenEncrypted, 'plain-refresh-token');
  assert.equal(
    decryptGoogleToken(repository.tokens.accessTokenEncrypted, encryptionKey),
    'plain-access-token',
  );
  assert.equal(
    decryptGoogleToken(repository.tokens.refreshTokenEncrypted!, encryptionKey),
    'plain-refresh-token',
  );
  assert.deepEqual(repository.tokens.scopes, [...GOOGLE_SCOPES]);
});

test('OAuth callback rejects invalid state before exchanging a code', async (t) => {
  const oauthClient = createOAuthClient();
  const exchange = t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {},
  }));
  const service = new GoogleAuthService(
    new InMemoryGoogleTokenRepository(),
    () => oauthClient,
    encryptionKey,
  );

  await assert.rejects(
    service.completeAuthorization({
      code: 'one-time-code',
      state: 'attacker-state',
      cookieState: 'browser-state',
    }),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_OAUTH_STATE_INVALID',
  );
  assert.equal(exchange.mock.callCount(), 0);
});

test('Google client retrieval reports an unconnected shared account', async () => {
  const service = new GoogleAuthService(
    new InMemoryGoogleTokenRepository(),
    createOAuthClient,
    encryptionKey,
  );

  await assert.rejects(
    service.getAuthenticatedClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED',
  );
});

test('expired access credentials refresh and preserve the stored refresh token', async (t) => {
  const repository = new InMemoryGoogleTokenRepository();
  repository.tokens = {
    accountId: 'shared-google-account',
    accessTokenEncrypted: encryptGoogleToken('expired-access-token', encryptionKey),
    refreshTokenEncrypted: encryptGoogleToken('stable-refresh-token', encryptionKey),
    expiresAt: new Date(Date.now() - 1000),
    scopes: [...GOOGLE_SCOPES],
  };
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'new-access-token',
      expiry_date: futureExpiry.getTime(),
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const service = new GoogleAuthService(
    repository,
    () => oauthClient,
    encryptionKey,
  );

  const client = await service.getAuthenticatedClient();
  assert.equal(client.credentials.access_token, 'new-access-token');
  assert.equal(repository.refreshCount, 1);
  assert.equal(
    decryptGoogleToken(repository.tokens!.accessTokenEncrypted, encryptionKey),
    'new-access-token',
  );
  assert.equal(
    decryptGoogleToken(repository.tokens!.refreshTokenEncrypted!, encryptionKey),
    'stable-refresh-token',
  );
});

test('concurrent access-token refreshes share one refresh operation', async (t) => {
  const repository = new InMemoryGoogleTokenRepository();
  repository.tokens = {
    accountId: 'shared-google-account',
    accessTokenEncrypted: encryptGoogleToken('expired-access-token', encryptionKey),
    refreshTokenEncrypted: encryptGoogleToken('stable-refresh-token', encryptionKey),
    expiresAt: new Date(Date.now() - 1000),
    scopes: [...GOOGLE_SCOPES],
  };
  const oauthClient = createOAuthClient();
  let refreshCount = 0;
  t.mock.method(oauthClient, 'refreshAccessToken', async () => {
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      credentials: {
        access_token: 'new-access-token',
        expiry_date: futureExpiry.getTime(),
        scope: GOOGLE_SCOPES.join(' '),
      },
    };
  });
  const service = new GoogleAuthService(
    repository,
    () => oauthClient,
    encryptionKey,
  );

  const [first, second] = await Promise.all([
    service.getAuthenticatedClient(),
    service.getAuthenticatedClient(),
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(first.credentials.access_token, 'new-access-token');
  assert.equal(second.credentials.access_token, 'new-access-token');
});

test('invalid_grant marks the shared Google authorization revoked', async (t) => {
  const repository = new InMemoryGoogleTokenRepository();
  repository.tokens = {
    accountId: 'shared-google-account',
    accessTokenEncrypted: encryptGoogleToken('expired-access-token', encryptionKey),
    refreshTokenEncrypted: encryptGoogleToken('invalid-refresh-token', encryptionKey),
    expiresAt: new Date(Date.now() - 1000),
    scopes: [...GOOGLE_SCOPES],
  };
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'refreshAccessToken', async () => {
    throw Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
  });
  const service = new GoogleAuthService(
    repository,
    () => oauthClient,
    encryptionKey,
  );

  await assert.rejects(
    service.getAuthenticatedClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_AUTHORIZATION_REVOKED',
  );
  assert.equal(repository.revoked, true);
});

test('connected credentials missing a required scope are rejected', async () => {
  const repository = new InMemoryGoogleTokenRepository();
  repository.tokens = {
    accountId: 'shared-google-account',
    accessTokenEncrypted: encryptGoogleToken('access-token', encryptionKey),
    refreshTokenEncrypted: encryptGoogleToken('refresh-token', encryptionKey),
    expiresAt: futureExpiry,
    scopes: [GOOGLE_SCOPES[0]!],
  };
  const service = new GoogleAuthService(
    repository,
    createOAuthClient,
    encryptionKey,
  );

  await assert.rejects(
    service.getAuthenticatedClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_MISSING_PERMISSIONS',
  );
});

