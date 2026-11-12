import type React from 'react';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { AppState } from 'react-native';
import { getPendingCaptures } from '../database/captures';
import {
	addBill,
	deleteBill,
	deleteTransaction,
	getBillPayments,
	getBills,
	getTransactionsByDateRange,
	initDatabase,
	restoreTransaction,
	saveBillPayments,
	updateBill,
} from '../database/database';
import type {
	Bill,
	BillPayment,
	Capture,
	Category,
	Transaction,
	TransactionDraft,
} from '../database/schema';
import { useAfterPull } from '../hooks/useAfterPull';
import * as syncQueue from '../sync/queue';
import { emitBillsChanged, onBillsChanged } from '../utils/billEvents';
import {
	BILL_MATCH_DAYS_AFTER,
	BILL_MATCH_DAYS_BEFORE,
	type BillMovement,
	paysBillMonth,
} from '../utils/billMatcher';
import { billDueDate, type CardReminderSource } from '../utils/billReminders';
import {
	type BillInput,
	billDraftOf,
	canDeleteBill,
	canToggleActive,
	editedBillDraft,
	isOpenMonth,
	type MonthBills,
	monthBills,
	newBillDraft,
	type PaidState,
	payableMonth,
	settleMonth,
	undoMonth,
} from '../utils/billRules';
import { resolveCategoryId } from '../utils/captureActions';
import { addDays, getISODate, monthKeyOf, shiftMonthKey, todayISO } from '../utils/dateUtils';
import { scheduleBillReminders, scheduleCardReminders } from '../utils/notificationUtils';
import { occurrenceId } from '../utils/recurrence';
import { useAccounts } from './AccountsContext';
import { useSync } from './SyncContext';
import { useTransactions } from './TransactionsContext';

/**
 * As contas a pagar: a lista, as contas do mês e as ações da tela.
 *
 * É daqui que saem os lembretes: depois de toda carga e de toda gravação a agenda é
 * remarcada do zero (`scheduleBillReminders`). Recarrega na abertura, quando alguém avisa
 * que as contas mudaram (`onBillsChanged`: a dívida, a baixa automática), quando o app
 * volta ao primeiro plano (o dia pode ter virado) e quando um sync termina (outro aparelho
 * pode ter dado baixa). Os lembretes da fatura dos cartões (E2E-22) também saem daqui:
 * a cada recarga dos cartões (`useAccounts`, que já recalcula a cada lançamento, pagamento
 * e volta ao app), com o resumo que a tela do cartão mostra (`scheduleCardReminders`).
 *
 * "Já paguei" (E2E-23) lança a saída: o valor, a categoria e a conta de pagamento da conta
 * a pagar, com a data de hoje — salvo quando já há um lançamento que paga a conta no
 * período (`paysBillMonth`, o casamento da captura) ou o aviso do banco ainda está na caixa
 * de entrada. Ver `billPaymentPlan`.
 *
 * Mês atrasado (SPD-145): "Já paguei" quita o mês mais antigo em aberto (`payableMonth`), não
 * o de hoje — com outubro em aberto, quita outubro, e o próximo toque quita novembro. O
 * desfazer reabre o último mês pago, um por vez, e tira o lançamento que o "Já paguei" criou
 * para aquele mês (o id determinístico diz qual é), mesmo depois de reabrir o app.
 *
 * Mês pulado e fora de ordem (SPD-146): "Não vou pagar este mês" (`skipMonth`) registra o mês
 * sem lançamento nenhum; "Já paguei" pode quitar um mês escolhido (`month`) com outro mais
 * antigo em aberto, que continua atrasado. Toda baixa grava o registro do mês com o lançamento
 * (`bill_payments`), e o desfazer reabre o mês escolhido pelo registro dele (`undoMonth`).
 *
 * As regras — mês pago de partida, bloqueio da conta de dívida, total do mês — ficam em
 * `utils/billRules.ts`; aqui só se grava e se avisa.
 */

