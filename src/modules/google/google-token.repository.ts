import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationAccounts, oauthTokens } from '../../db/schema.js';

export type EncryptedGoogleTokens = {
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  expiresAt: Date | null;
  scopes: string[];
};

export type StoredGoogleTokens = Omit<EncryptedGoogleTokens, 'refreshTokenEncrypted'> & {
  accountId: string;
  refreshTokenEncrypted: string | null;
};

export class GoogleAccountAlreadyConnectedError extends Error {
  constructor() {
    super('A Google account is already connected.');
    this.name = 'GoogleAccountAlreadyConnectedError';
  }
}

export class GoogleTokenRepository {
  async findSharedTokens(): Promise<StoredGoogleTokens | null> {
    const [row] = await db
      .select({
        accountId: integrationAccounts.id,
        accessTokenEncrypted: oauthTokens.accessTokenEncrypted,
        refreshTokenEncrypted: oauthTokens.refreshTokenEncrypted,
        expiresAt: oauthTokens.expiresAt,
        scopes: oauthTokens.scopes,
      })
      .from(integrationAccounts)
      .innerJoin(
        oauthTokens,
        eq(oauthTokens.integrationAccountId, integrationAccounts.id),
      )
      .where(and(
        eq(integrationAccounts.provider, 'google'),
        isNull(integrationAccounts.userId),
        eq(integrationAccounts.status, 'active'),
      ))
      .limit(1);

    return row
      ? {
          ...row,
          refreshTokenEncrypted: row.refreshTokenEncrypted ?? null,
          expiresAt: row.expiresAt ?? null,
          scopes: row.scopes ?? [],
        }
      : null;
  }

  async createSharedTokens(tokens: EncryptedGoogleTokens) {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(781245190132)`);
      const [existing] = await transaction
        .select({ id: integrationAccounts.id })
        .from(integrationAccounts)
        .where(and(
          eq(integrationAccounts.provider, 'google'),
          isNull(integrationAccounts.userId),
          eq(integrationAccounts.status, 'active'),
        ))
        .limit(1);
      if (existing) {
        throw new GoogleAccountAlreadyConnectedError();
      }

      const [account] = await transaction
        .insert(integrationAccounts)
        .values({
          userId: null,
          provider: 'google',
          status: 'active',
          authorizationScope: tokens.scopes.join(' '),
        })
        .returning({ id: integrationAccounts.id });

      if (!account) {
        throw new Error('Google integration account could not be created.');
      }

      await transaction.insert(oauthTokens).values({
        integrationAccountId: account.id,
        accessTokenEncrypted: tokens.accessTokenEncrypted,
        refreshTokenEncrypted: tokens.refreshTokenEncrypted ?? null,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      });
    });
  }

  async refreshSharedTokens(
    refresh: (tokens: StoredGoogleTokens) => Promise<EncryptedGoogleTokens>,
  ): Promise<StoredGoogleTokens> {
    return db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(781245190132)`);
      const [row] = await transaction
        .select({
          accountId: integrationAccounts.id,
          accessTokenEncrypted: oauthTokens.accessTokenEncrypted,
          refreshTokenEncrypted: oauthTokens.refreshTokenEncrypted,
          expiresAt: oauthTokens.expiresAt,
          scopes: oauthTokens.scopes,
        })
        .from(integrationAccounts)
        .innerJoin(
          oauthTokens,
          eq(oauthTokens.integrationAccountId, integrationAccounts.id),
        )
        .where(and(
          eq(integrationAccounts.provider, 'google'),
          isNull(integrationAccounts.userId),
          eq(integrationAccounts.status, 'active'),
        ))
        .limit(1)
        .for('update', { of: oauthTokens });

      if (!row) {
        throw new Error('Google account is not connected.');
      }

      const current: StoredGoogleTokens = {
        ...row,
        refreshTokenEncrypted: row.refreshTokenEncrypted ?? null,
        expiresAt: row.expiresAt ?? null,
        scopes: row.scopes ?? [],
      };
      const refreshed = await refresh(current);
      await transaction
        .update(oauthTokens)
        .set({
          accessTokenEncrypted: refreshed.accessTokenEncrypted,
          ...(refreshed.refreshTokenEncrypted
            ? { refreshTokenEncrypted: refreshed.refreshTokenEncrypted }
            : {}),
          expiresAt: refreshed.expiresAt,
          scopes: refreshed.scopes,
          updatedAt: new Date(),
        })
        .where(eq(oauthTokens.integrationAccountId, current.accountId));

      return {
        ...current,
        accessTokenEncrypted: refreshed.accessTokenEncrypted,
        refreshTokenEncrypted: refreshed.refreshTokenEncrypted ??
          current.refreshTokenEncrypted,
        expiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes,
      };
    });
  }

  async markSharedAccountRevoked() {
    await db
      .update(integrationAccounts)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(integrationAccounts.provider, 'google'),
        isNull(integrationAccounts.userId),
        eq(integrationAccounts.status, 'active'),
      ));
  }

}
