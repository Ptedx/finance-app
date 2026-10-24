import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import i18next from 'i18next';
import { Platform } from 'react-native';
import type { Bill, RecurringTransaction } from '../database/schema';
import { errorData, log } from '../diagnostics/log';
import { type BillReminder, billReminders } from './billReminders';
import { getISODate, parseISODate } from './dateUtils';
import { formatCents } from './money';
import { STORAGE_KEYS } from './storageUtils';

// Keys for storing notification settings. O liga/desliga mora em `STORAGE_KEYS` porque
// viaja no backup e no sync (`preferences`), e o nome tem de ser um só.
const NOTIFICATIONS_ENABLED_KEY = STORAGE_KEYS.notificationsEnabled;
const PUSH_TOKEN_KEY = '@spendr_push_token';
const SCHEDULED_NOTIFICATIONS_KEY = '@spendr_scheduled_notifications';

/** Canal Android dos lembretes de contas a pagar. */
const BILLS_CHANNEL_ID = 'bills';

/** Prefixo dos identificadores dos lembretes de conta: `bill:<billId>:<mês>:<kind>:<n>`. */
const BILL_IDENTIFIER_PREFIX = 'bill:';

// Lazy-load expo-notifications to avoid crashing in Expo Go (SDK 53+
// removed remote notifications from Expo Go on Android).
type NotificationsModule = typeof import('expo-notifications');
let _notifications: NotificationsModule | null = null;

const getNotifications = (): NotificationsModule | null => {
	if (_notifications !== null) return _notifications;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		_notifications = require('expo-notifications') as NotificationsModule;
		// Configure default notification behaviour on first successful load
		_notifications.setNotificationHandler({
			handleNotification: async () => ({
				shouldShowAlert: true,
				shouldPlaySound: false,
				shouldSetBadge: true,
				shouldShowBanner: true,
				shouldShowList: true,
			}),
		});
		return _notifications;
	} catch {
		return null;
	}
};

/**
 * Register for push notifications and store the token.
 * Returns null silently when running in Expo Go.
 */
export const registerForPushNotificationsAsync = async (): Promise<string | null> => {
	const Notifications = getNotifications();
	if (!Notifications) return null;

	let token: string | null = null;

	try {
		if (Platform.OS === 'android') {
			await Notifications.setNotificationChannelAsync('default', {
				name: 'Default',
				importance: Notifications.AndroidImportance.MAX,
				vibrationPattern: [0, 250, 250, 250],
				lightColor: '#15E8FE',
			});

			await Notifications.setNotificationChannelAsync('recurring-transactions', {
				name: 'Recurring Transactions',
				description: 'Notifications for upcoming recurring transactions',
				importance: Notifications.AndroidImportance.HIGH,
				vibrationPattern: [0, 250, 250, 250],
				lightColor: '#15E8FE',
			});

			await ensureBillsChannel(Notifications);
		}

		if (Device.isDevice) {
			const { status: existingStatus } = await Notifications.getPermissionsAsync();
			let finalStatus = existingStatus;

			if (existingStatus !== 'granted') {
				const { status } = await Notifications.requestPermissionsAsync();
				finalStatus = status;
			}

			if (finalStatus !== 'granted') {
				console.log('Notification permissions not granted');
				return null;
			}

			token = (await Notifications.getExpoPushTokenAsync()).data ?? null;

			if (token) {
				await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
			}
		} else {
			console.log('Must use physical device for Push Notifications');
		}

		return token;
	} catch (error) {
		console.warn(
			'Error in registerForPushNotificationsAsync (Firebase likely not configured):',
			error
		);
		return null;
	}
};

/**
 * Check if notifications are enabled in app settings
 */
export const areNotificationsEnabled = async (): Promise<boolean> => {
	try {
		const value = await AsyncStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
		return value === null ? true : value === 'true';
	} catch (error) {
		console.error('Error checking notification settings:', error);
		return false;
	}
};

