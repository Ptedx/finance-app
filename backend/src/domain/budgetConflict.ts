/**
 * Dois orçamentos para o mesmo mês, vindos de lados diferentes.
 *
 * O banco exige **um só orçamento vivo** por `(userId, year, month)` — o índice parcial
 * `budgets_userId_year_month_live_key`, escrito à mão em
 * `prisma/migrations/20260722150100_budget_period_unique`, o mesmo que o SQLite do app
 * cria em `CREATE_INDEXES`. Ids diferentes para o mesmo mês acontecem de verdade: o
 * aparelho usado anônimo e depois conectado a uma conta que já tinha aquele mês, ou dois
 * aparelhos que preencheram o mês offline. Sem tratamento, o upsert violava o índice, o
 * Prisma lançava P2002 dentro da transação, o erro virava 500 e a fila reenviava a mesma
 * remessa para sempre: nada mais saía daquele aparelho — nem lançamento, nem conta.
 *
 * A regra é a do resto do sync, last-write-wins por `updatedAt`: o mais recente fica
 * vivo, o perdedor ganha lápide. É também o que o app já faz sozinho ao aplicar um pull
 * (ver o trecho dos orçamentos em `applyPulledChanges`), então os dois lados convergem
 * para a mesma linha viva.
 *
 * Função pura, separada do controller, porque é a parte que vale testar.
 */

/** A linha que chegou na remessa, já com as datas convertidas. */
export interface IncomingBudget {
	id: string;
	updatedAt: Date;
	deletedAt: Date | null;
}

/** O orçamento vivo que o servidor já tem para aquele mês, se houver outro. */
export interface LiveBudget {
	id: string;
	updatedAt: Date;
}

/**
 * O que fazer antes de gravar a linha que chegou:
 *
 * - `none`: nada no caminho, o upsert de sempre;
 * - `tombstone_existing`: a linha que já estava viva é mais antiga e ganha lápide;
 * - `tombstone_incoming`: a que chegou é a mais antiga, e é ela que entra apagada.
 *
 * `at` é o carimbo da lápide: sempre o `updatedAt` de **quem venceu**, para que a lápide
 * seja mais nova que a linha que ela substitui no aparelho de origem.
 */
export type BudgetPeriodResolution =
	| { kind: 'none' }
	| { kind: 'tombstone_existing'; id: string; at: Date }
	| { kind: 'tombstone_incoming'; at: Date };

export const resolveBudgetPeriod = (
	incoming: IncomingBudget,
	live: LiveBudget | null
): BudgetPeriodResolution => {
	// Uma lápide que chega não disputa nada: o índice só olha as linhas vivas.
	if (incoming.deletedAt !== null) return { kind: 'none' };

	// Mesma linha, ou mês livre: o upsert normal resolve.
	if (live === null || live.id === incoming.id) return { kind: 'none' };

	// Empate a favor de quem envia, como em `isStale`: reaplicar uma escrita idêntica
	// custa zero, e recusá-la deixaria o aparelho tentando para sempre.
	if (live.updatedAt > incoming.updatedAt) return { kind: 'tombstone_incoming', at: live.updatedAt };

	return { kind: 'tombstone_existing', id: live.id, at: incoming.updatedAt };
};
