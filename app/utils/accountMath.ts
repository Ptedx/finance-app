/**
 * Somas das contas para a tela inicial. Puro e testado.
 *
 * O saldo de cada conta vem do banco de dados (`getAccountBalances`), mais as compras
 * ainda na caixa de entrada que já contam como provisórias (`withProvisionalBalances`,
 * a mesma regra do cartão e do quadro do mês). Ciclo, fatura e
 * limite de cartão ficam em `cardMath.ts`: cartão não tem saldo, e as contas nunca
 * olham para eles além de subtrair o que eles devem do patrimônio.
 *
 * Convenção de sinal guardada na âncora de um cartão: **negativo** quando há valor a
 * pagar. `owedCents` lê ao contrário.
 */

import type { Account, AccountRole, Capture } from '../database/schema';
import { type CardEntry, cardInstallmentDates, cycleRuleOf } from './cardMath';
import { getISODate } from './dateUtils';
import { splitInstallments } from './installments';

/**
 * O "Gastou" que a folha "Acertar conta" pré-preenche: o que saiu da conta no período.
 *
 * Fora do envelope é a **despesa**, sem descontar a receita. O salário que cai na principal
 * não é gasto negativo: descontá-lo fazia R$ 5.000 de salário e R$ 3.000 de gastos virarem
 * "Gastou R$ 0", e quem digitava o número do banco (R$ 3.000) via o app lançar mais R$ 3.000
 * — o mês dobrava.
 *
 * No envelope continua o líquido, como em `buildMonthOverview`: o que entra lá dentro é
 * devolução de compra do próprio envelope, e a barra mede o que sobrou do teto.
 */
export const periodSpentCents = (item: { incomeCents: number; expenseCents: number }, role: AccountRole): number =>
	role === 'envelope' ? Math.max(0, item.expenseCents - item.incomeCents) : Math.max(0, item.expenseCents);

/**
 * O lançamento que falta para o gasto do mês numa conta bater com o que o usuário informou.
 *
 * Compras que o app não viu (as do Inter antes de a conta existir, por exemplo) são gasto
 * de verdade e precisam entrar no mês — é isso que move a barra do envelope. Gasto menor
 * do que o app já tinha significa dinheiro voltando, então vira entrada.
 *
 * Nulo quando já está igual.
 */
/**
 * O outro lado do par "já gastei" e "ainda tenho": os dois somam o dinheiro do mês.
 * Nunca negativo — quem gastou mais do que o mês tinha corrige o outro campo, e o app
 * entende a diferença como sobra de antes.
 */
export const counterpartCents = (availableCents: number, typedCents: number): number =>
	Math.max(0, availableCents - typedCents);

export const spendingAdjustment = (
	currentSpentCents: number,
	informedSpentCents: number
): { amountCents: number; isIncome: boolean } | null => {
	const difference = informedSpentCents - currentSpentCents;
	if (difference === 0) return null;
	return { amountCents: Math.abs(difference), isIncome: difference < 0 };
};

/** Quanto o cartão deve: o saldo negativo lido ao contrário; um saldo positivo é crédito. */
export const owedCents = (balanceCents: number): number => Math.max(0, -balanceCents);

export interface AccountsOverview {
	/**
	 * O dinheiro disponível para pagar contas: contas que não são cartão, nem reserva, nem
	 * externas, mais os lançamentos sem conta. A reserva fica de fora de propósito — ela não
	 * vai ser usada para pagar a fatura, e contá-la aqui faria parecer que sim. A conta
	 * `external` (a PJ, por exemplo) também: o dinheiro da empresa não é o seu caixa, e o
	 * quadro do mês já a ignora — somá-la aqui fazia "Em caixa" errar por um valor que
	 * crescia todo mês.
	 */
	cashCents: number;
	/** O que está guardado nas reservas. Dinheiro seu, mas fora do caixa. */
	savedCents: number;
	/** Soma do que os cartões devem, sem os arquivados. */
	cardsOwedCents: number;
	/** Caixa menos cartões, sem contar a reserva. */
	netCents: number;
}

export const summarizeAccounts = (
	accounts: Account[],
	balances: Map<string, number>,
	unassignedNetCents: number
): AccountsOverview => {
	let cashCents = unassignedNetCents;
	let savedCents = 0;
	let cardsOwedCents = 0;

	for (const account of accounts) {
		// Arquivada sai dos totais de hoje; a externa nunca entrou neles.
		if (account.archived || account.role === 'external') continue;
		const balance = balances.get(account.id) ?? account.openingBalanceCents;
		if (account.kind === 'credit_card') cardsOwedCents += owedCents(balance);
		else if (account.role === 'reserve') savedCents += balance;
		else cashCents += balance;
	}

	return { cashCents, savedCents, cardsOwedCents, netCents: cashCents - cardsOwedCents };
};

