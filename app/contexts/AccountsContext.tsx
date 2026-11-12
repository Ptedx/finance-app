import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
	addAccount,
	addTransaction,
	addTransfer,
	assignUnassignedToAccount,
	countUnassignedOnOrBeforeAnchor,
	type UnassignedAssignment,
	deleteAccount,
	deleteTransfer,
	foldAccountBalance,
	getAccountContents,
	getAccount,
	getAccountActivity,
	getAccountBalances,
	getAccounts,
	getAccountTransactions,
	getAccountTransfers,
	getBills,
	getCardPurchasesOriginated,
	getDebts,
	getTransactions,
	getUnassignedNet,
	getUnassignedPeriodSummary,
	getTransfersByDateRange,
	mergeCardInto,
	moveAccountLedger,
	normalizeAccountDraft,
	reassignCaptureLedger,
	repointTransfers,
	retireMergedAccount,
	runInTransaction,
	setAccountCardNames,
	setAccountAnchor,
	setAccountBalanceToday,
	updateAccount,
	updateTransfer,
} from '../database/database';
import { getAllCaptures, getPendingCaptures, updateCapture } from '../database/captures';
import type { Account, AccountDraft, AccountEdit, Transfer } from '../database/schema';
import { log } from '../diagnostics/log';
import { useAfterPull } from '../hooks/useAfterPull';
import * as syncQueue from '../sync/queue';
import {
	type AccountsOverview,
	periodSpentCents,
	provisionalBalanceCents,
	provisionalEntries,
	provisionalEntriesByAccount,
	provisionalFlows,
	spendingAdjustment,
	summarizeAccounts,
	withProvisionalBalances,
} from '../utils/accountMath';
import { type AccountContents, CLOSING_TRANSFER_NOTE, type ClosePlan, planAccountClose } from '../utils/accountClosing';
import { canMergeAccounts, DebitFutureError, isDebitTarget, MergeRoleError } from '../utils/accountMerging';
import { emitBillsChanged } from '../utils/billEvents';
import {
	buildCardSummary,
	CARD_ADJUSTMENT_NOTE,
	type CardChargeKind,
	cardChargeNote,
	cardChargeShown,
	type CardEntry,
	type CardMovement,
	type CardSummary,
	cycleRuleOf,
	existingInstallmentDates,
	invoicesClosingBetween,
	isSameCardPayment,
	openInvoiceInformed,
	pickOpenCardPayment,
	planCardAdjustment,
	planCardOpening,
	splitCardCharges,
} from '../utils/cardMath';
import { resolveCategoryId } from '../utils/captureActions';
import { changesCardRouting, planCardLedgerRepair } from '../utils/cardLedgerRepair';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { feedOwnerOf } from '../utils/accountBinding';
import { type AccountLinks, autoMergeCandidates, isEmptyUntouched, planAutoMerges } from '../utils/autoMergeAccounts';
import { type AutoMergeNotice, addAutoMergeNotice, clearAutoMergeNotices, getAutoMergeNotices } from '../utils/autoMergeNotices';
import { getDismissedBalanceUnset } from '../utils/balanceUnsetDismissals';
import { planBusinessFeed } from '../utils/businessFeed';
import { getBusinessFeeds, setBusinessFeed } from '../utils/businessFeedPreference';
import { getDistinctAccountPairs } from '../utils/distinctAccounts';
import {
	externalTransfersInByMonth,
	externalTransfersOutByMonth,
	investmentIncomeRows,
	lastInvestmentIncomeDateByAccount,
} from '../utils/reportSeries';
import { parseCardNames, withCardName } from '../utils/cardNames';
import { addDays, monthKeyOf, monthKeyRange, shiftMonthKey, todayISO } from '../utils/dateUtils';
import {
	type AccountMonthActivity,
	buildMonthOverview,
	type MonthOverview,
	type ProvisionalPart,
	provisionalPart,
} from '../utils/monthOverview';
import { type CdiRate, loadCachedCdi, refreshCdi } from '../api/cdi';
import { accruedYieldCents, type YieldFlow } from '../utils/yield';
import { usePeriod } from './PeriodContext';
import { useTransactions } from './TransactionsContext';

/**
 * Contas e cartões para as telas, **em dois mundos separados**.
 *
 * Contas têm saldo. Cartões têm limite, fatura aberta, fatura fechada e parcelas —
 * calculados por `cardMath.ts` a partir dos lançamentos e pagamentos de cada cartão.
 * As telas de conta nunca veem cartão, e as de cartão nunca veem saldo.
 *
 * Recarrega quando o livro-caixa muda, quando o período muda e quando uma captura vira
 * transferência (o CapturesContext chama `refresh`).
 */

/**
 * Um cartão de débito: não tem fatura nem limite, é um cartão da conta corrente. Existe
 * quando a conta tem compras com aquele final ou quando o usuário deu nome a ele.
 */
export interface DebitCard {
	/** `contaId:final`. */
	key: string;
	account: Account;
	last4: string;
	name: string | null;
	/** Compras menos estornos no período selecionado. */
	periodSpentCents: number;
	/** Data da compra mais recente, para ordenar. */
	lastUsed: string | null;
}

/** O que o último cartão criado ou editado trouxe da conta corrente, para a tela avisar. */
export interface CardLedgerRepairNotice {
	cardId: string;
	/** Compras que foram para o cartão, com os lançamentos. */
	movedCount: number;
	/** Compras que iriam, mas ficaram porque o usuário editou o lançamento à mão. */
	keptCount: number;
}

/**
 * Uma transferência entre contas suas, como o formulário a manda: sem `id` é nova, com `id`
 * é a edição daquela. Um lado nulo é "fora do app" — só aparece ao editar uma transferência
 * que a captura gravou assim; a manual nova tem os dois lados.
 */
export interface TransferInput {
	id?: string;
	fromAccountId: string | null;
	toAccountId: string | null;
	amountCents: number;
	/** `YYYY-MM-DD`. */
	date: string;
	note: string;
}

export interface ExistingInstallmentsInput {
	cardId: string;
	note: string;
	category: string;
	parcelCents: number;
	currentIndex: number;
	totalCount: number;
}

