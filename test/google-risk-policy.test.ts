import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarService } from '../src/modules/google/calendar.service.js';
import { GmailService } from '../src/modules/google/gmail.service.js';
import { ApprovalService, type ApprovalRecord, type ApprovalRepository } from '../src/modules/tools/approval.service.js';

class PendingApprovalRepository implements ApprovalRepository {
  readonly records: ApprovalRecord[] = [];

  async create(input: {
    id: string;
    userId: string;
    actionType: string;
    actionTarget: string | null;
    payload: Record<string, unknown>;
    expiresAt: Date;
  }) {
    const record = { ...input, status: 'pending' as const };
    this.records.push(record);
    return record;
  }

  async decide() {
    throw new Error('Decision is not part of this test.');
  }

  async recordExecution() {
    throw new Error('Execution is not part of this test.');
  }
}

test('Gmail blocks sensitive email delivery and stores the exact approval payload', async () => {
  const repository = new PendingApprovalRepository();
  const gmailService = new GmailService(
    new ApprovalService(true, 60_000, repository),
  );
  const result = await gmailService.sendMessage(
    {
      to: 'finance@example.com',
      subject: 'Confidential financial report',
      body: 'Please see the report.',
    },
    'user-1',
  );

  assert.equal(result.status, 'pending');
  assert.equal(repository.records.length, 1);
  assert.equal(repository.records[0]?.userId, 'user-1');
  assert.equal(repository.records[0]?.actionType, 'gmail_send_sensitive');
  assert.deepEqual(repository.records[0]?.payload, {
    to: 'finance@example.com',
    subject: 'Confidential financial report',
    body: 'Please see the report.',
    classificationReason: 'confidential or proprietary information',
  });
  assert.equal(JSON.stringify(repository.records[0]).includes('access-token'), false);
});

test('Calendar event updates and deletions require a stored approval before Google API access', async () => {
  const repository = new PendingApprovalRepository();
  const calendarService = new CalendarService(
    new ApprovalService(true, 60_000, repository),
  );

  const update = await calendarService.updateEvent(
    'event-1',
    { summary: 'Updated planning meeting' },
    'user-1',
  );
  const deletion = await calendarService.deleteEvent(
    'event-2',
    'user-1',
  );

  assert.equal(update.status, 'pending');
  assert.equal(deletion?.status, 'pending');
  assert.deepEqual(repository.records.map(({ actionType, payload }) => ({
    actionType,
    payload,
  })), [
    {
      actionType: 'calendar_update',
      payload: {
        calendarId: 'primary',
        eventId: 'event-1',
        changes: { summary: 'Updated planning meeting' },
      },
    },
    {
      actionType: 'calendar_delete',
      payload: { calendarId: 'primary', eventId: 'event-2' },
    },
  ]);
});

test('Calendar creation validates details before accessing Google', async () => {
  const calendarService = new CalendarService();

  await assert.rejects(
    calendarService.createEvent({
      summary: ' ',
      start: { dateTime: 'not-a-date' },
      end: { dateTime: '2026-11-21T11:00:00Z' },
    }),
    /title and valid start\/end times/,
  );
});