/**
 * O id do lançamento que o "Já paguei" de uma conta cria num mês `YYYY-MM`: sempre o mesmo,
 * derivado da conta e do mês (`occurrenceId`, formatado como uuid).
 *
 * É ele que liga o lançamento à conta sem coluna nova: a baixa (`paidByRef`) aponta para
 * ele, como na captura, e o desfazer reconhece pelo id que o lançamento foi criado aqui —
 * mesmo depois de reabrir o app, e em outro aparelho — e só então o apaga. Dois aparelhos
 * marcando a mesma conta no mesmo mês geram a mesma linha, e o sync as junta.
 */
export const markPaidTransactionId = (billId: string, month: string): string =>
	occurrenceId(`bill-paid:${billId}`, month);

/** O que o "Já paguei" faz com o dinheiro. */
export type BillPaymentPlan =
	/**
	 * Já há um lançamento que paga a conta no período: a baixa é dele, nada é lançado. O valor
	 * e a data são os dele, para a tela dizer o que achou.
	 */
	| { kind: 'matched'; ref: string; amountCents: number; date: string }
	/** O aviso do banco do pagamento está na caixa de entrada: o lançamento vem dele. */
	| { kind: 'inbox' }
	/** Lançar a saída `draft` com o id `id`. */
	| { kind: 'post'; id: string; draft: TransactionDraft }
	/** Conta de valor variável: não há valor para lançar, só se marca. */
	| { kind: 'none' };

export interface BillPaymentInput {
	bill: Bill;
	/** Todas as contas: o lançamento que já deu baixa em outra não serve para esta. */
	bills: Bill[];
	/** Mês que o "Já paguei" quita, `YYYY-MM`: o mais antigo em aberto. */
	month: string;
	/** Hoje, `YYYY-MM-DD`: a data do lançamento. */
	today: string;
	/** Despesas do livro do começo da janela do vencimento até hoje. */
	ledger: BillMovement[];
	/** Saídas na caixa de entrada (avisos do banco ainda não confirmados). */
	inbox: BillMovement[];
	categories: Category[];
	/** Os meses registrados (SPD-146): o lançamento que já pagou outro mês não serve para este. */
	payments?: readonly BillPayment[];
}

/** Quantos meses para cada lado o "Já paguei" olha os lançamentos que ele mesmo criou para outros meses. */
const OWN_PAYMENT_MONTHS_AROUND = 6;

/**
 * Decide o que o "Já paguei" faz. Puro: quem lê o banco é o contexto.
 *
 * Antes de lançar, procura o pagamento que já exista para o mês (SPD-145: sem isso, o
 * pagamento de outubro feito em 20/10 sem baixa era lançado de novo em novembro):
 *  - o lançamento que o "Já paguei" cria para este mês (`markPaidTransactionId`) — outro
 *    aparelho pode já tê-lo lançado;
 *  - uma despesa que paga a conta neste mês (`paysBillMonth`): do vencimento − 10 dias até
 *    hoje, a conta de pagamento, o valor e o texto. Num mês atrasado vale também só o valor
 *    exato, porque quem diz que pagou é o usuário.
 * Não serve o lançamento que já deu baixa em outra conta, a última baixa desta (já quitou o
 * mês anterior), o que o "Já paguei" criou para outro mês dela nem o que já é o pagamento
 * registrado de outro mês (`payments`, SPD-146).
 */
