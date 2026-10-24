/**
 * O reagendamento das contas a pagar no diário (SPD-014): quantas contas, quantos avisos
 * ficaram agendados e se a permissão do sistema estava negada — o caso em que o app agenda
 * e o aviso nunca aparece. Nada do nome nem do valor da conta.
 *
 * `expo-notifications` é o mesmo dublê de `notificationUtils.test.ts`, com a permissão
 * programável.
 */

const mockStorage = new Map<string, string>();
const mockPermission: { status: string; fails: boolean } = { status: 'granted', fails: false };

jest.mock('../../diagnostics/log', () => ({ ...jest.requireActual('../../diagnostics/log'), log: jest.fn() }));

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
	getPermissionsAsync: jest.fn(async () => {
		if (mockPermission.fails) throw new Error('sem módulo');
		return { status: mockPermission.status };
	}),
	requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
	scheduleNotificationAsync: jest.fn(async () => 'id'),
	cancelScheduledNotificationAsync: jest.fn(async () => undefined),
	cancelAllScheduledNotificationsAsync: jest.fn(async () => undefined),
	getAllScheduledNotificationsAsync: jest.fn(async () => []),
}));

import * as Notifications from 'expo-notifications';
import type { Bill } from '../../database/schema';
import { log } from '../../diagnostics/log';
import { scheduleBillReminders, setNotificationsEnabled } from '../notificationUtils';

const logMock = log as jest.Mock;

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'consorcio-secreto',
	name: 'Consórcio do Fulano',
	dueDay: 10,
	amountCents: 45_000,
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

const now = new Date(2026, 9, 24, 12, 0);

const events = () =>
	logMock.mock.calls.map(([area, event, options]) => ({ area, event, level: options?.level, data: options?.data }));

let errorSpy: jest.SpyInstance;

beforeEach(() => {
	mockStorage.clear();
	mockPermission.status = 'granted';
	mockPermission.fails = false;
	jest.clearAllMocks();
	errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe('bill_reminders_rescheduled', () => {
	it('quantas contas e quantos avisos, com a permissão', async () => {
		const count = await scheduleBillReminders([bill(), bill({ id: 'outra', paidThrough: '2026-12' })], now);

		expect(count).toBe(6);
		expect(events()).toEqual([
			{
				area: 'reminders',
				event: 'bill_reminders_rescheduled',
				level: 'info',
				data: { bills: 2, scheduled: 6, enabled: true, permission: 'granted' },
			},
		]);
		expect(JSON.stringify(logMock.mock.calls)).not.toMatch(/Consórcio|Fulano|secreto|45000|450/);
	});

	it('permissão negada: agendou, mas o aviso não vai aparecer — em warn', async () => {
		mockPermission.status = 'denied';
		await scheduleBillReminders([bill()], now);

		expect(events()[0]).toMatchObject({ level: 'warn', data: { scheduled: 6, permission: 'denied' } });
	});

	it('notificações desligadas no app: nada agendado, e o diário diz por quê', async () => {
		await setNotificationsEnabled(false);
		logMock.mockClear();
		await scheduleBillReminders([bill()], now);

		expect(events()).toEqual([
			expect.objectContaining({ data: { bills: 1, scheduled: 0, enabled: false, permission: 'granted' } }),
		]);
	});

	it('sem como ler a permissão: unknown, e o reagendamento segue', async () => {
		mockPermission.fails = true;

		expect(await scheduleBillReminders([bill()], now)).toBe(6);
		expect(events()[0].data).toMatchObject({ permission: 'unknown', scheduled: 6 });
	});

	it('falhou no meio: bill_reminders_failed, sem a mensagem', async () => {
		(Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(
			new TypeError('Consórcio do Fulano: canal')
		);

		expect(await scheduleBillReminders([bill()], now)).toBe(0);
		expect(events()).toEqual([
			{
				area: 'reminders',
				event: 'bill_reminders_failed',
				level: 'error',
				data: { bills: 1, error: 'TypeError' },
			},
		]);
	});
});
