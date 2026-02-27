import { Router } from 'express';
import userRoutes from '../modules/user/user.routes.js';
import repoRoutes from '../modules/repo/repo.routes.js';
import webhookRoutes from '../modules/webhook/webhook.routes.js';

const router = Router();

router.use('/users', userRoutes);
router.use('/repos', repoRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