/**
 * Enable or disable notifications in app settings
 */
export const setNotificationsEnabled = async (enabled: boolean): Promise<void> => {
	try {
		await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, enabled ? 'true' : 'false');
	} catch (error) {
		console.error('Error saving notification settings:', error);
	}
};

const getNotificationIdentifier = (transactionId: string): string => {
	return `transaction_${transactionId}`;
};

/**
 * Marca de "já agendado" de uma ocorrência: recorrente + data do vencimento.
 *
 * Era só o id da recorrente, e a marca nunca saía — então só o primeiro vencimento era
 * lembrado (REM-02). Por ocorrência, cada vencimento agenda o seu.
 */
const getOccurrenceKey = (transactionId: string, dueDate: Date): string =>
	`${transactionId}:${getISODate(dueDate)}`;

/**
 * Schedule a notification for an upcoming recurring transaction.
 * No-ops silently when running in Expo Go.
 */
export const scheduleTransactionNotification = async (
	transaction: RecurringTransaction,
	dueDate: Date
): Promise<string | null> => {
	const Notifications = getNotifications();
	if (!Notifications) return null;

	try {
		const isEnabled = await areNotificationsEnabled();
		if (!isEnabled) return null;

		const occurrenceKey = getOccurrenceKey(transaction.id, dueDate);
		const scheduledNotifications = await getScheduledNotifications();
		if (scheduledNotifications[occurrenceKey]) return null;

		const notificationDate = new Date(dueDate);
		notificationDate.setDate(notificationDate.getDate() - 1);

		if (notificationDate < new Date()) return null;

		const content = {
			title: i18next.t(
				transaction.isIncome
					? 'reminders.recurring.incomeTitle'
					: 'reminders.recurring.expenseTitle'
			),
			body: i18next.t('reminders.recurring.body', {
				name: transaction.note || i18next.t('reminders.recurring.fallbackName'),
				amount: formatCents(transaction.amountCents),
			}),
			data: { transactionId: transaction.id },
			sound: true,
		};

		const identifier = getNotificationIdentifier(transaction.id);
		await cancelTransactionNotification(transaction.id);

		const notificationId = await Notifications.scheduleNotificationAsync({
			content,
			trigger: {
				type: Notifications.SchedulableTriggerInputTypes.DATE,
				date: notificationDate,
				channelId: Platform.OS === 'android' ? 'recurring-transactions' : undefined,
			},
			identifier,
		});

		await markNotificationScheduled(occurrenceKey);
		return notificationId;
	} catch (error) {
		console.error('Error scheduling transaction notification:', error);
		return null;
	}
};

/**
 * Cancel a scheduled notification for a transaction.
 */
export const cancelTransactionNotification = async (transactionId: string): Promise<void> => {
	const Notifications = getNotifications();
	if (!Notifications) return;

	try {
		const identifier = getNotificationIdentifier(transactionId);
		await Notifications.cancelScheduledNotificationAsync(identifier);
		await clearScheduledNotification(transactionId);
	} catch (error) {
		console.error('Error canceling transaction notification:', error);
	}
};

/**
 * Check for upcoming transactions and schedule notifications.
 */
export const checkAndScheduleNotifications = async (
	transactions: RecurringTransaction[]
): Promise<void> => {
	if (!getNotifications()) return;

	try {
		const isEnabled = await areNotificationsEnabled();
		if (!isEnabled) return;

		const now = new Date();
		const thirtyDaysFromNow = new Date();
		thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

		for (const transaction of transactions) {
			if (!transaction.active || !transaction.nextDue) continue;

			// Data de calendário, em hora local: `new Date('2026-11-10')` seria meia-noite UTC.
			const dueDate = parseISODate(transaction.nextDue);
			if (dueDate >= now && dueDate <= thirtyDaysFromNow) {
				await scheduleTransactionNotification(transaction, dueDate);
			}
		}
	} catch (error) {
		console.error('Error checking and scheduling notifications:', error);
	}
};

