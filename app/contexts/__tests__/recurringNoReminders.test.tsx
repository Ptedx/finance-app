/**
 * As recorrências antigas não lembram mais nada (SPD-122, DEC-37), e na abertura do app sai o
 * que versões anteriores deixaram (SPD-138).
 *
 * A tela de recorrências saiu no SPD-079 e as regras pararam de lançar `[Auto]` no SPD-113.
 * O contexto das recorrências (`RecurringTransactionsProvider`) só sobrava para reler uma
 * lista que nenhuma tela mostrava e para cancelar, ao abrir, os "X vence amanhã" antigos
 * (`transaction_<id>`). Saiu no SPD-138: o cancelamento agora roda no `_layout` da raiz, uma
 * vez por abertura, e também apaga o canal Android `recurring-transactions`, que nenhum aviso
 * usa. Os lembretes das Contas do mês (`bill:`) e das faturas (`card:`) ficam como estão.
 *
 * Aqui o `_layout` é o de verdade, com os providers e a pilha trocados por dublês que só
 * repassam os filhos. O banco é um dublê; o `notificationUtils` é o de verdade, sobre um
 * `expo-notifications` de mentira que guarda os agendados e os canais.
 */

const mockStorage = new Map<string, string>();
const mockScheduled = new Map<
	string,
	{ content: Record<string, unknown>; trigger: Record<string, unknown> }
>();
const mockChannels = new Set<string>();

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
	setNotificationChannelAsync: jest.fn(async (id: string) => {
		mockChannels.add(id);
		return null;
	}),
	deleteNotificationChannelAsync: jest.fn(async (id: string) => {
		mockChannels.delete(id);
	}),
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

// A lista das regras: ninguém deve mais lê-la na abertura.
jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getRecurringTransactions: jest.fn(async () => []),
}));

jest.mock('../../i18n', () => ({}));
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('expo-font', () => ({ useFonts: () => [true] }));
jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn() }),
	SplashScreen: { preventAutoHideAsync: jest.fn(async () => true), hideAsync: jest.fn(async () => true) },
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: () => undefined }));
jest.mock('../../diagnostics/lifecycle', () => ({ startDiagnostics: () => () => undefined }));
jest.mock('../../utils/onboardingUtils', () => ({ isOnboardingCompleted: jest.fn(async () => true) }));
jest.mock('../../utils/biometricUtils', () => ({
	__esModule: true,
	default: {
		isBiometricAvailable: jest.fn(async () => false),
		isBiometricEnabled: jest.fn(async () => false),
	},
}));
jest.mock('../../components/RootStack', () => () => null);
jest.mock('../../components/BiometricAuthScreen', () => () => null);
jest.mock('../../components/tour/TourProvider', () => ({
	__esModule: true,
	default: ({ children }: { children: React.ReactNode }) => children,
}));
// Os registros das trilhas (SPD-131) leem as contas, que aqui só repassam os filhos.
jest.mock('../../components/tour/TrailRecordsSource', () => () => null);

// Os providers da raiz só repassam os filhos: o que importa é o que o `_layout` faz ao abrir.
jest.mock('../../contexts/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../contexts/SyncContext', () => ({ SyncProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../contexts/LanguageContext', () => ({
	LanguageProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../contexts/CurrencyContext', () => ({
	CurrencyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../contexts/PeriodContext', () => ({ PeriodProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../contexts/BudgetContext', () => ({ BudgetProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../contexts/TransactionsContext', () => ({
	TransactionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../contexts/AccountsContext', () => ({
	AccountsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../contexts/CapturesContext', () => ({
	CapturesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../contexts/DebtsContext', () => ({ DebtsProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../contexts/BillsContext', () => ({ BillsProvider: ({ children }: { children: React.ReactNode }) => children }));

import * as Notifications from 'expo-notifications';
import type React from 'react';
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import RootLayout from '../../_layout';
import { getRecurringTransactions } from '../../database/database';
import type { Bill } from '../../database/schema';
import { buildCardSummary, type CardSettings } from '../../utils/cardMath';
import { scheduleBillReminders, scheduleCardReminders } from '../../utils/notificationUtils';

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

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

/** Abre o app: monta o `_layout` da raiz e espera o arranque (e o cancelamento) terminar. */
const open = async () => {
	await act(async () => {
		renderer = create(<RootLayout />);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
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
	mockChannels.clear();
	jest.clearAllMocks();
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('a abertura não passa mais pelas regras', () => {
	it('abrir o app não lê a lista das recorrências nem agenda lembrete delas', async () => {
		await open();

		expect(getRecurringTransactions).not.toHaveBeenCalled();
		expect(recurringScheduleCalls()).toHaveLength(0);
		expect(ids('transaction_')).toEqual([]);
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

	it('roda uma vez por abertura', async () => {
		await open();

		expect(Notifications.getAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
	});
});

describe('na abertura, sai o canal Android das recorrências', () => {
	it('no Android, o canal recurring-transactions é apagado; o bills fica', async () => {
		mockChannels.add('default');
		mockChannels.add('bills');
		mockChannels.add('recurring-transactions');
		const os = jest.replaceProperty(Platform, 'OS', 'android');
		try {
			await open();
		} finally {
			os.restore();
		}

		expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledWith('recurring-transactions');
		expect(Array.from(mockChannels).sort()).toEqual(['bills', 'default']);
	});

	it('no iOS (sem canais) não tenta apagar nada', async () => {
		const os = jest.replaceProperty(Platform, 'OS', 'ios');
		try {
			await open();
		} finally {
			os.restore();
		}

		expect(Notifications.deleteNotificationChannelAsync).not.toHaveBeenCalled();
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
