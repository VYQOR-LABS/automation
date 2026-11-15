import { config } from '../../config.js';
import { OpenAIService } from './openai.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { ApprovalService } from '../tools/approval.service.js';
import { ToolRegistry } from '../tools/tool-registry.js';

export type OrchestratorRequest = {
  userId: string;
  message: string;
};

export class AiOrchestrator {
  constructor(
    private readonly deps: {
      memoryService: MemoryService;
      toolRegistry: ToolRegistry;
      approvalService: ApprovalService;
      openAiService: OpenAIService;
    },
  ) {}

  async process(request: OrchestratorRequest) {
    const memoryMatches = config.features.memoryEnabled
      ? await this.deps.memoryService.search(request.userId, request.message)
      : [];

    const toolList = this.deps.toolRegistry.list();
    const toolIntent = this.getToolIntent(request.message);

    const selectedTool = toolIntent ? toolList.find((tool) => tool.name === toolIntent) : undefined;
    let toolResult: unknown = null;

    if (selectedTool) {
      const evaluation = await this.deps.approvalService.evaluate({
        toolName: selectedTool.name,
        risk: selectedTool.risk,
        payload: { message: request.message },
      });

      if (evaluation.approved) {
        toolResult = await this.deps.toolRegistry.execute(selectedTool.name, {
          userId: request.userId,
          message: request.message,
        });
      } else {
        toolResult = { approvalRequired: true, approvalId: evaluation.approvalId, message: evaluation.message };
      }
    }

    const aiResponse = await this.deps.openAiService.generateReply({
      userId: request.userId,
      message: request.message,
      context: memoryMatches.map((match) => match.factText),
    });

    return {
      userId: request.userId,
      intent: toolIntent ?? 'general-response',
      memoryMatches,
      toolResult,
      availableTools: toolList,
      response: aiResponse.content,
      model: config.openAiModel,
      generatedAt: new Date().toISOString(),
    };
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
