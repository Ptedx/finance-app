import * as api from '../api/sync';
import {
	applyPulledChanges,
	countDirtyRows,
	getDirtyChanges,
	getSyncState,
	hasCategory,
	markCategoryDirty,
	markChangesClean,
	reassignToUncategorized,
	setSyncState,
} from '../database/database';
import { SCHEMA_VERSION } from '../database/schema';
import { countChanges, EMPTY_CURSOR, inheritCursor, type RejectedRow, type SyncCursor } from './types';

/**
 * Motor de sincronização.
 *
 * Duas metades independentes: `pullAll` traz o que mudou no servidor, `pushAll` sobe o
 * que mudou aqui. Nenhuma das duas é chamada por uma tela — a UI escreve no SQLite e
 * segue a vida; isto roda depois, em segundo plano, e pode falhar sem consequência
 * visível porque as linhas continuam marcadas até subirem.
 */

/**
 * O cursor do pull, guardado **por versão do banco**.
 *
 * Voltar para uma versão anterior do app é uma operação prevista (docs/versionamento.md).
 * A versão anterior grava o cursor inteiro que o servidor devolve — inclusive o de coleções
 * que ela não conhece e cujas linhas ela descarta. Se esta versão lesse esse cursor, as
 * linhas descartadas nunca mais chegariam. Por isso cada versão tem sua chave, e ao nascer
 * ela herda do cursor antigo só as coleções que a versão anterior já conhecia.
 */
const CURSOR_KEY = `pullCursor@${SCHEMA_VERSION}`;
/** A chave de antes do cursor por versão (a 1.0 grava aqui). */
const LEGACY_CURSOR_KEY = 'pullCursor';
/** Versão do banco da última versão que usava a chave antiga. */
const LEGACY_CURSOR_SCHEMA = 14;
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

const parseCursor = (stored: string | null): SyncCursor | null => {
	if (!stored) return null;
	try {
		return { ...EMPTY_CURSOR, ...(JSON.parse(stored) as Partial<SyncCursor>) };
	} catch {
		// Cursor corrompido: um sync completo é lento mas correto, e o
		// last-write-wins garante que nada local seja atropelado no caminho.
		console.warn('Cursor de sync ilegível, recomeçando do zero');
		return null;
	}
};

const readCursor = async (): Promise<SyncCursor> => {
	const own = parseCursor(await getSyncState(CURSOR_KEY));
	if (own) return own;
	const legacy = parseCursor(await getSyncState(LEGACY_CURSOR_KEY));
	return legacy ? inheritCursor(legacy, LEGACY_CURSOR_SCHEMA) : EMPTY_CURSOR;
};

