import { randomUUID } from 'node:crypto';

export type IngestMessageInput = {
  phone: string;
  content: string;
};

export class MessagingService {
  async ingestMessage(input: IngestMessageInput) {
    return {
      messageId: randomUUID(),
      conversationId: randomUUID(),
      phone: input.phone,
      content: input.content,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
  }
}
