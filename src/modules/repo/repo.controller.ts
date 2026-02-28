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

export const connectRepoHandler = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) throw new ApiError(400, 'Repository id is required');

  const result = await repoService.connectRepo(req.user!.id, id);

  res.status(200).json({ success: true, data: result });
});

export const disconnectRepoHandler = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) throw new ApiError(400, 'Repository id is required');

  // keepContext=true → preserve Pinecone vectors; false → delete namespace
  const keepContext = req.body?.keepContext === true;

  const result = await repoService.disconnectRepo(req.user!.id, id, keepContext);

  res.status(200).json({ success: true, data: result });
});

export const listPullRequestsHandler = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) throw new ApiError(400, 'Repository id is required');

  const prs = await repoService.listPullRequests(req.user!.id, id);

  const serializable = prs.map((pr) => ({
    ...pr,
    githubReviewId: pr.githubReviewId != null ? pr.githubReviewId.toString() : null,
  }));

  res.status(200).json({ success: true, data: { pullRequests: serializable } });
});
