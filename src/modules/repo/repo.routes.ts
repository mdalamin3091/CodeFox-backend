import { Router } from 'express';
import authMiddleware from '../../middlewares/auth.middleware.js';
import {
  listReposHandler,
  syncReposHandler,
  getRepoHandler,
  connectRepoHandler,
  disconnectRepoHandler,
  listPullRequestsHandler,
} from './repo.controller.js';

const router = Router();

router.use(authMiddleware);

router.get('/', listReposHandler);                          // GET    /api/repos
router.post('/sync', syncReposHandler);                     // POST   /api/repos/sync
router.get('/:id', getRepoHandler);                         // GET    /api/repos/:id
router.post('/:id/connect', connectRepoHandler);            // POST   /api/repos/:id/connect
router.delete('/:id/connect', disconnectRepoHandler);       // DELETE /api/repos/:id/connect
router.get('/:id/pull-requests', listPullRequestsHandler);  // GET    /api/repos/:id/pull-requests

export default router;