interface AccountsContextType {
	/** Tudo, contas e cartões, inclusive arquivados. */
	accounts: Account[];
	/** Contas (não cartões) ativas, na ordem de exibição. */
	bankAccounts: Account[];
	/** Cartões ativos, na ordem de exibição. */
	creditCards: Account[];
	/** Cartões de débito das contas ativas, os mais usados primeiro. */
	debitCards: DebitCard[];
	/** Só as não arquivadas, contas e cartões — para seletores de lançamento. */
	activeAccounts: Account[];
	/**
	 * Saldo de hoje por conta — nas contas que rendem, já com o rendimento estimado, e em
	 * todas com as compras da caixa de entrada que já contam como provisórias
	 * (`isProvisionalCapture`, a mesma regra do cartão).
	 */
	balances: Map<string, number>;
	/** Quanto do saldo de hoje de cada conta vem de provisórias (com sinal); só as que têm. */
	provisionalBalances: Map<string, number>;
	/** Quanto de "Em caixa" e de "Depois das faturas" vem de provisórias (com sinal). */
	provisionalOverview: { cashCents: number; netCents: number };
	/** A parte do mês selecionado que vem de provisórias. Nula até a primeira carga. */
	provisionalMonth: ProvisionalPart | null;
	/** Rendimento estimado desde a última âncora, por conta que rende (ver utils/yield.ts). */
	accruedYield: Map<string, number>;
	/**
	 * O mesmo rendimento estimado, só dos últimos 12 meses, por conta. É a estimativa que o
	 * "rendeu nos últimos 12 meses" soma ao rendimento lançado — sem ela o indicador
	 * afirmava 0% num investimento que rende.
	 */
	accruedYield12m: Map<string, number>;
	/** A taxa CDI em uso, do Banco Central; nula enquanto nenhuma foi obtida. */
	cdi: CdiRate | null;
	/** Resumo de cada cartão (ativo ou arquivado). */
	cardSummaries: Map<string, CardSummary>;
	/** Somas de todos os cartões ativos. */
	cardsTotals: { toPayCents: number; openInvoicesCents: number; limitAvailableCents: number | null; limitUsedCents: number };
	overview: AccountsOverview;
	/** O mês selecionado, por papel de conta. Nulo até a primeira carga. */
	month: MonthOverview | null;
	unassignedNetCents: number;
	isLoading: boolean;
	refresh: () => Promise<void>;
	/**
	 * Criar um cartão de crédito — ou, em `saveAccount`, mudar o banco, o final ou o tipo
	 * dele — leva para o cartão as compras dele que tinham caído na conta corrente
	 * (`utils/cardLedgerRepair.ts`). O conserto nunca impede salvar.
	 */
	createAccount: (draft: AccountDraft) => Promise<string>;
	saveAccount: (account: AccountEdit) => Promise<void>;
	/** O que o último conserto moveu ou deixou; nulo quando não havia nada. */
	cardLedgerRepair: CardLedgerRepairNotice | null;
	/** A tela já avisou: some o aviso. */
	dismissCardLedgerRepair: () => void;
	/**
	 * Apaga só conta vazia (SPD-144, `isAccountEmpty`); com conteúdo, rejeita com
	 * `AccountInUseError` e nada muda.
	 */
	removeAccount: (id: string) => Promise<void>;
	/** O que está ligado à conta: lançamentos, transferências, capturas, saldo de partida, contas a pagar e dívidas. */
	loadAccountContents: (id: string) => Promise<AccountContents>;
	/** Como encerrar a conta agora sem mexer no patrimônio (`planAccountClose`). */
	planClose: (id: string) => Promise<ClosePlan>;
	/**
	 * Encerra a conta (`archived`). Com saldo, antes uma transferência de hoje leva o saldo
	 * para `counterpartId` (ou traz dele): o patrimônio não muda. Rejeita o plano bloqueado.
	 */
	closeAccount: (id: string, counterpartId: string | null) => Promise<void>;
	/** Reabre uma conta encerrada. */
	reopenAccount: (id: string) => Promise<void>;
	/**
	 * Acerta uma conta com o que o banco mostra: quanto já saiu neste mês e quanto ainda há
	 * na conta. A diferença de gasto entra como lançamento de hoje (aparece no mês e na
	 * barra do envelope); o que sobrar de diferença no saldo é sobra de antes do app e move
	 * só o ponto de partida. Serve para a primeira vez — depois as notificações cobrem.
	 */
	adjustAccountMonth: (id: string, input: { spentCents: number; balanceCents: number }) => Promise<void>;
	/** Gasto do período em cada conta (despesas menos receitas), para preencher o acerto. */
	periodSpentByAccount: Map<string, number>;
	/** Transferências do período: dinheiro trocando de bolso, que a lista de lançamentos mostra. */
	periodTransfers: Transfer[];
	/**
	 * "O banco mostra X na fatura aberta e Y na fechada ainda não paga". As duas ficam
	 * separadas: Y na fatura fechada, X na aberta (`planCardAdjustment`). `null` é "não
	 * informei": aquela fatura fica valendo o que já valia.
	 *
	 * `opening`: é o cadastro do cartão. A aberta vira a âncora sempre que dá, sem lançamento
	 * de ajuste (`planCardOpening`) — como o saldo informado de uma conta.
	 *
	 * `asCharge`: o dono disse que a diferença a mais é juros, IOF, anuidade ou tarifa. O que
	 * passa do que o app mostrava vira encargo do cartão em cada fatura (`splitCardCharges`), e
	 * o resto segue o acerto de sempre. Devolve quanto foi lançado como encargo.
	 */
	adjustCardInvoices: (
		cardId: string,
		openCents: number | null,
		closedCents: number | null,
		options?: { opening?: boolean; asCharge?: boolean }
	) => Promise<number>;
	/**
	 * Juros, IOF, anuidade, multa ou tarifa cobrados no cartão: um lançamento "Encargo do
	 * cartão" na data, que entra na fatura do ciclo dela e não conta como compra.
	 */
	addCardCharge: (cardId: string, kind: CardChargeKind, amountCents: number, date: string) => Promise<void>;
	/**
	 * Pagamento de fatura: transferência da conta (ou de fora) para o cartão. Devolve falso
	 * quando o mesmo pagamento já estava registrado (pela notificação, por exemplo).
	 */
	recordCardPayment: (cardId: string, fromAccountId: string | null, amountCents: number, date: string) => Promise<boolean>;
	/**
	 * Transferência manual entre contas suas (o "+" e a edição em Lançamentos, E2E-28): não
	 * é receita nem despesa, só muda o saldo das duas pontas. Nova para um cartão de crédito
	 * é pagamento de fatura e vai por `recordCardPayment`. Devolve falso quando aquele
	 * pagamento já estava registrado; recusa De igual a Para e valor que não seja positivo.
	 */
	saveTransfer: (input: TransferInput) => Promise<boolean>;
	/** Apaga (com lápide, que o sync leva) uma transferência. */
	removeTransfer: (id: string) => Promise<void>;
	/**
	 * Compra parcelada feita antes do app: cria as parcelas restantes. Devolve quantas. Com a
	 * fatura aberta já informada (`openInvoiceInformed`), a parcela atual já está no valor
	 * dela e não é criada.
	 */
	addExistingInstallments: (input: ExistingInstallmentsInput) => Promise<number>;
	/**
	 * Cartão de débito cadastrado como cartão: leva os lançamentos para a conta de onde o
	 * dinheiro sai de verdade e apaga o cartão. Débito não tem fatura nem limite. O saldo do
	 * cartão e as transferências vão junto: o patrimônio não muda (SPD-152). Com lançamento de
	 * data futura no cartão (parcela por cair), recusa sem mudar nada (`DebitFutureError`).
	 */
	convertCardToDebit: (cardId: string, accountId: string) => Promise<void>;
	/**
	 * Junta duas fichas da mesma conta do banco: tudo vai para `intoId` e a outra sai. Papéis
	 * diferentes, com a que sai não vazia, recusam com `MergeRoleError` (SPD-152).
	 */
	mergeAccounts: (fromId: string, intoId: string) => Promise<void>;
	/**
	 * "Juntamos X em Y": as fichas duplicadas vazias que o app juntou sozinho e que a tela de
	 * Contas ainda não mostrou (SPD-116). Ficam guardadas no aparelho até lá.
	 */
	autoMergeNotices: AutoMergeNotice[];
	/** A tela mostrou: os avisos saem, aqui e no aparelho. */
	dismissAutoMergeNotices: () => void;
	/**
	 * Junta dois cartões de crédito do mesmo cartão do banco (E2E-34): compras, parcelas,
	 * encargos, ajustes e pagamentos vão para `intoId`, que mantém fechamento e limite; a
	 * dívida dos dois soma, e o patrimônio não muda (`mergeCardInto`, SPD-152).
	 */
	mergeCards: (fromId: string, intoId: string) => Promise<void>;
	/** As compras que o app do banco avisa passam a cair nesta conta, e não na outra. */
	takeNotifications: (accountId: string) => Promise<void>;
	/** Os avisos da PJ ("da conta Nu Empresas") passam a cair nesta conta (SPD-074). */
	takeBusinessNotifications: (accountId: string) => Promise<void>;
	/** Dá nome a um cartão (físico, virtual ou de débito) pelo final; nome vazio tira. */
	renameCard: (accountId: string, last4: string, name: string | null) => Promise<void>;
	/** Move todos os lançamentos sem conta para uma conta. Devolve quantos mudaram. */
	assignUnassigned: (accountId: string) => Promise<UnassignedAssignment>;
	/**
	 * Quantos lançamentos sem conta são datados antes ou na âncora desta conta — e portanto
	 * somem do total sem reaparecer no saldo dela. Para a tela avisar **antes** do toque.
	 */
	unassignedBeforeAnchor: (accountId: string) => Promise<number>;
}

