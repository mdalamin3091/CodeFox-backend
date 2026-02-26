import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import ApiError from '../utils/ApiError';
import logger from '../utils/logger';
import config from '../config';

const errorMiddleware = (err: Error, req: Request, res: Response, _next: NextFunction): void => {
  let error = err;

  // Handle Prisma known request errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      error = new ApiError(409, 'A record with this value already exists');
    } else if (error.code === 'P2025') {
      error = new ApiError(404, 'Record not found');
    } else {
      error = new ApiError(400, 'Database request error');
    }
  }

  // Handle Prisma validation errors
  if (error instanceof Prisma.PrismaClientValidationError) {
    error = new ApiError(400, 'Invalid data provided');
  }

  const apiError = error instanceof ApiError ? error : new ApiError(500, 'Internal server error', false);

  if (!apiError.isOperational) {
    logger.error('Non-operational error:', err);
  }

  res.status(apiError.statusCode).json({
    success: false,
    message: apiError.message,
    ...(config.env === 'development' && !apiError.isOperational && { stack: err.stack }),
  });
};

export default errorMiddleware;
