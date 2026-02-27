import { Router } from 'express';
import { githubWebhookHandler } from './webhook.controller.js';

const router = Router();

// Public route — GitHub sends events here, signature verified inside handler
router.post('/github', githubWebhookHandler); // POST /api/webhooks/github

export default router;
