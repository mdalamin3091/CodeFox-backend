import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync.js';
import * as webhookService from './webhook.service.js';
import prisma from '../../config/prisma.js';
import logger from '../../utils/logger.js';

export const githubWebhookHandler = catchAsync(async (req: Request, res: Response) => {
  const event = req.headers['x-github-event'] as string | undefined;
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = req.rawBody;

  if (!signature || !rawBody) {
    res.status(400).json({ error: 'Missing signature or body' });
    return;
  }

  const payload = req.body as Record<string, any>;

  if (!payload?.repository?.id) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  // Look up the repo to retrieve its per-repo webhook secret
  const repo = await prisma.repository.findFirst({
    where: { githubId: payload.repository.id as number, connected: true },
    select: { webhookSecret: true },
  });

  if (!repo?.webhookSecret) {
    // Unknown or disconnected repo — accept silently so GitHub stops retrying
    logger.warn(`Webhook: received event for unknown/disconnected repo githubId=${payload.repository.id as number}`);
    res.status(200).json({ ok: true });
    return;
  }

  if (!webhookService.verifyGitHubSignature(repo.webhookSecret, rawBody, signature)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  if (event === 'pull_request') {
    await webhookService.handlePullRequestEvent(payload);
  }

  res.status(200).json({ ok: true });
});
