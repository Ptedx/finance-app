import { getPendingCaptures } from '../database/captures';
import {
	getAccountActivity,
	getAccountBalances,
	getAccounts,
	getAccountTransactions,
	getAccountTransfers,
	getCardPurchasesOriginated,
	getTransfersByDateRange,
	getUnassignedNet,
	getUnassignedPeriodSummary,
} from '../database/database';
import type { Account, Transfer } from '../database/schema';
import { periodSpentCents, provisionalEntriesByAccount, provisionalFlows, withProvisionalBalances } from './accountMath';
import { buildCardSummary, type CardEntry, type CardMovement, type CardSummary, invoicesClosingBetween } from './cardMath';
import { addDays, monthKeyOf, monthKeyRange, shiftMonthKey } from './dateUtils';
import { type AccountMonthActivity, buildMonthOverview, type MonthOverview, type ProvisionalPart, provisionalPart } from './monthOverview';
import {
	externalTransfersInByMonth,
	externalTransfersOutByMonth,
	investmentIncomeRows,
	lastInvestmentIncomeDateByAccount,
} from './reportSeries';
import { accruedYieldCents, type YieldFlow } from './yield';

/**
 * A carga das contas e dos cartões, tirada do `AccountsContext` (SPD-163b) para que o Mirai
 * leia exatamente os mesmos números que as telas: o contexto chama `loadAccountsState` e só
 * guarda o resultado; as ferramentas do Mirai (`utils/mirai/tools`) chamam a mesma função.
 *
 * A conta é a de sempre — nada mudou ao sair do contexto: saldos com as provisórias, o quadro
 * do mês do período, o resumo de cada cartão e o que a estimativa de rendimento precisa.
 */

/** O que a estimativa de rendimento precisa saber de uma conta que rende. */
export interface YieldAccountInput {
	anchorCents: number;
	anchorDate: string;
	flows: YieldFlow[];
	percentOfCdiBp: number;
	/** A data do último rendimento lançado na conta; nula sem nenhum. */
	lastPostedYieldDate: string | null;
}

/** Quantos meses a janela do "rendeu nos últimos 12 meses" cobre, contando o de hoje. */
export const YIELD_WINDOW_MONTHS = 12;

/** Tudo o que uma recarga do `AccountsContext` grava. */
export interface AccountsState {
	list: Account[];
	/** Saldo registrado (âncora + movimentos) com as provisórias; sem o rendimento estimado. */
	balances: Map<string, number>;
	/** Quanto do saldo de hoje de cada conta vem de provisórias (com sinal); só as que têm. */
	provisionalBalances: Map<string, number>;
	yieldInputs: Map<string, YieldAccountInput>;
	cardSummaries: Map<string, CardSummary>;
	unassignedNetCents: number;
	periodTransfers: Transfer[];
	periodSpentByAccount: Map<string, number>;
	month: MonthOverview;
	provisionalMonth: ProvisionalPart;
}

/** Soma por conta um mapa `mês|contaId`: aqui só há transferências do período pedido. */
const sumByAccount = (byKey: Map<string, number>): Map<string, number> => {
	const byAccount = new Map<string, number>();
	for (const [key, cents] of byKey) {
		const accountId = key.slice(key.indexOf('|') + 1);
		byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + cents);
	}
	return byAccount;
};

/**
 * Lê o banco e monta o estado das contas para o período `[startDate, endDate]`, visto de
 * `today`. É o corpo do `refresh` do `AccountsContext`.
 */
