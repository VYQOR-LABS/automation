import { randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import {
  assertGoogleTokenEncryptionKey,
  decryptGoogleToken,
  encryptGoogleToken,
} from './google-token-crypto.js';
import {
  GoogleAccountAlreadyConnectedError,
  GoogleTokenRepository,
  type StoredGoogleTokens,
} from './google-token.repository.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REFRESH_EARLY_MS = 60_000;

export type GoogleAuthErrorCode =
  | 'GOOGLE_AUTH_NOT_CONFIGURED'
  | 'GOOGLE_TOKEN_STORAGE_NOT_CONFIGURED'
  | 'GOOGLE_ACCOUNT_NOT_CONNECTED'
  | 'GOOGLE_AUTHORIZATION_REVOKED'
  | 'GOOGLE_MISSING_PERMISSIONS'
  | 'GOOGLE_TOKEN_REFRESH_FAILED'
  | 'GOOGLE_TOKEN_EXCHANGE_FAILED'
  | 'GOOGLE_OAUTH_STATE_INVALID'
  | 'GOOGLE_ACCOUNT_ALREADY_CONNECTED';

export class GoogleAuthError extends Error {
  constructor(
    readonly code: GoogleAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

type GoogleOAuthTokenSet = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
};

type OAuthClientFactory = () => OAuth2Client;

export class GoogleAuthService {
  private readonly refreshInFlight = new Map<string, Promise<OAuth2Client>>();

  constructor(
    private readonly tokenRepository = new GoogleTokenRepository(),
    private readonly createOAuthClient: OAuthClientFactory = () => {
      if (!config.googleClientId || !config.googleClientSecret) {
        throw new GoogleAuthError(
          'GOOGLE_AUTH_NOT_CONFIGURED',
          'Google OAuth client has not been configured.',
        );
      }
      return new google.auth.OAuth2(
        config.googleClientId,
        config.googleClientSecret,
        config.googleRedirectUri,
      );
    },
    private readonly encryptionKey = config.googleTokenEncryptionKey,
  ) {}

  buildAuthUrl(state = randomBytes(32).toString('base64url')) {
    const oauth2Client = this.createOAuthClient();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: [...GOOGLE_SCOPES],
    });
  }

  beginAuthorization() {
    try {
      assertGoogleTokenEncryptionKey(this.encryptionKey);
    } catch {
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_STORAGE_NOT_CONFIGURED',
        'Google token encryption is not configured. Set GOOGLE_TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte key.',
      );
    }
    const state = randomBytes(32).toString('base64url');
    return { state, authUrl: this.buildAuthUrl(state) };
  }

  async completeAuthorization(input: {
    code: string;
    state: string;
    cookieState?: string;
  }) {
    this.validateAuthorizationState(input.state, input.cookieState);
    try {
      assertGoogleTokenEncryptionKey(this.encryptionKey);
    } catch {
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_STORAGE_NOT_CONFIGURED',
        'Google token encryption is not configured.',
      );
    }

    const requestId = randomBytes(16).toString('hex');
    const startedAt = Date.now();
    logger.info(
      { requestId, operation: 'oauth.token_exchange', endpoint: TOKEN_ENDPOINT },
      'Google OAuth token request started',
    );

    let tokens: GoogleOAuthTokenSet;
    try {
      const { tokens: receivedTokens } = await this.createOAuthClient().getToken(input.code);
      tokens = receivedTokens;
    } catch (error) {
      logger.error(
        {
          requestId,
          operation: 'oauth.token_exchange',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
          ...this.errorMetadata(error),
        },
        'Google OAuth token request failed',
      );
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_EXCHANGE_FAILED',
        'Google authorization could not be completed.',
      );
    }

    const scopes = this.parseScopes(tokens.scope);
    if (!tokens.access_token || !tokens.refresh_token) {
      logger.error(
        {
          requestId,
          operation: 'oauth.token_exchange',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
          reason: 'offline_credentials_missing',
          scopesGranted: scopes.length,
        },
        'Google OAuth token request returned incomplete credentials',
      );
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_EXCHANGE_FAILED',
        'Google did not provide the access and offline refresh credentials required.',
      );
    }
    try {
      this.assertRequiredScopes(scopes);
    } catch (error) {
      logger.error(
        {
          requestId,
          operation: 'oauth.token_exchange',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
          reason: 'required_scope_missing',
          scopesGranted: scopes.length,
        },
        'Google OAuth token request returned insufficient permissions',
      );
      throw error;
    }

    try {
      await this.tokenRepository.createSharedTokens({
        accessTokenEncrypted: encryptGoogleToken(tokens.access_token, this.encryptionKey),
        refreshTokenEncrypted: encryptGoogleToken(tokens.refresh_token, this.encryptionKey),
        expiresAt: this.expiryDate(tokens.expiry_date),
        scopes,
      });
    } catch (error) {
      if (error instanceof GoogleAccountAlreadyConnectedError) {
        logger.warn(
          {
            requestId,
            operation: 'oauth.token_storage',
            durationMs: Date.now() - startedAt,
            reason: 'shared_account_already_connected',
          },
          'Google OAuth credentials were not stored because a shared account already exists',
        );
        throw new GoogleAuthError(
          'GOOGLE_ACCOUNT_ALREADY_CONNECTED',
          'A shared Google account is already connected.',
        );
      }
      logger.error(
        {
          requestId,
          operation: 'oauth.token_storage',
          durationMs: Date.now() - startedAt,
          ...this.errorMetadata(error),
        },
        'Google OAuth credentials could not be stored',
      );
      throw error;
    }

    logger.info(
      {
        requestId,
        operation: 'oauth.token_exchange',
        endpoint: TOKEN_ENDPOINT,
        durationMs: Date.now() - startedAt,
        scopesGranted: scopes.length,
        refreshTokenStored: true,
      },
      'Google OAuth token request completed',
    );
    return { connected: true };
  }

  validateAuthorizationState(state: string | undefined, cookieState: string | undefined) {
    if (!state || !cookieState || !this.statesMatch(state, cookieState)) {
      throw new GoogleAuthError(
        'GOOGLE_OAUTH_STATE_INVALID',
        'Google authorization state is missing, expired, or invalid.',
      );
    }
  }

  async getAuthenticatedClient(userId = 'shared') {
    try {
      assertGoogleTokenEncryptionKey(this.encryptionKey);
    } catch {
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_STORAGE_NOT_CONFIGURED',
        'Google token encryption is not configured.',
      );
    }

    const startedAt = Date.now();
    logger.info(
      { operation: 'oauth.credentials.get', userId },
      'Shared Google credentials lookup started',
    );
    const current = await this.tokenRepository.findSharedTokens();
    if (!current) {
      logger.warn(
        {
          operation: 'oauth.credentials.get',
          userId,
          durationMs: Date.now() - startedAt,
        },
        'Shared Google credentials are not connected',
      );
      throw new GoogleAuthError(
        'GOOGLE_ACCOUNT_NOT_CONNECTED',
        'A shared Google account has not been connected.',
      );
    }
    try {
      this.assertRequiredScopes(current.scopes);
    } catch (error) {
      if (error instanceof GoogleAuthError &&
        error.code === 'GOOGLE_MISSING_PERMISSIONS') {
        await this.tokenRepository.markSharedAccountRevoked();
      }
      throw error;
    }

    if (current.expiresAt && current.expiresAt.getTime() > Date.now() + REFRESH_EARLY_MS) {
      const client = this.createClientWithAccessToken(
        this.decryptToken(current.accessTokenEncrypted),
      );
      logger.info(
        {
          operation: 'oauth.credentials.get',
          userId,
          accountId: current.accountId,
          durationMs: Date.now() - startedAt,
        },
        'Shared Google credentials lookup completed',
      );
      return client;
    }

    const inFlight = this.refreshInFlight.get(current.accountId);
    if (inFlight) {
      return inFlight;
    }

    const refresh = this.refreshAndCreateClient(current.accountId, userId);
    this.refreshInFlight.set(current.accountId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight.get(current.accountId) === refresh) {
        this.refreshInFlight.delete(current.accountId);
      }
    }
  }

  private async refreshAndCreateClient(accountId: string, userId: string) {
    const requestId = randomBytes(16).toString('hex');
    const startedAt = Date.now();
    logger.info(
      {
        requestId,
        userId,
        accountId,
        operation: 'oauth.refresh_token',
        endpoint: TOKEN_ENDPOINT,
      },
      'Google OAuth refresh-token request started',
    );

    try {
      const stored = await this.tokenRepository.refreshSharedTokens(
        async (current: StoredGoogleTokens) => {
          if (
            current.expiresAt &&
            current.expiresAt.getTime() > Date.now() + REFRESH_EARLY_MS
          ) {
            return {
              accessTokenEncrypted: current.accessTokenEncrypted,
              refreshTokenEncrypted: current.refreshTokenEncrypted ?? undefined,
              expiresAt: current.expiresAt,
              scopes: current.scopes,
            };
          }
          if (!current.refreshTokenEncrypted) {
            throw new GoogleAuthError(
              'GOOGLE_AUTHORIZATION_REVOKED',
              'Google offline authorization is no longer available. Reconnect the Google account.',
            );
          }

          const client = this.createOAuthClient();
          client.setCredentials({
            refresh_token: this.decryptToken(current.refreshTokenEncrypted),
          });
          try {
            const { credentials } = await client.refreshAccessToken();
            if (!credentials.access_token) {
              throw new Error('Google returned no access token during refresh.');
            }
            const scopes = credentials.scope
              ? this.parseScopes(credentials.scope)
              : current.scopes;
            this.assertRequiredScopes(scopes);
            return {
              accessTokenEncrypted: encryptGoogleToken(
                credentials.access_token,
                this.encryptionKey,
              ),
              ...(credentials.refresh_token
                ? {
                    refreshTokenEncrypted: encryptGoogleToken(
                      credentials.refresh_token,
                      this.encryptionKey,
                    ),
                  }
                : {}),
              expiresAt: this.expiryDate(credentials.expiry_date),
              scopes,
            };
          } catch (error) {
            if (this.isInvalidGrant(error)) {
              throw new GoogleAuthError(
                'GOOGLE_AUTHORIZATION_REVOKED',
                'Google authorization was revoked or the refresh token expired. Reconnect the Google account.',
              );
            }
            throw error;
          }
        },
      );
      logger.info(
        {
          requestId,
          userId,
          accountId,
          operation: 'oauth.refresh_token',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
        },
        'Google OAuth refresh-token request completed',
      );
      return this.createClientWithAccessToken(
        this.decryptToken(stored.accessTokenEncrypted),
      );
    } catch (error) {
      if (
        error instanceof GoogleAuthError &&
        (error.code === 'GOOGLE_AUTHORIZATION_REVOKED' ||
          error.code === 'GOOGLE_MISSING_PERMISSIONS')
      ) {
        await this.tokenRepository.markSharedAccountRevoked();
      }
      logger.error(
        {
          requestId,
          userId,
          accountId,
          operation: 'oauth.refresh_token',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
          ...this.errorMetadata(error),
        },
        'Google OAuth refresh-token request failed',
      );
      if (error instanceof GoogleAuthError) {
        throw error;
      }
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_REFRESH_FAILED',
        'Google access could not be refreshed.',
      );
    }
  }

  private createClientWithAccessToken(accessToken: string) {
    const client = this.createOAuthClient();
    client.setCredentials({ access_token: accessToken });
    return client;
  }

  private decryptToken(value: string) {
    try {
      return decryptGoogleToken(value, this.encryptionKey);
    } catch {
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_STORAGE_NOT_CONFIGURED',
        'Stored Google credentials could not be decrypted. Check GOOGLE_TOKEN_ENCRYPTION_KEY.',
      );
    }
  }

  private assertRequiredScopes(scopes: readonly string[]) {
    const granted = new Set(scopes);
    if (!GOOGLE_SCOPES.every((scope) => granted.has(scope))) {
      throw new GoogleAuthError(
        'GOOGLE_MISSING_PERMISSIONS',
        'The connected Google account is missing one or more required permissions. Reconnect the account.',
      );
    }
  }

  private parseScopes(scope: string | null | undefined) {
    return scope?.split(/\s+/).filter(Boolean) ?? [];
  }

  private expiryDate(expiryDate: number | null | undefined) {
    return typeof expiryDate === 'number' && Number.isFinite(expiryDate)
      ? new Date(expiryDate)
      : null;
  }

  private statesMatch(state: string, cookieState: string) {
    const provided = Buffer.from(state);
    const stored = Buffer.from(cookieState);
    return provided.length === stored.length && timingSafeEqual(provided, stored);
  }

  private isInvalidGrant(error: unknown) {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const properties = error as {
      response?: { data?: { error?: unknown } | null } | null;
      message?: unknown;
    };
    return properties.response?.data?.error === 'invalid_grant' ||
      typeof properties.message === 'string' &&
      properties.message.includes('invalid_grant');
  }

  private errorMetadata(error: unknown) {
    if (typeof error !== 'object' || error === null) {
      return {};
    }
    const properties = error as {
      code?: unknown;
      response?: { status?: unknown } | null;
    };
    return {
      ...(typeof properties.response?.status === 'number'
        ? { statusCode: properties.response.status }
        : {}),
      ...(typeof properties.code === 'string'
        ? { errorCode: properties.code }
        : {}),
    };
  }
}

export { GoogleAuthService as GoogleIntegrationService };
