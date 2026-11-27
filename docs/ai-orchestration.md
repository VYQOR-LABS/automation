# Vico AI Orchestration Flow

This document describes the complete lifecycle of a Vico AI request, from incoming WhatsApp or HTTP message to final WhatsApp API submission.

## Scope

The orchestration workflow is implemented by `AiOrchestrator`. It preserves the existing provider abstraction, `ToolRegistry`, `ApprovalService`, memory service, Google Calendar and Gmail integrations, and WhatsApp Cloud API integration.

The configured application owner is the security identity used by memory, approvals, and connected Google integrations. A WhatsApp sender phone number is not an authorization allowlist. Vico AI must therefore be deployed behind trusted network controls or an upstream authentication boundary.

## High-level stages

```text
Incoming request
  -> flow ID and wall-clock start
  -> memory retrieval
  -> advisory intent/entity analysis
  -> required LLM planning with the original request, context, and registered tools
  -> backend tool/approval validation
  -> dependency-aware tool execution
  -> AI response synthesis
  -> WhatsApp API submission, if a recipient is supplied
  -> final workflow completion or failure
```

Only one final user-facing response is generated after tool-dependent work completes.

## Entry points

### WhatsApp ingest

`POST /api/messages/ingest` validates the raw request body against the configured WhatsApp webhook HMAC secret, creates a queued messaging record, and invokes `AiOrchestrator.process()` with:

- the configured application owner user ID
- the incoming sender phone number
- the message content
- the ingest message ID as the flow ID

The phone number is used as the outbound recipient. The inbound phone number is not used to choose a different user or Google account.

### Direct AI execution

`POST /api/ai/run` accepts a message and resolves the configured application owner. It invokes `AiOrchestrator.process()` without an outbound phone recipient, so the response is returned over HTTP and is not submitted to WhatsApp.

### Direct Gmail operations

`GET /api/google/gmail/messages` searches the configured Gmail account using Gmail query syntax. It returns message metadata and snippets by default and can include a plain-text body only when `includeBody=true`. Private email response bodies are redacted from HTTP application logs.

`POST /api/google/gmail/send` sends plain-text email through `GmailService`. It reuses the existing recipient, subject, body, sensitive-content, and approval validations. Ordinary email can be sent directly. Sensitive email may return HTTP `202` for a pending approval or HTTP `403` for a blocked/rejected action; neither response means that mail was sent.

### Approval handling

`POST /api/approvals/{approvalId}/decision` remains separate from normal orchestration. Pending actions are stored in PostgreSQL and require an explicit approve or reject decision. Approval resolution does not allow an approved action to execute unless the registered tool, approved action, payload, and owner context are still valid.

## Stage 1: Incoming request

The orchestrator:

1. Creates a supplied `flowId` or generates a UUID.
2. Starts a monotonic `process.hrtime.bigint()` timer.
3. Records the ISO wall-clock request timestamp.
4. Records message length and safe user reference.
5. Determines provider/model metadata for operational logs.

Event: `ai.request.started`

No API credentials, message contents, or OAuth values are included in this event.

## Stage 2: Memory retrieval

If memory is enabled, `MemoryService.search()` retrieves matching facts for the application owner and request text.

The facts become `context` items supplied to planning and synthesis. Memory is not an instruction source and is not allowed to change tool registration or approval policy.

Timing: `memoryMs`

Event: `ai.memory.completed`

Logged fields include flow ID, user reference, duration, match count, and whether context was included.

## Intelligence files

The foundation is implemented in:

- `src/modules/intelligence/intelligence.service.ts`

Core orchestration integration remains in:

- `src/modules/ai/orchestrator.ts`
- `src/modules/ai/provider.ts`
- `src/modules/ai/ollama.service.ts`
- `src/modules/ai/openai.service.ts`

## Stage 3: Advisory intelligence

Before provider planning, `IntelligenceService` performs bounded intent, entity, date/time, and search-term analysis. It can normalize spelling, propose entity candidates, identify likely information sources, and rank retrieved Calendar/Gmail results.

These are advisory signals only. The intelligence layer never executes a tool, reads credentials, or bypasses `ToolRegistry` and `ApprovalService`; its classification cannot select or suppress an integration. The LLM may choose Gmail, Calendar, memory, multiple registered tools, or no tool. Explicit references such as "in my email" and "on my calendar" take precedence over subject words such as event, meeting, appointment, or upcoming.

