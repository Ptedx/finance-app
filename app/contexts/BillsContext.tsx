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
import { addBill, deleteBill, getBills, initDatabase, updateBill } from '../database/database';
import type { Bill } from '../database/schema';
import * as syncQueue from '../sync/queue';
import { emitBillsChanged, onBillsChanged } from '../utils/billEvents';
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
import { monthKeyOf, todayISO } from '../utils/dateUtils';
import { scheduleBillReminders } from '../utils/notificationUtils';
import { useSync } from './SyncContext';

/**
 * As contas a pagar: a lista, as contas do mês e as ações da tela.
 *
 * É daqui que saem os lembretes: depois de toda carga e de toda gravação a agenda é
 * remarcada do zero (`scheduleBillReminders`). Recarrega na abertura, quando alguém avisa
 * que as contas mudaram (`onBillsChanged`: a dívida, a baixa automática), quando o app
 * volta ao primeiro plano (o dia pode ter virado) e quando um sync termina (outro aparelho
 * pode ter dado baixa).
 *
 * As regras — mês pago de partida, bloqueio da conta de dívida, total do mês — ficam em
 * `utils/billRules.ts`; aqui só se grava e se avisa.
 */

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
	markPaid: (id: string) => Promise<void>;
	undoPaid: (id: string) => Promise<void>;
	/** Remarca os lembretes com as contas atuais (o liga/desliga das notificações). */
	rescheduleReminders: () => Promise<number>;
	refresh: () => Promise<void>;
}

const BillsContext = createContext<BillsContextType | undefined>(undefined);

export const BillsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [bills, setBills] = useState<Bill[]>([]);
	const [today, setToday] = useState(todayISO);
	const [isLoading, setIsLoading] = useState(true);
	const { lastSyncedAt } = useSync();

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

	const markPaid = useCallback(
		async (id: string) => {
			const bill = findBill(id);
			if (!bill) return;
			beforePaid.current.set(id, { paidThrough: bill.paidThrough, paidByRef: bill.paidByRef });
			await commit(() =>
				updateBill(id, { ...billDraftOf(bill), ...markedPaid(bill, monthKeyOf(todayISO())) })
			);
		},
		[commit, findBill]
	);

	const undoPaid = useCallback(
		async (id: string) => {
			const bill = findBill(id);
			if (!bill) return;
			const previous = beforePaid.current.get(id);
			beforePaid.current.delete(id);
			await commit(() =>
				updateBill(id, {
					...billDraftOf(bill),
					...undonePaid(bill, monthKeyOf(todayISO()), previous),
				})
			);
		},
		[commit, findBill]
	);

	const rescheduleReminders = useCallback(() => scheduleBillReminders(billsRef.current), []);

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
