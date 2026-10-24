/**
 * Agendamento dos lembretes no aparelho.
 *
 * Dois problemas de origem: o usuário nunca recebeu aviso de vencimento de consórcio e
 * financiamento (REM-01 — as contas a pagar não avisavam nada), e o lembrete de recorrente
 * só disparava no primeiro vencimento (REM-02): a marca de "já agendado" era o id da
 * recorrente, para sempre, e o texto saía em inglês.
 *
 * `expo-notifications` é trocado por um mock que guarda os agendados; o AsyncStorage é
 * um mapa em memória. Os textos vêm da i18n de verdade.
 */

const mockStorage = new Map<string, string>();
const mockScheduled = new Map<
	string,
	{ content: Record<string, unknown>; trigger: Record<string, unknown> }
>();

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
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

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Bill, RecurringTransaction } from '../../database/schema';
import i18n from '../../i18n';
import { getISODate } from '../dateUtils';
import { formatCents } from '../money';
import {
	checkAndScheduleNotifications,
	registerForPushNotificationsAsync,
	scheduleBillReminders,
	scheduleTransactionNotification,
	setNotificationsEnabled,
} from '../notificationUtils';

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

const inDays = (days: number): Date => {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + days);
	return date;
};

const recurring = (overrides: Partial<RecurringTransaction> = {}): RecurringTransaction => ({
	id: 'aluguel',
	amountCents: 150_000,
	isIncome: false,
	note: 'Aluguel',
	category: 'housing',
	recurrenceType: 'monthly',
	day: 10,
	active: true,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'consorcio',
	name: 'Consórcio',
	dueDay: 10,
	amountCents: 45_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: 'debt-1',
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

beforeAll(async () => {
	await i18n.changeLanguage('pt');
});

afterAll(async () => {
	await i18n.changeLanguage('en');
});

beforeEach(() => {
	mockStorage.clear();
	mockScheduled.clear();
	jest.clearAllMocks();
});

describe('lembrete de recorrente (REM-02)', () => {
	it('cada vencimento agenda o seu, não só o primeiro', async () => {
		const first = await scheduleTransactionNotification(
			recurring({ nextDue: getISODate(inDays(10)) }),
			inDays(10)
		);
		expect(first).not.toBeNull();

		// A ocorrência foi lançada e a recorrente avançou para o mês seguinte.
		const second = await scheduleTransactionNotification(
			recurring({ nextDue: getISODate(inDays(40)) }),
			inDays(40)
		);
		expect(second).not.toBeNull();

		expect(scheduleMock).toHaveBeenCalledTimes(2);
		const [, secondCall] = scheduleMock.mock.calls;
		const expected = inDays(39);
		expect((secondCall[0].trigger.date as Date).getTime()).toBe(expected.getTime());
	});

	it('o mesmo vencimento não agenda duas vezes', async () => {
		await scheduleTransactionNotification(recurring(), inDays(10));
		await scheduleTransactionNotification(recurring(), inDays(10));
		expect(scheduleMock).toHaveBeenCalledTimes(1);
	});

	it('pela checagem geral: a recorrente que avançou volta a ser lembrada', async () => {
		await checkAndScheduleNotifications([recurring({ nextDue: getISODate(inDays(5)) })]);
		await checkAndScheduleNotifications([recurring({ nextDue: getISODate(inDays(5)) })]);
		await checkAndScheduleNotifications([recurring({ nextDue: getISODate(inDays(25)) })]);
		expect(scheduleMock).toHaveBeenCalledTimes(2);
	});

	it('pela checagem geral, o vencimento é lido como data local (véspera à meia-noite local)', async () => {
		await checkAndScheduleNotifications([recurring({ nextDue: getISODate(inDays(5)) })]);
		const trigger = scheduleMock.mock.calls[0][0].trigger;
		expect((trigger.date as Date).getTime()).toBe(inDays(4).getTime());
	});

	it('o texto vem da i18n, em português', async () => {
		await scheduleTransactionNotification(recurring(), inDays(10));
		const { content } = scheduleMock.mock.calls[0][0];
		expect(content.title).toBe('Vence amanhã');
		expect(content.body).toBe(`Aluguel — ${formatCents(150_000)}`);
	});

	it('receita e recorrente sem descrição também em português', async () => {
		await scheduleTransactionNotification(recurring({ isIncome: true, note: '' }), inDays(10));
		const { content } = scheduleMock.mock.calls[0][0];
		expect(content.title).toBe('Receita amanhã');
		expect(content.body).toBe(`Lançamento recorrente — ${formatCents(150_000)}`);
	});
});

describe('scheduleBillReminders', () => {
	const now = new Date(2026, 9, 24, 12, 0);

	it('agenda os lembretes com identificador estável e o texto certo', async () => {
		const count = await scheduleBillReminders([bill({ dueDay: 10 })], now);
		expect(count).toBe(6); // novembro inteiro (5) + o 'soon' de dezembro

		const ids = Array.from(mockScheduled.keys());
		expect(ids).toEqual([
			'bill:consorcio:2026-11:soon:3',
			'bill:consorcio:2026-11:today:0',
			'bill:consorcio:2026-11:late:1',
			'bill:consorcio:2026-11:late:2',
			'bill:consorcio:2026-11:late:3',
			'bill:consorcio:2026-12:soon:3',
		]);

		const amount = formatCents(45_000);
		const soon = mockScheduled.get('bill:consorcio:2026-11:soon:3');
		expect(soon?.content).toMatchObject({
			title: 'Vence em 3 dias',
			body: `Consórcio — ${amount} no dia 10`,
		});
		const date = soon?.trigger.date as Date;
		expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([
			2026, 10, 7, 9,
		]);

		expect(mockScheduled.get('bill:consorcio:2026-11:today:0')?.content).toMatchObject({
			title: 'Vence hoje',
			body: `Consórcio — ${amount}`,
		});
		expect(mockScheduled.get('bill:consorcio:2026-11:late:2')?.content).toMatchObject({
			title: 'Conta atrasada',
			body: 'Consórcio venceu dia 10. Já pagou? Marque no app.',
		});
	});

	it('valor que varia sai sem valor', async () => {
		await scheduleBillReminders(
			[bill({ id: 'celular', name: 'Celular', dueDay: 10, amountCents: null })],
			now
		);
		expect(mockScheduled.get('bill:celular:2026-11:soon:3')?.content.body).toBe(
			'Celular vence no dia 10'
		);
		expect(mockScheduled.get('bill:celular:2026-11:today:0')?.content.body).toBe(
			'Celular vence hoje'
		);
	});

	it('dia 31 em mês de 30: o texto diz o dia em que vence de fato', async () => {
		await scheduleBillReminders([bill({ dueDay: 31 })], new Date(2026, 10, 20, 12, 0));
		expect(mockScheduled.get('bill:consorcio:2026-11:soon:3')?.content.body).toBe(
			`Consórcio — ${formatCents(45_000)} no dia 30`
		);
	});

	it('remarca do zero: cancela os bill: antigos e não mexe nos outros', async () => {
		mockScheduled.set('bill:velha:2026-10:today:0', { content: {}, trigger: {} });
		mockScheduled.set('transaction_aluguel', { content: {}, trigger: {} });

		await scheduleBillReminders([bill({ dueDay: 10, paidThrough: '2026-12' })], now);

		expect(mockScheduled.has('bill:velha:2026-10:today:0')).toBe(false);
		expect(mockScheduled.has('transaction_aluguel')).toBe(true);
		// Pago até dezembro: nada a avisar nos 45 dias.
		expect(Array.from(mockScheduled.keys()).filter((id) => id.startsWith('bill:'))).toEqual([]);
	});

	it('reagendar duas vezes dá o mesmo conjunto, sem duplicar', async () => {
		await scheduleBillReminders([bill()], now);
		const first = Array.from(mockScheduled.keys()).sort();
		await scheduleBillReminders([bill()], now);
		expect(Array.from(mockScheduled.keys()).sort()).toEqual(first);
	});

	it('com as notificações desligadas não agenda, e tira as que havia', async () => {
		mockScheduled.set('bill:velha:2026-10:today:0', { content: {}, trigger: {} });
		await setNotificationsEnabled(false);

		expect(await scheduleBillReminders([bill()], now)).toBe(0);
		expect(scheduleMock).not.toHaveBeenCalled();
		expect(mockScheduled.size).toBe(0);
	});

	it('no Android usa o canal bills', async () => {
		const os = jest.replaceProperty(Platform, 'OS', 'android');
		try {
			await scheduleBillReminders([bill()], now);
		} finally {
			os.restore();
		}
		expect(scheduleMock.mock.calls[0][0].trigger).toMatchObject({
			type: 'date',
			channelId: 'bills',
		});
	});

	it('textos existem em inglês e italiano', async () => {
		await i18n.changeLanguage('en');
		await scheduleBillReminders([bill({ amountCents: null })], now);
		expect(mockScheduled.get('bill:consorcio:2026-11:late:1')?.content.title).toBe('Overdue bill');

		await i18n.changeLanguage('it');
		await scheduleBillReminders([bill({ amountCents: null })], now);
		expect(mockScheduled.get('bill:consorcio:2026-11:soon:3')?.content.title).toBe(
			'Scade tra 3 giorni'
		);

		await i18n.changeLanguage('pt');
	});
});

describe('canal Android', () => {
	it('registerForPushNotificationsAsync cria o canal bills junto dos outros', async () => {
		const os = jest.replaceProperty(Platform, 'OS', 'android');
		try {
			await registerForPushNotificationsAsync();
		} finally {
			os.restore();
		}

		const channels = (Notifications.setNotificationChannelAsync as jest.Mock).mock.calls.map(
			([id]) => id
		);
		expect(channels).toEqual(
			expect.arrayContaining(['default', 'recurring-transactions', 'bills'])
		);
	});
});

describe('Expo Go (sem expo-notifications)', () => {
	it('scheduleBillReminders não faz nada', async () => {
		// `resetModules`, não `isolateModules`: o mock já carregado no registro principal
		// venceria o `doMock` dentro do isolado. Último teste do arquivo, de propósito.
		jest.resetModules();
		jest.doMock('expo-notifications', () => {
			throw new Error('not available in Expo Go');
		});
		// `require`, não `import()`: o jest daqui roda sem módulos ES nativos.
		const fresh = require('../notificationUtils') as typeof import('../notificationUtils');

		expect(await fresh.scheduleBillReminders([bill()], new Date(2026, 9, 24, 12, 0))).toBe(0);
		expect(await fresh.registerForPushNotificationsAsync()).toBeNull();
		expect(mockScheduled.size).toBe(0);
	});
});
