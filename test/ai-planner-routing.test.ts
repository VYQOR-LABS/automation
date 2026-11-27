import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import type { AiPlanningDecision, AiProvider } from '../src/modules/ai/provider.js';
import { interpretGmailMessage } from '../src/modules/google/gmail-result-interpreter.js';
import { MemoryService } from '../src/modules/memory/memory.service.js';
import { ApprovalService } from '../src/modules/tools/approval.service.js';
import { ToolRegistry } from '../src/modules/tools/tool-registry.js';

type ToolCall = {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string | { code: string; message: string };
};

function decisionFor(message: string): AiPlanningDecision {
  const lower = message.toLowerCase();
  if (lower.includes('good morning')) {
    return { action: 'respond_directly' };
  }
  if (lower.includes('calendar and')) {
    return {
      action: 'execute_multiple_tools',
      objective: 'Check the calendar and find its invitation email.',
      confidence: 0.98,
      tools: [
        {
          name: 'calendar_lookup',
          arguments: { period: 'tomorrow' },
          priority: 1,
        },
        {
          name: 'gmail_search',
          arguments: {
            query: 'in:anywhere {invitation meeting}',
            requiresFullContent: true,
          },
          priority: 2,
        },
      ],
    };
  }
  if (lower.includes('email') || lower.includes('invitation')) {
    return {
      action: 'execute_tool',
      objective: 'Find relevant email and inspect its contents.',
      confidence: 0.97,
      tools: [{
        name: 'gmail_search',
        arguments: {
          query: 'in:anywhere {event meeting invitation appointment} newer_than:30d',
          requiresFullContent: true,
        },
        priority: 1,
      }],
    };
  }
  return {
    action: 'execute_tool',
    objective: 'Look up calendar events.',
    confidence: 0.98,
    tools: [{
      name: 'calendar_lookup',
      arguments: { period: 'tomorrow' },
      priority: 1,
    }],
  };
}

function makePlanner(
  calls: string[],
  selectedTools: string[],
  onPlan?: (message: string, input: Parameters<AiProvider['planRequest']>[0]) => void,
): AiProvider {
  return {
    async planRequest(input) {
      calls.push('planner');
      const decision = decisionFor(input.message);
      selectedTools.push(...(decision.tools ?? []).map(({ name }) => name));
      onPlan?.(input.message, input);
      return {
        provider: 'planner-test',
        model: 'planner-test',
        raw: JSON.stringify(decision),
        decision,
      };
    },
    async generateReply(input) {
      calls.push('synthesis');
      const toolResults = input.toolResults ?? (input.toolResult ? [input.toolResult] : []);
      const resultText = JSON.stringify(toolResults);
      if (toolResults.some((tool) => tool.success === false)) {
        return { provider: 'planner-test', model: 'synthesis-test', content: 'I could not retrieve the email.' };
      }
      if (toolResults.some((tool) => tool.tool === 'gmail_search' && JSON.stringify(tool.data).includes('messages":[]'))) {
        return { provider: 'planner-test', model: 'synthesis-test', content: 'I found no matching emails.' };
      }
      if (resultText.includes('Quarterly meeting')) {
        return { provider: 'planner-test', model: 'synthesis-test', content: 'The email requests your confirmation for the quarterly meeting on December 4.' };
      }
      return { provider: 'planner-test', model: 'synthesis-test', content: 'Here is what I found.' };
    },
  };
}

