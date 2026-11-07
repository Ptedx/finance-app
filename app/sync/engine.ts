import * as api from '../api/sync';
import {
	applyPulledChanges,
	countDirtyRows,
	getDirtyChanges,
	getSyncedIds,
	getSyncState,
	hasCategory,
	markCategoryDirty,
	markChangesClean,
	reassignToUncategorized,
	reconcilePreferences,
	repairPhantomAppAccounts,
	setSyncState,
	stampEverything,
} from '../database/database';
import { SCHEMA_VERSION } from '../database/schema';
import { elapsedSince, log } from '../diagnostics/log';
import { logSyncFailure, rejectionSummary } from '../diagnostics/sync';
import { nowTimestamp } from '../utils/dateUtils';
import { dataWipedRefusal, decideAccountWipe, isNewerWipe } from './accountWipe';
import { readPendingClaim } from './claim';
import { emitPreferencesChanged } from './preferenceEvents';
import { chunkChanges, type Collection, COLLECTIONS, mergePages, replacementStamp, TABLE_OF, tombstonesFor } from './replace';
import {
	EMPTY_CURSOR,
	inheritCursor,
	KNOWN_WIPE_AT_KEY,
	onlyKnownCollections,
	type PushResponse,
	type RejectedRow,
	type SyncChanges,
	type SyncCursor,
} from './types';

/**
 * Quantas linhas uma remessa tem, **todas** as coleções contadas.
 *
 * Existe porque esta contagem decide se vale enviar: uma coleção que ficar de fora dela
 * faz a remessa ser lida como "nada mudou", o laço do push para na primeira volta e
 * aquelas linhas nunca sobem. É o que aconteceria com a caixa de entrada do v19 — o dado
 * que a coleção existe para salvar. Conta toda lista que a remessa traz, em vez de uma
 * lista de coleções escrita à mão: era derivada de `COLLECTIONS` (`sync/replace.ts`), e
 * as contas a pagar do v20 ficavam de fora enquanto lá ninguém as acrescentasse — a
 * mesma armadilha do `countChanges` do contrato, um lugar adiante.
 */
