import { Queue, Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/redis.js';

export type QueueJobPayload = Record<string, unknown>;

export const messageQueue = new Queue('vico-message-queue', { connection: redis });
export const aiQueue = new Queue('vico-ai-queue', { connection: redis });
export const notificationQueue = new Queue('vico-notification-queue', { connection: redis });

export function createWorker<T extends QueueJobPayload>(
  queueName: string,
  processor: (job: { data: T }) => Promise<unknown>,
) {
  return new Worker<T>(queueName, async (job) => processor(job), {
    connection: redis,
    autorun: true,
  });
}

export async function enqueueMessageJob(payload: QueueJobPayload) {
  await messageQueue.add('process-message', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

export async function enqueueAiJob(payload: QueueJobPayload) {
  await aiQueue.add('run-ai', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1500 },
  });
}

export async function enqueueNotificationJob(payload: QueueJobPayload) {
  await notificationQueue.add('notify-user', payload, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
