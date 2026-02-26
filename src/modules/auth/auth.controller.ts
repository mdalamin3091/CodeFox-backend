import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import * as authService from './auth.service';
import { RegisterInput, LoginInput } from './auth.schema';

export const registerHandler = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.register(req.body as RegisterInput);

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    data: result,
  });
});

export const loginHandler = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.login(req.body as LoginInput);

  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: result,
  });
});
