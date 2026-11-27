import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { MemoryService } from '../src/modules/memory/memory.service.js';
import {
  ApprovalService,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalRepository,
} from '../src/modules/tools/approval.service.js';
import { ToolRegistry } from '../src/modules/tools/tool-registry.js';

class TestApprovalRepository implements ApprovalRepository {
  readonly records = new Map<string, ApprovalRecord>();
  readonly executions: Array<{ success: boolean; payloadHash: string }> = [];

  async create(input: {
    id: string;
    userId: string;
    actionType: string;
    actionTarget: string | null;
    payload: Record<string, unknown>;
    expiresAt: Date;
  }) {
    const record: ApprovalRecord = { ...input, status: 'pending' };
    this.records.set(record.id, record);
    return record;
  }

  async decide(input: {
    approvalId: string;
    userId: string;
    decision: ApprovalDecision;
    decidedAt: Date;
  }) {
    const record = this.records.get(input.approvalId);
    if (!record || record.userId !== input.userId) {
      return null;
    }

    if (record.status === 'pending') {
      if (record.expiresAt && record.expiresAt <= input.decidedAt) {
        record.status = 'expired';
      } else {
        record.status = input.decision === 'approve' ? 'approved' : 'rejected';
      }

      return { record, newlyDecided: true };
    }

    return { record, newlyDecided: false };
  }

  async recordExecution(input: {
    approvalId: string;
    userId: string;
    actionType: string;
    payloadHash: string;
    success: boolean;
    occurredAt: Date;
  }) {
    this.executions.push({
      success: input.success,
      payloadHash: input.payloadHash,
    });
  }
}

test('ordinary email is allowed while credential-bearing email requires approval', async () => {
  const repository = new TestApprovalRepository();
  const approvals = new ApprovalService(true, 60_000, repository);

  const ordinary = await approvals.evaluateEmailSend({
    userId: 'user-1',
    email: {
      to: 'customer@example.com',
      subject: 'Meeting follow-up',
      body: 'Thanks for your time today. I will send the notes shortly.',
    },
  });
  assert.equal(ordinary.approved, true);
  assert.equal(ordinary.status, 'approved');
  assert.equal(repository.records.size, 0);

  const sensitive = await approvals.evaluateEmailSend({
    userId: 'user-1',
    email: {
      to: 'ops@example.com',
      subject: 'Deployment details',
      body: 'Use this API key: secret-value.',
    },
  });
  assert.equal(sensitive.approved, false);
  assert.equal(sensitive.status, 'pending');
  assert.equal(repository.records.size, 1);
  assert.deepEqual(repository.records.get(sensitive.approvalId!)?.payload, {
    to: 'ops@example.com',
    subject: 'Deployment details',
    body: 'Use this API key: secret-value.',
    classificationReason: 'credentials or access secrets',
  });
});

