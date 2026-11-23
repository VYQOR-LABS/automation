import { randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import {
  EncryptedGoogleTokenStore,
  GoogleTokenStoreError,
  type GoogleStoredCredentials,
  type GoogleTokenStore,
} from './google-token-store.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REFRESH_EARLY_MS = 60_000;

export type GoogleAuthErrorCode =
  | 'GOOGLE_AUTH_NOT_CONFIGURED'
  | 'GOOGLE_ACCOUNT_NOT_CONNECTED'
  | 'GOOGLE_CREDENTIALS_NOT_FOUND'
  | 'GOOGLE_CREDENTIALS_LOAD_FAILED'
  | 'GOOGLE_TOKEN_DECRYPTION_FAILED'
  | 'GOOGLE_REFRESH_TOKEN_MISSING'
  | 'GOOGLE_TOKEN_PERSISTENCE_FAILED'
  | 'GOOGLE_AUTHORIZATION_REVOKED'
  | 'GOOGLE_MISSING_PERMISSIONS'
  | 'GOOGLE_TOKEN_REFRESH_FAILED'
  | 'GOOGLE_TOKEN_EXCHANGE_FAILED'
  | 'GOOGLE_OAUTH_STATE_INVALID';

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
  private credentialsLoadInFlight: Promise<GoogleStoredCredentials | null> | undefined;
  private refreshInFlight: Promise<OAuth2Client> | undefined;
  private authenticatedClient: OAuth2Client | undefined;
  private credentials: GoogleStoredCredentials | null = null;
  private credentialsLoaded = false;
  private refreshToken: string;

  constructor(
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
    refreshToken = config.googleRefreshToken,
    private readonly tokenStore: GoogleTokenStore = new EncryptedGoogleTokenStore(),
  ) {
    this.refreshToken = refreshToken;
  }

  buildAuthUrl(state = randomBytes(32).toString('base64url')) {
    const oauth2Client = this.createOAuthClient();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      ...(this.refreshToken.trim() ? {} : { prompt: 'consent' }),
      include_granted_scopes: true,
      state,
      scope: [...GOOGLE_SCOPES],
    });
  }

  async beginAuthorization() {
    await this.loadStoredCredentials(true);
    const state = randomBytes(32).toString('base64url');
    return { state, authUrl: this.buildAuthUrl(state) };
  }

  async completeAuthorization(input: {
    code: string;
    state: string;
    cookieState?: string;
  }) {
    this.validateAuthorizationState(input.state, input.cookieState);
    await this.loadStoredCredentials(true);

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
    const refreshToken = tokens.refresh_token?.trim() ||
      this.credentials?.refreshToken || this.refreshToken;
    if (!tokens.access_token || !refreshToken) {
      logger.error(
        {
          requestId,
          operation: 'oauth.token_exchange',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
          reason: tokens.access_token ? 'refresh_token_missing' : 'access_token_missing',
          scopesGranted: scopes.length,
        },
        'Google OAuth token request returned incomplete credentials',
      );
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_EXCHANGE_FAILED',
        'Google did not provide usable access credentials. Reauthorize with offline access.',
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

    const storedCredentials: GoogleStoredCredentials = {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: this.expiryTimestamp(tokens.expiry_date),
      scopes,
      tokenType: tokens.token_type ?? 'Bearer',
    };
    await this.saveStoredCredentials(storedCredentials);
    this.refreshToken = refreshToken;
    this.credentials = storedCredentials;
    this.credentialsLoaded = true;
    this.authenticatedClient = this.createClientWithCredentials(storedCredentials);

    logger.info(
      {
        requestId,
        operation: 'oauth.token_exchange',
        endpoint: TOKEN_ENDPOINT,
        durationMs: Date.now() - startedAt,
        scopesGranted: scopes.length,
        refreshTokenReceived: Boolean(tokens.refresh_token),
        refreshTokenPreserved: !tokens.refresh_token,
      },
      'Google OAuth authorization completed',
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

  async getAuthenticatedGoogleClient() {
    await this.loadStoredCredentials();
    const authClientConfigured = Boolean(
      config.googleClientId.trim() && config.googleClientSecret.trim(),
    );
    logger.info(
      {
        operation: 'oauth.credentials.get',
        authClientConfigured,
        sharedIntegrationAccountFound: Boolean(this.credentials),
        oauthTokenRecordFound: Boolean(this.credentials),
        refreshTokenPresent: Boolean(this.refreshToken.trim()),
        authenticatedClientPresent: Boolean(this.authenticatedClient),
        inMemoryCredentialsPresent: Boolean(this.credentials),
      },
      'Shared Google credentials lookup started',
    );
    if (this.credentials?.accessToken) {
      const accessTokenValid = this.credentials.expiresAt !== null &&
        this.credentials.expiresAt > Date.now() + REFRESH_EARLY_MS;
      logger.info(
        {
          operation: 'oauth.credentials.validity',
          accessTokenValid,
          accessTokenExpiredOrExpiring: !accessTokenValid,
        },
        accessTokenValid
          ? 'Google access token is valid'
          : 'Google access token is expired or approaching expiry',
      );
      if (accessTokenValid) {
        this.authenticatedClient ??= this.createClientWithCredentials(this.credentials);
        logger.info(
          { operation: 'oauth.credentials.client', created: true },
          'Authenticated Google client created successfully',
        );
        return this.authenticatedClient;
      }
    }
    if (!this.refreshToken.trim()) {
      const code = this.credentials
        ? 'GOOGLE_REFRESH_TOKEN_MISSING'
        : 'GOOGLE_ACCOUNT_NOT_CONNECTED';
      logger.error(
        {
          operation: 'oauth.credentials.get',
          failureCode: code,
          failureStage: 'refresh_token_precondition',
          reason: 'refresh_token_missing',
          authClientConfigured,
          refreshTokenPresent: false,
          authenticatedClientPresent: Boolean(this.authenticatedClient),
          inMemoryCredentialsPresent: Boolean(this.credentials),
        },
        'Google credentials unavailable before API request',
      );
      throw new GoogleAuthError(
        code,
        code === 'GOOGLE_REFRESH_TOKEN_MISSING'
          ? 'The stored Google credentials do not include a refresh token. Reauthorize Google.'
          : 'A shared Google account is not connected. Start authorization at GET /api/google/connect.',
      );
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const refresh = this.refreshAndCreateClient();
    this.refreshInFlight = refresh;
    try {
      this.authenticatedClient = await refresh;
      logger.info(
        { operation: 'oauth.credentials.client', created: true },
        'Authenticated Google client created successfully',
      );
      return this.authenticatedClient;
    } finally {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = undefined;
      }
    }
  }

  private async refreshAndCreateClient() {
    const requestId = randomBytes(16).toString('hex');
    const startedAt = Date.now();
    logger.info(
      {
        requestId,
        operation: 'oauth.refresh_token',
        endpoint: TOKEN_ENDPOINT,
      },
      'Google OAuth refresh-token request started',
    );

    try {
      const client = this.createOAuthClient();
      client.setCredentials({ refresh_token: this.refreshToken });
      let credentials: OAuth2Client['credentials'];
      try {
        ({ credentials } = await client.refreshAccessToken());
      } catch (error) {
        if (this.isInvalidGrant(error)) {
          throw new GoogleAuthError(
            'GOOGLE_AUTHORIZATION_REVOKED',
            'Google authorization was revoked or the refresh token expired. Reauthorize Google.',
          );
        }
        throw error;
      }

      logger.info(
        {
          requestId,
          operation: 'oauth.refresh_token',
          endpoint: TOKEN_ENDPOINT,
          tokenEndpointSucceeded: true,
        },
        'Google OAuth refresh request succeeded',
      );
      if (!credentials.access_token) {
        throw new Error('Google returned no access token during refresh.');
      }
      const tokenInfo = credentials.scope && credentials.expiry_date
        ? undefined
        : await client.getTokenInfo(credentials.access_token);
      const scopes = tokenInfo?.scopes ?? this.parseScopes(credentials.scope);
      this.assertRequiredScopes(scopes);
      const updatedCredentials: GoogleStoredCredentials = {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token?.trim() || this.refreshToken,
        expiresAt: this.expiryTimestamp(credentials.expiry_date ?? tokenInfo?.expiry_date),
        scopes,
        tokenType: credentials.token_type ?? this.credentials?.tokenType ?? 'Bearer',
      };
      await this.saveStoredCredentials(updatedCredentials);
      this.credentials = updatedCredentials;
      this.refreshToken = updatedCredentials.refreshToken ?? '';

      logger.info(
        {
          requestId,
          operation: 'oauth.refresh_token',
          endpoint: TOKEN_ENDPOINT,
          durationMs: Date.now() - startedAt,
          scopesGranted: scopes.length,
          refreshTokenRotated: Boolean(credentials.refresh_token),
          tokenEndpointSucceeded: true,
        },
        'Shared Google credentials refreshed and ready for use',
      );
      return this.createClientWithCredentials(updatedCredentials);
    } catch (error) {
      logger.error(
        {
          requestId,
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

  private async loadStoredCredentials(allowMissingTokenRecord = false) {
    if (this.credentialsLoaded) {
      return this.credentials;
    }
    if (this.credentialsLoadInFlight) {
      return this.credentialsLoadInFlight;
    }

    const loading = (async () => {
      const authClientConfigured = Boolean(
        config.googleClientId.trim() && config.googleClientSecret.trim(),
      );
      logger.info(
        {
          operation: 'oauth.credentials.load',
          authClientConfigured,
          configuredRedirectUri: config.googleRedirectUri,
        },
        'Loading shared Google credentials',
      );
      try {
        this.credentials = await this.tokenStore.getSharedCredentials();
        if (this.credentials?.refreshToken) {
          this.refreshToken = this.credentials.refreshToken;
        }
        this.credentialsLoaded = true;
        logger.info(
          {
            operation: 'oauth.credentials.load',
            sharedIntegrationAccountFound: Boolean(this.credentials),
            oauthTokenRecordFound: Boolean(this.credentials),
            refreshTokenPresent: Boolean(this.refreshToken.trim()),
          },
          this.credentials
            ? 'Shared Google credentials loaded'
            : 'No shared Google credentials found',
        );
        return this.credentials;
      } catch (error) {
        if (
          allowMissingTokenRecord &&
          error instanceof GoogleTokenStoreError &&
          error.code === 'GOOGLE_CREDENTIALS_NOT_FOUND'
        ) {
          this.credentials = null;
          this.credentialsLoaded = true;
          logger.warn(
            { operation: 'oauth.credentials.load', failureCode: error.code },
            'No saved Google token record exists; OAuth authorization can create one',
          );
          return null;
        }
        logger.error(
          {
            operation: 'oauth.credentials.load',
            ...this.errorMetadata(error),
            databaseError: this.safeDatabaseErrorMessage(error, [
              config.databaseUrl,
              config.googleClientSecret,
              config.googleRefreshToken,
            ]),
          },
          'Shared Google credentials could not be loaded',
        );
        if (error instanceof GoogleTokenStoreError) {
          throw new GoogleAuthError(error.code, error.message);
        }
        throw new GoogleAuthError(
          'GOOGLE_CREDENTIALS_LOAD_FAILED',
          'Shared Google credentials could not be loaded.',
        );
      }
    })();
    this.credentialsLoadInFlight = loading;
    try {
      return await loading;
    } finally {
      if (this.credentialsLoadInFlight === loading) {
        this.credentialsLoadInFlight = undefined;
      }
    }
  }

  private async saveStoredCredentials(credentials: GoogleStoredCredentials) {
    try {
      await this.tokenStore.saveSharedCredentials({
        ...credentials,
        refreshToken: credentials.refreshToken ?? undefined,
      });
      logger.info(
        {
          operation: 'oauth.credentials.save',
          credentialSource: 'oauth_token_endpoint',
          accessTokenSaved: true,
          refreshTokenSaved: Boolean(credentials.refreshToken),
        },
        'Google credentials persisted successfully',
      );
    } catch (error) {
      logger.error(
        {
          operation: 'oauth.credentials.save',
          accessTokenSaved: false,
          refreshTokenSaved: false,
          ...this.errorMetadata(error),
          databaseError: this.safeDatabaseErrorMessage(error, [
            credentials.accessToken,
            credentials.refreshToken ?? '',
            config.googleClientSecret,
          ]),
        },
        'Google credentials could not be persisted',
      );
      throw new GoogleAuthError(
        'GOOGLE_TOKEN_PERSISTENCE_FAILED',
        'Google credentials could not be saved. Retry Google authorization.',
      );
    }
  }

  private createClientWithCredentials(credentials: GoogleStoredCredentials) {
    const client = this.createOAuthClient();
    client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken ?? undefined,
      expiry_date: credentials.expiresAt ?? undefined,
      scope: credentials.scopes.join(' '),
      token_type: credentials.tokenType ?? undefined,
    });
    return client;
  }

  private expiryTimestamp(value: number | null | undefined) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
      return { errorType: typeof error };
    }
    const properties = error as {
      code?: unknown;
      response?: { status?: unknown } | null;
    };
    return {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      ...(typeof properties.response?.status === 'number'
        ? { statusCode: properties.response.status }
        : {}),
      ...(typeof properties.code === 'string'
        ? { errorCode: properties.code }
        : {}),
    };
  }

  private safeDatabaseErrorMessage(error: unknown, sensitiveValues: string[]) {
    if (!(error instanceof Error)) {
      return 'Unknown database error.';
    }
    const messages: string[] = [];
    const seen = new Set<object>();
    let current: unknown = error;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      const properties = current as Error & { code?: unknown; cause?: unknown };
      const code = typeof properties.code === 'string'
        ? ` (${properties.code})`
        : '';
      messages.push(`${current.name}${code}: ${current.message}`);
      current = properties.cause;
    }

    let message = messages.join(' <- caused by ')
      .replace(/\nparams:[\s\S]*/i, '\nparams: [redacted]');
    for (const value of sensitiveValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
      message = message.replaceAll(value, '[redacted]');
    }
    return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }
}

export { GoogleAuthService as GoogleIntegrationService };