export const loadAccountsState = async (startDate: string, endDate: string, today: string): Promise<AccountsState> => {
	// Saldo na véspera do período e no fim dele (ou hoje, se ainda está correndo): é o que
	// diz quanto sobrou do mês anterior e quanto ainda há na conta.
	const periodEnd = endDate < today ? endDate : today;
	const [list, ledgerBalances, unassigned, unassignedPeriod, pendingCaptures, ledgerStartBalances, ledgerEndBalances, transfersInPeriod] =
		await Promise.all([
			getAccounts(),
			getAccountBalances(today),
			getUnassignedNet(today),
			getUnassignedPeriodSummary(startDate, endDate),
			getPendingCaptures(),
			getAccountBalances(addDays(startDate, -1)),
			getAccountBalances(periodEnd),
			getTransfersByDateRange(startDate, endDate),
		]);

	// O que as contas de papel `external` (a PJ) mandaram para contas suas no período, e o
	// que as suas mandaram para elas: o líquido é receita do mês, e no livro é
	// transferência. O mapa é por mês e conta, mas aqui só há transferências do período
	// pedido, então vale somar todos os meses de cada conta.
	const live = list.filter((account) => !account.deletedAt);
	const fromExternalByAccount = sumByAccount(externalTransfersInByMonth(transfersInPeriod, live));
	const toExternalByAccount = sumByAccount(externalTransfersOutByMonth(transfersInPeriod, live));

	// As compras da caixa de entrada sem pergunta em aberto contam como provisórias em
	// todo lugar — saldo, cartão e mês —, como o cartão já fazia. Uma regra só
	// (`provisionalEntries`), para o saldo da conta corrente e o "Gastou" não divergirem
	// do cartão nem dos Relatórios.
	const provisional = provisionalEntriesByAccount(pendingCaptures, live);
	const nextBalances = withProvisionalBalances(ledgerBalances, live, provisional, today);
	const startBalances = withProvisionalBalances(ledgerStartBalances, live, provisional, addDays(startDate, -1));
	const endBalances = withProvisionalBalances(ledgerEndBalances, live, provisional, periodEnd);
	const nextProvisionalBalances = new Map<string, number>();
	for (const [accountId, cents] of nextBalances) {
		const delta = cents - (ledgerBalances.get(accountId) ?? cents);
		if (delta !== 0) nextProvisionalBalances.set(accountId, delta);
	}

	const nextSummaries = new Map<string, CardSummary>();
	const nextYieldInputs = new Map<string, YieldAccountInput>();
	const activity: AccountMonthActivity[] = [];
	// O mesmo mês só com o livro: a diferença é a parte "a revisar" (`provisionalPart`).
	const ledgerActivity: AccountMonthActivity[] = [];

	for (const account of list) {
		if (account.deletedAt) continue;

		const period = await getAccountActivity(account.id, startDate, endDate);
		const isCard = account.kind === 'credit_card';
		const pending = provisional.get(account.id) ?? [];
		const pendingFlows = provisionalFlows(pending, startDate, endDate);
		const purchasesOriginatedCents = isCard ? await getCardPurchasesOriginated(account.id, startDate, endDate) : undefined;
		// Rendimento é só a receita em categoria de rendimento de investimento. Sem isto,
		// toda receita que encostasse numa conta de reserva — o Pix de um amigo, um
		// reembolso — era anunciada como rentabilidade que não houve.
		const investmentIncomeCents =
			account.role === 'reserve'
				? investmentIncomeRows(
						(await getAccountTransactions(account.id)).filter((tx) => tx.date >= startDate && tx.date <= endDate)
					).reduce((total, row) => total + row.cents, 0)
				: 0;
		const ledgerItem: AccountMonthActivity = {
			accountId: account.id,
			name: account.name,
			kind: account.kind,
			// O papel de verdade, inclusive de conta arquivada: trocá-lo por `external` aqui
			// reescrevia o passado — arquivar um cartão apagava as faturas dele dos meses
			// fechados. Arquivada fica fora dos totais de hoje, nunca de um mês fechado.
			role: account.role,
			incomeCents: period.incomeCents,
			investmentIncomeCents,
			expenseCents: period.expenseCents,
			passThroughCents: period.passThroughCents,
			transfersInCents: period.transfersInCents,
			transfersInFromExternalCents: fromExternalByAccount.get(account.id) ?? 0,
			transfersOutCents: period.transfersOutCents,
			transfersOutToExternalCents: toExternalByAccount.get(account.id) ?? 0,
			purchasesOriginatedCents,
			envelopeMonthlyCents: account.envelopeMonthlyCents,
			startBalanceCents: ledgerStartBalances.get(account.id) ?? 0,
			endBalanceCents: ledgerEndBalances.get(account.id) ?? 0,
		};
		ledgerActivity.push(ledgerItem);
		activity.push({
			...ledgerItem,
			incomeCents: period.incomeCents + pendingFlows.incomeCents,
			expenseCents: period.expenseCents + pendingFlows.expenseCents,
			purchasesOriginatedCents: purchasesOriginatedCents === undefined ? undefined : purchasesOriginatedCents + pendingFlows.purchasesCents,
			startBalanceCents: startBalances.get(account.id) ?? 0,
			endBalanceCents: endBalances.get(account.id) ?? 0,
		});

		// Conta que rende: a âncora e o que entrou e saiu depois dela, para estimar o
		// rendimento até hoje.
		if (!isCard && (account.yieldCdiBp ?? 0) > 0) {
			const [ownTransactions, ownTransfers] = await Promise.all([getAccountTransactions(account.id), getAccountTransfers(account.id)]);
			const flows: YieldFlow[] = [
				...ownTransactions.map((tx) => ({ date: tx.date, cents: tx.isIncome ? tx.amountCents : -tx.amountCents })),
				...ownTransfers.map((transfer) => ({
					date: transfer.date,
					cents: transfer.toAccountId === account.id ? transfer.amountCents : -transfer.amountCents,
				})),
			].filter((flow) => flow.date > account.openingBalanceDate);
			nextYieldInputs.set(account.id, {
				anchorCents: account.openingBalanceCents,
				anchorDate: account.openingBalanceDate,
				flows,
				percentOfCdiBp: account.yieldCdiBp ?? 0,
				// Ou se lança o rendimento, ou se estima — nunca os dois no mesmo período. O
				// último rendimento lançado cobre tudo até a data dele; antes dela quem vale é
				// o livro. Sem isto, a receita de rendimento já estava no saldo e continuava
				// sendo estimada por cima, compondo sobre a duplicata: inflava reserva,
				// capital, patrimônio e progresso da meta, e podia declarar a reserva cheia
				// antes da hora.
				lastPostedYieldDate: lastInvestmentIncomeDateByAccount(ownTransactions).get(account.id) ?? null,
			});
		}

		if (!isCard) continue;
		const cardActivity = activity[activity.length - 1];

		const [cardTransactions, cardTransfers] = await Promise.all([getAccountTransactions(account.id), getAccountTransfers(account.id)]);
		const ledgerEntries: CardEntry[] = cardTransactions.map((tx) => ({
			id: tx.id,
			amountCents: tx.amountCents,
			isIncome: tx.isIncome,
			date: tx.date,
			note: tx.note,
			category: tx.category,
			installmentGroup: tx.installmentGroup,
			installmentIndex: tx.installmentIndex,
			installmentCount: tx.installmentCount,
			cardLast4: tx.cardLast4,
		}));
		const entries = [...ledgerEntries, ...pending];
		const movements: CardMovement[] = cardTransfers.map((transfer) => ({
			amountCents: transfer.amountCents,
			date: transfer.date,
			inbound: transfer.toAccountId === account.id,
		}));
		nextSummaries.set(account.id, buildCardSummary(account, entries, movements, today));
		cardActivity.invoiceCents = invoicesClosingBetween(account, entries, startDate, endDate);
		ledgerActivity[ledgerActivity.length - 1].invoiceCents = invoicesClosingBetween(account, ledgerEntries, startDate, endDate);
	}

	const month = buildMonthOverview({ accounts: activity, unassigned: unassignedPeriod });
	return {
		list,
		balances: nextBalances,
		provisionalBalances: nextProvisionalBalances,
		yieldInputs: nextYieldInputs,
		cardSummaries: nextSummaries,
		unassignedNetCents: unassigned,
		periodTransfers: transfersInPeriod,
		periodSpentByAccount: new Map(activity.map((item) => [item.accountId, periodSpentCents(item, item.role)])),
		month,
		provisionalMonth: provisionalPart(month, buildMonthOverview({ accounts: ledgerActivity, unassigned: unassignedPeriod })),
	};
};

