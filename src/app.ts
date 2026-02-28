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
    "https://codefox-frontend-production.up.railway.app",
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

  // Explicit CORS for better-auth routes — toNodeHandler builds its own
  // response and may not preserve headers set by the global cors() middleware.
  // Setting headers here via res.setHeader() guarantees they survive.
  app.use('/api/auth', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin as string | undefined;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    next();
  });

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