export const billPaymentPlan = ({
	bill,
	bills,
	month,
	today,
	ledger,
	inbox,
	categories,
	payments = [],
}: BillPaymentInput): BillPaymentPlan => {
	const own = markPaidTransactionId(bill.id, month);
	const taken = new Set<string | null>(
		bills.filter((other) => other.id !== bill.id).map((other) => other.paidByRef)
	);
	for (const payment of payments) {
		if (payment.deletedAt || (payment.billId === bill.id && payment.month === month)) continue;
		taken.add(payment.transactionId);
	}
	const otherMonths = new Set<string>();
	for (let delta = -OWN_PAYMENT_MONTHS_AROUND; delta <= OWN_PAYMENT_MONTHS_AROUND; delta += 1) {
		if (delta !== 0) otherMonths.add(markPaidTransactionId(bill.id, shiftMonthKey(month, delta)));
	}
	const pays = (movement: BillMovement): boolean => paysBillMonth(bill, movement, month, { lateByAmount: true });
	const usable = (movement: BillMovement): boolean =>
		movement.id === own ||
		(!taken.has(movement.id) && movement.id !== bill.paidByRef && !otherMonths.has(movement.id) && pays(movement));

	const existing = ledger.find((movement) => movement.id === own) ?? ledger.find(usable);
	if (existing) {
		return { kind: 'matched', ref: existing.id, amountCents: Math.abs(existing.amountCents), date: existing.date };
	}
	if (inbox.some(pays)) return { kind: 'inbox' };
	if (bill.amountCents === null || bill.amountCents <= 0) return { kind: 'none' };

	return {
		kind: 'post',
		id: markPaidTransactionId(bill.id, month),
		draft: {
			amountCents: bill.amountCents,
			category: resolveCategoryId(bill.category, 'out', categories),
			date: today,
			note: bill.name,
			isIncome: false,
			accountId: bill.accountId,
		},
	};
};

/** Despesa do livro, como o casador lê. Parcela não paga conta (a regra da baixa automática). */
const ledgerMovement = (tx: Transaction): BillMovement | null =>
	tx.isIncome || (tx.installmentCount ?? 1) > 1
		? null
		: { id: tx.id, amountCents: tx.amountCents, date: tx.date, accountId: tx.accountId, text: tx.note, isExpense: true };

/** Saída avisada pelo banco, ainda na caixa de entrada. */
const inboxMovement = (capture: Capture): BillMovement | null =>
	capture.direction !== 'out' || (capture.installments ?? 1) > 1
		? null
		: {
				id: capture.id,
				amountCents: capture.amountCents,
				date: getISODate(new Date(capture.postedAt)),
				accountId: capture.accountId,
				text: capture.counterparty ?? capture.appLabel,
				isExpense: true,
			};

/** O que o "Já paguei" fez: o plano, se a saída foi lançada e o mês quitado (`YYYY-MM`). */
export type MarkPaidResult = BillPaymentPlan & { posted: boolean; month: string };

/** O "Já paguei" de antes guardado nesta sessão: o estado de antes e o mês que ele quitou. */
interface PaidMemory {
	previous: PaidState;
	month: string;
}

