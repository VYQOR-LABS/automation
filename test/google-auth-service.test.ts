import assert from 'node:assert/strict';
import { test } from 'node:test';
import { google } from 'googleapis';
import {
  GoogleAuthError,
  GoogleAuthService,
  GOOGLE_SCOPES,
} from '../src/modules/google/google.service.js';
import type {
  GoogleCredentialsToStore,
  GoogleStoredCredentials,
  GoogleTokenStore,
} from '../src/modules/google/google-token-store.js';
import { GoogleTokenStoreError } from '../src/modules/google/google-token-store.js';

const refreshToken = 'environment-refresh-token';
const futureExpiry = Date.now() + 60 * 60 * 1000;

function createOAuthClient() {
  return new google.auth.OAuth2(
    'test-client-id',
    'test-client-secret',
    'http://localhost:3020/google/redirect',
  );
}

class InMemoryGoogleTokenStore implements GoogleTokenStore {
  credentials: GoogleStoredCredentials | null = null;

  async getSharedCredentials() {
    return this.credentials;
  }

  async saveSharedCredentials(credentials: GoogleCredentialsToStore) {
    this.credentials = {
      ...credentials,
      refreshToken: credentials.refreshToken ?? this.credentials?.refreshToken ?? null,
      tokenType: credentials.tokenType ?? 'Bearer',
    };
  }
}

test('OAuth authorization URL requests offline access and the required Google scopes', async () => {
  const service = new GoogleAuthService(
    createOAuthClient,
    refreshToken,
    new InMemoryGoogleTokenStore(),
  );
  const { state, authUrl } = await service.beginAuthorization();
  const url = new URL(authUrl);

  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), null);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(url.searchParams.get('state'), state);
  assert.deepEqual(url.searchParams.get('scope')?.split(' ').sort(), [...GOOGLE_SCOPES].sort());
});

test('initial OAuth authorization prompts for consent to obtain a refresh token', async () => {
  const service = new GoogleAuthService(createOAuthClient, '', new InMemoryGoogleTokenStore());
  const { authUrl } = await service.beginAuthorization();
  assert.equal(new URL(authUrl).searchParams.get('prompt'), 'consent');
});

test('OAuth callback persists credentials and immediately authorizes the running service', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {
      access_token: 'plain-access-token',
      refresh_token: 'plain-refresh-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const tokenStore = new InMemoryGoogleTokenStore();
  const service = new GoogleAuthService(() => oauthClient, refreshToken, tokenStore);
  const { state } = await service.beginAuthorization();

  assert.deepEqual(await service.completeAuthorization({
    code: 'one-time-code',
    state,
    cookieState: state,
  }), {
    connected: true,
  });
  assert.equal(tokenStore.credentials?.accessToken, 'plain-access-token');
  assert.equal(tokenStore.credentials?.refreshToken, 'plain-refresh-token');
  const client = await service.getAuthenticatedGoogleClient();
  assert.equal(client.credentials.access_token, 'plain-access-token');
  assert.equal(client.credentials.refresh_token, 'plain-refresh-token');
});

test('OAuth callback fails instead of reporting connected when persistence fails', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {
      access_token: 'plain-access-token',
      refresh_token: 'plain-refresh-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const tokenStore: GoogleTokenStore = {
    async getSharedCredentials() {
      return null;
    },
    async saveSharedCredentials() {
      throw new Error('database unavailable');
    },
  };
  const service = new GoogleAuthService(() => oauthClient, '', tokenStore);

  await assert.rejects(
    service.completeAuthorization({
      code: 'one-time-code',
      state: 'valid-state',
      cookieState: 'valid-state',
    }),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_TOKEN_PERSISTENCE_FAILED',
  );
});

