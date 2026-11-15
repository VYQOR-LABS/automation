import { randomUUID } from 'node:crypto';

export type ToolRisk = 'low' | 'medium' | 'high';

export class ApprovalService {
  constructor(private readonly enabled: boolean) {}

  async evaluate(action: { toolName: string; risk: ToolRisk; payload: Record<string, unknown> }) {
    if (!this.enabled || action.risk === 'low') {
      return {
        status: 'approved',
        approved: true,
        approvalId: randomUUID(),
      };
    }

    return {
      status: 'pending',
      approved: false,
      approvalId: randomUUID(),
      message: `Action ${action.toolName} requires explicit user approval before execution.`,
    };
  }
}
