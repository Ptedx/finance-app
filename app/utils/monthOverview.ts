/**
 * O quadro do mês por papel de conta: "quanto gastei de verdade e quanto sobrou".
 *
 * A fatura do cartão não é o gasto do mês. O gasto do mês é a soma de três coisas que
 * saem de lugares diferentes: as compras no cartão (parcela a parcela, no mês em que
 * caem), o Pix e o débito da conta principal, e o que foi mandado para os envelopes
 * de gastos. O que vai para a reserva não é gasto, é poupança. Um pagamento de fatura
 * é transferência e não entra em lugar nenhum — senão o cartão contaria duas vezes.
 *
 * Puro: recebe o movimento de cada conta no período (já somado pelo banco) e compõe.
 */

import type { AccountKind, AccountRole } from '../database/schema';

export interface AccountMonthActivity {
	accountId: string;
	name: string;
	kind: AccountKind;
	role: AccountRole;
	/** Receitas lançadas na conta no período. */
	incomeCents: number;
	/** Despesas lançadas na conta no período (no cartão, as parcelas que caem no mês). */
	expenseCents: number;
	transfersInCents: number;
	transfersOutCents: number;
	/**
	 * Só cartões: soma das faturas que **fecham** no período. É a métrica principal —
	 * o que sai do bolso. Nulo quando o cartão não tem fechamento informado.
	 */
	invoiceCents?: number | null;
	/** Só cartões: valor cheio das compras **feitas** no período, parceladas ou não. */
	purchasesOriginatedCents?: number;
	envelopeMonthlyCents?: number | null;
}

export interface MonthOverviewInput {
	accounts: AccountMonthActivity[];
	/** Lançamentos sem conta no período: contam como se fossem da principal. */
	unassigned: { incomeCents: number; expenseCents: number };
}

export interface CardMonth {
	accountId: string;
	name: string;
	/**
	 * A fatura deste mês (a que fecha nele), com parcelas e a "fatura atual" informada. Sem
	 * fechamento no cartão, as compras e parcelas datadas no mês, menos estornos.
	 */
	spendCents: number;
	/** O que foi comprado neste mês, valor cheio — a métrica secundária. */
	purchasesCents: number;
}

export interface EnvelopeMonth {
	accountId: string;
	name: string;
	/** O que entrou no envelope no mês: é isto que conta como gasto. */
	fundedCents: number;
	/** O que saiu de dentro do envelope, para a barra "gastou X de Y". */
	spentCents: number;
	/** Valor combinado por mês, quando informado. */
	monthlyCents: number | null;
}

export interface MonthOverview {
	incomeCents: number;
	cardSpendCents: number;
	cardPurchasesCents: number;
	mainSpendCents: number;
	envelopeFundingCents: number;
	totalSpendCents: number;
	/** Entrou na reserva menos o que saiu dela. */
	savedCents: number;
	/** Rendimento das reservas: receita, mas de outra natureza. */
	yieldCents: number;
	/** Receita menos gasto total. O que foi guardado sai daqui. */
	leftoverCents: number;
	/** Pontos-base de (receita − gasto) / receita; nulo sem receita. */
	savingsRateBp: number | null;
	cards: CardMonth[];
	envelopes: EnvelopeMonth[];
}

export const buildMonthOverview = (input: MonthOverviewInput): MonthOverview => {
	let incomeCents = input.unassigned.incomeCents;
	let mainSpendCents = input.unassigned.expenseCents;
	let cardSpendCents = 0;
	let cardPurchasesCents = 0;
	let envelopeFundingCents = 0;
	let savedCents = 0;
	let yieldCents = 0;
	const cards: CardMonth[] = [];
	const envelopes: EnvelopeMonth[] = [];

	for (const account of input.accounts) {
		switch (account.role) {
			case 'main': {
				incomeCents += account.incomeCents;
				mainSpendCents += account.expenseCents;
				break;
			}
			case 'card': {
				const spend = Math.max(0, account.invoiceCents ?? account.expenseCents - account.incomeCents);
				const purchases = account.purchasesOriginatedCents ?? 0;
				cardSpendCents += spend;
				cardPurchasesCents += purchases;
				cards.push({ accountId: account.accountId, name: account.name, spendCents: spend, purchasesCents: purchases });
				break;
			}
			case 'envelope': {
				// O que entrou menos o que saiu para outras contas suas. Mandar R$ 600 do envelope
				// para a principal pagar a fatura não é gasto do envelope: a fatura já conta no
				// cartão. Sem descontar, o mesmo dinheiro contava duas vezes.
				const funded = account.transfersInCents - account.transfersOutCents;
				envelopeFundingCents += funded;
				envelopes.push({
					accountId: account.accountId,
					name: account.name,
					fundedCents: funded,
					spentCents: Math.max(0, account.expenseCents - account.incomeCents),
					monthlyCents: account.envelopeMonthlyCents ?? null,
				});
				break;
			}
			case 'reserve': {
				savedCents += account.transfersInCents - account.transfersOutCents;
				yieldCents += account.incomeCents;
				break;
			}
			case 'external':
				// Não acompanhada: o que ela manda para a principal já chegou lá como receita.
				break;
		}
	}

	const totalSpendCents = cardSpendCents + mainSpendCents + envelopeFundingCents;
	const leftoverCents = incomeCents - totalSpendCents;
	const savingsRateBp = incomeCents > 0 ? Math.round((leftoverCents / incomeCents) * 10_000) : null;

	return {
		incomeCents,
		cardSpendCents,
		cardPurchasesCents,
		mainSpendCents,
		envelopeFundingCents,
		totalSpendCents,
		savedCents,
		yieldCents,
		leftoverCents,
		savingsRateBp,
		cards,
		envelopes,
	};
};

export default { buildMonthOverview };
