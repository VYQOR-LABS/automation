import { google } from 'googleapis';
import { config } from '../../config.js';

export class GoogleIntegrationService {
  buildAuthUrl() {
    const oauth2Client = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
    );

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    });
  }

  async exchangeCode(code: string) {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('Google OAuth client has not been configured.');
    }

    const oauth2Client = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
    );

    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
  }
}
