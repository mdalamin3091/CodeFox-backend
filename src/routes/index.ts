import { Router } from 'express';
import userRoutes from '../modules/user/user.routes.js';
import repoRoutes from '../modules/repo/repo.routes.js';

const router = Router();

router.use('/users', userRoutes);
router.use('/repos', repoRoutes);

export default router;