// ---------------------------------------------------------------------------
// Compras na caixa de entrada: provisórias
// ---------------------------------------------------------------------------

/** O que de uma captura decide se ela conta e como ela entraria no livro. */
export type ProvisionalSource = Pick<
	Capture,
	| 'id'
	| 'status'
	| 'question'
	| 'accountId'
	| 'amountCents'
	| 'direction'
	| 'postedAt'
	| 'installments'
	| 'counterparty'
	| 'appLabel'
	| 'suggestedCategory'
	| 'cardLast4'
	| 'deletedAt'
>;

/**
 * A captura que já conta como **provisória**: pendente, sem pergunta em aberto e com conta.
 *
 * É a regra única para o saldo da conta, o cartão e o quadro do mês (Home e Relatórios). O
 * banco já aprovou a compra, então ela já saiu do saldo e já está na fatura; só a categoria
 * espera. A pergunta em aberto fica de fora: "é a mesma compra?" poderia contá-la duas
 * vezes, e "é transferência?" pode tirá-la do gasto. Sem conta, não há onde contar.
 * Descartar tira o valor (deixa de ser pendente); confirmar o mantém, agora no livro.
 */
export const isProvisionalCapture = (capture: ProvisionalSource): boolean =>
	capture.status === 'pending' && capture.question === null && capture.accountId !== null && !capture.deletedAt;

/**
 * Uma captura provisória como as linhas que confirmá-la lançaria (`postTransaction`): a data
 * local do aviso e, se parcelada, uma parcela por fatura no cartão (ou por mês fora dele).
 * Vazio quando a captura não conta ou é de outra conta.
 */
export const provisionalEntries = (
	capture: ProvisionalSource,
	account: Pick<Account, 'id' | 'kind' | 'closingDay' | 'closingDaysBefore'>
): CardEntry[] => {
	if (!isProvisionalCapture(capture) || capture.accountId !== account.id) return [];
	const count = capture.installments && capture.installments > 1 ? capture.installments : 1;
	const parts = splitInstallments(capture.amountCents, count);
	const rule = account.kind === 'credit_card' ? cycleRuleOf(account) : null;
	const dates = cardInstallmentDates(getISODate(new Date(capture.postedAt)), count, rule);
	const note = capture.counterparty ?? capture.appLabel;
	return dates.map((date, index) => ({
		id: `capture:${capture.id}:${index + 1}`,
		amountCents: parts[index],
		isIncome: capture.direction === 'in',
		date,
		note: count > 1 ? `${note} (${index + 1}/${count})` : note,
		category: capture.suggestedCategory ?? '',
		installmentGroup: count > 1 ? capture.id : null,
		installmentIndex: count > 1 ? index + 1 : null,
		installmentCount: count > 1 ? count : null,
		cardLast4: capture.cardLast4,
		pendingReview: true,
	}));
};

/** As linhas provisórias de cada conta (só as que têm alguma). */
export const provisionalEntriesByAccount = (
	captures: ProvisionalSource[],
	accounts: Pick<Account, 'id' | 'kind' | 'closingDay' | 'closingDaysBefore'>[]
): Map<string, CardEntry[]> => {
	const byId = new Map(accounts.map((account) => [account.id, account]));
	const result = new Map<string, CardEntry[]>();
	for (const capture of captures) {
		const account = capture.accountId ? byId.get(capture.accountId) : undefined;
		if (!account) continue;
		const entries = provisionalEntries(capture, account);
		if (entries.length === 0) continue;
		result.set(account.id, [...(result.get(account.id) ?? []), ...entries]);
	}
	return result;
};

const signedCents = (entry: Pick<CardEntry, 'amountCents' | 'isIncome'>): number => (entry.isIncome ? entry.amountCents : -entry.amountCents);

/**
 * Quanto as linhas provisórias mexem no saldo do fim de `asOf`, pela mesma conta de
 * `getAccountBalances`: depois da âncora, soma o que veio entre ela e a data; antes dela,
 * desfaz o que houve entre a data e a âncora. O que é da âncora ou de antes já está nela —
 * o saldo informado no dia seguinte ao aviso já tem a compra.
 */
