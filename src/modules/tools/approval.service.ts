import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { approvalRequests, auditLogs } from '../../db/schema.js';

export type ToolRisk = 'low' | 'medium' | 'high';
export type ApprovalDecision = 'approve' | 'reject';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export const ACTION_RISK: Readonly<Record<string, ToolRisk>> = {
  memory_search: 'low',
  calendar_lookup: 'low',
  calendar_create: 'low',
  calendar_update: 'medium',
  calendar_delete: 'high',
  gmail_search: 'low',
  gmail_read: 'low',
  gmail_send_ordinary: 'low',
  gmail_send_sensitive: 'high',
  gmail_delete: 'high',
  gmail_forward_sensitive: 'high',
};

const SENSITIVE_EMAIL_RULES: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'credentials or access secrets',
    pattern: /\b(password|passphrase|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|credential|private[\s_-]?key|client[\s_-]?secret)\b/i,
  },
  {
    reason: 'confidential or proprietary information',
    pattern: /\b(confidential|proprietary|trade secret|non[- ]public|internal[- ]only|classified)\b/i,
  },
  {
    reason: 'sensitive financial or banking information',
    pattern: /\b(bank account|routing number|account number|credit card|cvv|wire transfer|banking details|financial commitment|financial report|invoice|payment|budget|salary|compensation|tax return|investment|reimbursement)\b/i,
  },
  {
    reason: 'sensitive personal information',
    pattern: /\b(social security|ssn|passport number|medical record|health information|date of birth)\b/i,
  },
  {
    reason: 'legal agreement or business commitment',
    pattern: /\b(legal agreement|contract|binding agreement|hereby agree|commit to|accept the terms|sign on behalf|approve the proposal|authorize payment|accept the offer)\b/i,
  },
];

export function validateOutgoingEmail(input: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}) {
  const isValidRecipientList = (value: string) =>
    value.length <= 2048 &&
    value.split(',').every((recipient) =>
      recipient.trim().length <= 254 &&
      /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(recipient.trim()),
    );
  if (
    !isValidRecipientList(input.to) ||
    (input.cc !== undefined && !isValidRecipientList(input.cc)) ||
    (input.bcc !== undefined && !isValidRecipientList(input.bcc)) ||
    /[\r\n]/.test(input.to) ||
    /[\r\n]/.test(input.cc ?? '') ||
    /[\r\n]/.test(input.bcc ?? '')
  ) {
    throw new Error('Email recipients must be valid comma-separated email addresses.');
  }
  if (
    !input.subject.trim() ||
    input.subject.length > 998 ||
    /[\r\n]/.test(input.subject)
  ) {
    throw new Error('Email subject must be non-empty and contain no line breaks.');
  }
  if (!input.body.trim() || input.body.length > 1_000_000) {
    throw new Error('Email body must be non-empty and no larger than 1 MB.');
  }
}

export function classifyEmailSensitivity(
  input: { subject: string; body: string },
  additionalKeywords: readonly string[] = [],
) {
  const content = `${input.subject}\n${input.body}`;
  for (const rule of SENSITIVE_EMAIL_RULES) {
    if (rule.pattern.test(content)) {
      return { sensitive: true, reason: rule.reason };
    }
  }

  const configuredKeyword = additionalKeywords.find((keyword) =>
    keyword.trim() && content.toLowerCase().includes(keyword.trim().toLowerCase()),
  );
  if (configuredKeyword) {
    return {
      sensitive: true,
      reason: `configured sensitive term: ${configuredKeyword.trim()}`,
    };
  }

  return {
    sensitive: false,
    reason: 'No configured sensitive-content indicators were detected.',
  };
}

export type ApprovalRecord = {
  id: string;
  userId: string;
  actionType: string;
  actionTarget: string | null;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  expiresAt: Date | null;
};

