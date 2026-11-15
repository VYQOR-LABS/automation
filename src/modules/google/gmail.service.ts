import { gmail } from '@googleapis/gmail';
import { google } from 'googleapis';
import { config } from '../../config.js';

export class GmailService {
  async listMessages(accessToken: string, query?: string) {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('Google OAuth is not configured.');
    }

    const oauth2Client = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
    );

    oauth2Client.setCredentials({ access_token: accessToken });
    const gmailClient = gmail({ version: 'v1', auth: oauth2Client });
    const response = await gmailClient.users.messages.list({
      userId: 'me',
      q: query ?? 'in:inbox',
      maxResults: 5,
    });

    return response.data.messages ?? [];
  }
}
