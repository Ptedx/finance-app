import { deleteAccount } from '../api/auth';
import { ApiError } from '../api/client';
import { clearTokens, loadTokens } from '../api/tokens';
import { errorData, log } from '../diagnostics/log';
import { decideAccountGone } from '../sync/accountWipe';
import { endSyncSession } from '../sync/claim';
import { hasSyncedWithAccount } from '../sync/engine';
import * as syncQueue from '../sync/queue';
import { wipeDevice } from './dataWipe';

/**
 * "Apagar a conta" (SPD-084, DEC-35): a exigência da Google Play de apagar a conta de
 * dentro do app.
 *
 * O servidor apaga a conta e tudo o que ela tem, sessões incluídas (`DELETE /api/me`, com
 * a senha). Este aparelho apaga os próprios dados como no "Apagar todos os dados" sem conta
 * (`wipeDevice`): ficam as categorias, as regras aprendidas e a configuração. Os outros
 * aparelhos ficam sabendo no próximo pedido que fizerem, pelo 401 `account_gone`, e fazem o
 * mesmo: apagam os dados e saem (`leaveDeletedAccount`, mais abaixo).
 *
 * A sessão daqui termina sem o `/auth/logout`: a sessão dele já foi apagada com a conta, e
 * esperar por ele só arranjaria um erro para mostrar depois de tudo ter dado certo.
 */

export type AccountDeletionResult =
	/**
	 * A conta não existe mais e a sessão daqui acabou. `alreadyGone`: ela já tinha sido
	 * apagada (em outro aparelho). `deviceWiped` falso: o aparelho não terminou de apagar
	 * — a conta já foi, então o "Apagar todos os dados" sem conta termina o serviço.
	 */
	| { ok: true; alreadyGone: boolean; deviceWiped: boolean }
	/**
	 * Nada foi apagado, nem lá nem aqui. `wrong_password`: a senha não confere.
	 * `session_lost`: a sessão caiu no meio (renovação recusada) e a conta continua lá.
	 * `unavailable`: sem rede, servidor sem a rota (404), erro dele, muitas tentativas.
	 */
	| { ok: false; reason: 'wrong_password' | 'session_lost' | 'unavailable' };

type Refusal = Extract<AccountDeletionResult, { ok: false }>['reason'];

/** O que a resposta do servidor quer dizer: `gone` é a conta que já não existia. */
const classify = (error: unknown): 'gone' | Refusal => {
	if (!(error instanceof ApiError)) return 'unavailable';
	if (error.status === 401 && error.code === 'account_gone') return 'gone';
	if (error.status === 403 && error.code === 'wrong_password') return 'wrong_password';
	if (error.status === 401) return 'session_lost';
	return 'unavailable';
};

/**
 * Apaga a conta e, só se o servidor confirmar, este aparelho — nesta ordem:
 *
 *  1. `DELETE /api/me`. Recusado, devolve o motivo sem ter mexido em nada aqui;
 *  2. desliga a fila de sync **antes** de soltá-la: o `runExclusive` roda uma rodada ao
 *     terminar, e ela sairia com o token de uma conta que não existe mais;
 *  3. apaga o aparelho (`wipeDevice`, sem marca de apagar: não há conta para ela valer);
 *  4. apaga os tokens e o estado de sync da conta — cursor, último sync, claim, a conta
 *     dona e a marca do último apagar (`endSyncSession`).
 *
 * Depois de o servidor apagar, nada aqui sobe como erro: a conta já foi, e quem chamou
 * precisa saber disso para tirar a tela da conta. Uma falha no passo 3 vira
 * `deviceWiped: false`; nos do passo 4, fica no diário — sem a conta, o token que sobrar
 * só recebe 401.
 *
 * Tudo com a fila parada, como o `eraseAllData`: nenhuma rodada fala com o servidor no
 * meio, nem recebe ela mesma o 401 da conta apagada.
 *
 * Quem tira a conta da tela é o `AuthContext` (`deleteAccount`).
 */
