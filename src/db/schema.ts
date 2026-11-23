import {
  boolean,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userStatusEnum = pgEnum('user_status', ['active', 'inactive', 'suspended']);
export const conversationStatusEnum = pgEnum('conversation_status', ['active', 'archived', 'closed']);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'expired']);
export const aiRunStatusEnum = pgEnum('ai_run_status', ['started', 'running', 'completed', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  whatsappPhone: varchar('whatsapp_phone', { length: 32 }),
  email: varchar('email', { length: 255 }),
  fullName: varchar('full_name', { length: 255 }),
  displayName: varchar('display_name', { length: 255 }),
  status: userStatusEnum('status').notNull().default('active'),
  locale: varchar('locale', { length: 16 }).default('en'),
  timezone: varchar('timezone', { length: 64 }).default('UTC'),
  consentVersion: numeric('consent_version', { precision: 8, scale: 0 }).default('1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
});

export const userProfiles = pgTable('user_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  jobTitle: varchar('job_title', { length: 255 }),
  companyName: varchar('company_name', { length: 255 }),
  personalContext: jsonb('personal_context'),
  workContext: jsonb('work_context'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  preferenceKey: varchar('preference_key', { length: 128 }).notNull(),
  preferenceValue: jsonb('preference_value').notNull(),
  scope: varchar('scope', { length: 32 }).notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  conversationType: varchar('conversation_type', { length: 32 }).notNull().default('whatsapp'),
  externalThreadId: varchar('external_thread_id', { length: 255 }),
  title: varchar('title', { length: 255 }),
  status: conversationStatusEnum('status').notNull().default('active'),
  contextSummary: text('context_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  senderParticipantId: uuid('sender_participant_id'),
  messageType: varchar('message_type', { length: 32 }).notNull().default('text'),
  content: text('content'),
  contentHash: varchar('content_hash', { length: 128 }),
  externalMessageId: varchar('external_message_id', { length: 255 }),
  direction: varchar('direction', { length: 16 }).notNull().default('inbound'),
  status: varchar('status', { length: 32 }).notNull().default('received'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

export const integrationAccounts = pgTable('integration_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  provider: varchar('provider', { length: 64 }).notNull(),
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  businessAccountId: varchar('business_account_id', { length: 255 }),
  accountEmail: varchar('account_email', { length: 255 }),
  authorizationScope: text('authorization_scope'),
  status: varchar('status', { length: 32 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('integration_accounts_google_shared_uidx')
    .on(table.provider)
    .where(sql`${table.userId} is null and ${table.provider} = 'google' and ${table.status} = 'active'`),
  uniqueIndex('integration_accounts_whatsapp_owner_uidx')
    .on(table.provider)
    .where(sql`${table.provider} = 'whatsapp' and ${table.status} = 'active'`),
]);

export const oauthTokens = pgTable('oauth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationAccountId: uuid('integration_account_id').notNull().references(() => integrationAccounts.id),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  tokenType: varchar('token_type', { length: 32 }).default('Bearer'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
  scopes: text('scopes').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memoryRecords = pgTable('memory_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  memoryDomain: varchar('memory_domain', { length: 32 }).notNull().default('personal'),
  factText: text('fact_text').notNull(),
  factType: varchar('fact_type', { length: 32 }).default('fact'),
  confidence: numeric('confidence', { precision: 5, scale: 4 }).default('0.0000'),
  sourceType: varchar('source_type', { length: 32 }).notNull().default('conversation'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  isDeleted: boolean('is_deleted').default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const aiRuns = pgTable('ai_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  runType: varchar('run_type', { length: 32 }).notNull().default('chat'),
  status: aiRunStatusEnum('status').notNull().default('started'),
  modelName: varchar('model_name', { length: 128 }).notNull(),
  promptVersion: varchar('prompt_version', { length: 64 }),
  inputSummary: text('input_summary'),
  outputSummary: text('output_summary'),
  tokenInput: numeric('token_input', { precision: 20, scale: 0 }),
  tokenOutput: numeric('token_output', { precision: 20, scale: 0 }),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  errorMessage: text('error_message'),
});

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  actionType: varchar('action_type', { length: 64 }).notNull(),
  actionTarget: varchar('action_target', { length: 255 }),
  payload: jsonb('payload').notNull(),
  status: approvalStatusEnum('status').notNull().default('pending'),
  createdBy: varchar('created_by', { length: 64 }).notNull().default('ai'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  actorType: varchar('actor_type', { length: 32 }).notNull().default('system'),
  actorId: varchar('actor_id', { length: 255 }),
  actionType: varchar('action_type', { length: 64 }).notNull(),
  resourceType: varchar('resource_type', { length: 64 }),
  resourceId: uuid('resource_id'),
  eventPayload: jsonb('event_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const securityEvents = pgTable('security_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  severity: varchar('severity', { length: 16 }).notNull().default('medium'),
  metadata: jsonb('metadata'),
  resolved: boolean('resolved').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
