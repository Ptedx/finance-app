/**
 * As recorrências antigas não lembram mais nada (SPD-122, DEC-37).
 *
 * A tela de recorrências saiu no SPD-079 e as regras pararam de lançar `[Auto]` no SPD-113,
 * mas o contexto seguia agendando "X vence amanhã" para cada regra ativa — ao abrir o app, ao
 * criar e ao editar. Agora ele não agenda, e na abertura cancela o que versões anteriores
 * deixaram agendado (`transaction_<id>`). Os lembretes das Contas do mês (`bill:`) e das
 * faturas (`card:`) ficam como estão.
 *
 * O banco é um dublê (só a lista das regras); o `notificationUtils` é o de verdade, sobre um
 * `expo-notifications` de mentira que guarda os agendados.
 */

const mockStorage = new Map<string, string>();
const mockScheduled = new Map<
	string,
	{ content: Record<string, unknown>; trigger: Record<string, unknown> }
>();
const mockRules: Array<Record<string, unknown>> = [];

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
}));

jest.mock('expo-device', () => ({ isDevice: false }));

jest.mock('expo-notifications', () => ({
	AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
	SchedulableTriggerInputTypes: { DATE: 'date' },
	setNotificationHandler: jest.fn(),
	setNotificationChannelAsync: jest.fn(async () => null),
	getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
	requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
	getExpoPushTokenAsync: jest.fn(async () => ({ data: null })),
	scheduleNotificationAsync: jest.fn(
		async (request: {
			identifier: string;
			content: Record<string, unknown>;
			trigger: Record<string, unknown>;
		}) => {
			mockScheduled.set(request.identifier, { content: request.content, trigger: request.trigger });
			return request.identifier;
		}
	),
	cancelScheduledNotificationAsync: jest.fn(async (identifier: string) => {
		mockScheduled.delete(identifier);
	}),
	cancelAllScheduledNotificationsAsync: jest.fn(async () => {
		mockScheduled.clear();
	}),
	getAllScheduledNotificationsAsync: jest.fn(async () =>
		Array.from(mockScheduled.entries()).map(([identifier, request]) => ({ identifier, ...request }))
	),
}));

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getRecurringTransactions: jest.fn(async () => mockRules.map((rule) => ({ ...rule }))),
}));

jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: () => undefined }));

import * as Notifications from 'expo-notifications';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Bill, RecurringTransaction } from '../../database/schema';
import { buildCardSummary, type CardSettings } from '../../utils/cardMath';
import { getISODate } from '../../utils/dateUtils';
import { scheduleBillReminders, scheduleCardReminders } from '../../utils/notificationUtils';
import { RecurringTransactionsProvider, useRecurringTransactions } from '../RecurringTransactionsContext';

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

const inDays = (days: number): Date => {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + days);
	return date;
};

/** Aluguel de R$ 1.500, ativo, vencendo daqui a 10 dias: antes, virava lembrete na véspera. */
const rule = (overrides: Partial<RecurringTransaction> = {}): RecurringTransaction => ({
	id: 'aluguel',
	amountCents: 150_000,
	isIncome: false,
	note: 'Aluguel',
	category: 'housing',
	recurrenceType: 'monthly',
	day: 10,
	active: true,
	nextDue: getISODate(inDays(10)),
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'internet',
	name: 'Internet',
	dueDay: 10,
	amountCents: 12_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const CARD: CardSettings = {
	closingDay: 10,
	closingDaysBefore: 7,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
};

let renderer: ReactTestRenderer | null = null;
let context: ReturnType<typeof useRecurringTransactions> | null = null;

const Probe = () => {
	context = useRecurringTransactions();
	return null;
};

/** Abre o app: monta o provider e espera a carga (e o cancelamento) terminar. */
const open = async () => {
	await act(async () => {
		renderer = create(
			<RecurringTransactionsProvider>
				<Probe />
			</RecurringTransactionsProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
};

const ids = (prefix: string): string[] => Array.from(mockScheduled.keys()).filter((id) => id.startsWith(prefix));

const recurringScheduleCalls = (): unknown[] =>
	scheduleMock.mock.calls.filter(([request]) => String(request.identifier).startsWith('transaction_'));

beforeEach(() => {
	mockStorage.clear();
	mockScheduled.clear();
	mockRules.length = 0;
	mockRules.push({ ...rule() });
	context = null;
	jest.clearAllMocks();
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('regra ativa não agenda lembrete', () => {
	it('ao abrir o app, com o aluguel ativo vencendo em 10 dias: nada é agendado', async () => {
		await open();

		expect(context?.transactions).toHaveLength(1);
		expect(recurringScheduleCalls()).toHaveLength(0);
		expect(ids('transaction_')).toEqual([]);
	});

	it('o contexto não oferece mais criar, editar nem apagar uma regra (SPD-128)', async () => {
		await open();

		expect(Object.keys(context ?? {}).sort()).toEqual(['refreshTransactions', 'transactions']);
	});
});

describe('na abertura, os lembretes já agendados das regras são cancelados', () => {
	it('sai o transaction_ (e a marca de "já agendado"); ficam o bill: e o card:', async () => {
		mockScheduled.set('transaction_aluguel', { content: { title: 'Aluguel vence amanhã' }, trigger: {} });
		mockScheduled.set('transaction_academia', { content: { title: 'Academia vence amanhã' }, trigger: {} });
		mockScheduled.set('bill:internet:2026-11:soon:3', { content: {}, trigger: {} });
		mockScheduled.set('card:cartao:2026-11:today:0', { content: {}, trigger: {} });
		mockStorage.set('@spendr_scheduled_notifications', JSON.stringify({ 'aluguel:2026-11-17': true }));

		await open();

		expect(ids('transaction_')).toEqual([]);
		expect(ids('bill:')).toEqual(['bill:internet:2026-11:soon:3']);
		expect(ids('card:')).toEqual(['card:cartao:2026-11:today:0']);
		expect(mockStorage.has('@spendr_scheduled_notifications')).toBe(false);
	});

	it('com as notificações desligadas também cancela', async () => {
		mockStorage.set('@spendr_notifications_enabled', 'false');
		mockScheduled.set('transaction_aluguel', { content: {}, trigger: {} });

		await open();

		expect(ids('transaction_')).toEqual([]);
	});
});

describe('Contas do mês e faturas continuam avisando', () => {
	it('depois da abertura, a conta de R$ 120 e a fatura do cartão seguem sendo agendadas', async () => {
		await open();

		const billsNow = new Date(2026, 9, 24, 12, 0);
		expect(await scheduleBillReminders([bill()], billsNow)).toBeGreaterThan(0);
		expect(ids('bill:internet:2026-11:').length).toBeGreaterThan(0);

		const cardsNow = new Date(2026, 10, 7, 10, 0);
		const summary = buildCardSummary(
			CARD,
			[
				{
					id: 'compra',
					amountCents: 30_000,
					isIncome: false,
					date: '2026-11-07',
					note: 'compra',
					category: 'shopping',
					installmentGroup: null,
					installmentIndex: null,
					installmentCount: null,
				},
			],
			[],
			'2026-11-07'
		);
		expect(await scheduleCardReminders([{ cardId: 'cartao', name: 'Cartão Teste', summary }], cardsNow)).toBe(2);
		expect(ids('card:cartao:')).toHaveLength(2);
		expect(ids('transaction_')).toEqual([]);
	});
});