test('OAuth callback preserves the environment refresh token when Google omits a replacement', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {
      access_token: 'replacement-access-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const tokenStore = new InMemoryGoogleTokenStore();
  tokenStore.credentials = {
    accessToken: 'previous-access-token',
    refreshToken: 'previous-refresh-token',
    expiresAt: Date.now() - 1,
    scopes: [...GOOGLE_SCOPES],
    tokenType: 'Bearer',
  };
  const service = new GoogleAuthService(
    () => oauthClient,
    'previous-refresh-token',
    tokenStore,
  );

  await service.completeAuthorization({
    code: 'one-time-code',
    state: 'valid-state',
    cookieState: 'valid-state',
  });

  assert.equal(tokenStore.credentials?.accessToken, 'replacement-access-token');
  assert.equal(tokenStore.credentials?.refreshToken, 'previous-refresh-token');
});

test('OAuth can recreate credentials when a shared account has no token record', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  let savedCredentials: GoogleCredentialsToStore | undefined;
  const tokenStore: GoogleTokenStore = {
    async getSharedCredentials() {
      throw new GoogleTokenStoreError(
        'GOOGLE_CREDENTIALS_NOT_FOUND',
        'No token row exists.',
      );
    },
    async saveSharedCredentials(credentials) {
      savedCredentials = credentials;
    },
  };
  const service = new GoogleAuthService(() => oauthClient, '', tokenStore);
  const { state, authUrl } = await service.beginAuthorization();
  assert.equal(new URL(authUrl).searchParams.get('prompt'), 'consent');

  await service.completeAuthorization({
    code: 'one-time-code',
    state,
    cookieState: state,
  });

  assert.equal(savedCredentials?.refreshToken, 'new-refresh-token');
});

test('OAuth callback rejects invalid state before exchanging a code', async (t) => {
  const oauthClient = createOAuthClient();
  const exchange = t.mock.method(oauthClient, 'getToken', async () => ({
    tokens: {},
  }));
  const service = new GoogleAuthService(() => oauthClient, refreshToken, new InMemoryGoogleTokenStore());

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

test('client retrieval requires an environment refresh token or OAuth authorization', async () => {
  const service = new GoogleAuthService(createOAuthClient, '', new InMemoryGoogleTokenStore());

  await assert.rejects(
    service.getAuthenticatedGoogleClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED',
  );
});

test('client retrieval refreshes an access token from the callback refresh token', async (t) => {
  const oauthClient = createOAuthClient();
  let tokenInfoAccessToken: string | undefined;
  t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'new-access-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  t.mock.method(oauthClient, 'getTokenInfo', async (accessToken: string) => {
    tokenInfoAccessToken = accessToken;
    return {
      aud: 'test-client-id',
      scopes: [...GOOGLE_SCOPES],
      expiry_date: futureExpiry,
    };
  });
  const tokenStore = new InMemoryGoogleTokenStore();
  const service = new GoogleAuthService(() => oauthClient, refreshToken, tokenStore);

  const client = await service.getAuthenticatedGoogleClient();
  assert.equal(client.credentials.access_token, 'new-access-token');
  assert.equal(client.credentials.refresh_token, refreshToken);
  assert.equal(tokenInfoAccessToken, undefined);
  assert.equal(tokenStore.credentials?.accessToken, 'new-access-token');
  assert.equal(tokenStore.credentials?.refreshToken, refreshToken);
});

test('client retrieval restores a valid access token from persistent credentials after restart', async (t) => {
  const oauthClient = createOAuthClient();
  const refresh = t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'unexpected-refresh-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const tokenStore = new InMemoryGoogleTokenStore();
  tokenStore.credentials = {
    accessToken: 'persisted-access-token',
    refreshToken: 'persisted-refresh-token',
    expiresAt: futureExpiry,
    scopes: [...GOOGLE_SCOPES],
    tokenType: 'Bearer',
  };
  const restartedService = new GoogleAuthService(() => oauthClient, '', tokenStore);

  const client = await restartedService.getAuthenticatedGoogleClient();

  assert.equal(client.credentials.access_token, 'persisted-access-token');
  assert.equal(client.credentials.refresh_token, 'persisted-refresh-token');
  assert.equal(refresh.mock.callCount(), 0);
});

