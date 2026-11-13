/**
 * Agendamento dos lembretes no aparelho.
 *
 * Dois problemas de origem: o usuário nunca recebeu aviso de vencimento de consórcio e
 * financiamento (REM-01 — as contas a pagar não avisavam nada), e o lembrete de recorrente
 * só disparava no primeiro vencimento (REM-02). Desde o SPD-122 as recorrências antigas não
 * lembram mais nada: o que sobra delas é cancelar o que versões anteriores agendaram.
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
	deleteNotificationChannelAsync: jest.fn(async () => undefined),
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
import type { Bill } from '../../database/schema';
import i18n from '../../i18n';
import type { CardReminderSource } from '../billReminders';
import { buildCardSummary, type CardEntry, type CardSettings } from '../cardMath';
import { formatCents } from '../money';
import * as notificationUtils from '../notificationUtils';
import {
	cancelRecurringReminders,
	clearScheduledNotifications,
	registerForPushNotificationsAsync,
	scheduleBillReminders,
	scheduleCardReminders,
	setNotificationsEnabled,
} from '../notificationUtils';

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

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

describe('lembretes das recorrências antigas (SPD-122)', () => {
	// O que versões anteriores agendavam para cada regra: `transaction_<id>`, na véspera.
	const seedOld = () => {
		mockScheduled.set('transaction_aluguel', { content: { title: 'Vence amanhã' }, trigger: {} });
		mockScheduled.set('transaction_salario', { content: { title: 'Receita amanhã' }, trigger: {} });
		mockStorage.set('@spendr_scheduled_notifications', JSON.stringify({ 'aluguel:2026-11-10': true, salario: true }));
	};

	it('cancela os transaction_ e esquece as marcas; os bill: ficam', async () => {
		seedOld();
		await scheduleBillReminders([bill()], new Date(2026, 9, 24, 12, 0));
		const bills = Array.from(mockScheduled.keys()).filter((id) => id.startsWith('bill:'));
		expect(bills.length).toBeGreaterThan(0);

		expect(await cancelRecurringReminders()).toBe(2);

		expect(Array.from(mockScheduled.keys()).filter((id) => id.startsWith('transaction_'))).toEqual([]);
		expect(Array.from(mockScheduled.keys()).filter((id) => id.startsWith('bill:'))).toEqual(bills);
		expect(mockStorage.has('@spendr_scheduled_notifications')).toBe(false);
	});

	it('sem nada das recorrências agendado, não cancela nada', async () => {
		await scheduleBillReminders([bill()], new Date(2026, 9, 24, 12, 0));
		const before = mockScheduled.size;

		expect(await cancelRecurringReminders()).toBe(0);
		expect(mockScheduled.size).toBe(before);
		expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
	});

	it('o módulo não oferece mais como agendar um lembrete de recorrência', () => {
		const exported = Object.keys(notificationUtils);
		expect(exported).not.toContain('scheduleTransactionNotification');
		expect(exported).not.toContain('checkAndScheduleNotifications');
	});

	// O canal que versões anteriores criavam para eles (SPD-138): nenhum aviso usa mais.
	it('no Android, apaga o canal recurring-transactions, mesmo sem lembrete agendado', async () => {
		const os = jest.replaceProperty(Platform, 'OS', 'android');
		try {
			expect(await cancelRecurringReminders()).toBe(0);
		} finally {
			os.restore();
		}

		expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledTimes(1);
		expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledWith('recurring-transactions');
	});

	it('se apagar o canal falha, os lembretes antigos saem do mesmo jeito', async () => {
		seedOld();
		(Notifications.deleteNotificationChannelAsync as jest.Mock).mockRejectedValueOnce(new Error('sem canal'));
		const os = jest.replaceProperty(Platform, 'OS', 'android');
		try {
			expect(await cancelRecurringReminders()).toBe(2);
		} finally {
			os.restore();
		}

		expect(Array.from(mockScheduled.keys()).filter((id) => id.startsWith('transaction_'))).toEqual([]);
		expect(mockStorage.has('@spendr_scheduled_notifications')).toBe(false);
	});

	it('no iOS, que não tem canal, não tenta apagar', async () => {
		const os = jest.replaceProperty(Platform, 'OS', 'ios');
		try {
			await cancelRecurringReminders();
		} finally {
			os.restore();
		}

		expect(Notifications.deleteNotificationChannelAsync).not.toHaveBeenCalled();
	});
});

describe('apagar todos os dados (SPD-082)', () => {
	it('cancela todo lembrete agendado, de recorrente antiga e de conta a pagar, e esquece as marcas', async () => {
		mockScheduled.set('transaction_aluguel', { content: {}, trigger: {} });
		mockStorage.set('@spendr_scheduled_notifications', JSON.stringify({ 'aluguel:2026-11-10': true }));
		await scheduleBillReminders([bill()], new Date(2026, 9, 24, 12, 0));
		expect(mockScheduled.size).toBeGreaterThan(1);

		await clearScheduledNotifications();

		expect(mockScheduled.size).toBe(0);
		expect(mockStorage.has('@spendr_scheduled_notifications')).toBe(false);
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

	it('no Android cria o canal bills antes de agendar, mesmo sem o onboarding novo', async () => {
		// Quem passou pelo onboarding antes da v20 não tem o canal: aviso agendado num canal
		// que não existe não aparece no Android.
		const channelMock = Notifications.setNotificationChannelAsync as jest.Mock;
		channelMock.mockClear();
		const os = jest.replaceProperty(Platform, 'OS', 'android');
		try {
			await scheduleBillReminders([bill()], now);
		} finally {
			os.restore();
		}

		expect(channelMock).toHaveBeenCalledWith('bills', expect.any(Object));
		expect(channelMock.mock.invocationCallOrder[0]).toBeLessThan(
			scheduleMock.mock.invocationCallOrder[0]
		);
	});

	it('no iOS não mexe em canal', async () => {
		const channelMock = Notifications.setNotificationChannelAsync as jest.Mock;
		channelMock.mockClear();
		const os = jest.replaceProperty(Platform, 'OS', 'ios');
		try {
			await scheduleBillReminders([bill()], now);
		} finally {
			os.restore();
		}

		expect(channelMock).not.toHaveBeenCalled();
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

/**
 * Fatura do cartão (E2E-22): o `dumpsys alarm` do app só tinha os avisos da conta a pagar.
 * Nubank fecha dia 10 e vence 7 dias depois (17/11/2026), fatura de R$ 1.634,56.
 */
