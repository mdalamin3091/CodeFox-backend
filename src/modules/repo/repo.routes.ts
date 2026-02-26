import { Router } from 'express';
import authMiddleware from '../../middlewares/auth.middleware.js';
import { listReposHandler, syncReposHandler, getRepoHandler } from './repo.controller.js';

const router = Router();

router.use(authMiddleware);

router.get('/', listReposHandler);          // GET  /api/repos
router.post('/sync', syncReposHandler);     // POST /api/repos/sync
router.get('/:id', getRepoHandler);         // GET  /api/repos/:id

export default router;