/**
 * Cancel all scheduled notifications.
 */
export const cancelAllNotifications = async (): Promise<void> => {
	const Notifications = getNotifications();
	if (!Notifications) return;

	try {
		await Notifications.cancelAllScheduledNotificationsAsync();
	} catch (error) {
		console.error('Error canceling all notifications:', error);
	}
};

/** `bill:<billId>:<mês>:<kind>:<n>` — o mesmo aviso tem sempre o mesmo identificador. */
const billReminderIdentifier = (reminder: BillReminder): string =>
	`${BILL_IDENTIFIER_PREFIX}${reminder.billId}:${reminder.month}:${reminder.kind}:${reminder.n}`;

const billReminderContent = (
	bill: Bill,
	reminder: BillReminder
): { title: string; body: string } => {
	// O dia em que vence de fato: o 31 de uma conta vira 30 em novembro.
	const day = Number(reminder.dueDate.slice(8, 10));
	const amount = bill.amountCents === null ? null : formatCents(bill.amountCents);
	const values = { name: bill.name, amount, day };

	switch (reminder.kind) {
		case 'soon':
			return {
				title: i18next.t('reminders.bill.soonTitle'),
				body: i18next.t(
					amount ? 'reminders.bill.soonBody' : 'reminders.bill.soonBodyNoAmount',
					values
				),
			};
		case 'today':
			return {
				title: i18next.t('reminders.bill.todayTitle'),
				body: i18next.t(
					amount ? 'reminders.bill.todayBody' : 'reminders.bill.todayBodyNoAmount',
					values
				),
			};
		case 'late':
			return {
				title: i18next.t('reminders.bill.lateTitle'),
				body: i18next.t('reminders.bill.lateBody', values),
			};
	}
};

/** Uma remarcação por vez: duas chamadas seguidas não intercalam cancelar e agendar. */
let billScheduling: Promise<unknown> = Promise.resolve();

/**
 * Remarca do zero os lembretes das contas a pagar: cancela todos os agendados `bill:` e
 * agenda os dos próximos 45 dias (`billReminders`). Chamar sempre que as contas mudarem
 * (criar, editar, dar baixa, apagar) e na abertura do app — é isso que mantém os avisos
 * remarcados todo mês.
 *
 * Com as notificações desligadas, só cancela. No Expo Go não faz nada.
 * Devolve quantos lembretes ficaram agendados.
 */
export const scheduleBillReminders = (bills: Bill[], now: Date = new Date()): Promise<number> => {
	const run = billScheduling.then(() => rescheduleBillReminders(bills, now));
	billScheduling = run.catch(() => undefined);
	return run;
};

/**
 * Cria (ou atualiza) o canal Android dos lembretes de conta. O `registerForPushNotificationsAsync`
 * também cria, mas só roda no onboarding e ao ligar a chave nos Ajustes: quem passou por eles
 * antes da v20 não tem o canal, e aviso agendado num canal que não existe não aparece.
 */
const ensureBillsChannel = async (
	Notifications: NonNullable<ReturnType<typeof getNotifications>>
): Promise<void> => {
	if (Platform.OS !== 'android') return;
	await Notifications.setNotificationChannelAsync(BILLS_CHANNEL_ID, {
		name: i18next.t('reminders.channelName'),
		description: i18next.t('reminders.channelDescription'),
		importance: Notifications.AndroidImportance.HIGH,
		vibrationPattern: [0, 250, 250, 250],
		lightColor: '#15E8FE',
	});
};

/**
 * A permissão do sistema, só para o diário: o app agenda com ela negada também (o aviso
 * simplesmente não aparece), e é isso que o diário precisa mostrar. Nunca lança.
 */
const permissionStatus = async (
	Notifications: NonNullable<ReturnType<typeof getNotifications>>
): Promise<string> => {
	try {
		return (await Notifications.getPermissionsAsync()).status;
	} catch {
		return 'unknown';
	}
};

