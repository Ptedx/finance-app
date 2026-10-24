/**
 * O que a conta tem, para o primeiro login de um aparelho decidir se pergunta.
 *
 * Conta vazia recebe os dados do aparelho direto; conta com dados faz o app perguntar se
 * sobe, puxa ou junta. Contava só lançamentos, recorrências, orçamentos e categorias
 * próprias: uma conta cujo dado estava nas contas, nas transferências, nas dívidas, nas
 * metas, na caixa de entrada, nas regras aprendidas ou nas contas a pagar era "vazia", e o
 * aparelho subia o dele por cima sem perguntar. Agora toda coleção de dado do usuário entra.
 *
 * De fora, de propósito:
 *  - as categorias padrão (quem conta é o controller, pelo id): toda conta nasce com elas;
 *  - as preferências: o aparelho as junta chave a chave pelo carimbo, e não há o que
 *    escolher entre os dois lados — uma conta que só tem o idioma não é motivo de pergunta.
 *
 * Puro, para dar para testar sem banco.
 */

/** Linhas vivas de cada coleção. Espelha `SyncStatusResponse['counts']` do app. */
export interface SyncStatusCounts {
	transactions: number;
	recurringTransactions: number;
	budgets: number;
	customCategories: number;
	accounts: number;
	transfers: number;
	debts: number;
	retirementGoals: number;
	reserveGoals: number;
	captures: number;
	merchantRules: number;
	bills: number;
}

export const EMPTY_STATUS_COUNTS: SyncStatusCounts = {
	transactions: 0,
	recurringTransactions: 0,
	budgets: 0,
	customCategories: 0,
	accounts: 0,
	transfers: 0,
	debts: 0,
	retirementGoals: 0,
	reserveGoals: 0,
	captures: 0,
	merchantRules: 0,
	bills: 0,
};

export const syncStatusOf = (counts: SyncStatusCounts) => ({
	hasData: Object.values(counts).some((count) => count > 0),
	counts,
});
