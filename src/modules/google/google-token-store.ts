import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { integrationAccounts, oauthTokens } from '../../db/schema.js';
import { decryptGoogleToken, encryptGoogleToken } from './google-token-crypto.js';

export type GoogleStoredCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  tokenType: string | null;
};

export type GoogleCredentialsToStore = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  scopes: string[];
  tokenType?: string | null;
};

export type GoogleTokenStoreErrorCode =
  | 'GOOGLE_CREDENTIALS_NOT_FOUND'
  | 'GOOGLE_TOKEN_DECRYPTION_FAILED';

export class GoogleTokenStoreError extends Error {
  constructor(
    readonly code: GoogleTokenStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleTokenStoreError';
  }
}

export interface GoogleTokenStore {
  getSharedCredentials(): Promise<GoogleStoredCredentials | null>;
  saveSharedCredentials(credentials: GoogleCredentialsToStore): Promise<void>;
}

function isVersionedToken(value: string) {
  return /^v\d+\./.test(value);
}

export class EncryptedGoogleTokenStore implements GoogleTokenStore {
  async getSharedCredentials(): Promise<GoogleStoredCredentials | null> {
    return db.transaction(async (transaction) => {
      const [account] = await transaction
        .select({ id: integrationAccounts.id })
        .from(integrationAccounts)
        .where(and(
          eq(integrationAccounts.provider, 'google'),
          isNull(integrationAccounts.userId),
          eq(integrationAccounts.status, 'active'),
        ))
        .limit(1);

      logger.info(
        {
          operation: 'oauth.credentials.load',
          sharedIntegrationAccountFound: Boolean(account),
        },
        'Shared Google integration account lookup completed',
      );
      if (!account) {
        return null;
      }

      const [tokenRecord] = await transaction
        .select({
          id: oauthTokens.id,
          accessTokenEncrypted: oauthTokens.accessTokenEncrypted,
          refreshTokenEncrypted: oauthTokens.refreshTokenEncrypted,
          expiresAt: oauthTokens.expiresAt,
          scopes: oauthTokens.scopes,
          tokenType: oauthTokens.tokenType,
        })
        .from(oauthTokens)
        .where(eq(oauthTokens.integrationAccountId, account.id))
        .limit(1);

      logger.info(
        {
          operation: 'oauth.credentials.load',
          sharedIntegrationAccountFound: true,
          oauthTokenRecordFound: Boolean(tokenRecord),
        },
        'Shared Google OAuth token record lookup completed',
      );
      if (!tokenRecord) {
        throw new GoogleTokenStoreError(
          'GOOGLE_CREDENTIALS_NOT_FOUND',
          'The shared Google account has no stored OAuth credentials.',
        );
      }

      let accessToken: string;
      try {
        accessToken = isVersionedToken(tokenRecord.accessTokenEncrypted)
          ? decryptGoogleToken(tokenRecord.accessTokenEncrypted)
          : tokenRecord.accessTokenEncrypted;
      } catch (error) {
        logger.error(
          {
            operation: 'oauth.credentials.decrypt',
            tokenType: 'access',
            errorType: error instanceof Error ? error.name : typeof error,
          },
          'Stored Google access token could not be decrypted',
        );
        throw new GoogleTokenStoreError(
          'GOOGLE_TOKEN_DECRYPTION_FAILED',
          'The stored Google access token could not be decrypted.',
        );
      }
      logger.info(
        { operation: 'oauth.credentials.decrypt', tokenType: 'access' },
        'Stored Google access token decrypted successfully',
      );

      let refreshToken: string | null = null;
      if (tokenRecord.refreshTokenEncrypted) {
        try {
          refreshToken = isVersionedToken(tokenRecord.refreshTokenEncrypted)
            ? decryptGoogleToken(tokenRecord.refreshTokenEncrypted)
            : tokenRecord.refreshTokenEncrypted;
        } catch (error) {
          logger.error(
            {
              operation: 'oauth.credentials.decrypt',
              tokenType: 'refresh',
              errorType: error instanceof Error ? error.name : typeof error,
            },
            'Stored Google refresh token could not be decrypted',
          );
          throw new GoogleTokenStoreError(
            'GOOGLE_TOKEN_DECRYPTION_FAILED',
            'The stored Google refresh token could not be decrypted.',
          );
        }
        logger.info(
          { operation: 'oauth.credentials.decrypt', tokenType: 'refresh' },
          'Stored Google refresh token decrypted successfully',
        );
      }

      const legacyPlaintext =
        !isVersionedToken(tokenRecord.accessTokenEncrypted) ||
        Boolean(
          tokenRecord.refreshTokenEncrypted &&
          !isVersionedToken(tokenRecord.refreshTokenEncrypted),
        );
      if (legacyPlaintext) {
        await transaction
          .update(oauthTokens)
          .set({
            accessTokenEncrypted: encryptGoogleToken(accessToken),
            ...(refreshToken
              ? { refreshTokenEncrypted: encryptGoogleToken(refreshToken) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(oauthTokens.id, tokenRecord.id));
        logger.info(
          { operation: 'oauth.credentials.encrypt_legacy', updated: true },
          'Legacy Google credentials encrypted in storage',
        );
      }

      return {
        accessToken,
        refreshToken,
        expiresAt: tokenRecord.expiresAt?.getTime() ?? null,
        scopes: tokenRecord.scopes ?? [],
        tokenType: tokenRecord.tokenType ?? null,
      };
    });
  }

  async saveSharedCredentials(credentials: GoogleCredentialsToStore): Promise<void> {
    const accessTokenEncrypted = encryptGoogleToken(credentials.accessToken);
    const refreshTokenEncrypted = credentials.refreshToken
      ? encryptGoogleToken(credentials.refreshToken)
      : undefined;
    const expiresAt = credentials.expiresAt === null
      ? null
      : new Date(credentials.expiresAt);

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(781245190132)`);
      const [existingAccount] = await transaction
        .select({ id: integrationAccounts.id })
        .from(integrationAccounts)
        .where(and(
          eq(integrationAccounts.provider, 'google'),
          isNull(integrationAccounts.userId),
          eq(integrationAccounts.status, 'active'),
        ))
        .limit(1)
        .for('update');

      const [account] = existingAccount
        ? [existingAccount]
        : await transaction
          .insert(integrationAccounts)
          .values({
            userId: null,
            provider: 'google',
            status: 'active',
            authorizationScope: credentials.scopes.join(' '),
          })
          .returning({ id: integrationAccounts.id });

      if (!account) {
        throw new Error('Google integration account could not be stored.');
      }

      const [existingTokens] = await transaction
        .select({ id: oauthTokens.id })
        .from(oauthTokens)
        .where(eq(oauthTokens.integrationAccountId, account.id))
        .limit(1)
        .for('update');
      const tokenValues = {
        accessTokenEncrypted,
        ...(refreshTokenEncrypted ? { refreshTokenEncrypted } : {}),
        tokenType: credentials.tokenType ?? 'Bearer',
        expiresAt,
        scopes: credentials.scopes,
        updatedAt: new Date(),
      };

      if (existingTokens) {
        await transaction
          .update(oauthTokens)
          .set(tokenValues)
          .where(eq(oauthTokens.id, existingTokens.id));
      } else {
        await transaction.insert(oauthTokens).values({
          integrationAccountId: account.id,
          ...tokenValues,
          refreshTokenEncrypted: refreshTokenEncrypted ?? null,
        });
      }

      await transaction
        .update(integrationAccounts)
        .set({ authorizationScope: credentials.scopes.join(' '), updatedAt: new Date() })
        .where(eq(integrationAccounts.id, account.id));
    });
  }
}
