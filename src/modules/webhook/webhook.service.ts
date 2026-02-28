import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import { Prisma } from '@prisma/client';
import prisma from '../../config/prisma.js';
import logger from '../../utils/logger.js';
import { analyzePrDiff } from '../embedding/embedding.service.js';
import { generatePrReview } from '../review/review.service.js';

// --------------------------------------------------------------------------
// HMAC-SHA256 signature verification
// --------------------------------------------------------------------------

export function verifyGitHubSignature(secret: string, payload: Buffer, signature: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// PR event processing
// --------------------------------------------------------------------------

export async function handlePullRequestEvent(payload: Record<string, any>): Promise<void> {
  const { action, pull_request: pr, repository: ghRepo } = payload;

  if (!['opened', 'synchronize', 'reopened', 'closed'].includes(action)) return;

  // Find the connected repo in our DB by GitHub repo id
  const repo = await prisma.repository.findFirst({
    where: { githubId: ghRepo.id, connected: true },
    select: {
      id: true,
      fullName: true,
      user: {
        select: {
          accounts: {
            where: { providerId: 'github' },
            select: { accessToken: true },
          },
        },
      },
    },
  });

  if (!repo) {
    logger.warn(`Webhook: no connected repo found for githubId=${ghRepo.id}`);
    return;
  }

  const accessToken = repo.user.accounts[0]?.accessToken ?? null;
  let diff: string | null = null;
  let files: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue = Prisma.JsonNull;

  if (accessToken) {
    const octokit = new Octokit({ auth: accessToken });
    const [owner, repoName] = repo.fullName.split('/');

    try {
      const diffRes = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo: repoName,
        pull_number: pr.number as number,
        headers: { accept: 'application/vnd.github.v3.diff' },
      });
      diff = typeof diffRes.data === 'string' ? diffRes.data : null;
    } catch (err) {
      logger.warn(`Webhook: failed to fetch PR diff for PR #${pr.number as number}: ${err}`);
    }

    try {
      const filesRes = await octokit.rest.pulls.listFiles({
        owner,
        repo: repoName,
        pull_number: pr.number as number,
        per_page: 100,
      });
      files = filesRes.data as Prisma.InputJsonValue;
    } catch (err) {
      logger.warn(`Webhook: failed to fetch PR files for PR #${pr.number as number}: ${err}`);
    }
  }

  await prisma.pullRequest.upsert({
    // Use PR number (unique within repo) — GitHub's internal PR id is a BigInt
    // that exceeds Int32 and is not suitable as a key
    where: { repositoryId_number: { repositoryId: repo.id, number: pr.number as number } },
    update: {
      title: pr.title as string,
      body: (pr.body as string | null) ?? null,
      state: pr.state as string,
      merged: (pr.merged as boolean) ?? false,
      headSha: pr.head.sha as string,
      baseSha: pr.base.sha as string,
      headRef: pr.head.ref as string,
      baseRef: pr.base.ref as string,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changed_files as number) ?? 0,
      diff,
      files,
      closedAt: pr.closed_at ? new Date(pr.closed_at as string) : null,
      mergedAt: pr.merged_at ? new Date(pr.merged_at as string) : null,
    },
    create: {
      githubPrId: BigInt(pr.id as number),
      number: pr.number as number,
      title: pr.title as string,
      body: (pr.body as string | null) ?? null,
      state: pr.state as string,
      merged: (pr.merged as boolean) ?? false,
      htmlUrl: pr.html_url as string,
      headSha: pr.head.sha as string,
      baseSha: pr.base.sha as string,
      headRef: pr.head.ref as string,
      baseRef: pr.base.ref as string,
      authorLogin: pr.user.login as string,
      authorAvatarUrl: (pr.user.avatar_url as string | null) ?? null,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changed_files as number) ?? 0,
      diff,
      files,
      closedAt: pr.closed_at ? new Date(pr.closed_at as string) : null,
      mergedAt: pr.merged_at ? new Date(pr.merged_at as string) : null,
      repositoryId: repo.id,
    },
  });
  
  logger.info(`Webhook: PR #${pr.number as number} (${action}) saved for ${repo.fullName}`);

  // Trigger diff analysis if we have a diff (fire-and-forget — don't block webhook response)
  if (diff && ['opened', 'synchronize', 'reopened'].includes(action)) {
    const saved = await prisma.pullRequest.findUnique({
      where: { repositoryId_number: { repositoryId: repo.id, number: pr.number as number } },
      select: { id: true },
    });
    if (saved) {
      // Pipeline: analyze diff → generate AI review (all background, non-blocking)
      analyzePrDiff(saved.id)
        .then(() => generatePrReview(saved.id))
        .catch((err) =>
          logger.error(`PR pipeline failed for PR #${pr.number as number}: ${err}`),
        );
    }
  }
}
