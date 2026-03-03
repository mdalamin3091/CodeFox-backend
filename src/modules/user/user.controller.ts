import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import * as userService from './user.service';
import { UpdateProfileInput } from './user.schema';
import prisma from '../../config/prisma';
import config from '../../config';

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

export const logoutHandler = catchAsync(async (req: Request, res: Response) => {
  const account = await prisma.account.findFirst({
    where: { userId: req.user!.id, providerId: 'github' },
    select: { accessToken: true },
  });

  if (account?.accessToken) {
    const credentials = Buffer.from(
      `${config.github.clientId}:${config.github.clientSecret}`,
    ).toString('base64');

    await fetch(`https://api.github.com/applications/${config.github.clientId}/grant`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: account.accessToken }),
    }).catch(() => {
      // Non-fatal — continue with logout even if revocation fails
    });
  }

  res.status(200).json({ success: true });
});
