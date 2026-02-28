import 'dotenv/config';

// Allow BigInt values to be serialized as strings in JSON responses
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
import createApp from './app';
import config from './config';
import logger from './utils/logger';
import prisma from './config/prisma';
import { embeddingWorker, embeddingQueue } from './modules/embedding/embedding.queue';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port} in ${config.env} mode`);
  logger.info('BullMQ embedding worker started');
});

const shutdown = async (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  await embeddingWorker.close();
  await embeddingQueue.close();
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
  process.exit(1);
});
