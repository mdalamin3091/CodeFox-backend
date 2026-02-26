import { Router } from 'express';
import validate from '../../middlewares/validate.middleware';
import { registerSchema, loginSchema } from './auth.schema';
import { registerHandler, loginHandler } from './auth.controller';

const router = Router();

router.post('/register', validate(registerSchema), registerHandler);
router.post('/login', validate(loginSchema), loginHandler);

export default router;
