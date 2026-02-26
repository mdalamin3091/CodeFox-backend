import { Octokit } from '@octokit/rest';
import prisma from '../../config/prisma.js';
import ApiError from '../../utils/ApiError.js';
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
