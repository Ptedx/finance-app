import * as api from '../api/sync';
import {
	applyPulledChanges,
	countDirtyRows,
	getDirtyChanges,
	getSyncState,
	markChangesClean,
	setSyncState,
} from '../database/database';
import { countChanges, EMPTY_CURSOR, type SyncCursor } from './types';

/**
 * Motor de sincronização.
 *
 * Duas metades independentes: `pullAll` traz o que mudou no servidor, `pushAll` sobe o
 * que mudou aqui. Nenhuma das duas é chamada por uma tela — a UI escreve no SQLite e
 * segue a vida; isto roda depois, em segundo plano, e pode falhar sem consequência
 * visível porque as linhas continuam marcadas até subirem.
 */

const CURSOR_KEY = 'pullCursor';
const LAST_SYNCED_KEY = 'lastSyncedAt';

/**
 * Quantas linhas cabem numa remessa. Tem que ser <= ao SYNC_PAGE_SIZE do servidor,
 * que recusa arrays maiores — quem usou o app meses sem conta sobe em várias voltas.
 */
const PAGE_SIZE = 500;

/**
 * Teto de páginas por rodada.
 *
 * Um sync grande é fatiado, mas não pode monopolizar o app indefinidamente: o que não
 * couber vai na próxima rodada, que acontece em segundos. O limite também é a rede de
 * segurança contra um laço que nunca convergisse.
 */
const MAX_PAGES = 40;

const readCursor = async (): Promise<SyncCursor> => {
	const stored = await getSyncState(CURSOR_KEY);
	if (!stored) return EMPTY_CURSOR;

	try {
		return { ...EMPTY_CURSOR, ...(JSON.parse(stored) as Partial<SyncCursor>) };
	} catch {
		// Cursor corrompido: um sync completo é lento mas correto, e o
		// last-write-wins garante que nada local seja atropelado no caminho.
		console.warn('Cursor de sync ilegível, recomeçando do zero');
		return EMPTY_CURSOR;
	}
};

export const resetCursor = async (): Promise<void> => {
	await setSyncState(CURSOR_KEY, null);
};

export const getLastSyncedAt = async (): Promise<string | null> => getSyncState(LAST_SYNCED_KEY);

/**
 * Traz tudo o que mudou no servidor desde o último cursor.
 *
 * Gravar as linhas e avançar o cursor acontece na ordem certa de propósito: se o app
 * morrer entre as duas coisas, a página é reaplicada na próxima vez. Reaplicar é
 * inofensivo — o upsert é idempotente —, ao passo que avançar o cursor antes de gravar
 * pularia aquelas linhas para sempre.
 */
export const pullAll = async (): Promise<number> => {
	let cursor = await readCursor();
	let received = 0;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		const response = await api.pull(cursor);

		await applyPulledChanges(response.changes);
		await setSyncState(CURSOR_KEY, JSON.stringify(response.cursor));

		cursor = response.cursor;
		received += countChanges(response.changes);

		if (!response.hasMore) break;
	}

	return received;
};

/**
 * Sobe as linhas pendentes, em páginas.
 *
 * As `rejected` voltam por serem mais antigas que a versão do servidor. Elas não são
 * reenviadas: continuam sujas de propósito, e o `pullAll` seguinte traz a versão que
 * venceu — momento em que `applyPulledChanges` limpa a marca.
 */
export const pushAll = async (): Promise<number> => {
	let sent = 0;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		const changes = await getDirtyChanges(PAGE_SIZE);
		const pending = countChanges(changes);

		if (pending === 0) break;

		const response = await api.push(changes);

		const rejected = new Set(response.rejected.map((row) => `${row.collection}:${row.id}`));

		await markChangesClean({
			categories: changes.categories.filter((r) => !rejected.has(`categories:${r.id}`)),
			transactions: changes.transactions.filter((r) => !rejected.has(`transactions:${r.id}`)),
			recurringTransactions: changes.recurringTransactions.filter(
				(r) => !rejected.has(`recurringTransactions:${r.id}`)
			),
			budgets: changes.budgets.filter((r) => !rejected.has(`budgets:${r.id}`)),
		});

		sent += response.applied;

		// Nada foi aceito e nada ficou limpo: insistir repetiria a mesma página para
		// sempre. O pull seguinte resolve trazendo as versões vencedoras.
		if (response.applied === 0 && response.rejected.length === pending) break;
		if (pending < PAGE_SIZE) break;
	}

	return sent;
};

export interface SyncResult {
	pulled: number;
	pushed: number;
	pendingAfter: number;
}

/**
 * Uma rodada completa: sobe o que é daqui, depois busca o que é de fora.
 *
 * O push vem primeiro para que o pull já traga o resultado do que acabou de subir,
 * inclusive as linhas que perderam no last-write-wins — assim a tela mostra o estado
 * final numa única rodada, em vez de piscar o valor perdedor até a rodada seguinte.
 */
export const syncNow = async (): Promise<SyncResult> => {
	const pushed = await pushAll();
	const pulled = await pullAll();

	await setSyncState(LAST_SYNCED_KEY, new Date().toISOString());

	return { pulled, pushed, pendingAfter: await countDirtyRows() };
};