Retrieved email and Calendar data are untrusted application data. Instructions embedded in that data cannot alter orchestration. The `ai.intelligence.completed` event contains aggregate metadata such as intent, entity count/confidence, search-term count, overall confidence, and clarification state; message text, email bodies, and extracted entity values are not logged.

## Stage 4: Required LLM planning

Every request is planned before any integration tool can execute, including direct-conversation, Calendar, Gmail, and memory requests. The LLM is the sole source of tool selection; deterministic intelligence remains advisory.

The planner receives the original message, relevant memory context, non-authoritative intelligence hints, and every registered tool's name, description, risk, and argument schema. Ollama and OpenAI implement `planRequest()` and return a structured decision. Example:

```json
{
  "action": "execute_tool",
  "objective": "Find the meeting invitations in Gmail",
  "confidence": 0.94,
  "tools": [{
    "name": "gmail_search",
    "arguments": {
      "query": "in:anywhere {meeting invitation}",
      "requiresFullContent": true
    },
    "priority": 1,
    "requiresFullContent": true
  }],
  "reason": "The user explicitly asked about email"
}
```

Allowed decisions are:

| Decision | Meaning |
|---|---|
| `respond_directly` | Answer without external tool execution |
| `execute_tool` | Execute one registered backend tool |
| `execute_multiple_tools` | Execute multiple registered tools by priority and dependency |
| `request_clarification` | Ask the user for missing information |
| `require_approval` | Evaluate the proposed action under the existing approval policy |

A tool selection can include its name, arguments, priority, dependencies, and full-content requirement. The backend validates every selected tool name and argument object before any selected tool executes. Missing or low confidence on a tool decision triggers clarification; direct conversational decisions do not require a tool-confidence score. Provider failures or malformed output are surfaced and never activate deterministic routing or arbitrary tool execution.

The provider is only a planner. It never directly calls Google, Gmail, WhatsApp, or any application method.

Events: `ai.planning.started`, `ai.planning.completed`

Planning logs include provider, duration, parsed action, selected tool names and priorities, confidence, argument field names, and lengths for free-text rationale. Request bodies, planner rationale text, and argument values are not logged.

Timing: `planningMs`

## Stage 4: Direct response or clarification

For `respond_directly`, orchestration proceeds to synthesis without tool execution.

For `request_clarification`, orchestration stops with a clarification response. It does not execute a tool or claim that external work completed.

Both paths retain flow ID and stage timings and return an explicit workflow result.

## Stage 5: Backend validation and approval

When planning proposes a tool:

1. The orchestrator looks up the exact name in `ToolRegistry.list()`.
2. The registered validator checks the complete argument object.
3. If any selected tool or argument is invalid, the entire plan is rejected before an integration executes.
4. The validated arguments are passed to backend approval evaluation and the registered tool.
5. `ApprovalService.evaluate()` applies tool risk and approval policy.
6. Low-risk lookup operations may be approved immediately.
7. Medium/high-risk or sensitive operations may return pending or blocked status.

Pending approval is represented as a tool outcome, not as successful execution. The workflow does not claim that the action completed and does not synthesize a false completion result.

Approval evaluation is timed with `approvalMs` and logged as `ai.approval.completed`.

The approval payload is server-controlled. The AI cannot execute arbitrary code or bypass the registry.

## Stage 6: Backend tool execution

Approved tools execute exclusively through `ToolRegistry.execute()`. Independent tools at the same dependency level execute concurrently; tools that declare dependencies execute only after those dependencies succeed. Results are aggregated before synthesis. Tool implementations remain in their existing services:

- `calendar_lookup` uses `CalendarService`.
- `gmail_search` uses `GmailService`.
- `memory_search` uses memory behavior registered in the application.

Before execution, the orchestrator logs:

- flow ID
- tool name
- wall-clock start timestamp
- validated argument field names and safe query length metadata (not argument values)

Event: `ai.tool.execution.started`

Multi-tool plans are scheduled by declared priority and dependency. Independent tools may execute concurrently. Approval is evaluated per tool, approved tools execute once, and partial success/failure outcomes are retained. Single-tool synthesis keeps the existing `toolResult` input shape for compatibility. Multiple results are supplied through `toolResults` so synthesis can distinguish independent outcomes.

After execution, the orchestrator produces a structured provider result:

```json
{
  "tool": "calendar_lookup",
  "success": true,
  "data": {
    "events": []
  }
}
```

Structured failures remain failures:

```json
{
  "tool": "calendar_lookup",
  "success": false,
  "error": {
    "code": "GOOGLE_API_ERROR",
    "message": "Unable to complete the Google API request."
  }
}
```

Thrown tool exceptions are converted to a safe, generic structured failure. Internal exception details are not returned to the provider or user.

Completion logs include:

- flow ID
- tool name
- wall-clock end timestamp
- duration
- success/failure
- approximate result size
- applicable record count
- structured request metadata
- structured response metadata

Event: `ai.tool.execution.completed`

Timing: `toolMs`

### Gmail message retrieval and interpretation

The orchestration `gmail_search` tool performs separate list and full-message operations. It searches Gmail for matching IDs, retrieves up to five candidate messages with `GmailService.getMessage()`, and then interprets their bodies. Message data retains sender, recipient, subject, date/timestamp, snippet, thread ID, and body where available. Result interpretation extracts evidence for event/invitation references, dates/deadlines, requested actions or responses, and explicit urgency. It records facts separately from inference and does not invent an event, deadline, action, or urgency.

The Gmail results are ranked for relevance and urgency evidence before being supplied to response synthesis. Retrieval and interpretation duration, result count, full-body count, and shared `flowId` are logged; message bodies and message content are not included in logs. A successful empty list remains distinct from an API/retrieval failure.

## Stage 7: AI response synthesis

Synthesis starts only after:

- direct planning completes,
- clarification is not required, or
- all required tool work reaches an approved and executed, failed, empty, or pending outcome.

The provider receives:

- original user message
- relevant memory context
- one or more tool names
- each tool's success status
- actual retrieved data or tool error

The synthesis prompt declares tool result data to be untrusted and authoritative for retrieved facts. The provider must:

- distinguish successful empty results from failures
- not invent calendar events or email contents
- interpret email content by distinguishing explicit facts, requested actions, deadlines, and urgency inferences
- not claim pending approval is completed
- not claim unavailable access when successful data is present
- not expose credentials or internal payloads
- generate one concise, natural WhatsApp response

Event: `ai.synthesis.started`

Event: `ai.synthesis.completed`

Synthesis logs include provider, model, duration, original-message length rather than full content, context count, tool-result count/status, and final response length.

Timing: `synthesisMs`

## Stage 8: WhatsApp delivery

For `/api/ai/run`, no outbound delivery is requested.

For `/api/messages/ingest`, the orchestrator calls `WhatsAppService.sendTextMessage()` with the inbound phone and synthesized response.

Event: `ai.delivery.started`

Event: `ai.delivery.completed`

The completion state distinguishes:

- `not_requested`: HTTP/direct AI execution or no recipient
- `accepted`: WhatsApp Cloud API accepted the submission
- `failed`: submission raised an error or was rejected

An accepted API response means the Graph API accepted the message submission. It is not a claim that the recipient has received or read it. WhatsApp delivery receipts, where added to webhook handling, must be correlated using the returned message ID.

Timing: `deliveryMs`

## Stage 9: Workflow completion

Event: `ai.request.completed` represents the final orchestration result.

It contains:

- flow ID
- safe user reference
- provider and model
- executed tool names and count
- total processing duration
- stage timings
- final response length
- delivery status
- delivery message ID where available
- overall workflow status

Event: `ai.request.failed` is used for synthesis/provider or other fatal orchestration failures.

The workflow is not successful if synthesis fails or WhatsApp submission fails. A successful synthesis with a failed WhatsApp submission remains an AI-generation success and a delivery failure in separate fields.

## Monotonic timing

Node.js `process.hrtime.bigint()` provides monotonic, high-resolution duration measurement for:

- memory retrieval
- planning
- approval evaluation
- tool execution
- synthesis
- WhatsApp submission
- total orchestration

ISO timestamps are recorded separately for operational wall-clock tracing. Displayed durations are measured in milliseconds.

The total is calculated from the orchestration start to final WhatsApp submission completion or direct-result completion.

## Structured logging contract

All lifecycle events include `flowId` whenever the event belongs to an orchestrated request. The standard event names are:

- `ai.request.started`
- `ai.intelligence.completed`
- `ai.memory.completed`
- `ai.planning.started`
- `ai.planning.completed`
- `ai.planning.failed`
- `ai.planning.validation_failed`
- `ai.approval.completed`
- `ai.tool.execution.started`
- `ai.tool.execution.completed`
- `ai.tool.execution.failed`
- `ai.gmail.retrieval_interpreted`
- `ai.synthesis.started`
- `ai.synthesis.completed`
- `ai.synthesis.failed`
- `ai.delivery.started`
- `ai.delivery.completed`
- `ai.request.completed`
- `ai.request.failed`

