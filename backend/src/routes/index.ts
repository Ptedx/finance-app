import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, refresh, register } from '../controllers/auth.controller.js';
import { postDiagnostics } from '../controllers/diagnostics.controller.js';
import { getSyncStatus, pullData, pushData } from '../controllers/sync.controller.js';
import { getMe, updateMe } from '../controllers/user.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Limite apertado nas rotas de credencial.
 *
 * `/auth/login` é o único ponto onde adivinhar vale a pena para um atacante, e o bcrypt
 * a 12 rounds custa caro por tentativa — sem esse teto, um bombardeio de logins derruba
 * a CPU da VM antes de qualquer senha ser descoberta.
 */
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.', code: 'rate_limited' },
});

/** O sync é chamado com frequência legítima; o teto aqui só barra laço descontrolado. */
const syncLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 120,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Sincronizações demais. Aguarde um instante.', code: 'rate_limited' },
});

/**
 * O diário sobe em lotes de até 500 eventos; mesmo um atraso de semanas cabe em poucos
 * envios. O teto só impede que um laço do app encha a tabela.
 */
const diagnosticsLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 30,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Envios de diagnóstico demais. Aguarde um instante.', code: 'rate_limited' },
});

router.post('/auth/register', authLimiter, asyncHandler(register));
router.post('/auth/login', authLimiter, asyncHandler(login));
router.post('/auth/refresh', authLimiter, asyncHandler(refresh));
router.post('/auth/logout', asyncHandler(logout));

router.get('/me', requireAuth, asyncHandler(getMe));
router.patch('/me', requireAuth, asyncHandler(updateMe));

router.get('/sync/status', requireAuth, syncLimiter, asyncHandler(getSyncStatus));
router.get('/sync/pull', requireAuth, syncLimiter, asyncHandler(pullData));
router.post('/sync/push', requireAuth, syncLimiter, asyncHandler(pushData));

// O teto de 512 KB do corpo desta rota fica no server.ts: o leitor de JSON roda antes do
// router, e o geral (5 MB) já teria lido o corpo quando a requisição chegasse aqui.
router.post('/diagnostics', requireAuth, diagnosticsLimiter, asyncHandler(postDiagnostics));

export default router;
