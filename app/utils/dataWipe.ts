import { drainCaptures, drainDiagnostics } from '../../modules/spendr-captures';
import { wipeAccountData } from '../api/sync';
import { wipeLocalData } from '../database/database';
import { clearDiary } from '../diagnostics/diary';
import { errorData, log } from '../diagnostics/log';
import * as syncQueue from '../sync/queue';
import { fingerprintOf } from './captureMatcher';
import { clearScheduledNotifications } from './notificationUtils';

/**
 * "Apagar todos os dados" (SPD-082, DEC-35).
 *
 * O que fica: as categorias, o que o app aprendeu por estabelecimento e a configuração
 * (moeda, idioma, CDI, lembretes ligados, biometria, onboarding, avisos dispensados, o id
 * da instalação). O resto sai **de verdade** — sem lápide carregando conteúdo — e, com
 * conta, na conta e em todos os aparelhos dela.
 *
 * Duas metades, de propósito:
 *
 *  - `eraseAllData`: o botão das Configurações. Com conta, o servidor apaga **primeiro**;
 *    se ele não confirmar, nada sai daqui.
 *  - `wipeDevice`: só o aparelho. É o que o SPD-083 chama quando descobre que outro
 *    aparelho apagou a conta (o 409 do push, o `dataWipedAt` do pull) — por isso não fala
 *    com o servidor nem mexe na fila de sync.
 */

export type EraseResult = { ok: true } | { ok: false; reason: 'server' };

/**
 * Apaga tudo o que este aparelho guarda do dinheiro do usuário, na ordem em que nada
 * escapa:
 *
 *  1. esvazia a fila nativa de capturas **antes** do banco: um aviso que já estava lá
 *     entraria logo depois, e uma regra aprendida poderia até confirmá-lo sozinha. Os
 *     avisos são descartados; só a impressão digital de cada um fica conhecida;
 *  2. descarta a fila de diagnóstico do serviço nativo, que pode ter texto de banco;
 *  3. o banco, numa transação (`wipeLocalData`), com a marca do apagar quando há;
 *  4. os lembretes agendados e as marcas deles;
 *  5. o diário de diagnóstico;
 *  6. avisa as telas, que releem tudo (`hooks/useAfterPull.ts`).
 *
 * `knownWipeAt` é o `dataWipedAt` do servidor; ausente sem conta.
 */
export const wipeDevice = async (knownWipeAt?: string): Promise<void> => {
	const seenFingerprints = drainCaptures().map((raw) => fingerprintOf(raw));
	drainDiagnostics();

	await wipeLocalData({ seenFingerprints, knownWipeAt });

	await clearScheduledNotifications();
	await clearDiary();

	// O primeiro evento do diário novo: só metadado, para quem depurar saber que o vazio
	// antes dele foi pedido.
	log('app', 'data_wiped', {
		data: { account: knownWipeAt !== undefined, discardedQueued: seenFingerprints.length },
	});

	syncQueue.notifyDataChanged();
};

/**
 * O botão "Apagar todos os dados".
 *
 * Com conta (`signedIn`), `POST /me/wipe` vem antes de tudo. Se falhar — sem rede, o
 * servidor que ainda não tem a rota (404), erro dele —, devolve `{ ok: false }` sem ter
 * apagado nada aqui: apagar só neste aparelho faria o pull seguinte trazer tudo de volta,
 * e o usuário acharia que apagou. Se o servidor apagou e o aparelho falhar, o erro sobe:
 * a conta já está vazia, e o SPD-083 termina o serviço aqui no próximo sync.
 *
 * Tudo com a fila de sync parada (`runExclusive`): nenhum pull que saiu antes do apagar
 * grava de volta o que o servidor apagou, nenhum push sobe no meio.
 */
export const eraseAllData = ({ signedIn }: { signedIn: boolean }): Promise<EraseResult> =>
	syncQueue.runExclusive(async (): Promise<EraseResult> => {
		let knownWipeAt: string | undefined;

		if (signedIn) {
			try {
				const response = await wipeAccountData();
				// Um 200 sem o instante ainda é um apagar feito: segue sem a marca, e o
				// próximo push recusado (SPD-083) a traz.
				knownWipeAt = typeof response?.dataWipedAt === 'string' ? response.dataWipedAt : undefined;
			} catch (error) {
				log('app', 'data_wipe_refused', { level: 'warn', data: errorData(error) });
				return { ok: false, reason: 'server' };
			}
		}

		await wipeDevice(knownWipeAt);
		return { ok: true };
	});

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { eraseAllData, wipeDevice };
