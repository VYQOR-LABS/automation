import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import {
  CalendarService,
  getCalendarLookupTimeRange,
  type CalendarLookupOptions,
} from '../src/modules/google/calendar.service.js';
import type { calendar_v3 } from 'googleapis';
import { GoogleAuthError } from '../src/modules/google/google.service.js';
import { getGoogleRequestUrl } from '../src/modules/google/google-api-logger.js';
import { ApprovalService } from '../src/modules/tools/approval.service.js';

const fixedNow = new Date('2026-11-20T12:00:00.000Z');

test('Google API request URL is extracted from upstream errors', () => {
  assert.equal(
    getGoogleRequestUrl({
      response: {
        status: 401,
        config: { url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events' },
      },
    }),
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
  );
  assert.equal(getGoogleRequestUrl(new GoogleAuthError(
    'GOOGLE_ACCOUNT_NOT_CONNECTED',
    'Authorize Google first.',
  )), undefined);
  assert.equal(
    getGoogleRequestUrl({
      config: {
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=private+search&maxResults=5#response',
      },
    }),
    'https://gmail.googleapis.com/gmail/v1/users/me/messages',
  );
});

function createCalendarService(
  lookup: (params: calendar_v3.Params$Resource$Events$List) => Promise<{
    data: {
      items?: Array<{
        id?: string | null;
        summary?: string | null;
        description?: string | null;
        start?: { date?: string | null; dateTime?: string | null } | null;
        end?: { date?: string | null; dateTime?: string | null } | null;
        location?: string | null;
        status?: string | null;
      }> | null;
      nextPageToken?: string | null;
    };
    status?: number;
  }>,
) {
  return new CalendarService(
    new ApprovalService(false),
    { getAuthenticatedGoogleClient: async () => { throw new Error('Test request bypasses Google auth.'); } },
    (params) => lookup(params),
  );
}

test('Calendar lookup requests events from the selected period and paginates results', async () => {
  const requests: calendar_v3.Params$Resource$Events$List[] = [];
  const service = createCalendarService(async (params) => {
    requests.push(params);
    if (params.pageToken) {
      return {
        status: 200,
        data: {
          items: [{
            id: 'event-2',
            summary: 'Second event',
            start: { date: '2026-11-20' },
            end: { date: '2026-11-21' },
            status: 'confirmed',
          }],
        },
      };
    }
    return {
      status: 200,
      data: {
        nextPageToken: 'next-page',
        items: [{
          id: 'event-1',
          summary: 'Project review',
          description: 'Weekly review.',
          start: { dateTime: '2026-11-20T15:00:00+03:00' },
          end: { dateTime: '2026-11-20T16:00:00+03:00' },
          location: 'Nairobi',
          status: 'confirmed',
        }],
      },
    };
  });

  const events = await service.listEvents(
    { period: 'today', timeZone: 'Africa/Nairobi', now: fixedNow },
    2500,
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    calendarId: 'primary',
    timeMin: '2026-11-19T21:00:00.000Z',
    timeMax: '2026-11-20T21:00:00.000Z',
    timeZone: 'Africa/Nairobi',
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });
  assert.equal(requests[1]?.pageToken, 'next-page');
  assert.deepEqual(events, [
    {
      id: 'event-1',
      summary: 'Project review',
      description: 'Weekly review.',
      start: '2026-11-20T15:00:00+03:00',
      end: '2026-11-20T16:00:00+03:00',
      location: 'Nairobi',
      status: 'confirmed',
    },
    {
      id: 'event-2',
      summary: 'Second event',
      start: '2026-11-20',
      end: '2026-11-21',
      status: 'confirmed',
    },
  ]);
});

test('Calendar lookup returns an actual empty list when Google returns no events', async () => {
  const service = createCalendarService(async () => ({
    status: 200,
    data: { items: [] },
  }));

  assert.deepEqual(
    await service.listEvents({ period: 'upcoming' }),
    [],
  );
});

test('Calendar lookup propagates Google API failures instead of returning empty results', async () => {
  const failure = Object.assign(new Error('private upstream details'), {
    response: { status: 403 },
  });
  const service = createCalendarService(async () => {
    throw failure;
  });

  await assert.rejects(
    service.listEvents(),
    (error) => error === failure,
  );
});

test('Calendar periods use timezone-aware day and week boundaries', () => {
  const options: CalendarLookupOptions = {
    timeZone: 'Africa/Nairobi',
    now: fixedNow,
  };
  assert.deepEqual(getCalendarLookupTimeRange({ ...options, period: 'today' }), {
    timeMin: '2026-11-19T21:00:00.000Z',
    timeMax: '2026-11-20T21:00:00.000Z',
  });
  assert.deepEqual(getCalendarLookupTimeRange({ ...options, period: 'tomorrow' }), {
    timeMin: '2026-11-20T21:00:00.000Z',
    timeMax: '2026-11-21T21:00:00.000Z',
  });
  assert.deepEqual(getCalendarLookupTimeRange({ ...options, period: 'this_week' }), {
    timeMin: '2026-11-15T21:00:00.000Z',
    timeMax: '2026-11-22T21:00:00.000Z',
  });
  assert.deepEqual(getCalendarLookupTimeRange({ ...options, period: 'upcoming' }), {
    timeMin: fixedNow.toISOString(),
  });
});

test('Calendar lookup API reports that Google OAuth must be completed', async () => {
  const app = await buildApp({
    googleAuthService: {
      beginAuthorization: async () => ({ state: 'test-state', authUrl: 'https://accounts.google.com/' }),
      completeAuthorization: async () => ({ connected: true }),
      validateAuthorizationState: () => undefined,
      getAuthenticatedGoogleClient: async () => {
        throw new GoogleAuthError(
          'GOOGLE_ACCOUNT_NOT_CONNECTED',
          'Authorize the Google account using GET /api/google/connect before using Calendar or Gmail.',
        );
      },
    },
  });
  try {
    await app.ready();
    assert.ok(app.swagger().paths?.['/api/google/calendar/events']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/google/calendar/events?period=today',
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      success: false,
      tool: 'calendar_lookup',
      error: {
        code: 'GOOGLE_ACCOUNT_NOT_CONNECTED',
        message: 'Authorize the Google account using GET /api/google/connect before using Calendar or Gmail.',
      },
    });
  } finally {
    await app.close();
  }
});