export const resetCursor = async (): Promise<void> => {
	await setSyncState(CURSOR_KEY, null);
	await setSyncState(LEGACY_CURSOR_KEY, null);
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
 * Conserta localmente o que o servidor devolveu por `unknown_category`, e diz quantas
 * linhas ficaram prontas para uma nova tentativa.
 *
 * O servidor não conhece a categoria de um lançamento daqui. Dois caminhos:
 *
 * - A categoria existe neste aparelho (é o caso normal: ela simplesmente ainda não
 *   subiu, ou o servidor a perdeu). Ela volta a ficar suja e vai na próxima página,
 *   antes dos lançamentos, e o servidor então aceita os dois.
 * - Ela não existe nem aqui, ou já foi reenviada nesta rodada e o servidor continua
 *   sem conhecê-la. Reenviar de novo não vai resolver; o lançamento é movido para
 *   'uncategorized' — o mesmo que o app faz ao apagar uma categoria — e sobe assim.
 *
 * Nos dois casos a decisão é tomada no aparelho dono do dado, então as cópias
 * convergem, em vez de o servidor reancorar sozinho e as duas versões divergirem
 * para sempre no empate do last-write-wins.
 */
const repairUnknownCategories = async (
	rejected: RejectedRow[],
	resentCategories: Set<string>
): Promise<number> => {
	const unknown = rejected.filter((row) => row.reason === 'unknown_category');
	if (unknown.length === 0) return 0;

	// Primeiro decide por categoria, depois por linha: várias linhas rejeitadas pela
	// mesma categoria na mesma página contam como um único reenvio dela.
	const resendingNow = new Set<string>();
	for (const row of unknown) {
		const categoryId = row.category;
		if (!categoryId || resentCategories.has(categoryId) || resendingNow.has(categoryId)) continue;
		if (await hasCategory(categoryId)) {
			await markCategoryDirty(categoryId);
			resentCategories.add(categoryId);
			resendingNow.add(categoryId);
		}
	}

	let repaired = 0;
	for (const row of unknown) {
		if (row.category && resendingNow.has(row.category)) {
			repaired += 1;
			continue;
		}
		if (row.collection === 'transactions' || row.collection === 'recurringTransactions') {
			await reassignToUncategorized(
				row.collection === 'transactions' ? 'transactions' : 'recurring_transactions',
				row.id
			);
			repaired += 1;
		}
	}

	return repaired;
};

/**
 * Sobe as linhas pendentes, em páginas.
 *
 * As `rejected` por `stale` são mais antigas que a versão do servidor. Elas não são
 * reenviadas: continuam sujas de propósito, e o `pullAll` seguinte traz a versão que
 * venceu — momento em que `applyPulledChanges` limpa a marca. As `unknown_category`
 * são consertadas aqui e tentadas de novo na página seguinte. As `invalid` ficam
 * sujas e visíveis no contador de pendências: o servidor não tem como aceitá-las como
 * estão, e escondê-las seria pior do que mostrá-las.
 */
export const pushAll = async (): Promise<number> => {
	let sent = 0;
	// Categorias já reenviadas nesta rodada. Uma segunda rejeição da mesma categoria
	// significa que reenviar não resolve, e o lançamento é reancorado aqui mesmo.
	const resentCategories = new Set<string>();

	for (let page = 0; page < MAX_PAGES; page += 1) {
		const changes = await getDirtyChanges(PAGE_SIZE);
		const pending = countChanges(changes);

		if (pending === 0) break;

		const response = await api.push(changes);

		const rejected = new Set(response.rejected.map((row) => `${row.collection}:${row.id}`));

		await markChangesClean({
			categories: changes.categories.filter((r) => !rejected.has(`categories:${r.id}`)),
			accounts: (changes.accounts ?? []).filter((r) => !rejected.has(`accounts:${r.id}`)),
			transactions: changes.transactions.filter((r) => !rejected.has(`transactions:${r.id}`)),
			recurringTransactions: changes.recurringTransactions.filter(
				(r) => !rejected.has(`recurringTransactions:${r.id}`)
			),
			budgets: changes.budgets.filter((r) => !rejected.has(`budgets:${r.id}`)),
			transfers: (changes.transfers ?? []).filter((r) => !rejected.has(`transfers:${r.id}`)),
			retirementGoals: (changes.retirementGoals ?? []).filter((r) => !rejected.has(`retirementGoals:${r.id}`)),
			debts: (changes.debts ?? []).filter((r) => !rejected.has(`debts:${r.id}`)),
		});

		sent += response.applied;

		for (const row of response.rejected) {
			if (row.reason === 'invalid') {
				console.warn(
					`Sync: servidor recusou ${row.collection}/${row.id}: ${row.message ?? 'linha inválida'}`
				);
			}
		}

		const repaired = await repairUnknownCategories(response.rejected, resentCategories);

		// Algo foi consertado: a próxima página leva a categoria (ou o lançamento já
		// reancorado), então vale tentar de novo mesmo que esta página fosse a última.
		if (repaired > 0) continue;

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

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { syncNow, pullAll, pushAll, resetCursor, getLastSyncedAt };
