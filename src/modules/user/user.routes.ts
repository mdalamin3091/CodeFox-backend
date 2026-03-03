import { Router } from 'express';
import authMiddleware from '../../middlewares/auth.middleware';
import validate from '../../middlewares/validate.middleware';
import { updateProfileSchema } from './user.schema';
import { getProfileHandler, updateProfileHandler, logoutHandler } from './user.controller';

const router = Router();

router.use(authMiddleware);

router.get('/me', getProfileHandler);
router.patch('/me', validate(updateProfileSchema), updateProfileHandler);
router.post('/logout', logoutHandler);

export default router;
