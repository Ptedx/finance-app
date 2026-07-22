import { Router } from 'express';
import { login, register } from '../controllers/auth.controller.js';
import { pushData, pullData } from '../controllers/sync.controller.js';

const router = Router();

router.post('/auth/login', login);
router.post('/auth/register', register);

router.post('/sync/up', pushData);
router.get('/sync/down', pullData);

export default router;