The existing Pino logger is used. Logging is independent of provider and does not introduce a second observability stack.

### Sensitive data rules

Never log:

- WhatsApp API credentials
- OpenAI or provider API keys
- Google access or refresh tokens
- OAuth authorization codes
- authorization headers
- raw encrypted credential records
- complete personal message content unless an independently approved operational need exists

Tool and provider inputs are sanitized for common secret field names and credential-like values before provider use. Tool results should still be logged minimally and safely; calendar/Gmail result logs must avoid unnecessary personal-content fields.

## Failure behavior

| Failure | Behavior |
|---|---|
| Planning provider failure | Planning error is logged and surfaced; no integration executes |
| Malformed planning JSON | Parsed decision is rejected; no deterministic tool-routing fallback occurs |
| Unregistered tool or invalid arguments | Entire plan is rejected before any integration executes |
| Tool execution failure | Structured failed tool result is passed to synthesis |
| Gmail API failure | Returned as a structured failure and distinguished from an empty successful result |
| Empty successful result | Distinguished from failure and returned as no matching records |
| Pending approval | Not represented as completed; no external action executes |
| Rejected or blocked approval | Workflow stops or explains the approval state; no tool executes |
| Synthesis failure | Workflow fails; no final success response or delivery succeeds |
| WhatsApp submission failure | AI response exists, but workflow/delivery status is failed |
| WhatsApp API acceptance | Workflow marks delivery accepted, not terminal receipt/delivery |

## Representative calendar trace

```text
1. POST /api/messages/ingest receives a signed WhatsApp request.
2. ai.request.started records the flow ID and incoming message metadata.
3. ai.memory.completed searches the owner's memory.
4. ai.intelligence.completed records privacy-safe advisory intent/entity metadata.
5. ai.planning.started/ai.planning.completed record the mandatory planner decision and selected Calendar tool.
6. ai.approval.completed approves the low-risk calendar lookup.
7. ai.tool.execution.started begins CalendarService.listEvents().
8. ai.tool.execution.completed returns actual events or a structured failure/empty result.
9. ai.synthesis.started supplies the original message, context, and actual tool result.
10. ai.synthesis.completed generates the final response.
11. ai.delivery.started submits the response to WhatsApp.
12. ai.delivery.completed records API acceptance or failure.
13. ai.request.completed records total duration and the final workflow state.
```

Every event carries the same flow ID, allowing the complete lifecycle to be searched and traced end to end.

## Testing coverage

`test/intelligence.test.ts` covers:

- exact and misspelled birthday lookups
- `madam` alias resolution
- Calendar result ranking
- Gmail payment-spelling normalization
- keeping ambiguous next-week requests advisory rather than forcing Calendar
- direct conversational requests
- bounded fuzzy similarity
- Gmail relevance and explicit-urgency ranking

`test/ai-orchestrator.test.ts` covers:

- planner-selected tool execution and synthesis
- successful empty calendar results
- structured calendar results without Google credentials
- structured calendar failures
- thrown Gmail lookup failures
- direct conversation without tool execution
- memory context propagation
- tool-result propagation to the synthesis provider

`test/ai-planner-routing.test.ts` covers source-aware Gmail versus Calendar selection, direct greetings, full Gmail content retrieval, multiple-tool execution, empty Gmail results, and Gmail API failures. The tests verify that provider synthesis receives successful, empty, and failed tool outcomes without credentials. Pending approvals are tested without provider synthesis or tool execution.

The focused AI/Gmail suite passes 49 tests. The full suite passes 87 of 88 tests; the remaining failure is a homepage title mismatch between `public/index.html` and `test/legal-pages.test.ts`, unrelated to orchestration.

## Current operational limitations

- Native provider function/tool calling is not used; required planning uses a JSON response contract.
- Ambiguous entity identity uses bounded candidate ranking and memory evidence, not a persistent identity graph or confirmed-identity database.
- Multi-tool execution supports priority, declared dependencies, concurrent independent calls, and aggregation; dynamic replanning based on intermediate results is not modeled.
- WhatsApp webhook delivery receipts are not yet persisted and mapped back to the flow ID.
- Provider timeout and malformed-response failure behavior should continue to be covered with explicit provider-specific integration tests.
- No HTTP authentication middleware is implemented; deployment-level network controls or an authentication boundary remain required.