export const provisionalBalanceCents = (entries: Pick<CardEntry, 'amountCents' | 'isIncome' | 'date'>[], anchorDate: string, asOf: string): number => {
	const from = asOf < anchorDate ? asOf : anchorDate;
	const to = asOf < anchorDate ? anchorDate : asOf;
	let total = 0;
	for (const entry of entries) {
		if (entry.date > from && entry.date <= to) total += signedCents(entry);
	}
	return asOf >= anchorDate ? total : -total;
};

/**
 * O saldo do SQL com as provisórias somadas, conta a conta. Num cartão a compra deixa o
 * saldo mais negativo — o devido sobe, como `buildCardSummary` já conta.
 */
export const withProvisionalBalances = (
	balances: Map<string, number>,
	accounts: Pick<Account, 'id' | 'openingBalanceCents' | 'openingBalanceDate'>[],
	byAccount: Map<string, CardEntry[]>,
	asOf: string
): Map<string, number> => {
	if (byAccount.size === 0) return balances;
	const next = new Map(balances);
	for (const account of accounts) {
		const entries = byAccount.get(account.id);
		if (!entries) continue;
		const delta = provisionalBalanceCents(entries, account.openingBalanceDate, asOf);
		if (delta !== 0) next.set(account.id, (next.get(account.id) ?? account.openingBalanceCents) + delta);
	}
	return next;
};

/**
 * O que as linhas provisórias somam num período, como `getAccountActivity` somaria se já
 * estivessem no livro, mais o valor cheio das compras **feitas** nele (como
 * `getCardPurchasesOriginated`: a de uma vez, ou o total do parcelamento que começa nele).
 */
export const provisionalFlows = (
	entries: CardEntry[],
	startDate: string,
	endDate: string
): { incomeCents: number; expenseCents: number; purchasesCents: number } => {
	let incomeCents = 0;
	let expenseCents = 0;
	let purchasesCents = 0;
	const groupTotals = new Map<string, number>();
	for (const entry of entries) {
		if (entry.installmentGroup && !entry.isIncome) groupTotals.set(entry.installmentGroup, (groupTotals.get(entry.installmentGroup) ?? 0) + entry.amountCents);
	}
	for (const entry of entries) {
		if (entry.date < startDate || entry.date > endDate) continue;
		if (entry.isIncome) {
			incomeCents += entry.amountCents;
			continue;
		}
		expenseCents += entry.amountCents;
		if (!entry.installmentGroup) purchasesCents += entry.amountCents;
		else if (entry.installmentIndex === 1) purchasesCents += groupTotals.get(entry.installmentGroup) ?? 0;
	}
	return { incomeCents, expenseCents, purchasesCents };
};

export interface NetWorthInput {
	/** Contas (corrente, carteira, envelope): `overview.cashCents`. */
	cashCents: number;
	/** Reservas e investimentos no app: `overview.savedCents`. */
	savedCents: number;
	/** Investimentos que o app não acompanha (da meta de aposentadoria). */
	outsideCents: number;
	/** Cartões: o que já está nas faturas mais as parcelas que ainda vão cair. */
	cardsCents: number;
	/** Saldo devedor das dívidas de longo prazo. */
	debtsCents: number;
}

export interface NetWorth {
	/** O que se tem: contas, reservas, investimentos. */
	assetsCents: number;
	/** O que se deve: cartões e dívidas. */
	liabilitiesCents: number;
	/** A diferença. Pode ser negativa — e dizer isso é o ponto. */
	netCents: number;
}

/**
 * O patrimônio líquido: o que se tem menos o que se deve. Bens como carro e imóvel ficam
 * de fora — o app não sabe quanto valem —, então para quem financia um bem o número
 * aparece menor do que é, e a tela diz isso. Saldo negativo numa conta desconta dos ativos;
 * crédito num cartão (pagou a mais) não vira ativo.
 */
export const netWorth = (input: NetWorthInput): NetWorth => {
	const assetsCents = input.cashCents + input.savedCents + Math.max(0, input.outsideCents);
	const liabilitiesCents = Math.max(0, input.cardsCents) + Math.max(0, input.debtsCents);
	return { assetsCents, liabilitiesCents, netCents: assetsCents - liabilitiesCents };
};

export default {
	counterpartCents,
	owedCents,
	periodSpentCents,
	spendingAdjustment,
	summarizeAccounts,
	netWorth,
	isProvisionalCapture,
	provisionalEntries,
	provisionalEntriesByAccount,
	provisionalBalanceCents,
	withProvisionalBalances,
	provisionalFlows,
};