/** Uma remarcação no diário (SPD-014): quantas contas, quantos avisos, e se podiam aparecer. */
const logBillReminders = async (
	Notifications: NonNullable<ReturnType<typeof getNotifications>>,
	bills: Bill[],
	scheduled: number,
	enabled: boolean
): Promise<void> => {
	const permission = await permissionStatus(Notifications);
	log('reminders', 'bill_reminders_rescheduled', {
		level: enabled && permission === 'denied' && scheduled > 0 ? 'warn' : 'info',
		data: { bills: bills.length, scheduled, enabled, permission },
	});
};

const rescheduleBillReminders = async (bills: Bill[], now: Date): Promise<number> => {
	const Notifications = getNotifications();
	if (!Notifications) return 0;

	try {
		const scheduled = await Notifications.getAllScheduledNotificationsAsync();
		for (const request of scheduled) {
			if (request.identifier.startsWith(BILL_IDENTIFIER_PREFIX)) {
				await Notifications.cancelScheduledNotificationAsync(request.identifier);
			}
		}

		if (!(await areNotificationsEnabled())) {
			await logBillReminders(Notifications, bills, 0, false);
			return 0;
		}

		await ensureBillsChannel(Notifications);

		const billsById = new Map(bills.map((bill) => [bill.id, bill]));
		let count = 0;

		for (const reminder of billReminders(bills, now)) {
			const bill = billsById.get(reminder.billId);
			if (!bill) continue;

			await Notifications.scheduleNotificationAsync({
				identifier: billReminderIdentifier(reminder),
				content: {
					...billReminderContent(bill, reminder),
					data: { billId: bill.id, month: reminder.month, kind: reminder.kind },
					sound: true,
				},
				trigger: {
					type: Notifications.SchedulableTriggerInputTypes.DATE,
					date: reminder.at,
					channelId: Platform.OS === 'android' ? BILLS_CHANNEL_ID : undefined,
				},
			});
			count += 1;
		}

		await logBillReminders(Notifications, bills, count, true);
		return count;
	} catch (error) {
		console.error('Error scheduling bill reminders:', error);
		log('reminders', 'bill_reminders_failed', { level: 'error', data: { bills: bills.length, ...errorData(error) } });
		return 0;
	}
};

const getScheduledNotifications = async (): Promise<Record<string, boolean>> => {
	try {
		const value = await AsyncStorage.getItem(SCHEDULED_NOTIFICATIONS_KEY);
		return value ? JSON.parse(value) : {};
	} catch (error) {
		console.error('Error getting scheduled notifications:', error);
		return {};
	}
};

const markNotificationScheduled = async (occurrenceKey: string): Promise<void> => {
	try {
		const scheduled = await getScheduledNotifications();
		scheduled[occurrenceKey] = true;
		await AsyncStorage.setItem(SCHEDULED_NOTIFICATIONS_KEY, JSON.stringify(scheduled));
	} catch (error) {
		console.error('Error marking notification as scheduled:', error);
	}
};

/**
 * Tira as marcas da recorrente: as por ocorrência (`<id>:<data>`) e a antiga, só pelo id,
 * que instalações anteriores deixaram gravada.
 */
const clearScheduledNotification = async (transactionId: string): Promise<void> => {
	try {
		const scheduled = await getScheduledNotifications();
		for (const key of Object.keys(scheduled)) {
			if (key === transactionId || key.startsWith(`${transactionId}:`)) delete scheduled[key];
		}
		await AsyncStorage.setItem(SCHEDULED_NOTIFICATIONS_KEY, JSON.stringify(scheduled));
	} catch (error) {
		console.error('Error clearing scheduled notification:', error);
	}
};

export default {
	registerForPushNotificationsAsync,
	areNotificationsEnabled,
	setNotificationsEnabled,
	scheduleTransactionNotification,
	cancelTransactionNotification,
	checkAndScheduleNotifications,
	cancelAllNotifications,
	scheduleBillReminders,
};
