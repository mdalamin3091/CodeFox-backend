import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { embedRepository } from './embedding.service.js';
import logger from '../../utils/logger.js';

const QUEUE_NAME = 'repo-embedding';

// Shared Redis connection — maxRetriesPerRequest: null is required by BullMQ
export const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Queue — used to add jobs from the API layer
export const embeddingQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 100, // keep last 100 completed jobs
    removeOnFail: 200,
  },
});

// Worker — processes jobs in the background (one at a time)
export const embeddingWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { repoId } = job.data as { repoId: string };
    logger.info(`BullMQ [job=${job.id}]: started embedding repoId=${repoId}`);
    await embedRepository(repoId);
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
);

embeddingWorker.on('completed', (job) => {
  logger.info(`BullMQ [job=${job.id}]: completed repoId=${(job.data as { repoId: string }).repoId}`);
});

embeddingWorker.on('failed', (job, err) => {
  logger.error(
    `BullMQ [job=${job?.id}]: failed repoId=${(job?.data as { repoId: string } | undefined)?.repoId} — ${err.message}`,
  );
});