interface BillsContextType {
	/** Todas as vivas, desativadas inclusive. */
	bills: Bill[];
	/** Os meses registrados vivos (SPD-146): pulados, pagos fora de ordem e as baixas. */
	payments: BillPayment[];
	/** Só as que avisam e entram no mês. */
	activeBills: Bill[];
	/** As contas do mês corrente, com status e o total que ainda falta pagar. */
	month: MonthBills;
	/** Hoje, `YYYY-MM-DD`, renovado a cada carga. */
	today: string;
	isLoading: boolean;
	/** `currentMonthPaid`: a resposta a "este mês já está pago?" (falso quando não se perguntou). */
	createBill: (input: BillInput, currentMonthPaid: boolean) => Promise<string>;
	/** Na conta de dívida, nome, dia, valor e conta continuam os da dívida. */
	saveBill: (id: string, input: BillInput) => Promise<void>;
	/** Só a cadastrada à mão; na de dívida não faz nada. */
	setBillActive: (id: string, active: boolean) => Promise<void>;
	/** `false` quando a conta é de uma dívida viva e não pode ser apagada. */
	removeBill: (id: string) => Promise<boolean>;
	/**
	 * O que o "Já paguei" faria agora (sem gravar): a tela pergunta antes de lançar.
	 * `null` quando a conta não existe ou não tem mês em aberto até o atual. Com `month`, o
	 * plano daquele mês (fora de ordem), `null` se ele não estiver em aberto.
	 */
	planPayment: (id: string, month?: string) => Promise<BillPaymentPlan | null>;
	/**
	 * Marca como pago o mês mais antigo em aberto (`payableMonth`; com outubro em aberto, é
	 * outubro) — ou `month`, fora de ordem: o mais antigo continua atrasado — e, quando o plano
	 * é lançar, lança a saída — salvo `post: false` ("só marcar"). Grava o registro do mês com
	 * o lançamento. Devolve o que fez, ou `null` quando a conta não existe ou o mês não está em
	 * aberto.
	 */
	markPaid: (
		id: string,
		options?: { post?: boolean; month?: string }
	) => Promise<MarkPaidResult | null>;
	/**
	 * "Não vou pagar este mês" (SPD-146): registra o mês (`month`, ou o mais antigo em aberto)
	 * como pulado, sem lançamento nem mudança de saldo. Devolve o mês pulado, ou `null` quando
	 * a conta não existe ou o mês não está em aberto.
	 */
	skipMonth: (id: string, month?: string) => Promise<string | null>;
	/**
	 * Volta o mês `month` (por padrão, o último pago) para em aberto — só ele — e apaga o
	 * lançamento que o "Já paguei" criou para esse mês (só ele).
	 */
	undoPaid: (id: string, month?: string) => Promise<void>;
	/** Remarca os lembretes (contas e faturas) com o que há agora (o liga/desliga das notificações). */
	rescheduleReminders: () => Promise<number>;
	refresh: () => Promise<void>;
}

const BillsContext = createContext<BillsContextType | undefined>(undefined);

