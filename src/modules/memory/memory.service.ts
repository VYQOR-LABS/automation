import { randomUUID } from 'node:crypto';

export type MemoryRecord = {
  id: string;
  userId: string;
  factText: string;
  memoryDomain: 'personal' | 'work' | 'shared';
  confidence: number;
  sourceType: string;
  createdAt: string;
};

export class MemoryService {
  private readonly store: MemoryRecord[] = [];

  async addMemory(input: { userId: string; factText: string; memoryDomain?: MemoryRecord['memoryDomain']; sourceType?: string }) {
    const record: MemoryRecord = {
      id: randomUUID(),
      userId: input.userId,
      factText: input.factText,
      memoryDomain: input.memoryDomain ?? 'personal',
      confidence: 0.92,
      sourceType: input.sourceType ?? 'conversation',
      createdAt: new Date().toISOString(),
    };

    this.store.push(record);
    return record;
  }

  async search(userId: string, query: string) {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    return this.store
      .filter((record) => record.userId === userId)
      .filter((record) => record.factText.toLowerCase().includes(trimmed.toLowerCase()))
      .slice(0, 5);
  }
}
