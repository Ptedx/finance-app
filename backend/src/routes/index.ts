import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createAssistantController } from '../controllers/assistant.controller.js';
import { login, logout, refresh, register } from '../controllers/auth.controller.js';
import { postDiagnostics } from '../controllers/diagnostics.controller.js';
import { getSyncStatus, pullData, pushData } from '../controllers/sync.controller.js';
import { deleteMe, getMe, updateMe, wipeMyData } from '../controllers/user.controller.js';
import { mirai } from '../lib/mirai.js';
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

/**
 * "Apagar todos os dados" é um toque raro e pesado (uma transação que apaga todas as
 * tabelas do usuário). Ninguém apaga cinco vezes em quinze minutos de propósito; o teto só
 * impede que um laço do app martele o banco.
 */
const wipeLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 5,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: {
		error: 'Pedidos de apagar dados demais. Tente novamente em alguns minutos.',
		code: 'rate_limited',
	},
});

/**
 * Apagar a conta pede a senha, e por isso é também um jeito de adivinhá-la. As tentativas
 * passam pelo mesmo `authLimiter` do login — o mesmo contador, não um outro igual —, de
 * modo que somar as duas rotas não dá a ninguém mais palpites do que o login sozinho dá.
 * Este teto, menor, vale só para esta rota: ninguém apaga a conta cinco vezes em quinze
 * minutos, e quem errou a senha cinco vezes pode esperar.
 */
const deleteAccountLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 5,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: {
		error: 'Muitas tentativas de apagar a conta. Tente novamente em alguns minutos.',
		code: 'rate_limited',
	},
});

router.post('/auth/register', authLimiter, asyncHandler(register));
router.post('/auth/login', authLimiter, asyncHandler(login));
router.post('/auth/refresh', authLimiter, asyncHandler(refresh));
router.post('/auth/logout', asyncHandler(logout));

router.get('/me', requireAuth, asyncHandler(getMe));
router.patch('/me', requireAuth, asyncHandler(updateMe));
router.post('/me/wipe', requireAuth, wipeLimiter, asyncHandler(wipeMyData));
router.delete('/me', requireAuth, authLimiter, deleteAccountLimiter, asyncHandler(deleteMe));

router.get('/sync/status', requireAuth, syncLimiter, asyncHandler(getSyncStatus));
router.get('/sync/pull', requireAuth, syncLimiter, asyncHandler(pullData));
router.post('/sync/push', requireAuth, syncLimiter, asyncHandler(pushData));

// O teto de 512 KB do corpo desta rota fica no server.ts: o leitor de JSON roda antes do
// router, e o geral (5 MB) já teria lido o corpo quando a requisição chegasse aqui.
router.post('/diagnostics', requireAuth, diagnosticsLimiter, asyncHandler(postDiagnostics));

// Mirai, o assistente (SPD-163). Os limites (perguntas do dia, teto do mês, rodadas) são do
// próprio Mirai e respondem com os códigos do contrato; o teto do corpo fica no server.ts.
const assistant = createAssistantController(mirai);
router.get('/assistant/status', requireAuth, asyncHandler(assistant.getStatus));
router.post('/assistant/turn', requireAuth, asyncHandler(assistant.postTurn));

export default router;