test('approval is owner-bound, one-shot, and rejects changed decision attempts', async () => {
  const repository = new TestApprovalRepository();
  const approvals = new ApprovalService(true, 60_000, repository);
  const request = await approvals.evaluate({
    userId: 'user-1',
    toolName: 'calendar_delete',
    payload: { eventId: 'event-1', title: 'Planning', start: '2026-11-21T10:00:00Z' },
  });

  assert.equal(request.status, 'pending');
  if (request.status !== 'pending') {
    assert.fail('Expected a pending approval.');
  }

  const unauthorized = await approvals.decide({
    approvalId: request.approvalId,
    userId: 'user-2',
    decision: 'approve',
  });
  assert.equal(unauthorized.status, 'not_found');

  const approved = await approvals.decide({
    approvalId: request.approvalId,
    userId: 'user-1',
    decision: 'approve',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.newlyDecided, true);
  assert.deepEqual('payload' in approved ? approved.payload : null, {
    eventId: 'event-1',
    title: 'Planning',
    start: '2026-11-21T10:00:00Z',
  });

  const duplicate = await approvals.decide({
    approvalId: request.approvalId,
    userId: 'user-1',
    decision: 'approve',
  });
  assert.equal(duplicate.status, 'approved');
  assert.equal(duplicate.newlyDecided, false);
  assert.equal('payload' in duplicate, false);
});

test('rejected and expired approvals never authorize execution', async () => {
  const repository = new TestApprovalRepository();
  const approvals = new ApprovalService(true, 60_000, repository);
  const rejectedRequest = await approvals.evaluate({
    userId: 'user-1',
    toolName: 'calendar_update',
    payload: { eventId: 'event-1', changes: { start: '2026-11-22T10:00:00Z' } },
  });
  assert.equal(rejectedRequest.status, 'pending');
  if (rejectedRequest.status !== 'pending') {
    assert.fail('Expected a pending approval.');
  }

  const rejected = await approvals.decide({
    approvalId: rejectedRequest.approvalId,
    userId: 'user-1',
    decision: 'reject',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal('payload' in rejected, false);

  const expiringApprovals = new ApprovalService(true, 0, repository);
  const expiringRequest = await expiringApprovals.evaluate({
    userId: 'user-1',
    toolName: 'gmail_send_sensitive',
    payload: { to: 'finance@example.com', subject: 'Report', body: 'Sensitive' },
  });
  assert.equal(expiringRequest.status, 'pending');
  if (expiringRequest.status !== 'pending') {
    assert.fail('Expected a pending approval.');
  }

  const expired = await expiringApprovals.decide({
    approvalId: expiringRequest.approvalId,
    userId: 'user-1',
    decision: 'approve',
  });
  assert.equal(expired.status, 'expired');
  assert.equal('payload' in expired, false);
});

test('disabled approvals block non-low-risk actions instead of auto-approving', async () => {
  const approvals = new ApprovalService(false, 60_000, new TestApprovalRepository());
  const result = await approvals.evaluate({
    userId: 'user-1',
    toolName: 'calendar_delete',
    payload: { eventId: 'event-1' },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.approved, false);
});

test('backend policy assigns a sensitive action its configured high risk', async () => {
  const repository = new TestApprovalRepository();
  const approvals = new ApprovalService(true, 60_000, repository);
  const result = await approvals.evaluate({
    userId: 'user-1',
    toolName: 'gmail_send_sensitive',
    payload: {
      to: 'finance@example.com',
      subject: 'Confidential report',
      body: 'Please review.',
    },
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.approved, false);
});

test('email validation rejects invalid recipients and empty content', async () => {
  const approvals = new ApprovalService(true, 60_000, new TestApprovalRepository());

  await assert.rejects(
    approvals.evaluateEmailSend({
      userId: 'user-1',
      email: { to: 'not-an-email', subject: 'Hello', body: 'Message' },
    }),
    /valid comma-separated email addresses/,
  );
  await assert.rejects(
    approvals.evaluateEmailSend({
      userId: 'user-1',
      email: { to: 'user@example.com', subject: ' ', body: 'Message' },
    }),
    /subject must be non-empty/,
  );
  await assert.rejects(
    approvals.evaluateEmailSend({
      userId: 'user-1',
      email: { to: 'user@example.com', subject: 'Hello', body: '  ' },
    }),
    /body must be non-empty/,
  );
});

test('pending approvals are returned without asking the AI to claim execution', async () => {
  const toolRegistry = new ToolRegistry();
  let executions = 0;
  toolRegistry.register({
    name: 'calendar_lookup',
    description: 'Protected calendar action for this test.',
    risk: 'high',
    execute: async () => {
      executions += 1;
      return { changed: true };
    },
  });
  let providerCalls = 0;
  class AlwaysPendingApprovalService extends ApprovalService {
    override async evaluate(action: {
      userId: string;
      toolName: string;
      payload: Record<string, unknown>;
    }) {
      return {
        status: 'pending' as const,
        approved: false,
        approvalId: 'approval-1',
        action: action.toolName,
        payload: action.payload,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        message: `Action ${action.toolName} requires explicit user approval before execution.`,
      };
    }
  }

  const orchestrator = new AiOrchestrator({
    memoryService: new MemoryService(),
    toolRegistry,
    approvalService: new AlwaysPendingApprovalService(true),
    aiProvider: {
      async planRequest() {
        return {
          provider: 'test',
          model: 'test',
          raw: '{"action":"execute_tool","tool":"calendar_lookup","confidence":0.99}',
          decision: {
            action: 'execute_tool',
            tool: 'calendar_lookup',
            parameters: {},
            confidence: 0.99,
          },
        };
      },
      async generateReply() {
        providerCalls += 1;
        return { provider: 'test', model: 'test', content: 'This must not run.' };
      },
    },
  });

  const result = await orchestrator.process({
    userId: 'user-1',
    message: 'check my calendar',
  });

  assert.equal((result.toolResult as { approvalRequired: boolean }).approvalRequired, true);
  assert.equal(typeof (result.toolResult as { approvalId: string }).approvalId, 'string');
  assert.match(result.response, /requires explicit user approval/);
  assert.equal(providerCalls, 0);
  assert.equal(executions, 0);
});
