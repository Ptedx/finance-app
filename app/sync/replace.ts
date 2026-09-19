/**
 * "Subir deste aparelho": a conta passa a ter exatamente o que este aparelho tem.
 *
 * Feito com as regras do sync que já existem, sem endpoint novo:
 *
 *  1. O que a conta tem e este aparelho não tem vira **lápide** — apagado com data, para
 *     que qualquer outro aparelho ligado à conta também apague no próximo pull.
 *  2. Tudo o que este aparelho tem (inclusive as lápides dele) é regravado com um
 *     **carimbo** e sobe. O carimbo é depois de qualquer linha da conta, então o
 *     "última escrita vence" do servidor escolhe sempre a versão daqui.
 *
 * O carimbo não confia no relógio do celular: se ele estiver atrasado em relação às
 * linhas da conta, usa a linha mais nova da conta mais um milissegundo. Um relógio
 * errado não pode fazer a substituição falhar em silêncio.
 *
 * Puro: recebe o que foi lido do servidor e do banco local e devolve o que subir.
 */

import type { SyncChanges } from './types';

/** As coleções do sync, na ordem em que o servidor as grava. */
export const COLLECTIONS = ['categories', 'accounts', 'transactions', 'recurringTransactions', 'budgets', 'transfers', 'retirementGoals', 'debts'] as const;

export type Collection = (typeof COLLECTIONS)[number];

/** Tabela local de cada coleção. */
export const TABLE_OF: Record<Collection, string> = {
	categories: 'categories',
	accounts: 'accounts',
	transactions: 'transactions',
	recurringTransactions: 'recurring_transactions',
	budgets: 'budgets',
	transfers: 'transfers',
	retirementGoals: 'retirement_goals',
	debts: 'debts',
};

/** Uma lista vazia por coleção — derivada de COLLECTIONS, para nenhuma ficar de fora. */
const emptyByCollection = (): Record<Collection, SyncedRow[]> => Object.fromEntries(COLLECTIONS.map((collection) => [collection, []])) as unknown as Record<Collection, SyncedRow[]>;

interface SyncedRow {
	id: string;
	updatedAt: string;
	deletedAt?: string | null;
}

const rowsOf = (changes: Partial<SyncChanges>, collection: Collection): SyncedRow[] => (changes[collection] as SyncedRow[] | undefined) ?? [];

/**
 * O carimbo da substituição: agora, ou logo depois da linha mais nova da conta — o que
 * vier por último. Timestamps ISO em UTC comparam como texto.
 */
export const replacementStamp = (server: Partial<SyncChanges>, now: string): string => {
	let latest = now;
	for (const collection of COLLECTIONS) {
		for (const row of rowsOf(server, collection)) {
			if (row.updatedAt > latest) latest = row.updatedAt;
		}
	}
	if (latest === now) return now;
	return new Date(new Date(latest).getTime() + 1).toISOString();
};

/**
 * As lápides a subir: toda linha viva da conta cujo id não existe neste aparelho. Vão
 * com o conteúdo que a conta tinha (o servidor valida a linha inteira) e com o carimbo.
 * Linhas que existem aqui — vivas ou apagadas — não viram lápide: a versão daqui sobe
 * carimbada e vence.
 */
export const tombstonesFor = (server: Partial<SyncChanges>, localIds: Record<Collection, Set<string>>, stamp: string): SyncChanges => {
	const result = emptyByCollection();
	for (const collection of COLLECTIONS) {
		for (const row of rowsOf(server, collection)) {
			if (row.deletedAt) continue;
			if (localIds[collection].has(row.id)) continue;
			result[collection].push({ ...row, updatedAt: stamp, deletedAt: stamp });
		}
	}
	return result as unknown as SyncChanges;
};

/** Junta as páginas do pull numa foto só da conta. */
export const mergePages = (pages: Array<Partial<SyncChanges>>): Partial<SyncChanges> => {
	const merged = emptyByCollection();
	// A mesma linha pode vir em duas páginas (editada entre elas): fica a mais nova.
	const seen: Record<Collection, Map<string, SyncedRow>> = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()])) as Record<Collection, Map<string, SyncedRow>>;
	for (const page of pages) {
		for (const collection of COLLECTIONS) {
			for (const row of rowsOf(page, collection)) {
				const current = seen[collection].get(row.id);
				if (!current || row.updatedAt >= current.updatedAt) seen[collection].set(row.id, row);
			}
		}
	}
	for (const collection of COLLECTIONS) merged[collection] = [...seen[collection].values()];
	return merged as unknown as Partial<SyncChanges>;
};

/** Fatia uma remessa grande em remessas de até `size` linhas por coleção. */
export const chunkChanges = (changes: SyncChanges, size: number): SyncChanges[] => {
	const chunks: SyncChanges[] = [];
	for (const collection of COLLECTIONS) {
		const rows = rowsOf(changes, collection);
		for (let start = 0; start < rows.length; start += size) {
			const chunk: Record<string, SyncedRow[]> = { categories: [], transactions: [], recurringTransactions: [], budgets: [] };
			chunk[collection] = rows.slice(start, start + size);
			chunks.push(chunk as unknown as SyncChanges);
		}
	}
	return chunks;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { replacementStamp, tombstonesFor, mergePages, chunkChanges };
