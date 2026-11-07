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
	getBills,
	getTransactionsByDateRange,
	initDatabase,
	restoreTransaction,
	updateBill,
} from '../database/database';
import type { Bill, Capture, Category, Transaction, TransactionDraft } from '../database/schema';
import { useAfterPull } from '../hooks/useAfterPull';
import * as syncQueue from '../sync/queue';
import { emitBillsChanged, onBillsChanged } from '../utils/billEvents';
import {
	BILL_MATCH_DAYS_AFTER,
	BILL_MATCH_DAYS_BEFORE,
	type BillMovement,
	matchBillPayment,
} from '../utils/billMatcher';
import { billDueDate, type CardReminderSource } from '../utils/billReminders';
import {
	type BillInput,
	billDraftOf,
	canDeleteBill,
	canToggleActive,
	editedBillDraft,
	type MonthBills,
	markedPaid,
	monthBills,
	newBillDraft,
	type PaidState,
	undonePaid,
} from '../utils/billRules';
import { resolveCategoryId } from '../utils/captureActions';
import { addDays, getISODate, monthKeyOf, todayISO } from '../utils/dateUtils';
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
 * a pagar, com a data de hoje — salvo quando já há um lançamento que casa com a conta no
 * período (`matchBillPayment`, o mesmo casamento da captura) ou o aviso do banco ainda
 * está na caixa de entrada. Ver `billPaymentPlan`.
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
	/** Já há um lançamento que paga a conta no período: a baixa é dele, nada é lançado. */
	| { kind: 'matched'; ref: string }
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
	/** Mês que o "Já paguei" quita, `YYYY-MM`. */
	month: string;
	/** Hoje, `YYYY-MM-DD`: a data do lançamento. */
	today: string;
	/** Despesas do livro na janela do vencimento. */
	ledger: BillMovement[];
	/** Saídas na caixa de entrada (avisos do banco ainda não confirmados). */
	inbox: BillMovement[];
	categories: Category[];
}

/**
 * Decide o que o "Já paguei" faz. Puro: quem lê o banco é o contexto.
 *
 * O casamento é o da baixa automática (`matchBillPayment`), só com esta conta e só no mês
 * que se marca: data de 10 dias antes a 5 depois do vencimento, a conta de pagamento, o
 * valor e o texto. Uma despesa já lançada à mão (ou pela captura) antes de cadastrar a
 * conta, por exemplo, casa e não é lançada de novo.
 */
