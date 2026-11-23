import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import { config } from '../../config.js';
import { ApprovalService } from '../tools/approval.service.js';
import { logGoogleApiRequest } from './google-api-logger.js';
import { GoogleAuthService } from './google.service.js';

export type CalendarLookupPeriod = 'today' | 'tomorrow' | 'this_week' | 'upcoming';

export type CalendarLookupOptions = {
  period?: CalendarLookupPeriod;
  timeZone?: string;
  now?: Date;
};

type CalendarEventResult = {
  id: string;
  summary?: string;
  description?: string;
  start?: string;
  end?: string;
  location?: string;
  status?: string;
};

type CalendarListResponse = {
  data: {
    items?: calendar_v3.Schema$Event[] | null;
    nextPageToken?: string | null;
  };
  status?: number;
};

type CalendarListRequest = (
  params: calendar_v3.Params$Resource$Events$List,
) => Promise<CalendarListResponse>;

function getZonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(
    parts.map(({ type, value }) => [type, Number(value)]),
  ) as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function zonedMidnight(
  date: { year: number; month: number; day: number },
  timeZone: string,
) {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let timestamp = target;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const local = getZonedDateParts(new Date(timestamp), timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    timestamp += target - represented;
  }

  return new Date(timestamp).toISOString();
}

export function getCalendarLookupTimeRange(
  { period = 'upcoming', timeZone = 'Africa/Nairobi', now = new Date() }: CalendarLookupOptions = {},
) {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Calendar lookup time must be a valid date.');
  }

  const today = getZonedDateParts(now, timeZone);
  if (period === 'upcoming') {
    return { timeMin: now.toISOString() };
  }

  let firstDay: { year: number; month: number; day: number };
  let dayCount: number;
  if (period === 'today') {
    firstDay = today;
    dayCount = 1;
  } else if (period === 'tomorrow') {
    firstDay = addCalendarDays(today, 1);
    dayCount = 1;
  } else {
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    firstDay = addCalendarDays(today, (weekday + 6) % 7 * -1);
    dayCount = 7;
  }

  return {
    timeMin: zonedMidnight(firstDay, timeZone),
    timeMax: zonedMidnight(addCalendarDays(firstDay, dayCount), timeZone),
  };
}

export class CalendarService {
  constructor(
    private readonly approvalService = new ApprovalService(
      config.features.approvalsEnabled,
      config.approvalTtlMs,
    ),
    private readonly googleAuthService: Pick<GoogleAuthService, 'getAuthenticatedGoogleClient'> =
      new GoogleAuthService(),
    private readonly calendarListRequest?: CalendarListRequest,
  ) {}

  async createEvent(event: calendar_v3.Schema$Event) {
    const start = event.start?.dateTime ?? event.start?.date;
    const end = event.end?.dateTime ?? event.end?.date;
    if (
      !event.summary?.trim() ||
      typeof start !== 'string' ||
      typeof end !== 'string' ||
      !Number.isFinite(Date.parse(start)) ||
      !Number.isFinite(Date.parse(end)) ||
      Date.parse(end) <= Date.parse(start)
    ) {
      throw new Error('Calendar events require a title and valid start/end times.');
    }

    const response = await logGoogleApiRequest({
      service: 'calendar',
      operation: 'events.insert',
      calendarId: 'primary',
      request: async () => (await this.getCalendar()).events.insert({
        calendarId: 'primary',
        requestBody: event,
      }),
    });

    return response.data;
  }

  async getEvent(eventId: string) {
    const response = await logGoogleApiRequest({
      service: 'calendar',
      operation: 'events.get',
      calendarId: 'primary',
      request: async () => (await this.getCalendar()).events.get({
        calendarId: 'primary',
        eventId,
      }),
    });

    return response.data;
  }

  async updateEvent(
    eventId: string,
    event: calendar_v3.Schema$Event,
    userId: string,
  ) {
    const policy = await this.approvalService.evaluate({
      userId,
      toolName: 'calendar_update',
      payload: {
        calendarId: 'primary',
        eventId,
        changes: event,
      },
    });
    if (!policy.approved) {
      return policy;
    }

    const response = await logGoogleApiRequest({
      service: 'calendar',
      operation: 'events.patch',
      calendarId: 'primary',
      request: async () => (await this.getCalendar()).events.patch({
        calendarId: 'primary',
        eventId,
        requestBody: event,
      }),
    });

    return response.data;
  }

  async deleteEvent(eventId: string, userId: string) {
    const policy = await this.approvalService.evaluate({
      userId,
      toolName: 'calendar_delete',
      payload: { calendarId: 'primary', eventId },
    });
    if (!policy.approved) {
      return policy;
    }

    await logGoogleApiRequest({
      service: 'calendar',
      operation: 'events.delete',
      calendarId: 'primary',
      request: async () => (await this.getCalendar()).events.delete({
        calendarId: 'primary',
        eventId,
      }),
    });
  }

  async listUpcomingEvents(maxResults = 5) {
    return this.listEvents(
      { period: 'upcoming' },
      maxResults,
      maxResults,
    );
  }

  async listEvents(
    options: CalendarLookupOptions = {},
    maxResults = 2500,
    maxEventCount = Number.POSITIVE_INFINITY,
  ): Promise<CalendarEventResult[]> {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2500) {
      throw new Error('Calendar maxResults must be between 1 and 2500.');
    }

    const { timeMin, timeMax } = getCalendarLookupTimeRange(options);
    const calendar = this.calendarListRequest
      ? undefined
      : await this.getCalendar();
    const events: CalendarEventResult[] = [];
    let pageToken: string | undefined;

    do {
      const response = await logGoogleApiRequest({
        service: 'calendar',
        operation: 'events.list',
        calendarId: 'primary',
        request: () => {
          const params = {
            calendarId: 'primary',
            timeMin,
            ...(timeMax ? { timeMax } : {}),
            timeZone: options.timeZone ?? 'Africa/Nairobi',
            singleEvents: true,
            orderBy: 'startTime',
            maxResults,
            ...(pageToken ? { pageToken } : {}),
          };
          return this.calendarListRequest
            ? this.calendarListRequest(params)
            : calendar!.events.list(params);
        },
        getResultCount: (data) => data.items?.length ?? 0,
      });

      for (const event of response.data.items ?? []) {
        if (!event.id) {
          continue;
        }
        events.push({
          id: event.id,
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.description ? { description: event.description } : {}),
          ...(event.start?.dateTime || event.start?.date
            ? { start: event.start.dateTime ?? event.start.date! }
            : {}),
          ...(event.end?.dateTime || event.end?.date
            ? { end: event.end.dateTime ?? event.end.date! }
            : {}),
          ...(event.location ? { location: event.location } : {}),
          ...(event.status ? { status: event.status } : {}),
        });
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && events.length < maxEventCount);

    return events;
  }

  private async getCalendar() {
    const authClient = await this.googleAuthService.getAuthenticatedGoogleClient();
    return google.calendar({ version: 'v3', auth: authClient });
  }
}
