import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth';
import routes from './routes';
import errorMiddleware from './middlewares/error.middleware';
import ApiError from './utils/ApiError';
import logger from './utils/logger';

const createApp = () => {
  const app = express();

  app.use(helmet());

  const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    // 'https://codefox-frontend-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:3001',
  ];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: origin ${origin} not allowed`));
        }
      },
      credentials: true,
    }),
  );

  app.use(
    morgan('combined', {
      stream: { write: (message) => logger.http(message.trim()) },
    }),
  );

  // better-auth handles its own body parsing — mount BEFORE express.json()
  app.all('/api/auth/*', toNodeHandler(auth));

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api', routes);

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new ApiError(404, 'Route not found'));
  });

  app.use(errorMiddleware);

  return app;
};

export default createApp;