const AccountsContext = createContext<AccountsContextType | undefined>(undefined);

/** O que a estimativa de rendimento precisa saber de uma conta que rende. */
interface YieldAccountInput {
	anchorCents: number;
	anchorDate: string;
	flows: YieldFlow[];
	percentOfCdiBp: number;
	/** A data do último rendimento lançado na conta; nula sem nenhum. */
	lastPostedYieldDate: string | null;
}

/** Quantos meses a janela do "rendeu nos últimos 12 meses" cobre, contando o de hoje. */
const YIELD_WINDOW_MONTHS = 12;

/** Nota do lançamento que acerta o saldo de uma conta. */
const BALANCE_ADJUSTMENT_NOTE = 'Ajuste com o saldo do banco';

const byOrder = (a: Account, b: Account) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

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
 * Aplica o conserto de um cartão do jeito da migração v12 (`migrateCardPurchasesToRealCard`):
 * a captura e os lançamentos dela mudam de conta juntos — uma transação por compra, tudo
 * sujo para subir no próximo sync. O plano já tirou o que o usuário editou à mão.
 *
 * Nunca lança: o cartão já está gravado, e um erro aqui só deixa compras onde estavam (as
 * já movidas ficam movidas, cada uma inteira). Nulo quando não havia nada a mover.
 */
const repairCardLedger = async (cardId: string): Promise<CardLedgerRepairNotice | null> => {
	let movedCount = 0;
	let keptCount = 0;
	try {
		const [list, captures, ledger] = await Promise.all([getAccounts(), getAllCaptures(), getTransactions()]);
		const plan = planCardLedgerRepair(cardId, list, captures, ledger);
		keptCount = plan.keptEdited.length;
		for (const move of plan.moves) {
			await runInTransaction(async () => {
				await updateCapture(move.captureId, { accountId: move.toId });
				if (move.transactionIds.length > 0) await reassignCaptureLedger(move.transactionId, move.captureId, move.toId);
			});
			movedCount += 1;
		}
	} catch (error) {
		console.error('Error repairing card ledger:', error);
	}
	return movedCount > 0 || keptCount > 0 ? { cardId, movedCount, keptCount } : null;
};

/**
 * O que está ligado a uma conta, para dizer se ela está vazia (`isEmptyUntouched`). Para no
 * primeiro tipo que achar: a ficha com captura ou lançamento é o caso comum do par, e não
 * precisa ler o resto. Nula se a leitura falhar — na dúvida, a conta não é vazia.
 */
const linksOf = async (accountId: string): Promise<AccountLinks | null> => {
	const links: AccountLinks = { transactions: 0, transfers: 0, captures: 0, bills: 0, debts: 0 };
	try {
		links.transactions = (await getAccountTransactions(accountId)).length;
		if (links.transactions > 0) return links;
		links.transfers = (await getAccountTransfers(accountId)).length;
		if (links.transfers > 0) return links;
		// Viva, de qualquer status: a descartada também diz que o banco avisou algo ali.
		links.captures = (await getAllCaptures()).filter((capture) => capture.accountId === accountId).length;
		if (links.captures > 0) return links;
		links.bills = (await getBills()).filter((bill) => bill.accountId === accountId).length;
		links.debts = (await getDebts()).filter((debt) => debt.accountId === accountId).length;
		return links;
	} catch (error) {
		console.error('Error reading account links:', error);
		return null;
	}
};