const countAllChanges = (changes: SyncChanges): number =>
	Object.values(changes).reduce<number>((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);

/**
 * O que uma metade do ciclo fez, somado em todas as páginas, para o diário (SPD-014): um
 * evento por ciclo, nunca um por linha nem por página.
 */
interface CycleStats {
	pages: number;
	/** Linhas por coleção, somadas nas páginas. */
	rows: Map<string, number>;
}

const newStats = (): CycleStats => ({ pages: 0, rows: new Map() });

const countRows = (stats: CycleStats, changes: SyncChanges): void => {
	for (const [collection, rows] of Object.entries(changes)) {
		if (Array.isArray(rows) && rows.length > 0) {
			stats.rows.set(collection, (stats.rows.get(collection) ?? 0) + rows.length);
		}
	}
};

/** `transactions:12,captures:3`: só nomes de coleção e contagens. */
const rowsText = (rows: Map<string, number>): string =>
	[...rows].map(([collection, count]) => `${collection}:${count}`).join(',');

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
/** As coleções que o servidor conhece, lidas das chaves do cursor que ele devolve no pull. */
const SERVER_COLLECTIONS_KEY = 'serverCollections';

const readServerCollections = async (): Promise<Set<string> | null> => {
	const stored = await getSyncState(SERVER_COLLECTIONS_KEY);
	if (!stored) return null;
	try {
		const list = JSON.parse(stored);
		return Array.isArray(list) ? new Set(list.map(String)) : null;
	} catch {
		return null;
	}
};

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

/**
 * Passa para a tabela `preferences` o que mudou no AsyncStorage por fora (o CDI, um aviso
 * dispensado, o liga/desliga dos lembretes, um backup importado).
 *
 * Uma falha aqui não pode parar o sync: o resto da remessa é dinheiro, e a preferência
 * que não foi conferida agora é conferida no próximo push.
 */
const reconcilePreferencesSafely = async (): Promise<void> => {
	try {
		await reconcilePreferences();
	} catch (error) {
		console.warn('Sync: não foi possível conferir as preferências:', error);
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
 * O último "Apagar todos os dados" da conta que este aparelho conhece, ou `null` se nunca
 * apagou (ver `KNOWN_WIPE_AT_KEY`). Vai em todo push: é por ele que o servidor recusa a
 * remessa de quem ainda não sabe que a conta foi apagada.
 */
export const getKnownWipeAt = async (): Promise<string | null> => getSyncState(KNOWN_WIPE_AT_KEY);

/**
 * Quem apaga este aparelho quando a conta foi apagada em outro (SPD-083): o `wipeDevice`
 * do "Apagar todos os dados", mais o aviso ao usuário (`sync/remoteWipe.ts`, registrado
 * pelo `SyncProvider`).
 *
 * Entra por registro, como o `setSessionLostHandler` do cliente HTTP, e não por import:
 * `utils/dataWipe.ts` importa a fila, que importa este motor. Sem ninguém registrado, o
 * apagar que precisa acontecer não acontece e o sync falha — nunca guarda a marca sem
 * apagar, que faria o próximo push subir o que devia ter sumido.
 */
type AccountWipedHandler = (dataWipedAt: string) => Promise<void>;
let accountWipedHandler: AccountWipedHandler | null = null;

export const setAccountWipedHandler = (handler: AccountWipedHandler | null): void => {
	accountWipedHandler = handler;
};

/** O que um `dataWipedAt` do servidor fez aqui: nada, só passou a ser conhecido, ou apagou. */
export type AccountWipeOutcome = 'none' | 'adopted' | 'wiped';

/**
 * A conta foi apagada no meio de um trabalho que não dá para continuar com o que já leu
 * dela — a foto do "subir deste aparelho", uma segunda volta do pull na mesma rodada.
 */
class AccountWipedMidway extends Error {
	constructor() {
		super('A conta foi apagada durante o sync; o que já tinha sido lido dela não vale mais.');
		this.name = 'AccountWipedMidway';
	}
}

/**
 * Se este aparelho já tem dados que vieram desta conta ou foram para ela: completou um
 * sync com ela (`lastSyncedAt`) ou já baixou páginas dela (o cursor). Os dois saem quando
 * a conta muda (`beginSessionFor`, `endSyncSession`), então só falam desta conta.
 *
 * Com a escolha de dados pendente, não: o que está aqui é o que o usuário trouxe de antes
 * do login e ainda não decidiu o que fazer — o apagar da conta não é sobre isso.
 */
const hasSyncedWithAccount = async (): Promise<boolean> => {
	if (await readPendingClaim()) return false;
	for (const key of [LAST_SYNCED_KEY, CURSOR_KEY, LEGACY_CURSOR_KEY]) {
		if (await getSyncState(key)) return true;
	}
	return false;
};

/**
 * Aplica um `dataWipedAt` que o servidor mandou. A regra está em `sync/accountWipe.ts`:
 *
 * - `adopted`: este aparelho está entrando na conta agora e só passa a conhecer o apagar;
 *   nada sai daqui.
 * - `wiped`: já sincronizava com ela, e foi apagado — a marca entra na mesma transação do
 *   apagar (`wipeLocalData`). Depois o cursor recomeça: é barato, a conta acabou de ser
 *   esvaziada, e não depende de nenhuma suposição sobre a ordem das `serverSeq` em volta
 *   do apagar. Se o app morrer entre o apagar e o cursor, o cursor antigo também serve:
 *   o que a conta ganhou depois do apagar está depois dele.
 */
const applyWipeMark = async (
	dataWipedAt: string | null | undefined,
	source: 'pull' | 'push' | 'status'
): Promise<AccountWipeOutcome> => {
	const knownWipeAt = await getKnownWipeAt();
	if (!isNewerWipe(knownWipeAt, dataWipedAt)) return 'none';

	const syncedBefore = await hasSyncedWithAccount();
	const decision = decideAccountWipe({ knownWipeAt, dataWipedAt, syncedBefore });
	if (decision === 'wipe') {
		if (!accountWipedHandler) {
			throw new Error('A conta foi apagada em outro aparelho, e não há quem apague este.');
		}
		await accountWipedHandler(dataWipedAt);
		await resetCursor();
	} else {
		await setSyncState(KNOWN_WIPE_AT_KEY, dataWipedAt);
	}

	const outcome: AccountWipeOutcome = decision === 'wipe' ? 'wiped' : 'adopted';
	// Depois do apagar, que zera o diário: o diário novo começa dizendo por que está vazio.
	log('sync', 'sync_account_wiped', { data: { outcome, source } });
	return outcome;
};

/**
 * O login aprende o último apagar da conta pelo `/sync/status` **antes** do primeiro push
 * (`AuthContext`): sem isso, o primeiro upload de quem está entrando numa conta apagada
 * seria recusado. Num aparelho que já sincronizava com ela, apaga ali mesmo.
 */
export const learnAccountWipe = (
	dataWipedAt: string | null | undefined
): Promise<AccountWipeOutcome> => applyWipeMark(dataWipedAt, 'status');

/**
 * O que um push recusado por `data_wiped` ensina: aplica o apagar e diz o que fez. Uma
 * falha que não é essa, ou uma recusa que não traz apagar novo, sobe como veio — a fila
 * tenta de novo mais tarde, com o intervalo dela, em vez de martelar o servidor.
 *
 * O 409 sem o instante (o contrato manda; é só prudência) pergunta ao `/sync/status`.
 */
const learnFromRefusal = async (error: unknown): Promise<AccountWipeOutcome> => {
	const refusal = dataWipedRefusal(error);
	if (!refusal) throw error;
	const dataWipedAt = refusal.dataWipedAt ?? (await api.fetchSyncStatus()).dataWipedAt;
	const outcome = await applyWipeMark(dataWipedAt, 'push');
	if (outcome === 'none') throw error;
	return outcome;
};

/** O que sobrou de uma substituição: linhas da conta que o servidor não deixou apagar. */
export interface ReplaceResult {
	/** Linhas da conta apagadas porque não existiam neste aparelho. */
	removed: number;
	/** Linhas que o servidor recusou apagar (validação mudou desde que foram gravadas). */
	notRemoved: number;
}

/**
 * "Subir deste aparelho": a conta passa a ter exatamente o que este aparelho tem.
 * O desenho está em `sync/replace.ts`; aqui é a execução:
 *
 *  1. Lê a conta inteira, sem gravar nada aqui.
 *  2. Sobe como lápide o que só a conta tem.
 *  3. Carimba tudo deste aparelho depois de qualquer linha da conta e sobe.
 *  4. Refaz o cursor e puxa, para as lápides chegarem aqui também.
 *
 * Interromper no meio é seguro: as lápides já aceitas ficam, e o resto do aparelho
 * continua marcado para subir no próximo sync.
 *
 * A conta apagada em outro aparelho no meio disso (SPD-083) invalida a foto: as lápides
 * levam o conteúdo que a conta tinha, e subi-las depois do apagar devolveria à conta o
 * que ele levou. A substituição recomeça uma vez, com a foto nova; se apagarem de novo,
 * falha, e a escolha continua de pé para o usuário tentar outra vez.
 */
export const replaceAccountWithDevice = async (): Promise<ReplaceResult> => {
	try {
		return await replaceOnce();
	} catch (error) {
		if (!(error instanceof AccountWipedMidway)) throw error;
		return replaceOnce();
	}
};

const replaceOnce = async (): Promise<ReplaceResult> => {
	const pages = [];
	let cursor: SyncCursor = EMPTY_CURSOR;
	// Sem o teto de páginas do sync normal: a foto da conta precisa estar inteira.
	for (let page = 0; page < 10_000; page += 1) {
		const response = await api.pull(cursor);
		// A conta foi apagada enquanto a foto era tirada: as páginas de antes podem ter o que
		// o apagar levou, e a foto recomeça. Com a escolha pendente, nada sai daqui — o
		// apagar só passa a ser conhecido.
		if ((await applyWipeMark(response.dataWipedAt, 'pull')) !== 'none') {
			throw new AccountWipedMidway();
		}
		pages.push(response.changes);
		cursor = response.cursor;
		if (!response.hasMore) break;
	}
	const server = mergePages(pages);

	// Antes de ler o que existe aqui: num aparelho que nunca sincronizou, as preferências
	// só estão no AsyncStorage. Sem esta passada a moeda da conta viraria lápide — "não
	// existe neste aparelho" — e o pull do fim apagaria a moeda daqui também.
	await reconcilePreferencesSafely();

	const localIds = {} as Record<Collection, Set<string>>;
	for (const collection of COLLECTIONS) {
		localIds[collection] = await getSyncedIds(TABLE_OF[collection] as Parameters<typeof getSyncedIds>[0]);
	}

	const stamp = replacementStamp(server, nowTimestamp());
	const tombstones = tombstonesFor(server, localIds, stamp);
	const knownWipeAt = await getKnownWipeAt();

	let removed = 0;
	let notRemoved = 0;
	for (const chunk of chunkChanges(tombstones, PAGE_SIZE)) {
		let response: PushResponse;
		try {
			response = await api.push(chunk, knownWipeAt);
		} catch (error) {
			await learnFromRefusal(error);
			throw new AccountWipedMidway();
		}
		removed += response.applied;
		notRemoved += response.rejected.length;
		for (const row of response.rejected) {
			console.warn(`Substituição: o servidor não apagou ${row.collection}/${row.id} (${row.reason}${row.message ? `: ${row.message}` : ''})`);
		}
	}

	await stampEverything(stamp);
	await pushAll();

	await resetCursor();
	await pullAll();
	await setSyncState(LAST_SYNCED_KEY, nowTimestamp());

	return { removed, notRemoved };
};

/**
 * Traz tudo o que mudou no servidor desde o último cursor.
 *
 * Gravar as linhas e avançar o cursor acontece na ordem certa de propósito: se o app
 * morrer entre as duas coisas, a página é reaplicada na próxima vez. Reaplicar é
 * inofensivo — o upsert é idempotente —, ao passo que avançar o cursor antes de gravar
 * pularia aquelas linhas para sempre.
 */
export const pullAll = async (): Promise<number> => {
	const startedAt = Date.now();
	const stats: PullStats = { ...newStats(), unknown: new Map(), cursorMoved: false, complete: false, phantoms: 0 };
	try {
		const received = await pullPages(stats);
		log('sync', 'sync_pull_done', {
			data: {
				pages: stats.pages,
				received,
				rows: rowsText(stats.rows),
				cursorMoved: stats.cursorMoved,
				complete: stats.complete,
				// Coleções que o servidor mandou e esta versão não conhece: as linhas ficam de fora.
				unknownCollections: rowsText(stats.unknown) || null,
				phantomAccountsRemoved: stats.phantoms,
				durationMs: elapsedSince(startedAt),
			},
		});
		return received;
	} catch (error) {
		logSyncFailure('pull', error, { pages: stats.pages, cursorMoved: stats.cursorMoved });
		throw error;
	}
};

interface PullStats extends CycleStats {
	unknown: Map<string, number>;
	cursorMoved: boolean;
	complete: boolean;
	phantoms: number;
}

const pullPages = async (stats: PullStats): Promise<number> => {
	let cursor = await readCursor();
	const startCursor = JSON.stringify(cursor);
	let received = 0;
	let complete = false;
	let wipeApplied = false;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		const response = await api.pull(cursor);
		stats.pages += 1;

		// A conta foi apagada depois do que este aparelho sabe (SPD-083). A página que trouxe
		// a notícia não é gravada: o servidor lê as linhas **antes** da marca, então elas
		// podem ser do que o apagar levou — gravá-las traria de volta, e só aqui, o que
		// saiu da conta. O cursor fica onde estava (ou recomeça, se o aparelho foi apagado)
		// e a página é lida de novo, já com a marca conhecida.
		//
		// Uma vez por rodada: um segundo apagar novo no meio dela para o pull, e a fila
		// tenta de novo mais tarde.
		if (wipeApplied && isNewerWipe(await getKnownWipeAt(), response.dataWipedAt)) {
			throw new AccountWipedMidway();
		}
		if ((await applyWipeMark(response.dataWipedAt, 'pull')) !== 'none') {
			wipeApplied = true;
			cursor = await readCursor();
			continue;
		}

		countRows(stats, response.changes);
		for (const [collection, rows] of Object.entries(response.changes)) {
			if (!(collection in EMPTY_CURSOR) && Array.isArray(rows)) {
				stats.unknown.set(collection, (stats.unknown.get(collection) ?? 0) + rows.length);
			}
		}

		await applyPulledChanges(response.changes);
		await setSyncState(CURSOR_KEY, JSON.stringify(response.cursor));
		await setSyncState(SERVER_COLLECTIONS_KEY, JSON.stringify(Object.keys(response.cursor)));

		// A moeda e o idioma já estão no AsyncStorage; as telas vivas releem e aplicam
		// sem reiniciar o app (`CurrencyContext`, `LanguageContext`).
		emitPreferencesChanged((response.changes.preferences ?? []).map((row) => row.id));

		cursor = response.cursor;
		received += countAllChanges(response.changes);
		stats.cursorMoved = JSON.stringify(cursor) !== startCursor;

		if (!response.hasMore) {
			complete = true;
			break;
		}
	}

	// O pull pode ter trazido de volta as contas que nasceram de um app que não é banco —
	// "WhatsApp", "Gmail", "99". A limpeza era só a migração v18, que roda **antes** de as
	// tabelas existirem: numa instalação nova ela não acha nada, e em seguida o login
	// baixa as contas inventadas. Aconteceu com o dono, na 1.2.7, com seis delas de volta.
	//
	// Só quando a foto está completa: o reparo exige conta vazia, e uma conta cujos
	// lançamentos ainda estão numa página por vir **parece** vazia. Com `hasMore` ainda
	// pendente (ou o teto de páginas atingido), o reparo espera a próxima rodada.
	stats.complete = complete;
	if (complete) {
		const removed = await repairPhantomAppAccounts();
		stats.phantoms = removed;
		if (removed > 0) console.log(`Sync: ${removed} conta(s) fantasma apagada(s) depois do pull`);
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
	const startedAt = Date.now();
	const stats: PushStats = { ...newStats(), rejected: [], repaired: 0, heldBack: new Map() };
	try {
		const sent = await pushPages(stats);
		// Ciclo sem nada a subir não vira evento: o `sync_pull_done` já diz que o ciclo rodou.
		if (stats.pages > 0 || stats.heldBack.size > 0) {
			const { refused, ...rejection } = rejectionSummary(stats.rejected);
			log('sync', 'sync_push_done', {
				data: {
					pages: stats.pages,
					rows: rowsText(stats.rows),
					applied: sent,
					...rejection,
					repaired: stats.repaired,
					// Coleções que o servidor ainda não conhece: ficam aqui, sujas, até ele conhecer.
					heldBack: rowsText(stats.heldBack) || null,
					durationMs: elapsedSince(startedAt),
				},
			});
			// O que o banco do servidor recusou (`writeRowIsolated`) ou a validação barrou.
			if (refused) {
				log('sync', 'sync_rows_refused', { level: 'warn', data: { count: rejection.invalid, refused } });
			}
		}
		return sent;
	} catch (error) {
		logSyncFailure('push', error, { pages: stats.pages });
		throw error;
	}
};

interface PushStats extends CycleStats {
	rejected: RejectedRow[];
	repaired: number;
	heldBack: Map<string, number>;
}

const pushPages = async (stats: PushStats): Promise<number> => {
	let sent = 0;
	// Categorias já reenviadas nesta rodada. Uma segunda rejeição da mesma categoria
	// significa que reenviar não resolve, e o lançamento é reancorado aqui mesmo.
	const resentCategories = new Set<string>();
	const known = await readServerCollections();
	let knownWipeAt = await getKnownWipeAt();
	let wipeApplied = false;

	// O que mudou no AsyncStorage por fora vira linha suja antes de ler o que está sujo.
	await reconcilePreferencesSafely();

	for (let page = 0; page < MAX_PAGES; page += 1) {
		const dirty = await getDirtyChanges(PAGE_SIZE);
		const changes = onlyKnownCollections(dirty, known);
		const pending = countAllChanges(changes);
		for (const [collection, rows] of Object.entries(dirty)) {
			const kept = (changes as unknown as Record<string, unknown[] | undefined>)[collection];
			const held = (Array.isArray(rows) ? rows.length : 0) - (Array.isArray(kept) ? kept.length : 0);
			if (held > 0) stats.heldBack.set(collection, Math.max(stats.heldBack.get(collection) ?? 0, held));
		}

		if (pending === 0) break;

		let response: PushResponse;
		try {
			response = await api.push(changes, knownWipeAt);
		} catch (error) {
			// Recusado (409 `data_wiped`) porque a conta foi apagada em outro aparelho
			// (SPD-083): nada desta página foi aplicado. Aplicado o apagar, a página é
			// relida do banco — se o aparelho foi apagado, o que saiu com ele já não está
			// sujo e não sobe; o que fica (uma categoria editada) sobe com a marca nova.
			// Uma vez por rodada: a segunda recusa sobe como erro, e a fila espera.
			if (wipeApplied || !dataWipedRefusal(error)) throw error;
			await learnFromRefusal(error);
			wipeApplied = true;
			knownWipeAt = await getKnownWipeAt();
			continue;
		}
		stats.pages += 1;
		countRows(stats, changes);
		stats.rejected.push(...response.rejected);

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
			reserveGoals: (changes.reserveGoals ?? []).filter((r) => !rejected.has(`reserveGoals:${r.id}`)),
			// Nas capturas o `id` é o fingerprint, nos dois sentidos: é por ele que o
			// servidor recusa e é por ele que `markChangesClean` encontra a linha local.
			captures: (changes.captures ?? []).filter((r) => !rejected.has(`captures:${r.id}`)),
			merchantRules: (changes.merchantRules ?? []).filter((r) => !rejected.has(`merchantRules:${r.id}`)),
			bills: (changes.bills ?? []).filter((r) => !rejected.has(`bills:${r.id}`)),
			// Nas preferências o `id` é a chave do AsyncStorage, nos dois sentidos.
			preferences: (changes.preferences ?? []).filter((r) => !rejected.has(`preferences:${r.id}`)),
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
		stats.repaired += repaired;

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

	try {
		await setSyncState(LAST_SYNCED_KEY, new Date().toISOString());

		return { pulled, pushed, pendingAfter: await countDirtyRows() };
	} catch (error) {
		// O push e o pull registram as suas; aqui só o que falhou depois deles.
		logSyncFailure('finish', error);
		throw error;
	}
};

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default {
	syncNow,
	pullAll,
	pushAll,
	resetCursor,
	getLastSyncedAt,
	getKnownWipeAt,
	learnAccountWipe,
	setAccountWipedHandler,
};
