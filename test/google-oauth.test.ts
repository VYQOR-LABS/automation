import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import {
  GoogleAuthError,
  GoogleIntegrationService,
} from '../src/modules/google/google.service.js';

test('builds a fresh offline-consent URL with Gmail read/send and Calendar event scopes', () => {
  const url = new URL(new GoogleIntegrationService().buildAuthUrl());
  const scopes = url.searchParams.get('scope')?.split(' ').sort();

  assert.deepEqual(scopes, [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ]);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://localhost:3020/google/redirect',
  );
  assert.equal(config.googleRedirectUri, 'http://localhost:3020/google/redirect');
});

test('registers the configured Google OAuth redirect callback', async () => {
  const app = await buildApp({
    googleAuthService: {
      beginAuthorization: async () => ({ state: 'test-state', authUrl: 'https://accounts.google.com/' }),
      completeAuthorization: async () => ({ connected: true }),
      validateAuthorizationState: () => {
        throw new GoogleAuthError(
          'GOOGLE_OAUTH_STATE_INVALID',
          'Google authorization state is missing, expired, or invalid.',
        );
      },
      getAuthenticatedGoogleClient: async () => {
        throw new Error('Not used in this callback test.');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/google/redirect',
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      success: false,
      error: {
        code: 'GOOGLE_OAUTH_STATE_INVALID',
        message: 'Google authorization state is missing, expired, or invalid.',
      },
    });
  } finally {
    await app.close();
  }
});

test('starts shared Google connection with an HttpOnly state cookie and preserves the legacy URL route', async () => {
  const app = await buildApp({
    googleAuthService: {
      beginAuthorization: async () => ({
        state: 'state-is-not-logged',
        authUrl: 'https://accounts.google.com/o/oauth2/auth?state=state-is-not-logged',
      }),
      completeAuthorization: async () => ({ connected: true }),
      validateAuthorizationState: () => undefined,
      getAuthenticatedGoogleClient: async () => {
        throw new Error('Not used in this connect test.');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/google/connect',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      authUrl: 'https://accounts.google.com/o/oauth2/auth?state=state-is-not-logged',
    });
    assert.match(response.headers['set-cookie'] as string, /HttpOnly/);
    assert.match(response.headers['set-cookie'] as string, /SameSite=Lax/);
  } finally {
    await app.close();
  }
});

test('OAuth callback does not return the token exchange credentials', async () => {
  let receivedCode: string | undefined;
  const app = await buildApp({
    googleAuthService: {
      beginAuthorization: async () => ({
        state: 'test-state',
        authUrl: 'https://accounts.google.com/',
      }),
      async completeAuthorization(input) {
        receivedCode = input.code;
        return { connected: true };
      },
      validateAuthorizationState(state, cookieState) {
        assert.equal(state, 'test-state');
        assert.equal(cookieState, 'test-state');
      },
      getAuthenticatedGoogleClient: async () => {
        throw new Error('Not used in this callback test.');
      },
    },
  });
  try {
    const connect = await app.inject({
      method: 'GET',
      url: '/api/google/connect',
    });
    const stateCookie = (connect.headers['set-cookie'] as string).split(';')[0];

    const response = await app.inject({
      method: 'GET',
      url: '/google/redirect?code=one-time-code&state=test-state',
      headers: { cookie: stateCookie },
    });

    assert.equal(connect.statusCode, 200);
    assert.equal(stateCookie, 'google_oauth_state=test-state');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      success: true,
      message: 'Google account connected.',
    });
    assert.equal(receivedCode, 'one-time-code');
    assert.match(response.headers['set-cookie'] as string, /Max-Age=0/);
    assert.equal(response.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');
    assert.equal(response.headers.pragma, 'no-cache');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  } finally {
    await app.close();
  }
});
