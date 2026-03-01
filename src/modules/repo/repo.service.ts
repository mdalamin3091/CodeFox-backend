import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import prisma from '../../config/prisma.js';
import ApiError from '../../utils/ApiError.js';
import config from '../../config/index.js';
import { embeddingQueue } from '../embedding/embedding.queue.js';
import { deleteRepositoryEmbedding } from '../embedding/embedding.service.js';
import type { ListReposQuery } from './repo.schema.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function getGitHubAccessToken(userId: string): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { userId, providerId: 'github' },
    select: { accessToken: true },
  });

  if (!account?.accessToken) {
    throw new ApiError(400, 'No GitHub account linked or access token missing');
  }

  return account.accessToken;
}

// --------------------------------------------------------------------------
// Sync: fetch all repos from GitHub → upsert into DB
// --------------------------------------------------------------------------

export async function syncRepos(userId: string) {
  const token = await getGitHubAccessToken(userId);
  const octokit = new Octokit({ auth: token });

  const githubRepos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: 'updated',
    // affiliation: 'owner',
    affiliation: 'owner,collaborator,organization_member',
  });

  // Upsert all repos in parallel (batched to avoid connection exhaustion)
  const BATCH = 20;
  for (let i = 0; i < githubRepos.length; i += BATCH) {
    await Promise.all(
      githubRepos.slice(i, i + BATCH).map((repo) =>
        prisma.repository.upsert({
          where: { userId_githubId: { userId, githubId: repo.id } },
          update: {
            name: repo.name,
            fullName: repo.full_name,
            description: repo.description ?? null,
            htmlUrl: repo.html_url,
            cloneUrl: repo.clone_url,
            sshUrl: repo.ssh_url,
            private: repo.private,
            fork: repo.fork,
            language: repo.language ?? null,
            starCount: repo.stargazers_count,
            forkCount: repo.forks_count,
            openIssues: repo.open_issues_count,
            defaultBranch: repo.default_branch,
            topics: repo.topics ?? [],
            pushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
          },
          create: {
            githubId: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            description: repo.description ?? null,
            htmlUrl: repo.html_url,
            cloneUrl: repo.clone_url,
            sshUrl: repo.ssh_url,
            private: repo.private,
            fork: repo.fork,
            language: repo.language ?? null,
            starCount: repo.stargazers_count,
            forkCount: repo.forks_count,
            openIssues: repo.open_issues_count,
            defaultBranch: repo.default_branch,
            topics: repo.topics ?? [],
            pushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
            userId,
          },
        }),
      ),
    );
  }

  return { synced: githubRepos.length };
}

// --------------------------------------------------------------------------
// List repos from DB with filtering / pagination
// --------------------------------------------------------------------------

export async function listRepos(userId: string, query: ListReposQuery) {
  const { page, per_page, language, sort, order, search } = query;

  // Auto-sync if the user has never synced before
  const existingCount = await prisma.repository.count({ where: { userId } });
  if (existingCount === 0) {
    await syncRepos(userId);
  }

  const where: Record<string, unknown> = { userId };

  if (query.private !== 'all') {
    where.private = query.private === 'true';
  }
  if (query.fork !== 'all') {
    where.fork = query.fork === 'true';
  }
  if (language) {
    where.language = { equals: language, mode: 'insensitive' };
  }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { fullName: { contains: search, mode: 'insensitive' } },
    ];
  }

  const orderByField =
    sort === 'stars'
      ? 'starCount'
      : sort === 'forks'
        ? 'forkCount'
        : sort === 'name'
          ? 'name'
          : 'pushedAt';

  const [repos, total] = await Promise.all([
    prisma.repository.findMany({
      where,
      orderBy: { [orderByField]: order },
      skip: (page - 1) * per_page,
      take: per_page,
      select: {
        id: true,
        githubId: true,
        name: true,
        fullName: true,
        description: true,
        htmlUrl: true,
        cloneUrl: true,
        sshUrl: true,
        private: true,
        fork: true,
        language: true,
        starCount: true,
        forkCount: true,
        openIssues: true,
        defaultBranch: true,
        topics: true,
        pushedAt: true,
        syncedAt: true,
        connected: true,
        connectedAt: true,
        embeddingStatus: true,
        embeddedAt: true,
      },
    }),
    prisma.repository.count({ where }),
  ]);

  return {
    repos,
    pagination: {
      total,
      page,
      per_page,
      total_pages: Math.ceil(total / per_page),
    },
  };
}

// --------------------------------------------------------------------------
// Get single repo
// --------------------------------------------------------------------------