export const AccountsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { transactions, categories, refreshData } = useTransactions();
	const { startDate, endDate } = usePeriod();

	const [accounts, setAccounts] = useState<Account[]>([]);
	// Saldo registrado (âncora + movimentos). O exposto soma o rendimento estimado.
	const [rawBalances, setBalances] = useState<Map<string, number>>(new Map());
	const [yieldInputs, setYieldInputs] = useState<Map<string, YieldAccountInput>>(new Map());
	const [cdi, setCdi] = useState<CdiRate | null>(null);
	const [cardSummaries, setCardSummaries] = useState<Map<string, CardSummary>>(new Map());
	const [month, setMonth] = useState<MonthOverview | null>(null);
	const [provisionalMonth, setProvisionalMonth] = useState<ProvisionalPart | null>(null);
	const [provisionalBalances, setProvisionalBalances] = useState<Map<string, number>>(new Map());
	const [unassignedNetCents, setUnassignedNetCents] = useState(0);
	const [periodSpentByAccount, setPeriodSpentByAccount] = useState<Map<string, number>>(new Map());
	const [periodTransfers, setPeriodTransfers] = useState<Transfer[]>([]);
	// Lido dentro do acerto sem virar dependência dele.
	const periodSpentRef = useRef(periodSpentByAccount);
	periodSpentRef.current = periodSpentByAccount;
	const [isLoading, setIsLoading] = useState(true);

	// Cada recarga ganha um número; só a mais recente grava. Uma recarga lenta, começada
	// antes de um pagamento ou de trocar o mês, não sobrescreve a que veio depois.
	const generation = useRef(0);

	const refresh = useCallback(async () => {
		const mine = ++generation.current;
		try {
			const today = todayISO();
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

				const [cardTransactions, cardTransfers] = await Promise.all([
					getAccountTransactions(account.id),
					getAccountTransfers(account.id),
				]);
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

			if (mine !== generation.current) return;
			const nextMonth = buildMonthOverview({ accounts: activity, unassigned: unassignedPeriod });
			setAccounts(list);
			setBalances(nextBalances);
			setProvisionalBalances(nextProvisionalBalances);
			setYieldInputs(nextYieldInputs);
			setCardSummaries(nextSummaries);
			setUnassignedNetCents(unassigned);
			setPeriodTransfers(transfersInPeriod);
			setPeriodSpentByAccount(
				new Map(activity.map((item) => [item.accountId, periodSpentCents(item, item.role)]))
			);
			setMonth(nextMonth);
			setProvisionalMonth(provisionalPart(nextMonth, buildMonthOverview({ accounts: ledgerActivity, unassigned: unassignedPeriod })));
		} catch (error) {
			console.error('Error loading accounts:', error);
		} finally {
			setIsLoading(false);
		}
	}, [startDate, endDate]);

	// O livro-caixa mudou (o TransactionsContext trocou a lista) ou o período mudou.
	useEffect(() => {
		void refresh();
	}, [refresh, transactions]);

	// Voltar ao app recalcula: o dia pode ter virado (fechamento, vencimento) e o sync pode
	// ter trazido pagamentos ou compras de outro aparelho. O CDI também é conferido.
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state !== 'active') return;
			void refresh();
			void refreshCdi().then((next) => next && setCdi(next));
		});
		return () => subscription.remove();
	}, [refresh]);

	// O CDI guardado vale na hora; o do Banco Central chega em seguida, se for mais novo.
	useEffect(() => {
		void loadCachedCdi().then((cached) => cached && setCdi((current) => current ?? cached));
		void refreshCdi().then((next) => next && setCdi(next));
	}, []);

	/** O rendimento estimado de cada conta que rende, até ontem, no CDI em uso. */
	const accruedYield = useMemo(() => {
		const result = new Map<string, number>();
		if (!cdi) return result;
		const today = todayISO();
		for (const [accountId, input] of yieldInputs) {
			result.set(accountId, accruedYieldCents({ ...input, notBefore: input.lastPostedYieldDate, today, cdiAnnualBp: cdi.annualBp }));
		}
		return result;
	}, [yieldInputs, cdi]);

	/**
	 * O mesmo rendimento estimado, recortado nos últimos 12 meses: é o que o indicador
	 * "rendeu nos últimos 12 meses" precisa para não afirmar 0% num CDB de 120% do CDI,
	 * onde o acréscimo é estimado em memória e nada é lançado no livro. O recorte usa a
	 * data mais recente entre o começo da janela e o último rendimento lançado — o livro
	 * responde pelo período que ele cobre, a estimativa só pelo resto.
	 */
	const accruedYield12m = useMemo(() => {
		const result = new Map<string, number>();
		if (!cdi) return result;
		const today = todayISO();
		const windowStart = monthKeyRange(shiftMonthKey(monthKeyOf(today), -(YIELD_WINDOW_MONTHS - 1))).startDate;
		const notBeforeWindow = addDays(windowStart, -1);
		for (const [accountId, input] of yieldInputs) {
			const notBefore = input.lastPostedYieldDate !== null && input.lastPostedYieldDate > notBeforeWindow ? input.lastPostedYieldDate : notBeforeWindow;
			result.set(accountId, accruedYieldCents({ ...input, notBefore, today, cdiAnnualBp: cdi.annualBp }));
		}
		return result;
	}, [yieldInputs, cdi]);

	const balances = useMemo(() => {
		if (accruedYield.size === 0) return rawBalances;
		const next = new Map(rawBalances);
		for (const [accountId, cents] of accruedYield) next.set(accountId, (next.get(accountId) ?? 0) + cents);
		return next;
	}, [rawBalances, accruedYield]);

	const [cardLedgerRepair, setCardLedgerRepair] = useState<CardLedgerRepairNotice | null>(null);
	const dismissCardLedgerRepair = useCallback(() => setCardLedgerRepair(null), []);

	/**
	 * Depois de gravar a conta: se ela é um cartão cujo destino de compras mudou, o conserto
	 * roda e as telas releem. Compra movida muda a conta de lançamentos, então a lista de
	 * lançamentos também relê.
	 */
	const afterAccountSaved = useCallback(
		async (before: Account | null, after: Account) => {
			const notice = changesCardRouting(before, after) ? await repairCardLedger(after.id) : null;
			setCardLedgerRepair(notice);
			syncQueue.schedule();
			await Promise.all([refresh(), notice && notice.movedCount > 0 ? refreshData() : undefined]);
		},
		[refresh, refreshData]
	);

	const createAccount = useCallback(
		async (draft: AccountDraft) => {
			const id = await addAccount(draft);
			await afterAccountSaved(null, { ...normalizeAccountDraft(draft), id, updatedAt: '' });
			return id;
		},
		[afterAccountSaved]
	);

	const saveAccount = useCallback(
		async (account: AccountEdit) => {
			// Como estava, para saber se a edição mexeu no destino das compras. Sem conseguir
			// ler, o conserto não roda — a edição grava do mesmo jeito.
			let before: Account | undefined;
			try {
				before = (await getAccounts()).find((candidate) => candidate.id === account.id);
			} catch (error) {
				console.error('Error reading account before save:', error);
			}
			await updateAccount(account);
			if (before) {
				await afterAccountSaved(before, { ...before, ...normalizeAccountDraft(account), id: account.id });
			} else {
				syncQueue.schedule();
				await refresh();
			}
		},
		[afterAccountSaved, refresh]
	);

	/**
	 * Apaga só conta vazia (SPD-144): com conteúdo, `deleteAccount` recusa com
	 * `AccountInUseError` e nada muda. As contas a pagar e dívidas dela ficam sem conta; as
	 * listas delas estão em providers abaixo deste, e só o aviso as faz reler.
	 */
	const removeAccount = useCallback(
		async (id: string) => {
			await deleteAccount(id);
			syncQueue.schedule();
			emitBillsChanged();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData]
	);

	const loadAccountContents = useCallback((id: string) => getAccountContents(id), []);

	/**
	 * Como encerrar a conta agora sem mexer no patrimônio (`planAccountClose`), lido do banco
	 * na hora: o saldo de hoje como a tela mostra (com as compras provisórias da caixa de
	 * entrada e o rendimento estimado), as compras pendentes dela e o que ela tem com data
	 * depois de hoje.
	 */
	const planClose = useCallback(
		async (id: string): Promise<ClosePlan> => {
			const today = todayISO();
			const [list, ledger, pending, entries, moves] = await Promise.all([
				getAccounts(),
				getAccountBalances(today),
				getPendingCaptures(),
				getAccountTransactions(id),
				getAccountTransfers(id),
			]);
			const live = list.filter((account) => !account.deletedAt);
			const account = live.find((candidate) => candidate.id === id);
			if (!account) throw new Error('Conta não encontrada');
			const shown = withProvisionalBalances(ledger, live, provisionalEntriesByAccount(pending, live), today);
			return planAccountClose({
				account,
				balanceCents: (shown.get(id) ?? 0) + (accruedYield.get(id) ?? 0),
				pendingCaptures: pending.filter((capture) => capture.accountId === id).length,
				futureEntries:
					entries.filter((entry) => entry.date > today).length + moves.filter((move) => move.date > today).length,
			});
		},
		[accruedYield]
	);

	/**
	 * Encerra (`archived`) sem mexer no patrimônio. Com saldo, uma transferência de hoje leva
	 * o saldo para `counterpartId` (ou traz dele, se negativo) antes: o dinheiro muda de conta
	 * e o total fica. O histórico não é tocado. Recusa — sem mudar nada — o plano bloqueado
	 * (cartão devendo, compra a revisar, lançamento futuro) e a transferência sem destino.
	 *
	 * Serve também para acertar o saldo de uma conta que já estava encerrada com saldo.
	 */
	const closeAccount = useCallback(
		async (id: string, counterpartId: string | null) => {
			const plan = await planClose(id);
			if (plan.kind === 'blocked') throw new Error(`Encerrar recusado: ${plan.reason}`);
			const account = await getAccount(id);
			if (!account || account.deletedAt) throw new Error('Conta não encontrada');

			if (plan.kind === 'transfer') {
				const counterpart = counterpartId && counterpartId !== id ? await getAccount(counterpartId) : null;
				if (!counterpart || counterpart.deletedAt) throw new Error('Encerrar com saldo precisa de uma conta de destino');
				const today = todayISO();
				// O rendimento estimado só existe em memória: entra no saldo registrado antes,
				// para a transferência levar o saldo inteiro e a conta ficar zerada.
				const accrued = accruedYield.get(id) ?? 0;
				if (accrued !== 0) {
					const ledger = (await getAccountBalances(today)).get(id) ?? 0;
					await setAccountBalanceToday(id, ledger + accrued);
				}
				await addTransfer({
					fromAccountId: plan.direction === 'out' ? id : counterpart.id,
					toAccountId: plan.direction === 'out' ? counterpart.id : id,
					amountCents: plan.amountCents,
					date: today,
					note: CLOSING_TRANSFER_NOTE,
				});
			}
			if (!account.archived) await updateAccount({ ...account, archived: true });
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[planClose, accruedYield, refresh, refreshData]
	);

	/** Reabre uma conta encerrada: volta às listas, aos seletores e aos totais de hoje. */
	const reopenAccount = useCallback(
		async (id: string) => {
			const account = await getAccount(id);
			if (!account || account.deletedAt || !account.archived) return;
			await updateAccount({ ...account, archived: false });
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData]
	);

	const adjustAccountMonth = useCallback(
		async (id: string, input: { spentCents: number; balanceCents: number }) => {
			const today = todayISO();
			const spentNow = periodSpentRef.current.get(id) ?? 0;
			// O gasto que o app não viu é lançamento de verdade: é ele que mexe na barra.
			const spend = spendingAdjustment(spentNow, input.spentCents);
			if (spend) {
				await addTransaction({
					amountCents: spend.amountCents,
					category: resolveCategoryId(
						spend.isIncome ? 'other_income' : 'other_expense',
						spend.isIncome ? 'in' : 'out',
						categories
					),
					date: today,
					note: BALANCE_ADJUSTMENT_NOTE,
					isIncome: spend.isIncome,
					accountId: id,
				});
			}
			// O que ainda não bate é dinheiro de antes do app (a sobra do mês passado, por
			// exemplo): move o ponto de partida, sem entrar no mês.
			//
			// O saldo comparado é o que a tela mostrou, com as provisórias: sem elas, confirmar o
			// saldo sem mexer movia a âncora e engolia a compra pendente, que então não saía mais
			// ao ser descartada. A nova âncora fica em ontem (`setAccountBalanceToday`): a
			// provisória de hoje continua somando por cima dela, então sai do valor gravado.
			const [ledgerNow, pendingNow, list] = await Promise.all([getAccountBalances(today), getPendingCaptures(), getAccounts()]);
			const target = list.find((account) => account.id === id);
			const pending = target ? pendingNow.flatMap((capture) => provisionalEntries(capture, target)) : [];
			const anchorDate = target?.openingBalanceDate ?? today;
			const balanceNow = (ledgerNow.get(id) ?? 0) + provisionalBalanceCents(pending, anchorDate, today);
			if (balanceNow !== input.balanceCents) {
				await setAccountBalanceToday(id, input.balanceCents - provisionalBalanceCents(pending, addDays(today, -1), today));
			}
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData, categories]
	);

	const adjustCardInvoices = useCallback(
		async (cardId: string, openCents: number | null, closedCents: number | null, options?: { opening?: boolean; asCharge?: boolean }) => {
			const card = (await getAccounts()).find((account) => account.id === cardId);
			if (!card) return 0;
			const [cardTransactions, cardTransfers] = await Promise.all([getAccountTransactions(card.id), getAccountTransfers(card.id)]);
			const entries: CardEntry[] = cardTransactions.map((tx) => ({
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
			// Compras ainda na caixa de entrada já estão na fatura do banco: entram na conta.
			for (const capture of await getPendingCaptures()) entries.push(...provisionalEntries(capture, card));
			const movements: CardMovement[] = cardTransfers.map((transfer) => ({
				amountCents: transfer.amountCents,
				date: transfer.date,
				inbound: transfer.toAccountId === card.id,
			}));

			const today = todayISO();
			// A diferença a mais como encargo: comparada com o que a folha mostrou, que é o mesmo
			// resumo calculado aqui, e o resto vai para o acerto de sempre.
			const split = options?.asCharge
				? splitCardCharges(cardChargeShown(card, buildCardSummary(card, entries, movements, today)), today, openCents, closedCents)
				: { openCents, closedCents, charges: [], totalCents: 0 };
			const plan = (options?.opening ? planCardOpening : planCardAdjustment)(card, entries, movements, today, split.openCents, split.closedCents);
			// Sem a fatura fechada informada não há âncora nova: mexer nela zeraria a fechada
			// que o usuário não falou nada sobre.
			if (plan.anchor) await setAccountAnchor(card.id, plan.anchor.cents, plan.anchor.date);
			if (plan.adjustmentCents !== 0) {
				const isIncome = plan.adjustmentCents < 0;
				await addTransaction({
					amountCents: Math.abs(plan.adjustmentCents),
					category: resolveCategoryId(isIncome ? 'other_income' : 'other_expense', isIncome ? 'in' : 'out', categories),
					date: today,
					note: CARD_ADJUSTMENT_NOTE,
					isIncome,
					accountId: card.id,
				});
			}
			for (const charge of split.charges) {
				await addTransaction({
					amountCents: charge.cents,
					category: resolveCategoryId('other_expense', 'out', categories),
					date: charge.date,
					note: cardChargeNote('bank'),
					isIncome: false,
					accountId: card.id,
				});
			}
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
			return split.totalCents;
		},
		[refresh, refreshData, categories]
	);

	const addCardCharge = useCallback(
		async (cardId: string, kind: CardChargeKind, amountCents: number, date: string) => {
			if (amountCents <= 0) return;
			await addTransaction({
				amountCents,
				// Nasce em "Outras despesas", como o ajuste; os relatórios o tiram de lá e mostram
				// numa linha própria pela nota (`isCardCharge`), seja qual for a categoria.
				category: resolveCategoryId('other_expense', 'out', categories),
				date,
				note: cardChargeNote(kind),
				isIncome: false,
				accountId: cardId,
			});
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData, categories]
	);

	const recordCardPayment = useCallback(
		async (cardId: string, fromAccountId: string | null, amountCents: number, date: string) => {
			// A notificação do banco pode ter registrado este pagamento antes do toque. Casar
			// só por valor e janela de dias, porém, engolia a segunda metade de uma fatura paga
			// em duas parcelas iguais: `isSameCardPayment` exige a mesma conta de origem, o
			// mesmo valor e no máximo um dia de diferença.
			const payments = await getAccountTransfers(cardId);
			const already = payments.some(
				(transfer) =>
					transfer.toAccountId === cardId &&
					isSameCardPayment(
						{ fromAccountId: transfer.fromAccountId, amountCents: transfer.amountCents, date: transfer.date },
						{ fromAccountId, amountCents, date }
					)
			);
			if (already) {
				await refresh();
				return false;
			}
			// Com 0 ou 2+ cartões no banco, o aviso gravou o pagamento com destino em branco: é
			// este mesmo movimento, e criar outro debitaria a conta duas vezes. Completa o destino.
			if (fromAccountId !== null) {
				const open = pickOpenCardPayment(await getAccountTransfers(fromAccountId), { fromAccountId, amountCents, date });
				if (open) {
					await updateTransfer({
						id: open.id,
						fromAccountId: open.fromAccountId,
						toAccountId: cardId,
						amountCents: open.amountCents,
						date: open.date,
						note: open.note,
					});
					syncQueue.schedule();
					await refresh();
					return false;
				}
			}
			await addTransfer({ fromAccountId, toAccountId: cardId, amountCents, date, note: '' });
			syncQueue.schedule();
			await refresh();
			return true;
		},
		[refresh]
	);

	const saveTransfer = useCallback(
		async (input: TransferInput) => {
			const { fromAccountId, toAccountId, amountCents, date } = input;
			if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Transfer amount must be positive');
			if (fromAccountId === toAccountId || (fromAccountId === null && toAccountId === null)) {
				throw new Error('Transfer needs two different accounts');
			}
			const note = input.note.trim();
			if (input.id) {
				// O mesmo `updateTransfer` com que a captura e o pagamento de fatura completam uma
				// transferência: a linha fica suja e a fila de sync a leva.
				await updateTransfer({ id: input.id, fromAccountId, toAccountId, amountCents, date, note });
			} else {
				// Para um cartão é o pagamento de fatura, com a mesma conferência do botão "Pagar
				// fatura" (não lança de novo o que o aviso do banco já registrou). Dois caminhos
				// para o mesmo dinheiro divergiriam na primeira notificação.
				const destination = toAccountId ? await getAccount(toAccountId) : null;
				if (toAccountId && destination?.kind === 'credit_card') {
					return recordCardPayment(toAccountId, fromAccountId, amountCents, date);
				}
				await addTransfer({ fromAccountId, toAccountId, amountCents, date, note });
			}
			syncQueue.schedule();
			await refresh();
			return true;
		},
		[refresh, recordCardPayment]
	);

	const removeTransfer = useCallback(
		async (id: string) => {
			await deleteTransfer(id);
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const addExistingInstallments = useCallback(
		async (input: ExistingInstallmentsInput) => {
			const card = accounts.find((account) => account.id === input.cardId);
			if (!card) return 0;
			const today = todayISO();
			// A parcela atual já está na fatura informada? A mesma pergunta que a prévia da folha
			// faz, com os lançamentos gravados do cartão.
			const ledger: CardEntry[] = (await getAccountTransactions(card.id)).map((tx) => ({
				id: tx.id,
				amountCents: tx.amountCents,
				isIncome: tx.isIncome,
				date: tx.date,
				note: tx.note,
				category: tx.category,
				installmentGroup: tx.installmentGroup,
				installmentIndex: tx.installmentIndex,
				installmentCount: tx.installmentCount,
			}));
			const dates = existingInstallmentDates(
				input.currentIndex,
				input.totalCount,
				cycleRuleOf(card),
				today,
				card.openingBalanceDate,
				openInvoiceInformed(card, ledger, today)
			);
			const group = generateUniqueId();
			for (const { index, date } of dates) {
				await addTransaction({
					amountCents: input.parcelCents,
					category: input.category,
					date,
					note: `${input.note} (${index}/${input.totalCount})`,
					isIncome: false,
					accountId: card.id,
					installmentGroup: group,
					installmentIndex: index,
					installmentCount: input.totalCount,
				});
			}
			if (dates.length > 0) {
				syncQueue.schedule();
				await refreshData();
			}
			return dates.length;
		},
		[accounts, refreshData]
	);

	/**
	 * Duas fichas para a mesma conta do banco — a que o usuário cadastrou e a que a primeira
	 * notificação criou, por exemplo. Lançamentos, capturas e transferências vão para a que
	 * fica, junto com o app e a chave de extrato, para o que vier depois cair lá.
	 *
	 * O total não muda (SPD-073): o saldo da que sai passa para a que fica. Se as duas
	 * contavam o mesmo dinheiro, o total já estava dobrado antes de juntar, e "Acertar com o
	 * banco" corrige; somar em silêncio menos do que havia é que não pode.
	 *
	 * Só do mesmo papel (SPD-152), ou com a que sai vazia: a reserva juntada na corrente
	 * mantinha o total de hoje, mas o "Guardado" de outubro sumia do histórico. Papéis
	 * diferentes com conteúdo recusam com `MergeRoleError`, sem mudar nada.
	 */
	const mergeAccounts = useCallback(
		async (fromId: string, intoId: string) => {
			const from = accounts.find((account) => account.id === fromId);
			const into = accounts.find((account) => account.id === intoId);
			if (!from || !into || fromId === intoId) return;
			// Do mesmo papel nem precisa contar o que a que sai tem.
			const sameRole = from.role === into.role && from.kind !== 'credit_card' && into.kind !== 'credit_card';
			if (!sameRole && !canMergeAccounts(from, into, await getAccountContents(fromId))) throw new MergeRoleError();

			await foldAccountBalance(fromId, intoId);
			await moveAccountLedger(fromId, intoId, from.last4);
			await repointTransfers(fromId, intoId);

			// Os finais vêm junto: os virtuais que a ficha que sai já tinha nomeados, e o
			// plástico dela com o nome dela. Sem isso a próxima notificação daquele final não
			// encontra a conta e cria a duplicata de novo, agora com os lançamentos divididos.
			let cardNames = into.cardNames;
			for (const [last4, name] of Object.entries(parseCardNames(from.cardNames))) {
				cardNames = withCardName(cardNames, last4, name);
			}
			if (from.last4) cardNames = withCardName(cardNames, from.last4, from.name);

			// Uma gravação só: um `updateAccount` depois de `setAccountCardNames` regravaria a
			// coluna com o valor antigo e apagaria o nome que acabou de entrar.
			// A âncora vem do banco, não da cópia de antes: `foldAccountBalance` acabou de mudá-la.
			const anchored = (await getAccount(intoId)) ?? into;
			await updateAccount({
				...into,
				openingBalanceCents: anchored.openingBalanceCents,
				openingBalanceDate: anchored.openingBalanceDate,
				cardNames,
				last4: into.last4 ?? from.last4,
				packageName: into.packageName ?? from.packageName,
				accountKey: into.accountKey ?? from.accountKey,
				envelopeMonthlyCents: into.envelopeMonthlyCents ?? from.envelopeMonthlyCents,
				yieldCdiBp: into.yieldCdiBp ?? from.yieldCdiBp,
			});
			await retireMergedAccount(fromId);
			syncQueue.schedule();
			// As contas a pagar e as dívidas da que saiu vieram junto (SPD-099); as listas delas
			// estão em providers abaixo deste, e só o aviso as faz reler.
			emitBillsChanged();
			await Promise.all([refresh(), refreshData()]);
		},
		[accounts, refresh, refreshData]
	);

	/**
	 * Juntar sozinho a ficha duplicada vazia (SPD-116, DEC-36 Q4).
	 *
	 * Roda aqui porque é onde as contas são carregadas: na abertura, depois de cada escrita,
	 * ao voltar ao app e depois do sync (`useAfterPull`), sempre por `setAccounts`. Do par do
	 * aviso "Duas contas do mesmo banco", a ficha totalmente vazia e nunca editada
	 * (`autoMergeAccounts.ts`) vai para a outra pelo `mergeAccounts` de sempre — sync, lápide,
	 * contas a pagar, tudo como no botão. O par marcado como contas diferentes, o da PJ e os
	 * cartões ficam com o aviso.
	 *
	 * Com o sync no meio, não: uma ficha baixada pode parecer vazia só porque os lançamentos
	 * dela ainda estão numa página por vir (o mesmo cuidado do reparo das contas fantasma). O
	 * fim da rodada relê as contas e isto roda de novo.
	 *
	 * Cada ficha é tentada uma vez por abertura do app: junta, e a ficha sai; se a junção
	 * falhar no meio, o aviso de sempre continua lá para o usuário decidir.
	 */
	const [autoMergeNotices, setAutoMergeNotices] = useState<AutoMergeNotice[]>([]);
	const autoMergeBusy = useRef(false);
	const autoMergeTried = useRef(new Set<string>());

	useEffect(() => {
		void getAutoMergeNotices().then((stored) => {
			if (stored.length > 0) setAutoMergeNotices((current) => (current.length > 0 ? current : stored));
		});
	}, []);

	const dismissAutoMergeNotices = useCallback(() => {
		setAutoMergeNotices([]);
		void clearAutoMergeNotices();
	}, []);

	useEffect(() => {
		if (autoMergeBusy.current) return;
		const candidates = autoMergeCandidates(accounts).filter((account) => !autoMergeTried.current.has(account.id));
		if (candidates.length === 0) return;

		autoMergeBusy.current = true;
		void (async () => {
			try {
				if (syncQueue.getState().status === 'syncing') return;
				const [distinct, feeds, dismissed] = await Promise.all([
					getDistinctAccountPairs(),
					getBusinessFeeds(),
					getDismissedBalanceUnset(),
				]);
				const empty = new Set<string>();
				for (const account of candidates) {
					if (isEmptyUntouched(account, await linksOf(account.id), dismissed.has(account.id))) empty.add(account.id);
				}
				for (const { from, into } of planAutoMerges(accounts, empty, distinct, Object.values(feeds))) {
					autoMergeTried.current.add(from.id);
					await mergeAccounts(from.id, into.id);
					setAutoMergeNotices(await addAutoMergeNotice({ from: from.name, into: into.name }));
					// Diário (SPD-014): a decisão, sem nome nem valor.
					log('app', 'account_auto_merged', { data: { reason: 'empty_duplicate' } });
				}
			} catch (error) {
				console.error('Error auto-merging accounts:', error);
			} finally {
				autoMergeBusy.current = false;
			}
		})();
	}, [accounts, mergeAccounts]);

	/**
	 * Dois cartões para o mesmo cartão do banco — o cadastrado à mão e o que o extrato OFX
	 * criou, por exemplo. Como no `mergeAccounts`, a dívida de um soma na do outro e o
	 * patrimônio não muda (SPD-152). A regra inteira está em `mergeCardInto`.
	 */
	const mergeCards = useCallback(
		async (fromId: string, intoId: string) => {
			await mergeCardInto(fromId, intoId);
			syncQueue.schedule();
			// Como em `mergeAccounts`: contas a pagar e dívidas mudaram de cartão.
			emitBillsChanged();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData]
	);

	/**
	 * Puxa para esta conta as compras que o app do banco avisa.
	 *
	 * Duas contas no mesmo banco (a de todo dia e a do envelope, a PF e a PJ) não dizem
	 * qual é qual numa notificação, e o app escolheu uma. Aqui o usuário corrige: o
	 * vínculo com o app sai de uma e vai para a outra. O que já está lançado fica onde
	 * está — mover histórico é "juntar contas", que é outra decisão.
	 */
	const takeNotifications = useCallback(
		async (accountId: string) => {
			const target = accounts.find((account) => account.id === accountId);
			if (!target) return;
			const owner = feedOwnerOf(accounts, target);
			if (!owner || owner.id === accountId || owner.packageName === null) return;

			await updateAccount({ ...owner, packageName: null });
			await updateAccount({ ...target, packageName: owner.packageName });
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[accounts, refresh, refreshData]
	);

	/**
	 * "Avisos da Nu Empresas entram aqui" (SPD-074). A marca da PJ fica na preferência; se
	 * esta conta era a ligada ao app, o resto dos avisos (os da conta pessoal) passa para a
	 * outra ficha do banco — senão a PF continuaria recebendo nesta conta.
	 */
	const takeBusinessNotifications = useCallback(
		async (accountId: string) => {
			const plan = planBusinessFeed(accounts, accountId);
			const target = accounts.find((account) => account.id === accountId);
			if (!plan || !target) return;

			await setBusinessFeed(plan.packageName, accountId);
			if (plan.moveFeedTo) {
				await updateAccount({ ...target, packageName: null });
				await updateAccount({ ...plan.moveFeedTo, packageName: plan.packageName });
			}
			syncQueue.schedule();
			await refresh();
		},
		[accounts, refresh]
	);

	/**
	 * O "cartão de crédito" que era o débito de uma conta vira o cartão de débito dela: as
	 * compras passam para a conta, e o cartão sai.
	 *
	 * O patrimônio não muda (SPD-152), como em `mergeAccounts`: o saldo do cartão — a dívida —
	 * entra na âncora da conta (`foldAccountBalance`), e as transferências vêm junto
	 * (`repointTransfers`). Antes elas eram apagadas: o pagamento de R$ 800 da Corrente ao
	 * cartão voltava para a Corrente, e a fatura informada sumia — o saldo da conta e o
	 * patrimônio subiam sem aviso. O pagamento da própria conta ao cartão vira transferência da
	 * conta para ela mesma e some (o mesmo dinheiro com duas fichas); o de outra conta continua
	 * saindo dela e passa a entrar nesta. A confirmação mostra o saldo da conta antes e depois.
	 * Só para conta principal (`isDebitTarget`): em reserva ou externa o histórico mudaria.
	 *
	 * Com parcela por cair (lançamento ou transferência do cartão com data depois de hoje),
	 * recusa (`DebitFutureError`) antes de mexer em qualquer coisa: no cartão ela já é dívida;
	 * na conta, só sairia no dia dela — 2 × R$ 250 fariam o patrimônio de hoje subir R$ 500
	 * sem nada ter sido pago. Depois da última, leva normalmente.
	 */
	const convertCardToDebit = useCallback(
		async (cardId: string, accountId: string) => {
			const card = accounts.find((account) => account.id === cardId);
			const checking = accounts.find((account) => account.id === accountId);
			if (!card || !checking || card.kind !== 'credit_card' || !isDebitTarget(checking)) return;
			const today = todayISO();
			const [entries, moves] = await Promise.all([getAccountTransactions(cardId), getAccountTransfers(cardId)]);
			if (entries.some((entry) => entry.date > today) || moves.some((move) => move.date > today)) {
				throw new DebitFutureError();
			}
			// O nome do "cartão" vira o nome do cartão de débito da conta.
			if (card.last4) {
				await setAccountCardNames(checking.id, withCardName(checking.cardNames, card.last4, card.name));
			}
			// Antes de mover: depois o cartão não tem mais saldo para ler.
			await foldAccountBalance(cardId, accountId);
			await moveAccountLedger(cardId, accountId, card.last4);
			await repointTransfers(cardId, accountId);
			await retireMergedAccount(cardId);
			syncQueue.schedule();
			// Como em `mergeAccounts`: contas a pagar e dívidas do cartão foram para a conta.
			emitBillsChanged();
			await Promise.all([refresh(), refreshData()]);
		},
		[accounts, refresh, refreshData]
	);

	const renameCard = useCallback(
		async (accountId: string, last4: string, name: string | null) => {
			const account = accounts.find((candidate) => candidate.id === accountId);
			if (!account) return;
			await setAccountCardNames(accountId, withCardName(account.cardNames, last4, name));
			syncQueue.schedule();
			await refresh();
		},
		[accounts, refresh]
	);

	const assignUnassigned = useCallback(
		async (accountId: string) => {
			const result = await assignUnassignedToAccount(accountId);
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
			return result;
		},
		[refresh, refreshData]
	);

	const unassignedBeforeAnchor = useCallback(
		async (accountId: string) => countUnassignedOnOrBeforeAnchor(accountId),
		[]
	);

	const activeAccounts = useMemo(() => accounts.filter((account) => !account.archived).sort(byOrder), [accounts]);
	const bankAccounts = useMemo(() => activeAccounts.filter((account) => account.kind !== 'credit_card'), [activeAccounts]);
	const creditCards = useMemo(() => activeAccounts.filter((account) => account.kind === 'credit_card'), [activeAccounts]);
	const overview = useMemo(
		() => summarizeAccounts(accounts, balances, unassignedNetCents),
		[accounts, balances, unassignedNetCents]
	);
	// "Em caixa" e "Depois das faturas" sem as provisórias: a diferença é a marca "a revisar".
	const provisionalOverview = useMemo(() => {
		if (provisionalBalances.size === 0) return { cashCents: 0, netCents: 0 };
		const ledgerOnly = new Map(balances);
		for (const [accountId, cents] of provisionalBalances) ledgerOnly.set(accountId, (ledgerOnly.get(accountId) ?? 0) - cents);
		const withoutPending = summarizeAccounts(accounts, ledgerOnly, unassignedNetCents);
		return { cashCents: overview.cashCents - withoutPending.cashCents, netCents: overview.netCents - withoutPending.netCents };
	}, [accounts, balances, provisionalBalances, unassignedNetCents, overview]);

	const debitCards = useMemo<DebitCard[]>(() => {
		const byKey = new Map<string, DebitCard>();
		for (const account of bankAccounts) {
			for (const [last4, name] of Object.entries(parseCardNames(account.cardNames))) {
				byKey.set(`${account.id}:${last4}`, { key: `${account.id}:${last4}`, account, last4, name, periodSpentCents: 0, lastUsed: null });
			}
		}
		const accountById = new Map(bankAccounts.map((account) => [account.id, account]));
		for (const tx of transactions) {
			if (!tx.cardLast4 || !tx.accountId) continue;
			const account = accountById.get(tx.accountId);
			if (!account) continue;
			const key = `${account.id}:${tx.cardLast4}`;
			let card = byKey.get(key);
			if (!card) {
				card = { key, account, last4: tx.cardLast4, name: null, periodSpentCents: 0, lastUsed: null };
				byKey.set(key, card);
			}
			if (tx.date >= startDate && tx.date <= endDate) card.periodSpentCents += tx.isIncome ? -tx.amountCents : tx.amountCents;
			if (!card.lastUsed || tx.date > card.lastUsed) card.lastUsed = tx.date;
		}
		return [...byKey.values()].sort(
			(a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') || a.last4.localeCompare(b.last4)
		);
	}, [bankAccounts, transactions, startDate, endDate]);

	const cardsTotals = useMemo(() => {
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
	}, [creditCards, cardSummaries]);

	const value = useMemo<AccountsContextType>(
		() => ({
			accounts,
			bankAccounts,
			creditCards,
			debitCards,
			activeAccounts,
			balances,
			provisionalBalances,
			provisionalOverview,
			provisionalMonth,
			accruedYield,
			accruedYield12m,
			cdi,
			cardSummaries,
			cardsTotals,
			overview,
			month,
			unassignedNetCents,
			periodSpentByAccount,
			periodTransfers,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			cardLedgerRepair,
			dismissCardLedgerRepair,
			removeAccount,
			loadAccountContents,
			planClose,
			closeAccount,
			reopenAccount,
			adjustAccountMonth,
			adjustCardInvoices,
			addCardCharge,
			recordCardPayment,
			saveTransfer,
			removeTransfer,
			addExistingInstallments,
			convertCardToDebit,
			mergeAccounts,
			autoMergeNotices,
			dismissAutoMergeNotices,
			mergeCards,
			takeNotifications,
			takeBusinessNotifications,
			renameCard,
			assignUnassigned,
			unassignedBeforeAnchor,
		}),
		[
			accounts,
			bankAccounts,
			creditCards,
			debitCards,
			activeAccounts,
			balances,
			provisionalBalances,
			provisionalOverview,
			provisionalMonth,
			accruedYield,
			accruedYield12m,
			cdi,
			cardSummaries,
			cardsTotals,
			overview,
			month,
			unassignedNetCents,
			periodSpentByAccount,
			periodTransfers,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			cardLedgerRepair,
			dismissCardLedgerRepair,
			removeAccount,
			loadAccountContents,
			planClose,
			closeAccount,
			reopenAccount,
			adjustAccountMonth,
			adjustCardInvoices,
			addCardCharge,
			recordCardPayment,
			saveTransfer,
			removeTransfer,
			addExistingInstallments,
			convertCardToDebit,
			mergeAccounts,
			autoMergeNotices,
			dismissAutoMergeNotices,
			mergeCards,
			takeNotifications,
			takeBusinessNotifications,
			renameCard,
			assignUnassigned,
			unassignedBeforeAnchor,
		]
	);

	// Transferências e âncoras de saldo baixadas pelo sync não passam pelos lançamentos.
	useAfterPull(refresh);

	return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
};

export const useAccounts = (): AccountsContextType => {
	const context = useContext(AccountsContext);
	if (!context) throw new Error('useAccounts must be used within an AccountsProvider');
	return context;
};

export default AccountsProvider;