export const billPaymentPlan = ({ bill, bills, month, today, ledger, inbox, categories }: BillPaymentInput): BillPaymentPlan => {
	const taken = new Set(bills.filter((other) => other.id !== bill.id).map((other) => other.paidByRef));
	const pays = (movement: BillMovement): boolean => matchBillPayment([bill], movement)?.month === month;

	const existing = ledger.find((movement) => !taken.has(movement.id) && pays(movement));
	if (existing) return { kind: 'matched', ref: existing.id };
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

/** O que o "Já paguei" fez: o plano e se a saída foi lançada. */
export type MarkPaidResult = BillPaymentPlan & { posted: boolean };

interface BillsContextType {
	/** Todas as vivas, desativadas inclusive. */
	bills: Bill[];
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
	 * `null` quando a conta não existe.
	 */
	planPayment: (id: string) => Promise<BillPaymentPlan | null>;
	/**
	 * Marca o mês atual como pago e, quando o plano é lançar, lança a saída — salvo
	 * `post: false` ("só marcar"). Devolve o que fez, ou `null` quando a conta não existe.
	 */
	markPaid: (id: string, options?: { post?: boolean }) => Promise<MarkPaidResult | null>;
	/** Volta o mês para em aberto e apaga o lançamento que o "Já paguei" criou (só ele). */
	undoPaid: (id: string) => Promise<void>;
	/** Remarca os lembretes (contas e faturas) com o que há agora (o liga/desliga das notificações). */
	rescheduleReminders: () => Promise<number>;
	refresh: () => Promise<void>;
}

const BillsContext = createContext<BillsContextType | undefined>(undefined);

export const BillsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [bills, setBills] = useState<Bill[]>([]);
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
	// O estado de antes de cada "Já paguei" desta sessão, para o desfazer voltar a ele.
	const beforePaid = useRef(new Map<string, PaidState>());
	// O aviso que nós mesmos damos não precisa recarregar de novo: a ação já recarrega.
	const selfNotifying = useRef(false);

	const refresh = useCallback(async () => {
		try {
			await initDatabase();
			const rows = await getBills();
			billsRef.current = rows;
			setBills(rows);
			setToday(todayISO());
			void scheduleBillReminders(rows).catch((error) =>
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

	/** O plano do "Já paguei" com o banco de agora: o livro na janela do vencimento e a caixa de entrada. */
	const planFor = useCallback(async (bill: Bill, month: string, today: string): Promise<BillPaymentPlan> => {
		const due = billDueDate(bill, month);
		const [transactions, pending] = await Promise.all([
			getTransactionsByDateRange(addDays(due, -BILL_MATCH_DAYS_BEFORE), addDays(due, BILL_MATCH_DAYS_AFTER), 'expense'),
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
		});
	}, []);

	const planPayment = useCallback(
		async (id: string) => {
			const bill = findBill(id);
			if (!bill) return null;
			const today = todayISO();
			return planFor(bill, monthKeyOf(today), today);
		},
		[findBill, planFor]
	);

	const markPaid = useCallback(
		async (id: string, options: { post?: boolean } = {}): Promise<MarkPaidResult | null> => {
			const bill = findBill(id);
			if (!bill) return null;
			const today = todayISO();
			const month = monthKeyOf(today);
			const plan = await planFor(bill, month, today);
			const post = plan.kind === 'post' && options.post !== false;

			beforePaid.current.set(id, { paidThrough: bill.paidThrough, paidByRef: bill.paidByRef });
			await commit(async () => {
				// Lança antes de dar a baixa: a baixa aponta para o lançamento. `restoreTransaction`
				// tira a lápide de um "Já paguei" desfeito no mesmo mês (o id é o mesmo) antes de gravar.
				if (plan.kind === 'post' && post) await restoreTransaction(plan.draft, plan.id);
				const paid = markedPaid(bill, month);
				const paidByRef = plan.kind === 'matched' ? plan.ref : plan.kind === 'post' && post ? plan.id : paid.paidByRef;
				await updateBill(id, { ...billDraftOf(bill), ...paid, paidByRef });
			});
			// O saldo da conta e o gasto do mês passam a contar o lançamento.
			if (post) await refreshDataRef.current();
			return { ...plan, posted: post };
		},
		[commit, findBill, planFor]
	);

	const undoPaid = useCallback(
		async (id: string) => {
			const bill = findBill(id);
			if (!bill) return;
			const month = monthKeyOf(todayISO());
			const previous = beforePaid.current.get(id);
			beforePaid.current.delete(id);
			// Só o lançamento que o "Já paguei" criou (reconhecido pelo id) sai; a baixa que veio de
			// um lançamento que já existia — à mão ou da captura — volta atrás sem apagar nada.
			const created = markPaidTransactionId(bill.id, month);
			const ownPayment = bill.paidByRef === created;
			const undone = undonePaid(bill, month, previous);
			await commit(async () => {
				await updateBill(id, {
					...billDraftOf(bill),
					...undone,
					paidByRef: ownPayment && undone.paidByRef === created ? null : undone.paidByRef,
				});
				// Depois da conta: com a baixa já fora, apagar o lançamento não reabre nada de novo.
				if (ownPayment) await deleteTransaction(created);
			});
			if (ownPayment) await refreshDataRef.current();
		},
		[commit, findBill]
	);

	const rescheduleReminders = useCallback(async () => {
		const billCount = await scheduleBillReminders(billsRef.current);
		const cardCount = await scheduleCardReminders(cardSourcesRef.current);
		return billCount + cardCount;
	}, []);

	const activeBills = useMemo(() => bills.filter((bill) => bill.active), [bills]);
	const month = useMemo(() => monthBills(bills, today), [bills, today]);

	const value = useMemo<BillsContextType>(
		() => ({
			bills,
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
			undoPaid,
			rescheduleReminders,
			refresh,
		}),
		[
			bills,
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