test('client retrieval refreshes persisted expired credentials and saves the update', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'updated-access-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const tokenStore = new InMemoryGoogleTokenStore();
  tokenStore.credentials = {
    accessToken: 'expired-access-token',
    refreshToken: 'persisted-refresh-token',
    expiresAt: Date.now() - 1,
    scopes: [...GOOGLE_SCOPES],
    tokenType: 'Bearer',
  };
  const restartedService = new GoogleAuthService(() => oauthClient, '', tokenStore);

  const client = await restartedService.getAuthenticatedGoogleClient();

  assert.equal(client.credentials.access_token, 'updated-access-token');
  assert.equal(tokenStore.credentials?.accessToken, 'updated-access-token');
  assert.equal(tokenStore.credentials?.refreshToken, 'persisted-refresh-token');
});

test('client retrieval fails when refreshed credentials cannot be persisted', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'new-access-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES.join(' '),
    },
  }));
  const tokenStore: GoogleTokenStore = {
    async getSharedCredentials() {
      return null;
    },
    async saveSharedCredentials() {
      throw new Error('database unavailable');
    },
  };
  const service = new GoogleAuthService(() => oauthClient, refreshToken, tokenStore);

  await assert.rejects(
    service.getAuthenticatedGoogleClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_TOKEN_PERSISTENCE_FAILED',
  );
});

test('client retrieval verifies granted scopes when refresh response omits scope', async (t) => {
  const oauthClient = createOAuthClient();
  let tokenInfoAccessToken: string | undefined;
  t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'new-access-token',
      expiry_date: futureExpiry,
    },
  }));
  t.mock.method(oauthClient, 'getTokenInfo', async (accessToken: string) => {
    tokenInfoAccessToken = accessToken;
    return { scopes: [...GOOGLE_SCOPES] };
  });
  const service = new GoogleAuthService(() => oauthClient, refreshToken, new InMemoryGoogleTokenStore());

  const client = await service.getAuthenticatedGoogleClient();
  assert.equal(client.credentials.access_token, 'new-access-token');
  assert.equal(tokenInfoAccessToken, 'new-access-token');
});

test('insufficient OAuth permissions fail rather than returning an authenticated client', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'refreshAccessToken', async () => ({
    credentials: {
      access_token: 'new-access-token',
      expiry_date: futureExpiry,
      scope: GOOGLE_SCOPES[0],
    },
  }));
  const service = new GoogleAuthService(() => oauthClient, refreshToken, new InMemoryGoogleTokenStore());

  await assert.rejects(
    service.getAuthenticatedGoogleClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_MISSING_PERMISSIONS',
  );
});

test('invalid_grant reports revoked Google authorization', async (t) => {
  const oauthClient = createOAuthClient();
  t.mock.method(oauthClient, 'refreshAccessToken', async () => {
    throw Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
  });
  const service = new GoogleAuthService(() => oauthClient, refreshToken, new InMemoryGoogleTokenStore());

  await assert.rejects(
    service.getAuthenticatedGoogleClient(),
    (error) => error instanceof GoogleAuthError &&
      error.code === 'GOOGLE_AUTHORIZATION_REVOKED',
  );
});

test('concurrent client retrievals share a single token refresh', async (t) => {
  const oauthClient = createOAuthClient();
  let refreshCount = 0;
  t.mock.method(oauthClient, 'refreshAccessToken', async () => {
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      credentials: {
        access_token: 'new-access-token',
        expiry_date: futureExpiry,
        scope: GOOGLE_SCOPES.join(' '),
      },
    };
  });
  const service = new GoogleAuthService(() => oauthClient, refreshToken, new InMemoryGoogleTokenStore());

  const [first, second] = await Promise.all([
    service.getAuthenticatedGoogleClient(),
    service.getAuthenticatedGoogleClient(),
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(first.credentials.access_token, 'new-access-token');
  assert.equal(second.credentials.access_token, 'new-access-token');
});
