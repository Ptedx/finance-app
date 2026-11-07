/**
 * Abrir a Início não lança mais as recorrências antigas (SPD-113, AUTO-05/16).
 *
 * A tela de lançamentos recorrentes saiu no SPD-079, mas as regras antigas ficaram no
 * banco e a Início seguia lançando um `[Auto]` a cada vencimento; quando a cobrança de
 * verdade chegava (pela captura ou à mão), o mês ficava com o gasto dobrado. Aqui o banco é
 * o SQLite **de verdade** (`node:sqlite`, como em `accountSql.test.ts`) e o contexto das
 * recorrências é o de verdade: com uma regra vencida há meses, abrir a Início e puxar para
 * atualizar não cria lançamento nenhum, e a regra continua lá como estava (é dado do
 * usuário e segue no sync).
 *
 * Precisa de `NODE_OPTIONS=--experimental-sqlite` no Node 22.12; sem a flag é pulado.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync: (new (path: string) => {
		exec: (sql: string) => void;
		prepare: (sql: string) => {
			run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
			get: (...params: unknown[]) => unknown;
			all: (...params: unknown[]) => unknown[];
		};
	}) | null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value));
	return {
		mockSqliteAvailable: DatabaseSync !== null,
		openDatabaseSync: () => {
			if (!DatabaseSync) return {};
			const raw = new DatabaseSync(':memory:');
			return {
				execAsync: async (sql: string) => {
					raw.exec(sql);
				},
				runAsync: async (sql: string, params: unknown[] = []) => {
					const result = raw.prepare(sql).run(...normalise(params));
					return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...normalise(params)),
				withTransactionAsync: async (body: () => Promise<void>) => {
					raw.exec('BEGIN');
					try {
						await body();
						raw.exec('COMMIT');
					} catch (error) {
						raw.exec('ROLLBACK');
						throw error;
					}
				},
			};
		},
	};
});

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
	multiRemove: jest.fn(async () => undefined),
}));

jest.mock('../../utils/notificationUtils', () => ({
	checkAndScheduleNotifications: jest.fn(async () => undefined),
	cancelTransactionNotification: jest.fn(async () => undefined),
	scheduleTransactionNotification: jest.fn(async () => null),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: () => undefined }));

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// O resto da Início não importa aqui: só o que ela faz com as recorrências ao abrir.
jest.mock('../../components/AccountReminderBanner', () => () => null);
jest.mock('../../components/AccountsOverview', () => () => null);
jest.mock('../../components/bills/BillsMonthCard', () => () => null);
jest.mock('../../components/CaptureReviewBanner', () => () => null);
jest.mock('../../components/cards/CardsSection', () => () => null);
jest.mock('../../components/MonthOverviewCard', () => () => null);

const mockRefresh = jest.fn(async () => undefined);
jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ refreshData: mockRefresh }),
}));
jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ refresh: mockRefresh }),
}));
jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({ refresh: mockRefresh }),
}));
jest.mock('../../contexts/SyncContext', () => ({
	useSync: () => ({ syncNow: jest.fn() }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { RecurringTransactionsProvider } from '../../contexts/RecurringTransactionsContext';
import { addRecurringTransaction, db, initDatabase } from '../../database/database';
import { todayISO } from '../../utils/dateUtils';
import HomeScreen from '../HomeScreen';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('homeNoAutoRecurring.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

jest.setTimeout(20_000);

/** Dia 1 de três meses atrás: a regra mensal teria três ou quatro vencimentos a lançar. */
const threeMonthsAgo = (): string => {
	const [year, month] = todayISO().split('-').map(Number);
	const date = new Date(year, month - 1 - 3, 1);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
};

const settle = () => act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
});

const autoRows = () =>
	db.getAllAsync<{ id: string; note: string }>("SELECT id, note FROM transactions WHERE note LIKE '[Auto]%'");

describeSql('Início com recorrência antiga vencida no banco', () => {
	let renderer: ReactTestRenderer | null = null;
	let ruleId = '';
	let due = '';

	beforeAll(async () => {
		await initDatabase();
		ruleId = await addRecurringTransaction({
			amountCents: 5_500,
			isIncome: false,
			note: 'Netflix',
			category: 'entertainment',
			recurrenceType: 'monthly',
			day: 1,
			active: true,
		});
		// Como uma regra antiga que ninguém mais abre: nunca lançada e vencida há meses.
		due = threeMonthsAgo();
		await db.runAsync('UPDATE recurring_transactions SET nextDue = ?, lastProcessed = NULL WHERE id = ?', [due, ruleId]);
	});

	afterEach(() => {
		act(() => renderer?.unmount());
		renderer = null;
	});

	it('abrir a Início não cria [Auto]', async () => {
		await act(async () => {
			renderer = create(
				<RecurringTransactionsProvider>
					<HomeScreen />
				</RecurringTransactionsProvider>
			);
		});
		await settle();

		expect(await autoRows()).toEqual([]);
	});

	it('puxar para atualizar também não cria [Auto]', async () => {
		await act(async () => {
			renderer = create(
				<RecurringTransactionsProvider>
					<HomeScreen />
				</RecurringTransactionsProvider>
			);
		});
		await settle();

		const scroll = (renderer as ReactTestRenderer).root.findAll(
			(node: ReactTestInstance) => typeof node.props.refreshControl === 'object' && node.props.refreshControl !== null
		)[0];
		await act(async () => {
			await scroll.props.refreshControl.props.onRefresh();
		});
		await settle();

		expect(await autoRows()).toEqual([]);
		expect(mockRefresh).toHaveBeenCalled();
	});

	it('a regra fica no banco como estava: nada apagado, nada avançado', async () => {
		const rule = await db.getFirstAsync<{ nextDue: string | null; lastProcessed: string | null; deletedAt: string | null }>(
			'SELECT nextDue, lastProcessed, deletedAt FROM recurring_transactions WHERE id = ?',
			[ruleId]
		);
		expect(rule).toEqual({ nextDue: due, lastProcessed: null, deletedAt: null });
	});
});