export const deleteAccountAndData = (password: string): Promise<AccountDeletionResult> =>
	syncQueue.runExclusive(async (): Promise<AccountDeletionResult> => {
		let alreadyGone = false;
		try {
			await deleteAccount(password);
		} catch (error) {
			const outcome = classify(error);
			if (outcome !== 'gone') {
				// Só o status e o código; a senha nunca chega perto do diário.
				log('session', 'account_delete_refused', {
					level: 'warn',
					data: { reason: outcome, ...errorData(error) },
				});
				return { ok: false, reason: outcome };
			}
			alreadyGone = true;
		}

		syncQueue.stop();

		let deviceWiped = true;
		try {
			await wipeDevice();
		} catch (error) {
			deviceWiped = false;
			console.warn('A conta foi apagada, mas o aparelho não terminou de apagar:', error);
		}

		// Cada um por si: um não pode impedir o outro.
		await clearTokens().catch((error) => {
			console.warn('Não foi possível apagar os tokens da conta apagada:', error);
		});
		await endSyncSession().catch((error) => {
			console.warn('Não foi possível limpar o estado de sync da conta apagada:', error);
		});

		// Depois do `wipeDevice`, que limpa o diário: é o primeiro evento do diário novo.
		log('session', 'account_deleted', { data: { alreadyGone, deviceWiped } });
		return { ok: true, alreadyGone, deviceWiped };
	});

/**
 * O que o 401 `account_gone` fez neste aparelho (`leaveDeletedAccount`).
 *
 * - `wiped`: já sincronizava com a conta; os dados dela saíram daqui e a sessão terminou.
 * - `wipe_failed`: devia apagar e não terminou; a sessão terminou do mesmo jeito.
 * - `signed_out`: nunca sincronizou com ela (estava entrando, a escolha de dados no meio);
 *   só a sessão terminou.
 * - `already_ended`: a sessão que recebeu o 401 já não é a daqui — o "Apagar a conta"
 *   deste aparelho, ou um 401 anterior, já a encerrou. Nada foi feito.
 */
export type DeletedAccountOutcome = 'wiped' | 'wipe_failed' | 'signed_out' | 'already_ended';

/**
 * A conta não existe mais e este aparelho ficou sabendo por um pedido qualquer — o sync, o
 * perfil na abertura, o envio do diário (401 `account_gone`, avisado pelo cliente HTTP).
 * Foi apagada noutro aparelho, ou neste com o app fechado entre o 204 do servidor e o fim
 * do `deleteAccountAndData`.
 *
 * A regra é a do apagar de outro aparelho (`decideAccountGone`, com o mesmo
 * `hasSyncedWithAccount` do SPD-083): o aparelho que já sincronizava com a conta apaga os
 * dados como o "Apagar a conta" — sem marca de apagar, não há conta para ela valer —; o
 * que estava entrando nela só sai. Depois, nos dois casos, os tokens e o estado de sync,
 * sem o `/auth/logout`. A pergunta vem **antes** de limpar o estado de sync: é ele que diz
 * se este aparelho sincronizava.
 *
 * Com a fila parada (`runExclusive`), como o "Apagar a conta": nenhuma rodada no meio, e
 * nem o próprio "Apagar a conta" — os dois esperam um o outro. Quem chega depois confere se
 * a sessão daqui ainda é a do pedido recusado (`accessToken`); se não for, já foi tratada,
 * e nada se apaga nem se avisa de novo. É assim que o pedido que saiu antes do "Apagar a
 * conta" e voltou com o 401 no meio dele não apaga o aparelho duas vezes, e que dois
 * pedidos recusados juntos dão um apagar só.
 *
 * Quem chama não espera por isto de dentro de um pedido (ver `setSessionLostHandler`): a
 * fila só para depois de a rodada que recebeu o 401 terminar. Quem tira a conta da tela e
 * mostra o aviso é o `AuthContext`.
 */
export const leaveDeletedAccount = (accessToken: string): Promise<DeletedAccountOutcome> =>
	syncQueue.runExclusive(async (): Promise<DeletedAccountOutcome> => {
		const stored = await loadTokens();
		if (stored?.accessToken !== accessToken) return 'already_ended';

		// Antes de soltar a fila, como no "Apagar a conta": o `runExclusive` roda uma rodada
		// ao terminar, e ela sairia com o token de uma conta que não existe mais.
		syncQueue.stop();

		let outcome: DeletedAccountOutcome = 'signed_out';
		if (decideAccountGone({ syncedBefore: await hasSyncedWithAccount() }) === 'wipe') {
			try {
				await wipeDevice();
				outcome = 'wiped';
			} catch (error) {
				outcome = 'wipe_failed';
				console.warn('A conta foi apagada, mas o aparelho não terminou de apagar:', error);
			}
		}

		// Cada um por si, como no "Apagar a conta".
		await clearTokens().catch((error) => {
			console.warn('Não foi possível apagar os tokens da conta apagada:', error);
		});
		await endSyncSession().catch((error) => {
			console.warn('Não foi possível limpar o estado de sync da conta apagada:', error);
		});

		// Depois do `wipeDevice`, que limpa o diário. Só o desfecho, nunca o token.
		log('session', 'account_gone', { data: { outcome } });
		return outcome;
	});

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { deleteAccountAndData, leaveDeletedAccount };