/** O rendimento estimado de cada conta que rende, até ontem, no CDI em uso (vazio sem CDI). */
export const accruedYieldByAccount = (
	yieldInputs: Map<string, YieldAccountInput>,
	cdiAnnualBp: number | null,
	today: string
): Map<string, number> => {
	const result = new Map<string, number>();
	if (cdiAnnualBp === null) return result;
	for (const [accountId, input] of yieldInputs) {
		result.set(accountId, accruedYieldCents({ ...input, notBefore: input.lastPostedYieldDate, today, cdiAnnualBp }));
	}
	return result;
};

/**
 * O mesmo rendimento estimado, recortado nos últimos 12 meses: é o que o indicador
 * "rendeu nos últimos 12 meses" precisa para não afirmar 0% num CDB de 120% do CDI,
 * onde o acréscimo é estimado em memória e nada é lançado no livro. O recorte usa a
 * data mais recente entre o começo da janela e o último rendimento lançado — o livro
 * responde pelo período que ele cobre, a estimativa só pelo resto.
 */
export const accruedYield12mByAccount = (
	yieldInputs: Map<string, YieldAccountInput>,
	cdiAnnualBp: number | null,
	today: string
): Map<string, number> => {
	const result = new Map<string, number>();
	if (cdiAnnualBp === null) return result;
	const windowStart = monthKeyRange(shiftMonthKey(monthKeyOf(today), -(YIELD_WINDOW_MONTHS - 1))).startDate;
	const notBeforeWindow = addDays(windowStart, -1);
	for (const [accountId, input] of yieldInputs) {
		const notBefore = input.lastPostedYieldDate !== null && input.lastPostedYieldDate > notBeforeWindow ? input.lastPostedYieldDate : notBeforeWindow;
		result.set(accountId, accruedYieldCents({ ...input, notBefore, today, cdiAnnualBp }));
	}
	return result;
};