export const BillsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [bills, setBills] = useState<Bill[]>([]);
	const [payments, setPayments] = useState<BillPayment[]>([]);
	const [today, setToday] = useState(todayISO);
	const [isLoading, setIsLoading] = useState(true);
	const { lastSyncedAt } = useSync();
	const { creditCards, cardSummaries, isLoading: accountsLoading } = useAccounts();
	const { categories, refreshData } = useTransactions();

	// Lidos dentro das ações sem virar dependência delas (`refreshData` é novo a cada render).
	const categoriesRef = useRef(categories);
	categoriesRef.current = categories;
	const refreshDataRef = useRef(refreshData);
	refreshDataRef.current = refreshData;

	// Os cartões ativos com o resumo de cada um: é o que os lembretes de fatura leem.
	const cardSources = useMemo<CardReminderSource[]>(
		() =>
			creditCards.flatMap((card) => {
				const summary = cardSummaries.get(card.id);
				return summary ? [{ cardId: card.id, name: card.name, summary }] : [];
			}),
		[creditCards, cardSummaries]
	);
	const cardSourcesRef = useRef(cardSources);
	cardSourcesRef.current = cardSources;

	// A lista mais recente, para as ações não lerem uma versão velha entre duas cargas.
	const billsRef = useRef<Bill[]>([]);
	const paymentsRef = useRef<BillPayment[]>([]);
	// O estado de antes de cada "Já paguei" desta sessão, para o desfazer voltar a ele — só
	// enquanto o mês que ele quitou ainda for o último pago (outra baixa depois o invalida).
	const beforePaid = useRef(new Map<string, PaidMemory>());
	// O aviso que nós mesmos damos não precisa recarregar de novo: a ação já recarrega.
	const selfNotifying = useRef(false);

	const refresh = useCallback(async () => {
		try {
			await initDatabase();
			const [rows, months] = await Promise.all([getBills(), getBillPayments()]);
			billsRef.current = rows;
			paymentsRef.current = months;
			setBills(rows);
			setPayments(months);
			setToday(todayISO());
			void scheduleBillReminders(rows, new Date(), months).catch((error) =>
				console.error('Error scheduling bill reminders:', error)
			);
		} catch (error) {
			console.error('Error loading bills:', error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	// `lastSyncedAt` é o gatilho: muda a cada sync terminado.
	// biome-ignore lint/correctness/useExhaustiveDependencies: lastSyncedAt só dispara a recarga
	useEffect(() => {
		void refresh();
	}, [refresh, lastSyncedAt]);

	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') void refresh();
		});
		return () => subscription.remove();
	}, [refresh]);

	useEffect(
		() =>
			onBillsChanged(() => {
				if (!selfNotifying.current) void refresh();
			}),
		[refresh]
	);

	// Faturas novas (lançamento, pagamento, o dia que virou): remarca os avisos delas. Não
	// enquanto as contas carregam — a lista ainda vazia cancelaria todos. As mesmas faturas
	// de novo não remarcam nada (`scheduleCardReminders` compara com o último agendamento).
	useEffect(() => {
		if (accountsLoading) return;
		void scheduleCardReminders(cardSources).catch((error) =>
			console.error('Error scheduling card reminders:', error)
		);
	}, [cardSources, accountsLoading]);

	// O banco mudou por fora — "Apagar todos os dados", importar um backup, "puxar da
	// conta" no login: a lista e os lembretes seguem o que ficou.
	useAfterPull(refresh);

	/** Grava, sobe no sync, avisa os outros e recarrega (o que remarca os lembretes). */
	const commit = useCallback(
		async <T,>(write: () => Promise<T>): Promise<T> => {
			const result = await write();
			syncQueue.schedule();
			selfNotifying.current = true;
			try {
				emitBillsChanged();
			} finally {
				selfNotifying.current = false;
			}
			await refresh();
			return result;
		},
		[refresh]
	);

	const findBill = useCallback(
		(id: string): Bill | undefined => billsRef.current.find((bill) => bill.id === id),
		[]
	);

	const createBill = useCallback(
		(input: BillInput, currentMonthPaid: boolean) =>
			commit(() =>
				addBill(newBillDraft(input, todayISO(), currentMonthPaid, billsRef.current.length))
			),
		[commit]
	);

	const saveBill = useCallback(
		async (id: string, input: BillInput) => {
			const bill = findBill(id);
			if (!bill) return;
			await commit(() => updateBill(id, editedBillDraft(bill, input)));
		},
		[commit, findBill]
	);

	const setBillActive = useCallback(
		async (id: string, active: boolean) => {
			const bill = findBill(id);
			if (!bill || !canToggleActive(bill) || bill.active === active) return;
			await commit(() => updateBill(id, { ...billDraftOf(bill), active }));
		},
		[commit, findBill]
	);

	const removeBill = useCallback(
		async (id: string) => {
			const bill = findBill(id);
			if (!bill || !canDeleteBill(bill)) return false;
			await commit(() => deleteBill(id));
			beforePaid.current.delete(id);
			return true;
		},
		[commit, findBill]
	);

	/**
	 * O plano do "Já paguei" com o banco de agora: o livro do começo do mês (ou da janela do
	 * vencimento, o que vier antes) até hoje — num mês atrasado o pagamento pode ter sido
	 * feito bem depois do vencimento — e a caixa de entrada.
	 */
	const planFor = useCallback(async (bill: Bill, month: string, today: string): Promise<BillPaymentPlan> => {
		const due = billDueDate(bill, month);
		const windowStart = addDays(due, -BILL_MATCH_DAYS_BEFORE);
		const monthStart = `${month}-01`;
		const windowEnd = addDays(due, BILL_MATCH_DAYS_AFTER);
		const [transactions, pending] = await Promise.all([
			getTransactionsByDateRange(
				monthStart < windowStart ? monthStart : windowStart,
				today > windowEnd ? today : windowEnd,
				'expense'
			),
			getPendingCaptures(),
		]);
		return billPaymentPlan({
			bill,
			bills: billsRef.current,
			month,
			today,
			ledger: transactions.flatMap((tx) => ledgerMovement(tx) ?? []),
			inbox: pending.flatMap((capture) => inboxMovement(capture) ?? []),
			categories: categoriesRef.current,
			payments: paymentsRef.current,
		});
	}, []);

	/**
	 * O mês que a ação quita ou pula: `month`, se estiver em aberto, ou o mais antigo em aberto
	 * (`payableMonth`; com outubro em aberto, é outubro, mesmo em novembro). `null` sem nenhum.
	 */
	const targetMonth = useCallback((bill: Bill, current: string, month?: string): string | null => {
		if (month === undefined) return payableMonth(bill, current, paymentsRef.current);
		return isOpenMonth(bill, month, current, paymentsRef.current) ? month : null;
	}, []);

	const planPayment = useCallback(
		async (id: string, chosen?: string) => {
			const bill = findBill(id);
			if (!bill) return null;
			const today = todayISO();
			const month = targetMonth(bill, monthKeyOf(today), chosen);
			if (!month) return null;
			return planFor(bill, month, today);
		},
		[findBill, planFor, targetMonth]
	);

	const markPaid = useCallback(
		async (
			id: string,
			options: { post?: boolean; month?: string } = {}
		): Promise<MarkPaidResult | null> => {
			const bill = findBill(id);
			if (!bill) return null;
			const today = todayISO();
			const current = monthKeyOf(today);
			const month = targetMonth(bill, current, options.month);
			if (!month) return null;
			const plan = await planFor(bill, month, today);
			const post = plan.kind === 'post' && options.post !== false;
			const transactionId =
				plan.kind === 'matched' ? plan.ref : plan.kind === 'post' && post ? plan.id : null;
			const amountCents =
				plan.kind === 'matched'
					? plan.amountCents
					: plan.kind === 'post' && post
						? plan.draft.amountCents
						: null;
			const settled = settleMonth(bill, paymentsRef.current, month, current, {
				status: 'paid',
				transactionId,
				amountCents,
			});

			beforePaid.current.set(id, { previous: { paidThrough: bill.paidThrough, paidByRef: bill.paidByRef }, month });
			await commit(async () => {
				// Lança antes de dar a baixa: a baixa aponta para o lançamento. `restoreTransaction`
				// tira a lápide de um "Já paguei" desfeito no mesmo mês (o id é o mesmo) antes de gravar.
				if (plan.kind === 'post' && post) await restoreTransaction(plan.draft, plan.id);
				await saveBillPayments([settled.record]);
				await updateBill(id, {
					...billDraftOf(bill),
					paidThrough: settled.paidThrough,
					paidByRef: transactionId ?? bill.paidByRef,
				});
			});
			// O saldo da conta e o gasto do mês passam a contar o lançamento.
			if (post) await refreshDataRef.current();
			return { ...plan, posted: post, month };
		},
		[commit, findBill, planFor, targetMonth]
	);

	const skipMonth = useCallback(
		async (id: string, chosen?: string): Promise<string | null> => {
			const bill = findBill(id);
			if (!bill) return null;
			const current = monthKeyOf(todayISO());
			const month = targetMonth(bill, current, chosen);
			if (!month) return null;
			const settled = settleMonth(bill, paymentsRef.current, month, current, { status: 'skipped' });

			beforePaid.current.set(id, {
				previous: { paidThrough: bill.paidThrough, paidByRef: bill.paidByRef },
				month,
			});
			// Nenhum lançamento: o mês sai do que falta pagar e do atraso, e o saldo não muda.
			await commit(async () => {
				await saveBillPayments([settled.record]);
				if (settled.paidThrough !== bill.paidThrough) {
					await updateBill(id, { ...billDraftOf(bill), paidThrough: settled.paidThrough });
				}
			});
			return month;
		},
		[commit, findBill, targetMonth]
	);

	/**
	 * O lançamento que o "Já paguei" criou para `month` ainda está no livro? Ele tem a data do
	 * dia em que se marcou, que nunca é antes do próprio mês nem depois de hoje.
	 */
	const hasOwnPayment = useCallback(async (id: string, month: string, today: string): Promise<boolean> => {
		const start = `${month}-01`;
		if (start > today) return false;
		const transactions = await getTransactionsByDateRange(start, today, 'expense');
		return transactions.some((tx) => tx.id === id);
	}, []);

	const undoPaid = useCallback(
		async (id: string, chosen?: string) => {
			const bill = findBill(id);
			if (!bill) return;
			// Reabre o mês escolhido ou, sem escolha, o último pago — só ele: nunca "o mês atual − 1",
			// que deixaria pago um mês que ninguém pagou.
			const month = chosen ?? bill.paidThrough;
			if (!month) return;
			const memory = beforePaid.current.get(id);
			const previous = memory?.month === month ? memory.previous : undefined;
			const reopened = undoMonth(bill, paymentsRef.current, month, previous);
			if (!reopened) return;
			beforePaid.current.delete(id);
			// Só o lançamento que o "Já paguei" criou para este mês (reconhecido pelo id) sai — esteja
			// a baixa nele ou não (o mês seguinte pode ter sido quitado e desfeito depois). A baixa que
			// veio de um lançamento que já existia — à mão ou da captura — volta atrás sem apagar nada.
			const created = markPaidTransactionId(bill.id, month);
			const ownRef = bill.paidByRef === created;
			const ownPayment =
				ownRef ||
				reopened.remove?.transactionId === created ||
				(await hasOwnPayment(created, month, todayISO()));
			const paidByRef = previous ? previous.paidByRef : bill.paidByRef;
			await commit(async () => {
				await saveBillPayments(reopened.fill, reopened.remove ? [reopened.remove.id] : []);
				await updateBill(id, {
					...billDraftOf(bill),
					paidThrough: reopened.paidThrough,
					paidByRef: paidByRef === created ? null : paidByRef,
				});
				// Depois da conta: com a baixa já fora, apagar o lançamento não reabre nada de novo.
				if (ownPayment) await deleteTransaction(created);
			});
			if (ownPayment) await refreshDataRef.current();
		},
		[commit, findBill, hasOwnPayment]
	);

	const rescheduleReminders = useCallback(async () => {
		const billCount = await scheduleBillReminders(
			billsRef.current,
			new Date(),
			paymentsRef.current
		);
		const cardCount = await scheduleCardReminders(cardSourcesRef.current);
		return billCount + cardCount;
	}, []);

	const activeBills = useMemo(() => bills.filter((bill) => bill.active), [bills]);
	const month = useMemo(() => monthBills(bills, today, payments), [bills, today, payments]);

	const value = useMemo<BillsContextType>(
		() => ({
			bills,
			payments,
			activeBills,
			month,
			today,
			isLoading,
			createBill,
			saveBill,
			setBillActive,
			removeBill,
			planPayment,
			markPaid,
			skipMonth,
			undoPaid,
			rescheduleReminders,
			refresh,
		}),
		[
			bills,
			payments,
			activeBills,
			month,
			today,
			isLoading,
			createBill,
			saveBill,
			setBillActive,
			removeBill,
			planPayment,
			markPaid,
			skipMonth,
			undoPaid,
			rescheduleReminders,
			refresh,
		]
	);

	return <BillsContext.Provider value={value}>{children}</BillsContext.Provider>;
};

export const useBills = (): BillsContextType => {
	const context = useContext(BillsContext);
	if (!context) throw new Error('useBills must be used within a BillsProvider');
	return context;
};

export default BillsContext;