describe('scheduleCardReminders', () => {
	const now = new Date(2026, 10, 7, 10, 0);
	const NUBANK: CardSettings = {
		closingDay: 10,
		closingDaysBefore: 7,
		creditLimitCents: 500_000,
		openingBalanceCents: 0,
		openingBalanceDate: '2026-11-06',
	};
	const purchase = (id: string, amountCents: number): CardEntry => ({
		id,
		amountCents,
		isIncome: false,
		date: '2026-11-07',
		note: id,
		category: 'shopping',
		installmentGroup: null,
		installmentIndex: null,
		installmentCount: null,
	});
	const ENTRIES = [purchase('ajuste', 123_456), purchase('compra', 10_000), purchase('parcela', 30_000)];

	const nubank = (paidCents = 0): CardReminderSource => ({
		cardId: 'nubank',
		name: 'Nubank Teste',
		summary: buildCardSummary(
			NUBANK,
			ENTRIES,
			paidCents > 0 ? [{ amountCents: paidCents, date: '2026-11-07', inbound: true }] : [],
			'2026-11-07'
		),
	});

	const cardIds = (): string[] => Array.from(mockScheduled.keys()).filter((id) => id.startsWith('card:'));

	// A agenda de mentira é zerada a cada teste; o que o módulo lembra do último agendamento
	// também tem de ser — é o que "Apagar todos os dados" faz.
	beforeEach(async () => {
		await clearScheduledNotifications();
		jest.clearAllMocks();
	});

	it('agenda 14/11 e 17/11 às 09:00, com o valor da fatura', async () => {
		expect(await scheduleCardReminders([nubank()], now)).toBe(2);
		expect(cardIds()).toEqual(['card:nubank:2026-11:soon:3', 'card:nubank:2026-11:today:0']);

		const amount = formatCents(163_456);
		const soon = mockScheduled.get('card:nubank:2026-11:soon:3');
		expect(soon?.content).toMatchObject({
			title: 'Fatura vence em 3 dias',
			body: `Nubank Teste — fatura de ${amount} no dia 17`,
			data: { cardId: 'nubank', invoice: '2026-11', kind: 'soon' },
		});
		const soonAt = soon?.trigger.date as Date;
		expect([soonAt.getFullYear(), soonAt.getMonth(), soonAt.getDate(), soonAt.getHours()]).toEqual([2026, 10, 14, 9]);

		const today = mockScheduled.get('card:nubank:2026-11:today:0');
		expect(today?.content).toMatchObject({ title: 'Fatura vence hoje', body: `Nubank Teste — fatura de ${amount}` });
		const todayAt = today?.trigger.date as Date;
		expect([todayAt.getFullYear(), todayAt.getMonth(), todayAt.getDate(), todayAt.getHours()]).toEqual([2026, 10, 17, 9]);
	});

	it('paga a fatura (R$ 1.634,56), os avisos saem', async () => {
		await scheduleCardReminders([nubank()], now);
		expect(await scheduleCardReminders([nubank(163_456)], now)).toBe(0);
		expect(cardIds()).toEqual([]);
	});

	it('pagamento parcial: o aviso diz o que falta', async () => {
		await scheduleCardReminders([nubank(100_000)], now);
		expect(mockScheduled.get('card:nubank:2026-11:today:0')?.content.body).toBe(
			`Nubank Teste — fatura de ${formatCents(63_456)}`
		);
	});

	it('pagamento de antes da fatura informada (E2E-41): o texto diz R$ 1.634,56, como a tela', async () => {
		// Fatura informada no cadastro de 07/11 (âncora no fim de 06/11) e o "Pagamento recebido" de 05/11 do extrato.
		const informed: CardSettings = { ...NUBANK, openingBalanceCents: -123_456 };
		const source: CardReminderSource = {
			cardId: 'nubank',
			name: 'Nubank Teste',
			summary: buildCardSummary(
				informed,
				[purchase('mercado', 10_000), purchase('parcela', 30_000)],
				[{ amountCents: 123_456, date: '2026-11-05', inbound: true }],
				'2026-11-07'
			),
		};
		expect(await scheduleCardReminders([source], now)).toBe(2);
		expect(mockScheduled.get('card:nubank:2026-11:soon:3')?.content.body).toBe(
			`Nubank Teste — fatura de ${formatCents(163_456)} no dia 17`
		);
		expect(mockScheduled.get('card:nubank:2026-11:today:0')?.content.body).toBe(`Nubank Teste — fatura de ${formatCents(163_456)}`);
	});

	it('cartões e contas a pagar não apagam os avisos um do outro', async () => {
		await scheduleBillReminders([bill({ dueDay: 10 })], new Date(2026, 9, 24, 12, 0));
		await scheduleCardReminders([nubank()], now);
		expect(Array.from(mockScheduled.keys()).some((id) => id.startsWith('bill:'))).toBe(true);

		await scheduleBillReminders([], new Date(2026, 9, 24, 12, 0));
		expect(cardIds()).toHaveLength(2);
		await scheduleCardReminders([], now);
		expect(cardIds()).toEqual([]);
	});

	it('as mesmas faturas de novo não remarcam (a recarga das contas acontece a toda hora)', async () => {
		await scheduleCardReminders([nubank()], now);
		await scheduleCardReminders([nubank()], now);
		expect(scheduleMock).toHaveBeenCalledTimes(2);
	});

	it('com as notificações desligadas não agenda, e tira as que havia', async () => {
		await scheduleCardReminders([nubank()], now);
		await setNotificationsEnabled(false);
		expect(await scheduleCardReminders([nubank()], now)).toBe(0);
		expect(cardIds()).toEqual([]);

		await setNotificationsEnabled(true);
		expect(await scheduleCardReminders([nubank()], now)).toBe(2);
	});

	it('"Apagar todos os dados" esquece o que estava agendado: a próxima remarcação agenda de novo', async () => {
		await scheduleCardReminders([nubank()], now);
		await clearScheduledNotifications();
		expect(cardIds()).toEqual([]);
		expect(await scheduleCardReminders([nubank()], now)).toBe(2);
		expect(cardIds()).toHaveLength(2);
	});

	it('textos existem em inglês e italiano', async () => {
		await i18n.changeLanguage('en');
		await scheduleCardReminders([nubank()], now);
		expect(mockScheduled.get('card:nubank:2026-11:today:0')?.content.title).toBe('Card bill due today');

		await i18n.changeLanguage('it');
		await scheduleCardReminders([nubank()], now);
		expect(mockScheduled.get('card:nubank:2026-11:soon:3')?.content.title).toBe('Estratto conto in scadenza tra 3 giorni');

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
		expect(channels).toEqual(expect.arrayContaining(['default', 'bills']));
		// O das recorrências antigas não é mais criado: nenhum aviso usa (SPD-128).
		expect(channels).not.toContain('recurring-transactions');
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
