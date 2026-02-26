import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import * as userService from './user.service';
import { UpdateProfileInput } from './user.schema';

export const getProfileHandler = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.getProfile(req.user!.id);

  res.status(200).json({
    success: true,
    data: { user },
  });
});

export const updateProfileHandler = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.updateProfile(req.user!.id, req.body as UpdateProfileInput);

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { user },
  });
});
