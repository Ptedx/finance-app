import type { Category, Transaction } from '../database/schema';
import { isCardAdjustment } from './cardMath';

/**
 * As categorias mais usadas, para o topo da lista de categorias do lançamento (SPD-130).
 *
 * Conta os lançamentos do mesmo lado (despesa ou receita) em cada categoria oferecida e
 * devolve as `limit` com mais lançamentos, da mais usada para a menos. Puro e testado.
 *
 * - Só conta as categorias de `offered` (as que a lista mostra): "Sem categoria" e as do
 *   outro lado ficam fora mesmo que tenham lançamentos.
 * - Uma compra parcelada conta uma vez, não uma por parcela: 12 parcelas do celular não
 *   são 12 escolhas da categoria.
 * - O ajuste com a fatura do banco (`isCardAdjustment`) não conta: não foi o dono quem
 *   escolheu a categoria dele.
 * - Empate fica na ordem de `offered` (a ordem da lista), para o topo não trocar de lugar
 *   à toa entre uma abertura e outra.
 * - Categoria sem nenhum lançamento não entra: sem histórico, a lista vem sem o topo.
 */
export const mostUsedCategoryIds = (
	transactions: readonly Pick<Transaction, 'category' | 'isIncome' | 'note' | 'installmentGroup'>[],
	offered: readonly Pick<Category, 'id'>[],
	isIncome: boolean,
	limit = 4
): string[] => {
	const counts = new Map<string, number>(offered.map((category) => [category.id, 0]));
	const seenGroups = new Set<string>();
	for (const transaction of transactions) {
		if (transaction.isIncome !== isIncome) continue;
		const count = counts.get(transaction.category);
		if (count === undefined) continue;
		if (isCardAdjustment(transaction)) continue;
		if (transaction.installmentGroup) {
			if (seenGroups.has(transaction.installmentGroup)) continue;
			seenGroups.add(transaction.installmentGroup);
		}
		counts.set(transaction.category, count + 1);
	}
	return offered
		.map((category, index) => ({ id: category.id, index, count: counts.get(category.id) ?? 0 }))
		.filter((entry) => entry.count > 0)
		.sort((a, b) => b.count - a.count || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.id);
};
