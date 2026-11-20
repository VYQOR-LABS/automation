import type { ToolRisk } from './approval.service.js';

export type ToolDefinition = {
  name: string;
  description: string;
  risk: ToolRisk;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition) {
    this.tools.set(definition.name, definition);
  }

  list() {
    return Array.from(this.tools.values()).map(({ name, description, risk }) => ({
      name,
      description,
      risk,
    }));
  }

  async execute(name: string, input: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool.execute(input);
  }
}
