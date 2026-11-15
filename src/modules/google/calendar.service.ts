import { google } from 'googleapis';
import { config } from '../../config.js';

export class CalendarService {
  async listUpcomingEvents(accessToken: string, maxResults = 5) {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('Google OAuth is not configured.');
    }

    const oauth2Client = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
    );

    oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const response = await calendar.events.list({
      calendarId: 'primary',
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return response.data.items ?? [];
  }
}
