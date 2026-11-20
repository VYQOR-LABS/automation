import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import type { AiProvider, AiProviderInput } from './provider.js';
import { MemoryService } from '../memory/memory.service.js';
import { ApprovalService } from '../tools/approval.service.js';
import { ToolRegistry } from '../tools/tool-registry.js';

export type OrchestratorRequest = {
  userId: string;
  message: string;
};

function isStructuredToolResult(
  value: unknown,
): value is {
  success: boolean;
  tool: string;
  data?: unknown;
  error?: { code: string; message: string };
} {
  return typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof value.success === 'boolean' &&
    'tool' in value &&
    typeof value.tool === 'string' &&
    (!('error' in value) ||
      typeof value.error === 'object' &&
      value.error !== null &&
      'code' in value.error &&
      typeof value.error.code === 'string' &&
      'message' in value.error &&
      typeof value.error.message === 'string');
}

export class AiOrchestrator {
  constructor(
    private readonly deps: {
      memoryService: MemoryService;
      toolRegistry: ToolRegistry;
      approvalService: ApprovalService;
      aiProvider: AiProvider;
    },
  ) {}

  async process(request: OrchestratorRequest) {
    const flowId = randomUUID();
    const flowStartedAt = Date.now();
    logger.info(
      { flowId, userId: request.userId, messageLength: request.message.length },
      'AI request flow started',
    );

    const memoryMatches = config.features.memoryEnabled
      ? await this.deps.memoryService.search(request.userId, request.message)
      : [];
    logger.info(
      {
        flowId,
        userId: request.userId,
        memoryEnabled: config.features.memoryEnabled,
        memoryMatchCount: memoryMatches.length,
      },
      'AI memory search completed',
    );

    const toolList = this.deps.toolRegistry.list();
    const toolIntent = this.getToolIntent(request.message);

    const selectedTool = toolIntent ? toolList.find((tool) => tool.name === toolIntent) : undefined;
    logger.info(
      {
        flowId,
        userId: request.userId,
        intent: toolIntent ?? 'general-response',
        selectedTool: selectedTool?.name ?? null,
        availableToolCount: toolList.length,
      },
      'AI tool selection completed',
    );
    let toolResult: unknown = null;
    let providerToolResult: AiProviderInput['toolResult'];

    if (selectedTool) {
      const evaluation = await this.deps.approvalService.evaluate({
        userId: request.userId,
        toolName: selectedTool.name,
        payload: { message: request.message },
      });

      if (!evaluation.approved) {
        logger.info(
          {
            flowId,
            userId: request.userId,
            tool: selectedTool.name,
            approvalStatus: evaluation.status,
          },
          'AI tool execution requires approval',
        );
        toolResult = {
          approvalRequired: evaluation.status === 'pending',
          ...(evaluation.status === 'pending'
            ? {
                approvalId: evaluation.approvalId,
                action: evaluation.action,
                payload: evaluation.payload,
                expiresAt: evaluation.expiresAt,
                approvalEndpoint: evaluation.approvalEndpoint,
              }
            : {}),
          message: evaluation.message,
        };

        const result = {
          userId: request.userId,
          intent: toolIntent ?? 'general-response',
          memoryMatches,
          toolResult,
          availableTools: toolList,
          response: evaluation.message,
          provider: 'approval-service',
          model: 'risk-policy',
          generatedAt: new Date().toISOString(),
        };
        logger.info(
          {
            flowId,
            userId: request.userId,
            provider: result.provider,
            model: result.model,
            durationMs: Date.now() - flowStartedAt,
          },
          'AI request flow completed without tool execution',
        );
        return result;
      }

      const toolStartedAt = Date.now();
      logger.info(
        { flowId, userId: request.userId, tool: selectedTool.name },
        'AI tool execution started',
      );
      try {
        toolResult = await this.deps.toolRegistry.execute(selectedTool.name, {
          userId: request.userId,
          message: request.message,
          flowId,
        });
        providerToolResult = isStructuredToolResult(toolResult)
          ? {
              tool: toolResult.tool,
              success: toolResult.success,
              ...('data' in toolResult ? { data: toolResult.data } : {}),
              ...(toolResult.error ? { error: toolResult.error } : {}),
            }
          : {
              tool: selectedTool.name,
              success: true,
              data: toolResult,
            };
        logger.info(
          {
            tool: selectedTool.name,
            flowId,
            durationMs: Date.now() - toolStartedAt,
            success: providerToolResult.success,
          },
          'AI tool execution completed',
        );
      } catch {
        const durationMs = Date.now() - toolStartedAt;
        logger.error(
          {
            tool: selectedTool.name,
            flowId,
            durationMs,
            success: false,
          },
          'AI tool execution failed',
        );
        providerToolResult = {
          tool: selectedTool.name,
          success: false,
          error: 'The requested information could not be retrieved.',
        };
        toolResult = providerToolResult;
      }
    }

    const context = memoryMatches.map((match) => match.factText);
    logger.info(
      {
        flowId,
        userId: request.userId,
        toolResultIncluded: Boolean(providerToolResult),
        contextItemCount: context.length,
      },
      'AI provider request started',
    );
    const providerStartedAt = Date.now();
    let aiResponse: Awaited<ReturnType<AiProvider['generateReply']>>;
    try {
      aiResponse = await this.deps.aiProvider.generateReply({
        flowId,
        userId: request.userId,
        message: request.message,
        context,
        ...(providerToolResult ? { toolResult: providerToolResult } : {}),
      });
    } catch (error) {
      logger.error(
        {
          flowId,
          userId: request.userId,
          durationMs: Date.now() - providerStartedAt,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'AI provider request failed',
      );
      throw error;
    }
    logger.info(
      {
        flowId,
        userId: request.userId,
        provider: aiResponse.provider,
        model: aiResponse.model,
        durationMs: Date.now() - providerStartedAt,
        responseLength: aiResponse.content.length,
      },
      'AI provider response received',
    );

    const result = {
      userId: request.userId,
      intent: toolIntent ?? 'general-response',
      memoryMatches,
      toolResult,
      availableTools: toolList,
      response: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model,
      generatedAt: new Date().toISOString(),
    };
    logger.info(
      {
        flowId,
        userId: request.userId,
        intent: result.intent,
        provider: result.provider,
        model: result.model,
        durationMs: Date.now() - flowStartedAt,
      },
      'AI request flow completed',
    );
    return result;
  }

  private getToolIntent(message: string): string | null {
    const lower = message.toLowerCase();
    if (lower.includes('calendar') || lower.includes('schedule')) {
      return 'calendar_lookup';
    }
    if (lower.includes('memory') || lower.includes('remember')) {
      return 'memory_search';
    }
    if (lower.includes('email') || lower.includes('gmail')) {
      return 'gmail_search';
    }
    return null;
  }
}
