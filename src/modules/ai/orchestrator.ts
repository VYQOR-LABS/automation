import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import type { AiPlannedTool, AiProvider, AiProviderInput, AiPlanningDecision } from './provider.js';
import { MemoryService } from '../memory/memory.service.js';
import { ApprovalService } from '../tools/approval.service.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';

export type OrchestratorRequest = {
  userId: string;
  message: string;
  phone?: string;
  flowId?: string;
};

function elapsedMs(start: bigint) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function isStructuredToolResult(value: unknown): value is {
  success: boolean;
  tool: string;
  data?: unknown;
  error?: { code: string; message: string };
} {
  return typeof value === 'object' && value !== null && 'success' in value &&
    typeof (value as { success?: unknown }).success === 'boolean' &&
    'tool' in value && typeof (value as { tool?: unknown }).tool === 'string';
}

export class AiOrchestrator {
  private readonly intelligence = new IntelligenceService();

  constructor(
    private readonly deps: {
      memoryService: MemoryService;
      toolRegistry: ToolRegistry;
      approvalService: ApprovalService;
      aiProvider: AiProvider;
      whatsappService?: { sendTextMessage(to: string, text: string): Promise<unknown> };
    },
  ) {}

  async process(request: OrchestratorRequest) {
    const flowId = request.flowId ?? randomUUID();
    const flowStartedAt = process.hrtime.bigint();
    const wallStartedAt = new Date().toISOString();
    const timings = { memoryMs: 0, planningMs: 0, approvalMs: 0, toolMs: 0, synthesisMs: 0, deliveryMs: 0, totalMs: 0 };

    logger.info({ flowId, userId: request.userId, messageLength: request.message.length, requestTimestamp: wallStartedAt, provider: this.deps.aiProvider.constructor.name }, 'ai.request.started');

    let memoryMatches: Awaited<ReturnType<MemoryService['search']>> = [];
    const memoryStartedAt = process.hrtime.bigint();
    try {
      memoryMatches = config.features.memoryEnabled
        ? await this.deps.memoryService.search(request.userId, request.message)
        : [];
    } finally {
      timings.memoryMs = elapsedMs(memoryStartedAt);
      logger.info({ flowId, userId: request.userId, event: 'memory', durationMs: timings.memoryMs, memoryMatchCount: memoryMatches.length, contextIncluded: memoryMatches.length > 0 }, 'ai.memory.completed');
    }

    const toolList = this.deps.toolRegistry.list();
    const context = memoryMatches.map((match) => match.factText);
    const planningStartedAt = process.hrtime.bigint();
    const intelligence = this.intelligence.understand(request.message, memoryMatches);
    logger.info({
      flowId,
      userId: request.userId,
      normalizedMessageLength: intelligence.normalizedMessage.length,
      intent: intelligence.intent,
      entityCount: intelligence.entities.length,
      entityConfidence: intelligence.entities.map((entity) => entity.confidence),
      searchTermCount: intelligence.searchTerms.length,
      confidence: intelligence.confidence,
      clarificationRequired: intelligence.clarificationRequired,
    }, 'ai.intelligence.completed');
    logger.info({ flowId, userId: request.userId, provider: this.deps.aiProvider.constructor.name, contextItemCount: context.length, availableToolCount: toolList.length, intent: intelligence.intent }, 'ai.planning.started');

    let planningDecision: AiPlanningDecision | undefined;
    let planningRaw = '';

    if (intelligence.clarificationRequired) {
      planningDecision = {
        action: 'request_clarification',
        clarification: intelligence.clarification,
        confidence: intelligence.confidence,
      };
      planningRaw = 'Resolved by intelligence clarification policy.';
    } else if (intelligence.intent === 'direct_conversation') {
      planningDecision = {
        action: 'respond_directly',
        confidence: intelligence.confidence,
        reason: intelligence.reasoning,
      };
      planningRaw = 'Resolved directly by intelligence intent classifier.';
    } else if (
      intelligence.confidence >= 0.85 &&
      intelligence.tools.length === 1
    ) {
      const toolName = intelligence.tools[0];
      const registered = toolList.some((tool) => tool.name === toolName);
      if (registered) {
        const argumentsByTool: Record<string, Record<string, unknown>> = {
          calendar_lookup: {
            period: intelligence.timeExpressions.includes('tomorrow')
              ? 'tomorrow'
              : intelligence.timeExpressions.includes('today')
                ? 'today'
                : intelligence.timeExpressions.includes('this week') || intelligence.timeExpressions.includes('next week')
                  ? 'this_week'
                  : 'upcoming',
            searchTerms: intelligence.searchTerms,
          },
          gmail_search: {
            query: intelligence.searchTerms.join(' ').trim() || request.message,
            searchTerms: intelligence.searchTerms,
            requiresFullContent: true,
            maxResults: 5,
          },
          memory_search: {
            query: intelligence.searchTerms.join(' ').trim() || request.message,
          },
        };
        planningDecision = {
          action: 'execute_tool',
          tool: toolName,
          tools: [{
            name: toolName,
            arguments: argumentsByTool[toolName] ?? {},
            priority: 1,
          }],
          parameters: argumentsByTool[toolName] ?? {},
          confidence: intelligence.confidence,
          reason: 'Resolved directly by the high-confidence intelligence classifier.',
        };
        planningRaw = 'Resolved directly by intelligence tool routing.';
      }
    }

    if (!planningDecision) {
      try {
        const planned = await this.deps.aiProvider.planRequest({
          flowId,
          userId: request.userId,
          message: request.message,
          context,
          planningHints: [
            `Intent classifier hint (non-authoritative): ${intelligence.intent}.`,
            `Source candidates (non-authoritative): ${intelligence.tools.join(', ') || 'none'}.`,
            `Search terms (non-authoritative): ${intelligence.searchTerms.join(', ')}.`,
          ],
          availableTools: toolList,
        });
        planningRaw = planned.raw;
        planningDecision = planned.decision;
      } catch (error) {
        timings.planningMs = elapsedMs(planningStartedAt);
        timings.totalMs = elapsedMs(flowStartedAt);
        logger.error({
        flowId,
        userId: request.userId,
        durationMs: timings.planningMs,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'ai.planning.failed');
      logger.error({
        flowId,
        userId: request.userId,
        failedStage: 'planning',
        totalMs: timings.totalMs,
        timings,
      }, 'ai.request.failed');
        throw error;
      }
    }

    timings.planningMs = elapsedMs(planningStartedAt);
    logger.info({
      flowId,
      userId: request.userId,
      durationMs: timings.planningMs,
      plannerResponseLength: planningRaw.length,
      parsedDecision: planningDecision.action,
      selectedTools: planningDecision.tools?.map(({ name, priority }) => ({ name, priority })) ??
        (planningDecision.tool ? [{ name: planningDecision.tool, priority: 1 }] : []),
      objectiveLength: planningDecision.objective?.length,
      selectionExplanationLength: planningDecision.reason?.length,
      confidence: planningDecision.confidence,
      argumentKeys: planningDecision.tools?.map((tool) => Object.keys(tool.arguments)) ??
        Object.keys(planningDecision.parameters ?? {}),
      clarificationRequired: planningDecision.action === 'request_clarification',
      approvalRequired: planningDecision.action === 'require_approval',
    }, 'ai.planning.completed');

    if (planningDecision.action === 'request_clarification') {
      return this.finishDirect(request, flowId, wallStartedAt, flowStartedAt, timings, memoryMatches, toolList, planningDecision.clarification ?? 'Could you provide more details?', 'approval-service', 'risk-policy');
    }

    if (planningDecision.action === 'respond_directly') {
      return this.generateSynthesis(request, flowId, wallStartedAt, flowStartedAt, timings, memoryMatches, toolList, context, undefined);
    }

    if (planningDecision.confidence === undefined || planningDecision.confidence < 0.6) {
      return this.finishDirect(
        request,
        flowId,
        wallStartedAt,
        flowStartedAt,
        timings,
        memoryMatches,
        toolList,
        planningDecision.clarification ??
          'I am not confident which information source to check. Did you mean your email or your calendar?',
        'planner',
        'clarification',
      );
    }

    if (
      planningDecision.action !== 'execute_tool' &&
      planningDecision.action !== 'execute_multiple_tools' &&
      planningDecision.action !== 'require_approval'
    ) {
      return this.finishDirect(
        request,
        flowId,
        wallStartedAt,
        flowStartedAt,
        timings,
        memoryMatches,
        toolList,
        'I could not determine which information source you meant. Should I check your email or your calendar?',
        'planner',
        'clarification',
      );
    }

    const plannedTools = planningDecision.tools ?? (
      planningDecision.tool
        ? [{
            name: planningDecision.tool,
            arguments: planningDecision.parameters ?? {},
            priority: 1,
          }]
        : []
    );
    const selectedTools = [...plannedTools]
      .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
    if (
      selectedTools.length === 0 ||
      (planningDecision.action === 'execute_multiple_tools' && selectedTools.length < 2)
    ) {
      return this.finishDirect(
        request,
        flowId,
        wallStartedAt,
        flowStartedAt,
        timings,
        memoryMatches,
        toolList,
        planningDecision.clarification ?? 'Could you clarify which information source you want me to check?',
        'planner',
        'clarification',
      );
    }

    const providerToolResults: NonNullable<AiProviderInput['toolResults']> = [];
    const rawToolResults: unknown[] = [];
    const executionPlan: Array<AiPlannedTool & { validationError?: string }> = selectedTools.map((plannedTool) => {
      const registered = toolList.find((tool) => tool.name === plannedTool.name);
      if (!registered) {
        return {
          ...plannedTool,
          validationError: 'The requested tool is not registered.',
        };
      }
      try {
        return {
          ...plannedTool,
          arguments: this.deps.toolRegistry.validateInput(plannedTool.name, plannedTool.arguments),
        };
      } catch {
        return {
          ...plannedTool,
          validationError: 'The requested tool arguments failed backend validation.',
        };
      }
      });

    const invalidTools = executionPlan.filter((tool) => tool.validationError);
    if (invalidTools.length > 0) {
      logger.error({
        flowId,
        userId: request.userId,
        invalidToolCount: invalidTools.length,
        invalidToolNames: invalidTools.map((tool) => tool.name),
      }, 'ai.planning.validation_failed');
      return this.finishDirect(
        request,
        flowId,
        wallStartedAt,
        flowStartedAt,
        timings,
        memoryMatches,
        toolList,
        'I could not safely validate the requested lookup plan. Please rephrase your request.',
        'planner',
        'validation',
      );
    }

    const duplicateNames = executionPlan.some((tool, index) =>
      executionPlan.findIndex((candidate) => candidate.name === tool.name) !== index);
    const invalidDependencies = executionPlan.some((tool) =>
      tool.dependsOn?.some((dependency) =>
        dependency === tool.name || !executionPlan.some((candidate) => candidate.name === dependency)));
    const dependencyState = new Map<string, 'visiting' | 'done'>();
    const hasDependencyCycle = (name: string): boolean => {
      const state = dependencyState.get(name);
      if (state === 'visiting') return true;
      if (state === 'done') return false;
      dependencyState.set(name, 'visiting');
      const current = executionPlan.find((tool) => tool.name === name);
      if (current?.dependsOn?.some(hasDependencyCycle)) return true;
      dependencyState.set(name, 'done');
      return false;
    };
    const dependencyCycle = executionPlan.some((tool) => hasDependencyCycle(tool.name));
    if (duplicateNames || invalidDependencies || dependencyCycle) {
      logger.error({ flowId, userId: request.userId, duplicateNames, invalidDependencies, dependencyCycle }, 'ai.planning.validation_failed');
      return this.finishDirect(
        request,
        flowId,
        wallStartedAt,
        flowStartedAt,
        timings,
        memoryMatches,
        toolList,
        'I could not safely validate the requested lookup plan. Please rephrase your request.',
        'planner',
        'validation',
      );
    }

    type ExecutionOutcome = {
      provider: NonNullable<AiProviderInput['toolResults']>[number];
      raw: unknown;
    };
    const outcomes = new Map<string, ExecutionOutcome>();
    let pendingApproval: string | undefined;
    const remaining = new Map(executionPlan.map((tool) => [tool.name, tool]));
    while (remaining.size > 0) {
      const ready = [...remaining.values()]
        .filter((tool) => (tool.dependsOn ?? []).every((dependency) => outcomes.has(dependency)))
        .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
      if (ready.length === 0) {
        logger.error({ flowId, userId: request.userId, remainingTools: [...remaining.keys()] }, 'ai.planning.validation_failed');
        return this.finishDirect(
          request,
          flowId,
          wallStartedAt,
          flowStartedAt,
          timings,
          memoryMatches,
          toolList,
          'I could not safely validate the requested lookup dependencies.',
          'planner',
          'validation',
        );
      }

      const batch = await Promise.all(ready.map(async (plannedTool): Promise<[string, ExecutionOutcome]> => {
        const failedDependency = plannedTool.dependsOn?.find((dependency) =>
          !outcomes.get(dependency)?.provider.success);
        if (plannedTool.validationError || failedDependency) {
          const errorMessage = plannedTool.validationError ??
            `Required tool ${failedDependency} did not complete successfully.`;
          const failure = {
            tool: plannedTool.name,
            success: false,
            error: { code: plannedTool.validationError ? 'INVALID_TOOL_PLAN' : 'DEPENDENCY_FAILED', message: errorMessage },
          };
          return [plannedTool.name, { provider: failure, raw: failure }];
        }

        const approvalStartedAt = process.hrtime.bigint();
        const evaluation = await this.deps.approvalService.evaluate({
          userId: request.userId,
          toolName: plannedTool.name,
          payload: plannedTool.arguments,
        });
        timings.approvalMs += elapsedMs(approvalStartedAt);
        logger.info({ flowId, userId: request.userId, tool: plannedTool.name, approvalStatus: evaluation.status, durationMs: timings.approvalMs }, 'ai.approval.completed');
        if (!evaluation.approved) {
          const approval = {
            tool: plannedTool.name,
            success: false,
            approvalRequired: true,
            approvalStatus: evaluation.status,
            approvalId: 'approvalId' in evaluation ? evaluation.approvalId : undefined,
            message: evaluation.message,
          };
          pendingApproval ??= evaluation.message;
          return [plannedTool.name, {
            provider: {
              tool: plannedTool.name,
              success: false,
              error: evaluation.message ?? 'Approval is required before execution.',
            },
            raw: approval,
          }];
        }

        const toolStartedAt = process.hrtime.bigint();
        logger.info({
          flowId,
          userId: request.userId,
          tool: plannedTool.name,
          executionStartTimestamp: new Date().toISOString(),
          argumentKeys: Object.keys(plannedTool.arguments),
          queryLength: typeof plannedTool.arguments.query === 'string'
            ? plannedTool.arguments.query.length
            : undefined,
        }, 'ai.tool.execution.started');
        let raw: unknown;
        let providerResult: NonNullable<AiProviderInput['toolResults']>[number];
        try {
          raw = await this.deps.toolRegistry.execute(plannedTool.name, {
            ...plannedTool.arguments,
            userId: request.userId,
            message: request.message,
            flowId,
            dependencyResults: Object.fromEntries((plannedTool.dependsOn ?? []).map((name) => [
              name,
              outcomes.get(name)?.raw,
            ])),
          });
          providerResult = isStructuredToolResult(raw)
            ? {
                tool: raw.tool,
                success: raw.success,
                ...('data' in raw ? { data: raw.data } : {}),
                ...(raw.error ? { error: raw.error } : {}),
              }
            : { tool: plannedTool.name, success: true, data: raw };
        } catch (error) {
          logger.error({
            flowId,
            userId: request.userId,
            tool: plannedTool.name,
            durationMs: elapsedMs(toolStartedAt),
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }, 'ai.tool.execution.failed');
          raw = {
            tool: plannedTool.name,
            success: false,
            error: 'The requested information could not be retrieved.',
          };
          providerResult = {
            tool: plannedTool.name,
            success: false,
            error: 'The requested information could not be retrieved.',
          };
        }
        const durationMs = elapsedMs(toolStartedAt);
        timings.toolMs += durationMs;
        const sizeBytes = Buffer.byteLength(JSON.stringify(raw ?? null));
        const recordCount = this.countRecords(raw);
        logger.info({
          flowId,
          userId: request.userId,
          tool: plannedTool.name,
          executionEndTimestamp: new Date().toISOString(),
          durationMs,
          success: providerResult.success,
          resultSize: sizeBytes,
          recordCount,
        }, 'ai.tool.execution.completed');
        return [plannedTool.name, { provider: providerResult, raw }];
      }));
      for (const [name, outcome] of batch) {
        outcomes.set(name, outcome);
        remaining.delete(name);
      }
    }

    providerToolResults.push(...selectedTools.map((tool) => outcomes.get(tool.name)!.provider));
    rawToolResults.push(...selectedTools.map((tool) => outcomes.get(tool.name)!.raw));
    if (pendingApproval && selectedTools.length === 1) {
      return this.finishDirect(
        request,
        flowId,
        wallStartedAt,
        flowStartedAt,
        timings,
        memoryMatches,
        toolList,
        pendingApproval,
        'approval-service',
        'risk-policy',
        rawToolResults[0],
      );
    }

    const primary = providerToolResults[0];
    const rawPrimary = rawToolResults[0] ?? null;
    return this.generateSynthesis(
      request,
      flowId,
      wallStartedAt,
      flowStartedAt,
      timings,
      memoryMatches,
      toolList,
      context,
      primary,
      rawPrimary,
      providerToolResults,
      rawToolResults,
    );
  }

  private countRecords(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const data = 'data' in value ? (value as { data?: unknown }).data : value;
    if (!data || typeof data !== 'object') return undefined;
    for (const key of ['events', 'messages', 'results', 'items']) {
      if (key in data && Array.isArray((data as Record<string, unknown>)[key])) return ((data as Record<string, unknown>)[key] as unknown[]).length;
    }
    return undefined;
  }

  private async generateSynthesis(request: OrchestratorRequest, flowId: string, wallStartedAt: string, flowStartedAt: bigint, timings: Record<string, number>, memoryMatches: Awaited<ReturnType<MemoryService['search']>>, toolList: ReturnType<ToolRegistry['list']>, context: string[], toolResult?: AiProviderInput['toolResult'], rawToolResult?: unknown, toolResults?: NonNullable<AiProviderInput['toolResults']>, rawToolResults?: unknown[]) {
    const synthesisStartedAt = process.hrtime.bigint();
    logger.info({ flowId, userId: request.userId, provider: this.deps.aiProvider.constructor.name, originalMessageReference: request.message.length, contextItemCount: context.length, toolResultCount: toolResults?.length ?? (toolResult ? 1 : 0), toolStatuses: toolResults?.map((result) => result.success ? 'succeeded' : 'failed') ?? (toolResult ? [toolResult.success ? 'succeeded' : 'failed'] : []), requestTimestamp: new Date().toISOString() }, 'ai.synthesis.started');
    let aiResponse;
    try {
      aiResponse = await this.deps.aiProvider.generateReply({
        flowId,
        userId: request.userId,
        message: request.message,
        context,
        ...(toolResult ? { toolResult } : {}),
        ...(toolResults && toolResults.length > 1 ? { toolResults } : {}),
      });
    } catch (error) {
      timings.synthesisMs = elapsedMs(synthesisStartedAt);
      timings.totalMs = elapsedMs(flowStartedAt);
      logger.error({ flowId, userId: request.userId, durationMs: timings.synthesisMs, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ai.synthesis.failed');
      logger.error({
        flowId,
        userId: request.userId,
        failedStage: 'synthesis',
        totalMs: timings.totalMs,
        timings,
      }, 'ai.request.failed');
      throw error;
    }
    timings.synthesisMs = elapsedMs(synthesisStartedAt);
    logger.info({ flowId, userId: request.userId, provider: aiResponse.provider, model: aiResponse.model, durationMs: timings.synthesisMs, responseLength: aiResponse.content.length, succeeded: true }, 'ai.synthesis.completed');

    let deliveryStatus: 'not_requested' | 'accepted' | 'failed' = 'not_requested';
    let deliveryMessageId: string | undefined;
    if (request.phone && this.deps.whatsappService) {
      const deliveryStartedAt = process.hrtime.bigint();
      logger.info({ flowId, userId: request.userId, deliveryTarget: 'whatsapp', responseLength: aiResponse.content.length }, 'ai.delivery.started');
      try {
        const sent = await this.deps.whatsappService.sendTextMessage(request.phone, aiResponse.content) as { messages?: Array<{ id?: string }> };
        timings.deliveryMs = elapsedMs(deliveryStartedAt);
        deliveryMessageId = sent?.messages?.[0]?.id;
        deliveryStatus = 'accepted';
        logger.info({ flowId, userId: request.userId, durationMs: timings.deliveryMs, success: true, apiAcceptance: true, messageId: deliveryMessageId }, 'ai.delivery.completed');
      } catch (error) {
        timings.deliveryMs = elapsedMs(deliveryStartedAt);
        deliveryStatus = 'failed';
        logger.error({ flowId, userId: request.userId, durationMs: timings.deliveryMs, success: false, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ai.delivery.completed');
      }
    }

    timings.totalMs = elapsedMs(flowStartedAt);
    const executedTools = toolResults?.map((result) => result.tool) ?? (toolResult ? [toolResult.tool] : []);
    logger.info({ flowId, userId: request.userId, provider: aiResponse.provider, model: aiResponse.model, toolsExecuted: executedTools, toolsExecutedCount: executedTools.length, totalMs: timings.totalMs, timings, finalResponseLength: aiResponse.content.length, deliveryStatus, deliveryMessageId, workflowStatus: deliveryStatus === 'failed' ? 'failed' : 'succeeded' }, 'ai.request.completed');

    return { flowId, userId: request.userId, intent: toolResult?.tool ?? 'general-response', memoryMatches, toolResult: rawToolResults?.length === 1 ? rawToolResults[0] : rawToolResult ?? toolResult ?? null, ...(rawToolResults && rawToolResults.length > 1 ? { toolResults: rawToolResults } : {}), availableTools: toolList, response: aiResponse.content, provider: aiResponse.provider, model: aiResponse.model, generatedAt: new Date().toISOString(), timings, workflowStatus: deliveryStatus === 'failed' ? 'failed' : 'succeeded', deliveryStatus, deliveryMessageId };
  }

  private finishDirect(request: OrchestratorRequest, flowId: string, wallStartedAt: string, flowStartedAt: bigint, timings: Record<string, number>, memoryMatches: Awaited<ReturnType<MemoryService['search']>>, toolList: ReturnType<ToolRegistry['list']>, response: string, provider: string, model: string, toolResult?: unknown) {
    timings.totalMs = elapsedMs(flowStartedAt);
    logger.info({ flowId, userId: request.userId, provider, model, toolsExecuted: [], toolsExecutedCount: 0, totalMs: timings.totalMs, timings, finalResponseLength: response.length, deliveryStatus: 'not_requested', workflowStatus: 'succeeded' }, 'ai.request.completed');
    return { flowId, userId: request.userId, intent: 'pending-or-clarification', memoryMatches, toolResult: toolResult ?? null, availableTools: toolList, response, provider, model, generatedAt: new Date().toISOString(), timings, workflowStatus: 'succeeded', deliveryStatus: 'not_requested' };
  }
}
