import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import routes from './routes';
import errorMiddleware from './middlewares/error.middleware';
import ApiError from './utils/ApiError';
import logger from './utils/logger';

const createApp = () => {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS
  app.use(cors());

  // HTTP request logging
  app.use(
    morgan('combined', {
      stream: { write: (message) => logger.http(message.trim()) },
    }),
  );

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes
  app.use('/api', routes);

  // 404 handler
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new ApiError(404, 'Route not found'));
  });

  // Global error handler
  app.use(errorMiddleware);

  return app;
};

export default createApp;
