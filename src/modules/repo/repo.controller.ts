import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync.js';
import * as repoService from './repo.service.js';
import { listReposQuerySchema } from './repo.schema.js';
import ApiError from '../../utils/ApiError.js';

export const listReposHandler = catchAsync(async (req: Request, res: Response) => {
  const query = listReposQuerySchema.parse(req.query);
  const result = await repoService.listRepos(req.user!.id, query);

  res.status(200).json({
    success: true,
    data: result,
  });
});

export const syncReposHandler = catchAsync(async (req: Request, res: Response) => {
  const result = await repoService.syncRepos(req.user!.id);

  res.status(200).json({
    success: true,
    message: `Synced ${result.synced} repositories from GitHub`,
    data: result,
  });
});

export const getRepoHandler = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) throw new ApiError(400, 'Repository id is required');

  const repo = await repoService.getRepo(req.user!.id, id);

  res.status(200).json({
    success: true,
    data: { repo },
  });
});
