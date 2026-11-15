import { createWorker } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export function startMessageWorker() {
  const worker = createWorker<{ userId: string; phone: string; content: string }>('vico-message-queue', async (job) => {
    const { userId, phone, content } = job.data;
    logger.info({ userId, phone, contentLength: content.length }, 'Processing queued WhatsApp message');
    return { processed: true, userId, phone, content };
  });

  worker.on('ready', () => logger.info('Message worker ready'));
  worker.on('failed', (job, err) => logger.error({ err, jobName: job?.name }, 'Message worker failed'));

  return worker;
}