export type ApprovalRepository = {
  create(input: {
    id: string;
    userId: string;
    actionType: string;
    actionTarget: string | null;
    payload: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<ApprovalRecord>;
  decide(input: {
    approvalId: string;
    userId: string;
    decision: ApprovalDecision;
    decidedAt: Date;
  }): Promise<{ record: ApprovalRecord; newlyDecided: boolean } | null>;
  recordExecution(input: {
    approvalId: string;
    userId: string;
    actionType: string;
    payloadHash: string;
    success: boolean;
    occurredAt: Date;
  }): Promise<void>;
};

class PostgresApprovalRepository implements ApprovalRepository {
  async create(input: Parameters<ApprovalRepository['create']>[0]) {
    const [record] = await db
      .insert(approvalRequests)
      .values({
        id: input.id,
        userId: input.userId,
        actionType: input.actionType,
        actionTarget: input.actionTarget,
        payload: input.payload,
        expiresAt: input.expiresAt,
      })
      .returning();

    return record as ApprovalRecord;
  }

  async decide(input: Parameters<ApprovalRepository['decide']>[0]) {
    const newStatus = input.decision === 'approve' ? 'approved' : 'rejected';

    await db
      .update(approvalRequests)
      .set({ status: 'expired' })
      .where(and(
        eq(approvalRequests.id, input.approvalId),
        eq(approvalRequests.userId, input.userId),
        eq(approvalRequests.status, 'pending'),
        lte(approvalRequests.expiresAt, input.decidedAt),
      ));

    const [updated] = await db
      .update(approvalRequests)
      .set({
        status: newStatus,
        ...(input.decision === 'approve'
          ? { approvedAt: input.decidedAt }
          : { rejectedAt: input.decidedAt }),
      })
      .where(and(
        eq(approvalRequests.id, input.approvalId),
        eq(approvalRequests.userId, input.userId),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, input.decidedAt),
      ))
      .returning();

    if (updated) {
      return { record: updated as ApprovalRecord, newlyDecided: true };
    }

    const [existing] = await db
      .select()
      .from(approvalRequests)
      .where(and(
        eq(approvalRequests.id, input.approvalId),
        eq(approvalRequests.userId, input.userId),
      ))
      .limit(1);

    return existing
      ? { record: existing as ApprovalRecord, newlyDecided: false }
      : null;
  }

  async recordExecution(input: Parameters<ApprovalRepository['recordExecution']>[0]) {
    await db.insert(auditLogs).values({
      userId: input.userId,
      actorType: 'user',
      actorId: input.userId,
      actionType: input.success
        ? 'approval_execution_succeeded'
        : 'approval_execution_failed',
      resourceType: input.actionType,
      resourceId: input.approvalId,
      eventPayload: {
        payloadHash: input.payloadHash,
        executionStatus: input.success ? 'succeeded' : 'failed',
        occurredAt: input.occurredAt.toISOString(),
      },
    });
  }
}

export class ApprovalService {
  private readonly repository: ApprovalRepository;

  constructor(
    private readonly enabled: boolean,
    private readonly ttlMs = 10 * 60 * 1000,
    repository?: ApprovalRepository,
  ) {
    this.repository = repository ?? new PostgresApprovalRepository();
  }

  async evaluate(action: {
    userId: string;
    toolName: string;
    payload: Record<string, unknown>;
  }) {
    const risk = ACTION_RISK[action.toolName] ?? 'high';

    if (risk === 'low') {
      return { status: 'approved' as const, approved: true };
    }

    if (!this.enabled) {
      return {
        status: 'blocked' as const,
        approved: false,
        message: 'This action is blocked because approvals are disabled.',
      };
    }

    const approvalId = randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const actionTarget = typeof action.payload.to === 'string'
      ? action.payload.to
      : typeof action.payload.eventId === 'string'
        ? action.payload.eventId
        : null;
    const record = await this.repository.create({
      id: approvalId,
      userId: action.userId,
      actionType: action.toolName,
      actionTarget,
      payload: action.payload,
      expiresAt,
    });

    return {
      status: 'pending' as const,
      approved: false,
      approvalId: record.id,
      action: record.actionType,
      payload: record.payload,
      expiresAt: record.expiresAt?.toISOString() ?? expiresAt.toISOString(),
      approvalEndpoint: `/api/approvals/${record.id}/decision`,
      message: `Action ${record.actionType} requires explicit user approval before execution. Submit approve or reject to /api/approvals/${record.id}/decision.`,
    };
  }

  async evaluateEmailSend(input: {
    userId: string;
    email: {
      to: string;
      cc?: string;
      bcc?: string;
      subject: string;
      body: string;
    };
    additionalSensitiveKeywords?: readonly string[];
  }) {
    validateOutgoingEmail(input.email);
    const classification = classifyEmailSensitivity(
      input.email,
      input.additionalSensitiveKeywords ?? config.sensitiveEmailKeywords,
    );
    const toolName = classification.sensitive
      ? 'gmail_send_sensitive'
      : 'gmail_send_ordinary';

    return this.evaluate({
      userId: input.userId,
      toolName,
      payload: {
        ...input.email,
        classificationReason: classification.reason,
      },
    });
  }

  async decide(input: {
    approvalId: string;
    userId: string;
    decision: ApprovalDecision;
  }) {
    const result = await this.repository.decide({
      ...input,
      decidedAt: new Date(),
    });
    if (!result) {
      return { status: 'not_found' as const, newlyDecided: false };
    }

    const { record, newlyDecided } = result;
    return {
      status: record.status,
      newlyDecided,
      approvalId: record.id,
      ...(record.status === 'approved' && newlyDecided
        ? {
            action: record.actionType,
            payload: record.payload,
          }
        : {}),
      ...(record.status === 'expired'
        ? { message: 'This approval has expired.' }
        : {}),
    };
  }

  async recordExecution(input: {
    approvalId: string;
    userId: string;
    actionType: string;
    payload: Record<string, unknown>;
    success: boolean;
  }) {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(input.payload))
      .digest('hex');
    await this.repository.recordExecution({
      approvalId: input.approvalId,
      userId: input.userId,
      actionType: input.actionType,
      payloadHash,
      success: input.success,
      occurredAt: new Date(),
    });
  }
}