function createRegistry(options: {
  gmailResult?: 'email' | 'empty' | 'failure';
  calls: string[];
  concurrentBarrier?: { count: number; release: () => void };
}) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'calendar_lookup',
    description: 'Read calendar events by date period.',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['today', 'tomorrow', 'this_week', 'upcoming'] } },
      required: ['period'],
      additionalProperties: false,
    },
    validateInput(input) {
      assert.equal(typeof input.period, 'string');
      return input;
    },
    async execute(input) {
      options.calls.push('calendar');
      await options.concurrentBarrier?.release();
      return {
        tool: 'calendar_lookup',
        success: true,
        data: { events: [{ summary: `Event for ${String(input.period)}` }] },
      };
    },
  });
  registry.register({
    name: 'gmail_search',
    description: 'Search Gmail and read full message bodies.',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 500 },
        requiresFullContent: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    validateInput(input) {
      assert.equal(typeof input.query, 'string');
      return input;
    },
    async execute() {
      options.calls.push('gmail');
      await options.concurrentBarrier?.release();
      if (options.gmailResult === 'failure') {
        throw new Error('Private Gmail API diagnostic');
      }
      if (options.gmailResult === 'empty') {
        return { tool: 'gmail_search', success: true, data: { messages: [] } };
      }
      const fullMessage = interpretGmailMessage({
        id: 'message-1',
        threadId: 'thread-1',
        from: 'organizer@example.com',
        to: 'owner@example.com',
        subject: 'Quarterly meeting invitation',
        date: 'Tue, 24 Nov 2026 09:00:00 +0000',
        snippet: 'Please confirm your attendance.',
        body: 'Please confirm your attendance for the quarterly meeting on December 4. Reply by December 1.',
      });
      return {
        tool: 'gmail_search',
        success: true,
        data: {
          messages: [fullMessage],
          retrieval: { messageCount: 1, fullBodyCount: 1 },
        },
      };
    },
  });
  return registry;
}

function createOrchestrator(
  provider: AiProvider,
  toolRegistry: ToolRegistry,
) {
  return new AiOrchestrator({
    memoryService: new MemoryService(),
    toolRegistry,
    approvalService: new ApprovalService(true),
    aiProvider: provider,
  });
}

test('email event needing attention is routed directly to Gmail and full content is available to synthesis', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  let observedInput: Parameters<AiProvider['planRequest']>[0] | undefined;
  const provider = makePlanner(calls, selected, (_message, input) => {
    observedInput = input;
  });
  const registry = createRegistry({ calls, gmailResult: 'email' });
  const result = await createOrchestrator(provider, registry).process({
    userId: 'user-1',
    message: 'What event in my email needs my attention?',
  });

  assert.deepEqual(calls, ['gmail', 'synthesis']);
  assert.deepEqual(selected, []);
  assert.equal(observedInput, undefined);
  assert.equal(result.toolResult && JSON.stringify(result.toolResult).includes('Reply by December 1.'), true);
  assert.match(result.response, /December 4/);
});

test('meeting schedule requests are executed through the high-confidence intelligence route', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  const result = await createOrchestrator(
    makePlanner(calls, selected),
    createRegistry({ calls }),
  ).process({ userId: 'user-1', message: 'What meetings do I have tomorrow?' });

  assert.deepEqual(selected, []);
  assert.deepEqual(calls, ['calendar', 'synthesis']);
  assert.equal(JSON.stringify(result.toolResult).includes('Event for tomorrow'), true);
});

test('meeting invitation requests are routed to Gmail by the planner', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  const result = await createOrchestrator(
    makePlanner(calls, selected),
    createRegistry({ calls, gmailResult: 'email' }),
  ).process({ userId: 'user-1', message: 'Did anyone send me a meeting invitation?' });

  assert.deepEqual(selected, []);
  assert.ok(calls.includes('gmail'));
  assert.equal(JSON.stringify(result.toolResult).includes('fullBodyCount'), true);
});

test('explicit calendar source selects Calendar through intelligence', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  const result = await createOrchestrator(
    makePlanner(calls, selected),
    createRegistry({ calls }),
  ).process({ userId: 'user-1', message: 'What is on my calendar tomorrow?' });

  assert.deepEqual(selected, []);
  assert.deepEqual(calls, ['calendar', 'synthesis']);
  assert.equal(JSON.stringify(result.toolResult).includes('calendar_lookup'), true);
});