export async function getRepo(userId: string, id: string) {
  const repo = await prisma.repository.findFirst({
    where: { id, userId },
  });

  if (!repo) {
    throw new ApiError(404, 'Repository not found');
  }

  return repo;
}

// --------------------------------------------------------------------------
// Connect repo: install GitHub webhook
// --------------------------------------------------------------------------

export async function connectRepo(userId: string, repoId: string) {
  const repo = await prisma.repository.findFirst({ where: { id: repoId, userId } });
  if (!repo) throw new ApiError(404, 'Repository not found');
  if (repo.connected) throw new ApiError(409, 'Repository already connected');

  const token = await getGitHubAccessToken(userId);
  const octokit = new Octokit({ auth: token });
  const [owner, repoName] = repo.fullName.split('/');

  const secret = crypto.randomBytes(32).toString('hex');
  const webhookUrl = `${config.webhookBaseUrl}/api/webhooks/github`;

  let hook: Awaited<ReturnType<typeof octokit.repos.createWebhook>>['data'];
  try {
    ({ data: hook } = await octokit.repos.createWebhook({
      owner,
      repo: repoName,
      config: { url: webhookUrl, content_type: 'json', secret, insecure_ssl: '0' },
      events: ['pull_request'],
      active: true,
    }));
  } catch (err: any) {
    if (err?.status === 404 || err?.status === 403) {
      throw new ApiError(
        403,
        `Cannot install webhook on "${repo.fullName}". You need admin access to this repository. Only repos you own or have admin rights to can be connected.`,
      );
    }
    throw err;
  }

  // If the repo was previously disconnected with "keep context", skip re-embedding
  const alreadyEmbedded = repo.embeddingStatus === 'completed';

  await prisma.repository.update({
    where: { id: repoId },
    data: {
      connected: true,
      webhookId: hook.id,
      webhookSecret: secret,
      connectedAt: new Date(),
      // Only reset embedding fields when there is no existing context
      ...(!alreadyEmbedded && {
        embeddingStatus: 'pending',
        embeddedAt: null,
        embeddingError: null,
      }),
    },
  });

  // Enqueue embedding job only if there is no existing Pinecone context
  if (!alreadyEmbedded) {
    await embeddingQueue.add('embed-repo', { repoId });
  }

  return { connected: true, webhookId: hook.id, contextReused: alreadyEmbedded };
}

// --------------------------------------------------------------------------
// Disconnect repo: remove GitHub webhook
// --------------------------------------------------------------------------

export async function disconnectRepo(userId: string, repoId: string, keepContext: boolean) {
  const repo = await prisma.repository.findFirst({ where: { id: repoId, userId } });
  if (!repo) throw new ApiError(404, 'Repository not found');
  if (!repo.connected || !repo.webhookId) throw new ApiError(400, 'Repository is not connected');

  const token = await getGitHubAccessToken(userId);
  const octokit = new Octokit({ auth: token });
  const [owner, repoName] = repo.fullName.split('/');

  try {
    await octokit.repos.deleteWebhook({ owner, repo: repoName, hook_id: repo.webhookId });
  } catch (err: any) {
    // Webhook already removed on GitHub side — still clean up our DB
    if (err?.status !== 404) throw err;
  }

  // Delete Pinecone namespace only when the user opted to remove context
  if (!keepContext) {
    await deleteRepositoryEmbedding(repoId);
  }

  await prisma.repository.update({
    where: { id: repoId },
    data: {
      connected: false,
      webhookId: null,
      webhookSecret: null,
      connectedAt: null,
      // Clear embedding fields only when context is discarded
      ...(!keepContext && {
        embeddingStatus: null,
        embeddedAt: null,
        embeddingError: null,
      }),
    },
  });

  return { connected: false, contextKept: keepContext };
}

// --------------------------------------------------------------------------
// List pull requests for a connected repo
// --------------------------------------------------------------------------

export async function listPullRequests(userId: string, repoId: string) {
  const repo = await prisma.repository.findFirst({ where: { id: repoId, userId } });
  if (!repo) throw new ApiError(404, 'Repository not found');

  const prs = await prisma.pullRequest.findMany({
    where: { repositoryId: repoId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      githubPrId: true,
      number: true,
      title: true,
      state: true,
      merged: true,
      htmlUrl: true,
      headRef: true,
      baseRef: true,
      authorLogin: true,
      authorAvatarUrl: true,
      additions: true,
      deletions: true,
      changedFiles: true,
      analysisStatus: true,
      relevantFiles: true,
      analysisError: true,
      reviewStatus: true,
      reviewBody: true,
      reviewData: true,
      reviewError: true,
      githubReviewId: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      mergedAt: true,
    },
  });

  return prs;
}
