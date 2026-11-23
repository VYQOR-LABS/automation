# Google OAuth tokens and API requests

This guide describes how the application gets Google credentials, stores and
refreshes them, and uses them for Calendar and Gmail requests. The Google
connection is a single shared account for the application, not a per-user
connection.

## 1. Configure the OAuth client

Set these environment variables for the application:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3020/google/redirect
GOOGLE_TOKEN_ENCRYPTION_KEY=
```

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` identify the OAuth application;
they are not tokens for a Google account. Register the exact value of
`GOOGLE_REDIRECT_URI` as an authorized redirect URI in Google Cloud Console.
The default URI is `http://localhost:3020/google/redirect`.

`GOOGLE_TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key. It is used
to encrypt the tokens stored in PostgreSQL. Keep it secret and stable: changing
or losing the key makes existing encrypted tokens unreadable. An optional
`GOOGLE_REFRESH_TOKEN` can bootstrap authorization when there is no stored
refresh token; a database refresh token takes precedence once credentials are
stored.

Apply the database migrations before connecting Google. The token store uses
the `integration_accounts` and `oauth_tokens` tables.

## 2. Obtain and save tokens

1. Call `GET /api/google/connect` (the older alias
   `GET /api/google/auth-url` also works). The response contains an `authUrl`.
2. The server also sets a short-lived, `HttpOnly`, `SameSite=Lax` cookie with a
   random OAuth `state`. Open the returned URL in the same browser so that
   the browser sends the cookie back to the callback.
3. Google shows consent for these scopes:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`

   Authorization requests ask for offline access so the application can
   refresh access after the user leaves. The server asks Google to prompt for
   consent when it has no refresh token.
4. Google redirects to `GOOGLE_REDIRECT_URI` with a one-time authorization
   `code` and the `state`. The callback is available at
   `GET /google/redirect` (also `GET /api/google/callback`). The server compares
   the returned state with the cookie before exchanging the code.
5. The OAuth client exchanges the code with Google's token endpoint,
   `https://oauth2.googleapis.com/token`. The app checks that an access token,
   a refresh token (new or already held), and all required scopes are
   available. It saves credentials before confirming the connection. Google
   may omit a replacement refresh token; in that case, the existing refresh
   token is preserved.

The callback only returns a connection confirmation; it does not return the
access or refresh token. An unsuccessful save is treated as an error rather
than a successful connection.

## 3. Where credentials are stored

`EncryptedGoogleTokenStore` stores the shared Google account in
`integration_accounts` with provider `google` and no `user_id`. The associated
`oauth_tokens` row holds the access token, refresh token, expiry, token type,
and granted scopes. Both tokens are encrypted with AES-256-GCM before being
written to the database.

When a Google service needs credentials, it loads the shared record and
decrypts the tokens in memory. An access token expiring within 60 seconds is
considered due for refresh. The service uses the refresh token with Google's
OAuth token endpoint, checks the scopes again, and persists the new credentials
before returning an authenticated client. If Google rotates the refresh token,
the new one is stored; otherwise, the existing one is retained. A revoked or
expired refresh token requires reconnecting the Google account.

## 4. How the access token is sent to Google

Calendar and Gmail services call
`GoogleAuthService.getAuthenticatedGoogleClient()`. That method creates a
Google OAuth2 client and sets the decrypted access token, refresh token, expiry
and scopes on it. The services pass this OAuth2 client as the `auth` option to
the Google API client libraries:

- Calendar: `google.calendar({ version: 'v3', auth: authClient })`
- Gmail: `gmail({ version: 'v1', auth: authClient })`

The Google client library attaches the access token to Google API requests as
an HTTP `Authorization` header using the `Bearer` scheme and current access
token.

For example, Calendar event list/insert/get/patch/delete operations use the
authenticated Calendar client and the `primary` calendar. Gmail message
list/get/send operations use the authenticated Gmail client. Application code
does not manually copy a token into each request.

This is the token used on requests **from this backend to Google**. Callers of
the application's own Calendar or AI routes do not send a Google bearer token;
the backend retrieves it from its shared credential store.

## 5. Endpoints, errors, and access boundary

- `GET /api/google/connect` — start Google consent; returns `{ "authUrl": "..." }`.
- `GET /google/redirect` — OAuth callback; returns a connection confirmation,
  never tokens.
- `GET /api/google/calendar/events` — application Calendar lookup route.
- AI tools such as `calendar_lookup` and `gmail_search` use the same backend
  authentication service.

The application currently has no HTTP authentication middleware. Keep these
routes behind a trusted private network or an upstream authentication
boundary: a caller who can reach them may be able to access the shared Google
account's data. The OAuth state cookie protects the OAuth callback; it does
not authenticate callers of the application's API routes.

## Related implementation

- OAuth scopes, URL creation, callback token exchange, credential refresh and
  authenticated-client creation:
  [google.service.ts](../src/modules/google/google.service.ts)
- OAuth start/callback routes and the application Calendar route:
  [app.ts](../src/app.ts)
- Shared database credential loading and persistence:
  [google-token-store.ts](../src/modules/google/google-token-store.ts)
- AES-256-GCM token encryption:
  [google-token-crypto.ts](../src/modules/google/google-token-crypto.ts)
- Calendar API client creation and event operations:
  [calendar.service.ts](../src/modules/google/calendar.service.ts)
- Gmail API client creation and message operations:
  [gmail.service.ts](../src/modules/google/gmail.service.ts)
- Google API request metadata logging:
  [google-api-logger.ts](../src/modules/google/google-api-logger.ts)
- Environment variable defaults:
  [config.ts](../src/config.ts)
- Database table definitions:
  [schema.ts](../src/db/schema.ts)
- Database migration that creates the shared account and OAuth token tables:
  [0002_google_oauth_tables.sql](../drizzle/0002_google_oauth_tables.sql)
- OAuth and refresh behavior tests:
  [google-auth-service.test.ts](../test/google-auth-service.test.ts) and
  [google-oauth.test.ts](../test/google-oauth.test.ts)

### WhatsApp uses a different token

The WhatsApp integration does not use this Google OAuth flow. It sends its
separate `WHATSAPP_API_TOKEN` to the Meta Graph API from
[whatsapp.service.ts](../src/modules/whatsapp/whatsapp.service.ts).
