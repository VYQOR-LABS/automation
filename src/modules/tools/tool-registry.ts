import type { ToolRisk } from './approval.service.js';

export type ToolDefinition = {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters?: Record<string, unknown>;
  validateInput?: (input: Record<string, unknown>) => Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition) {
    this.tools.set(definition.name, definition);
  }

  list() {
    return Array.from(this.tools.values()).map(({ name, description, risk, parameters }) => ({
      name,
      description,
      risk,
      parameters: parameters ?? {
        type: 'object',
        additionalProperties: true,
        description: 'Tool parameters are validated by the backend before execution.',
      },
    }));
  }

  validateInput(name: string, input: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool.validateInput ? tool.validateInput(input) : input;
  }

  async execute(name: string, input: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool.execute(input);
  }
}