test('upcoming appointment email is read and available to synthesis', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  const result = await createOrchestrator(
    makePlanner(calls, selected),
    createRegistry({ calls, gmailResult: 'email' }),
  ).process({ userId: 'user-1', message: 'Find the email about my upcoming appointment.' });

  assert.deepEqual(selected, []);
  assert.equal(JSON.stringify(result.toolResult).includes('December 1'), true);
  assert.match(result.response, /confirmation/);
});

test('independent Gmail and Calendar tools are executed concurrently and aggregated', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  let complete!: () => void;
  const ready = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const concurrentBarrier = {
    count: 0,
    release: async () => {
      concurrentBarrier.count += 1;
      if (concurrentBarrier.count === 2) complete();
      await ready;
    },
  };
  let receivedResults: ToolCall[] | undefined;
  const provider = makePlanner(calls, selected);
  const originalSynthesis = provider.generateReply;
  provider.generateReply = async (input) => {
    receivedResults = input.toolResults as ToolCall[];
    return originalSynthesis(input);
  };
  const result = await createOrchestrator(
    provider,
    createRegistry({ calls, gmailResult: 'email', concurrentBarrier }),
  ).process({
    userId: 'user-1',
    message: 'Check my calendar and find the invitation in my email.',
  });

  assert.deepEqual(selected, ['calendar_lookup', 'gmail_search']);
  assert.equal(calls.includes('calendar'), true);
  assert.equal(calls.includes('gmail'), true);
  assert.equal(receivedResults?.length, 2);
  assert.equal(Array.isArray((result as { toolResults?: unknown[] }).toolResults), true);
});

test('rejects a multi-tool plan with an unregistered tool before any integration executes', async () => {
  const calls: string[] = [];
  const provider: AiProvider = {
    async planRequest() {
      return {
        provider: 'planner-test',
        model: 'planner-test',
        raw: '',
        decision: {
          action: 'execute_multiple_tools',
          confidence: 0.99,
          tools: [
            { name: 'calendar_lookup', arguments: { period: 'tomorrow' } },
            { name: 'unregistered_tool', arguments: {} },
          ],
        },
      };
    },
    async generateReply() {
      return { provider: 'planner-test', model: 'synthesis-test', content: 'Unexpected synthesis.' };
    },
  };
  const result = await createOrchestrator(
    provider,
    createRegistry({ calls }),
  ).process({ userId: 'user-1', message: 'Check my calendar and email.' });

  assert.deepEqual(calls, []);
  assert.match(result.response, /could not safely validate/i);
});

test('direct greeting is planned without tool execution', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  await createOrchestrator(
    makePlanner(calls, selected),
    createRegistry({ calls }),
  ).process({ userId: 'user-1', message: 'Good morning.' });

  assert.deepEqual(calls, ['synthesis']);
  assert.deepEqual(selected, []);
});

test('empty Gmail search remains a successful no-results result', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  const result = await createOrchestrator(
    makePlanner(calls, selected),
    createRegistry({ calls, gmailResult: 'empty' }),
  ).process({ userId: 'user-1', message: 'What event in my email needs attention?' });

  assert.equal((result.toolResult as { success: boolean }).success, true);
  assert.equal(JSON.stringify(result.toolResult).includes('"messages":[]'), true);
  assert.match(result.response, /no matching emails/);
});

test('Gmail API failure remains distinct from an empty successful result', async () => {
  const calls: string[] = [];
  const selected: string[] = [];
  let synthesisToolResult: ToolCall | undefined;
  const provider = makePlanner(calls, selected);
  const originalSynthesis = provider.generateReply;
  provider.generateReply = async (input) => {
    synthesisToolResult = input.toolResult as ToolCall;
    return originalSynthesis(input);
  };
  const result = await createOrchestrator(
    provider,
    createRegistry({ calls, gmailResult: 'failure' }),
  ).process({ userId: 'user-1', message: 'What event in my email needs attention?' });

  assert.equal(synthesisToolResult?.success, false);
  assert.equal(JSON.stringify(synthesisToolResult).includes('messages":[]'), false);
  assert.match(result.response, /could not retrieve the email/);
});