/** O saldo de hoje de cada conta: o registrado mais o rendimento estimado. */
export const balancesWithAccruedYield = (rawBalances: Map<string, number>, accrued: Map<string, number>): Map<string, number> => {
	if (accrued.size === 0) return rawBalances;
	const next = new Map(rawBalances);
	for (const [accountId, cents] of accrued) next.set(accountId, (next.get(accountId) ?? 0) + cents);
	return next;
};

export interface CardsTotals {
	toPayCents: number;
	openInvoicesCents: number;
	limitAvailableCents: number | null;
	limitUsedCents: number;
}

/** As somas de todos os cartões ativos (`creditCards`): "A pagar agora", faturas abertas e limite. */
export const cardsTotalsOf = (creditCards: Account[], cardSummaries: Map<string, CardSummary>): CardsTotals => {
	let toPayCents = 0;
	let openInvoicesCents = 0;
	let limitUsedCents = 0;
	let limitAvailableCents: number | null = null;
	for (const card of creditCards) {
		const summary = cardSummaries.get(card.id);
		if (!summary) continue;
		toPayCents += summary.toPayCents;
		openInvoicesCents += Math.max(0, summary.openInvoiceCents);
		limitUsedCents += summary.limitUsedCents;
		if (summary.limitAvailableCents !== null) {
			limitAvailableCents = (limitAvailableCents ?? 0) + summary.limitAvailableCents;
		}
	}
	return { toPayCents, openInvoicesCents, limitAvailableCents, limitUsedCents };
};

/** A ordem de exibição das contas e dos cartões. */
export const byDisplayOrder = (a: Account, b: Account) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** As ativas (não arquivadas), na ordem de exibição; `bankAccounts` e `creditCards` saem daqui. */
export const activeAccountsOf = (accounts: Account[]): Account[] => accounts.filter((account) => !account.archived).sort(byDisplayOrder);

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { loadAccountsState, accruedYieldByAccount, accruedYield12mByAccount, balancesWithAccruedYield, cardsTotalsOf, activeAccountsOf };
