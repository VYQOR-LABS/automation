import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { integrationAccounts, users } from '../../db/schema.js';

const WHATSAPP_OWNER_LOCK_ID = 781245190133;

export async function getOrCreateWhatsAppOwnerUserId(
  phoneNumberId: string,
  businessAccountId: string,
) {
  if (!phoneNumberId.trim() || !businessAccountId.trim()) {
    throw new Error(
      'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_BUSINESS_ACCOUNT_ID must be configured.',
    );
  }

  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${WHATSAPP_OWNER_LOCK_ID})`);
    const [existingAccount] = await transaction
      .select({
        id: integrationAccounts.id,
        userId: integrationAccounts.userId,
        providerAccountId: integrationAccounts.providerAccountId,
        businessAccountId: integrationAccounts.businessAccountId,
      })
      .from(integrationAccounts)
      .where(and(
        eq(integrationAccounts.provider, 'whatsapp'),
        eq(integrationAccounts.status, 'active'),
      ))
      .limit(1)
      .for('update');

    if (existingAccount) {
      if (
        existingAccount.providerAccountId !== phoneNumberId ||
        existingAccount.businessAccountId !== businessAccountId
      ) {
        throw new Error(
          'Configured WhatsApp IDs do not match the existing single-owner integration.',
        );
      }
      if (existingAccount.userId) {
        return existingAccount.userId;
      }

      const [owner] = await transaction
        .insert(users)
        .values({
          fullName: 'WhatsApp Business Owner',
          displayName: 'WhatsApp Business Owner',
        })
        .returning({ id: users.id });
      if (!owner) {
        throw new Error('WhatsApp owner user could not be created.');
      }

      await transaction
        .update(integrationAccounts)
        .set({ userId: owner.id, updatedAt: new Date() })
        .where(eq(integrationAccounts.id, existingAccount.id));
      logger.info(
        { operation: 'whatsapp.owner.resolve', created: true },
        'WhatsApp owner user linked to the configured business account',
      );
      return owner.id;
    }

    const [owner] = await transaction
      .insert(users)
      .values({
        fullName: 'WhatsApp Business Owner',
        displayName: 'WhatsApp Business Owner',
      })
      .returning({ id: users.id });
    if (!owner) {
      throw new Error('WhatsApp owner user could not be created.');
    }

    const [account] = await transaction
      .insert(integrationAccounts)
      .values({
        userId: owner.id,
        provider: 'whatsapp',
        providerAccountId: phoneNumberId,
        businessAccountId,
        status: 'active',
      })
      .returning({ id: integrationAccounts.id });
    if (!account) {
      throw new Error('WhatsApp business account could not be stored.');
    }

    logger.info(
      { operation: 'whatsapp.owner.resolve', created: true },
      'WhatsApp owner user and business integration created',
    );
    return owner.id;
  });
}
