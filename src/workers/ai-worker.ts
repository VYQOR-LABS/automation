import { createWorker } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export function startAiWorker() {
  const worker = createWorker<{ userId: string; message: string }>('vico-ai-queue', async (job) => {
    const { userId, message } = job.data;
    logger.info({ userId, messageLength: message.length }, 'Running AI job');
    return {
      processed: true,
      userId,
      response: `Replied by Vico Bot · AI Assistant. I processed: "${message}"`,
    };
  });

  worker.on('ready', () => logger.info('AI worker ready'));
  worker.on('failed', (job, err) => logger.error({ err, jobName: job?.name }, 'AI worker failed'));

  return worker;
}
