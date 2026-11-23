## Vico AI

### AI provider configuration

The application selects one AI provider at startup with `AI_PROVIDER`. It defaults
to Ollama and creates only that provider.

For local development with Ollama:

```dotenv
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=phi3
OLLAMA_NUM_CTX=2048
OLLAMA_NUM_PREDICT=200
OLLAMA_TIMEOUT_MS=120000
```

Run Ollama locally, download the model, then start the application:

```sh
ollama serve
ollama pull phi3
npm run dev
```

Keep the Ollama API bound to localhost for local development. The base URL can
be changed to use a separately secured remote Ollama server.

To select OpenAI instead, configure its existing credentials and model:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_API_KEY` is required only when OpenAI is selected. The AI response
includes the selected provider and model in its metadata.

### Request flow logs

Structured info logs correlate the AI request, memory search, tool selection,
tool execution, and AI provider response with a `flowId`. Google Calendar and
Gmail service calls log the API operation, status, duration, and result count;
OAuth authorization, token exchange, credential lookup, refresh, and refresh
persistence log only operation metadata and timings. Tokens, authorization
codes, email contents, calendar event contents, and Gmail search queries are
not included. The default `LOG_LEVEL=info` includes these lifecycle logs.

### Single-owner configuration

Vico AI uses one WhatsApp business phone and one Google account. Configure
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
`WHATSAPP_WEBHOOK_SECRET`, and `WHATSAPP_VERIFY_TOKEN`. The app creates or
resolves one internal owner row in PostgreSQL and links it to the WhatsApp
integration identified by the configured phone-number and business-account
IDs. This internal UUID continues to back memory, approval, and audit foreign
keys; `APP_OWNER_USER_ID` is not required.

Meta webhook requests must have a valid `WHATSAPP_WEBHOOK_SECRET` signature and
match the configured receiving phone-number and business-account IDs. Any
sender can message the business number; sender phone numbers are not used as
an authorization allowlist. All senders use the same owner context and can
potentially trigger access to that owner's memory and connected Google data.
The direct message ingest endpoint likewise accepts any sender only when its
HMAC signature is valid. Keep these endpoints behind appropriate operational
controls and monitor access.

There are no user-registration or user-profile API routes. A valid Meta webhook
signature proves the request came from Meta, not that the sender is the owner.
The other HTTP API routes also have no authentication middleware. Keep
Calendar, AI, messaging, and approval routes behind a trusted private network
or an upstream authentication boundary.

### Google OAuth permissions

Vico AI uses one shared Google account. Configure the OAuth application:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_REDIRECT_URI=http://localhost:3020/google/redirect
GOOGLE_TOKEN_ENCRYPTION_KEY=
```

The Google client ID and secret identify the OAuth application; they do not
authorize access to an account.

`GET /api/google/connect` starts authorization. The URL requests offline access,
the `calendar.events`, `gmail.readonly`, and `gmail.send` scopes, and includes
previously granted scopes. Consent is prompted when neither a stored nor
environment refresh token is available. Complete authorization in the same
browser that called `/api/google/connect` so the HttpOnly OAuth state cookie is
sent to `/google/redirect`. The callback validates the cookie before the
existing Google OAuth client exchanges the code at
`https://oauth2.googleapis.com/token`. The callback returns only a connection
confirmation; raw tokens are never returned or logged.

Google credentials are encrypted with AES-256-GCM using
`GOOGLE_TOKEN_ENCRYPTION_KEY`, a base64-encoded 32-byte key. Keep this key
stable and secret; changing or losing it makes persisted credentials
undecryptable. Access and refresh tokens are stored encrypted in the shared
`oauth_tokens` record. On startup, Gmail and Calendar load that record and
decrypt credentials in memory. An optional `GOOGLE_REFRESH_TOKEN` is a bootstrap
fallback when no stored connection exists. OAuth callback and refresh token
responses must be persisted successfully before the operation is considered
successful. If authorization is revoked, reconnect through
`GET /api/google/connect`.

`GET /api/google/calendar/events` and Gmail use the same in-memory credentials.
The backend refreshes expired access tokens using the stored refresh token and
persists updated credentials before returning an authenticated client. The
configured `GOOGLE_REDIRECT_URI` must exactly match the URI registered in Google
Cloud Console; the existing default is
`http://localhost:3020/google/redirect`. These API routes do not require a
Google bearer token from the caller.

The PostgreSQL migrations must be applied before connecting Google. This
application currently has no API authentication middleware. Any caller
able to reach the AI or Calendar HTTP routes can potentially access the owner's
Google account data. Keep those routes behind a
trusted private network or add an application authentication boundary before
public deployment. The OAuth state cookie prevents callback CSRF; it does not
authenticate the operator or protect the Calendar/AI endpoints.

### Risk-based approvals

Calendar lookup, Gmail search/read, calendar event creation, and ordinary
outgoing email are low-risk operations. Calendar updates, deletions, sensitive
email sends, email deletions, and sensitive forwards require approval. Email
classification uses conservative server-side rules; `SENSITIVE_EMAIL_KEYWORDS`
can add comma-separated organization-specific indicators. It cannot remove the
built-in checks.

Pending actions are stored in the PostgreSQL `approval_requests` table and
expire after `APPROVAL_TTL_MS` (10 minutes by default). Approve or reject a
request with `POST /api/approvals/{approvalId}/decision`, sending the owner
`decision` of `approve` or `reject`. The application resolves the owner through
the configured WhatsApp integration IDs;
only the stored action and payload are used, and repeated decisions do not
execute an action again.

This application does not implement HTTP authentication. Keep the decision
endpoint behind a trusted private network or an upstream authentication
boundary. Sensitive Gmail sends and Calendar modifications/deletions continue
to require the existing approval workflow.
