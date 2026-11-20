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

### Google OAuth permissions

Google is configured as one shared account for this deployment. The authorization
URL requests `calendar.events`, `gmail.readonly`, and `gmail.send` with offline
access and consent prompting. Configure `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and
`GOOGLE_TOKEN_ENCRYPTION_KEY`. Generate the encryption key outside the source
tree (for example, `openssl rand -base64 32`) and provide it through the
deployment secret manager. The key must decode from base64 to exactly 32 bytes.
Do not reuse a key shared in chat or commit it to source control.

Run `npm run db:migrate` against the existing PostgreSQL database to make
`integration_accounts.user_id` nullable for the singleton connection and add
the uniqueness constraint. Then open `GET /api/google/connect`, follow its
`authUrl`, and complete Google's redirect to
`http://localhost:3020/google/redirect` (or `GOOGLE_REDIRECT_URI`). The callback
validates a short-lived HttpOnly state cookie, exchanges the authorization code,
and stores encrypted access/refresh tokens and granted scopes in the existing
`oauth_tokens` table. Tokens are never returned by the callback. A connected
account is not silently replaced by another callback.

`GET /api/google/calendar/events` now uses the stored shared credentials and
does not require a Google bearer token. Gmail search and the Gmail service's
read/send methods use the same credentials. The backend refreshes expired
access tokens and persists refreshed values while retaining a stored refresh
token when Google omits a replacement.

This application currently has no API authentication middleware. Because the
Google account is shared, any caller able to reach the AI or Calendar HTTP
routes can potentially access that account's data. Keep those routes behind a
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
`userId` and a `decision` of `approve` or `reject`. Only the stored action and
payload are used; repeated decisions do not execute an action again.

The decision endpoint expects an upstream-authenticated caller to supply the
authenticated user ID. This application does not implement that authentication
boundary itself. Sensitive Gmail sends and Calendar modifications/deletions
continue to require the existing approval workflow.
