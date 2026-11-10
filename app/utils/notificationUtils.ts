import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import i18next from 'i18next';
import { Platform } from 'react-native';
import type { Bill } from '../database/schema';
import { errorData, log } from '../diagnostics/log';
import {
	type BillReminder,
	billReminders,
	type CardReminder,
	type CardReminderSource,
	cardReminders,
} from './billReminders';
import { formatCents } from './money';
import { STORAGE_KEYS } from './storageUtils';

// Keys for storing notification settings. O liga/desliga mora em `STORAGE_KEYS` porque
// viaja no backup e no sync (`preferences`), e o nome tem de ser um só.
const NOTIFICATIONS_ENABLED_KEY = STORAGE_KEYS.notificationsEnabled;
const PUSH_TOKEN_KEY = '@spendr_push_token';
const SCHEDULED_NOTIFICATIONS_KEY = '@spendr_scheduled_notifications';

/** Canal Android dos lembretes de contas a pagar (e das faturas dos cartões). */
const BILLS_CHANNEL_ID = 'bills';

/** Prefixo dos identificadores dos lembretes de conta: `bill:<billId>:<mês>:<kind>:<n>`. */
const BILL_IDENTIFIER_PREFIX = 'bill:';

/** Prefixo dos lembretes de fatura do cartão: `card:<cardId>:<fatura>:<kind>:<n>`. */
const CARD_IDENTIFIER_PREFIX = 'card:';

/**
 * O que foi agendado na última remarcação das faturas (avisos, textos, horários e o
 * liga/desliga). As faturas são recalculadas a cada recarga das contas — a cada lançamento,
 * a cada troca de mês na tela —, e remarcar o mesmo conjunto toda vez só enche o diário.
 * Nulo: nada conhecido, a próxima remarca de qualquer jeito (`cancelAllNotifications` zera).
 */
let cardSignature: string | null = null;

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

			// O canal `recurring-transactions` saiu (SPD-128): nenhum aviso usa mais desde que as
			// recorrências pararam de lembrar (SPD-122). Quem já o tem segue com ele, vazio.
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

/**
 * Prefixo dos lembretes das recorrências antigas: `transaction_<id>`. Nada agenda mais com
 * ele (SPD-122, DEC-37): a tela das recorrências saiu no SPD-079, as regras não lançam mais
 * nada desde o SPD-113, e o "Aluguel vence amanhã" de uma regra que o usuário não vê nem
 * edita só confundia. As regras seguem no banco, no sync e no backup.
 */
const RECURRING_IDENTIFIER_PREFIX = 'transaction_';

/**
 * Cancela os lembretes das recorrências antigas que versões anteriores deixaram agendados
 * (`transaction_<id>`) e esquece as marcas de "já agendado" deles. Os das Contas do mês
 * (`bill:`) e das faturas (`card:`) não são tocados.
 *
 * Chamada na abertura do app (`RecurringTransactionsProvider`); sem nada agendado, só lê a
 * agenda. Cancela mesmo com as notificações desligadas. No Expo Go não faz nada. Devolve
 * quantos cancelou.
 */
export const cancelRecurringReminders = async (): Promise<number> => {
	const Notifications = getNotifications();
	if (!Notifications) return 0;

	try {
		let cancelled = 0;
		const scheduled = await Notifications.getAllScheduledNotificationsAsync();
		for (const request of scheduled) {
			if (request.identifier.startsWith(RECURRING_IDENTIFIER_PREFIX)) {
				await Notifications.cancelScheduledNotificationAsync(request.identifier);
				cancelled += 1;
			}
		}
		// As marcas só existiam para os lembretes das recorrências.
		await AsyncStorage.removeItem(SCHEDULED_NOTIFICATIONS_KEY);
		if (cancelled > 0) log('reminders', 'recurring_reminders_cancelled', { data: { cancelled } });
		return cancelled;
	} catch (error) {
		console.error('Error canceling recurring reminders:', error);
		return 0;
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
	} finally {
		// Os de fatura saíram junto: a próxima remarcação deles agenda do zero.
		cardSignature = null;
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
 * "Apagar todos os dados" (SPD-082): cancela todo lembrete agendado — das contas a pagar
 * (`bill:`), das faturas (`card:`) e algum das recorrentes antigas (`transaction_*`) que
 * tenha sobrado — e esquece as marcas de "já agendado" delas.
 *
 * Entra na fila das remarcações das contas a pagar: uma remarcação em curso não agenda de
 * novo, depois do cancelamento, os lembretes de contas que acabaram de ser apagadas.
 */
export const clearScheduledNotifications = (): Promise<void> => {
	const run = billScheduling.then(async () => {
		await cancelAllNotifications();
		try {
			await AsyncStorage.removeItem(SCHEDULED_NOTIFICATIONS_KEY);
		} catch (error) {
			console.error('Error clearing scheduled notification marks:', error);
		}
	});
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

/** `card:<cardId>:<fatura>:<kind>:<n>` — o mesmo aviso tem sempre o mesmo identificador. */
const cardReminderIdentifier = (reminder: CardReminder): string =>
	`${CARD_IDENTIFIER_PREFIX}${reminder.cardId}:${reminder.invoice}:${reminder.kind}:${reminder.n}`;

const cardReminderContent = (name: string, reminder: CardReminder): { title: string; body: string } => {
	const values = {
		name,
		amount: formatCents(reminder.amountCents),
		day: Number(reminder.dueDate.slice(8, 10)),
	};
	return reminder.kind === 'soon'
		? { title: i18next.t('reminders.card.soonTitle'), body: i18next.t('reminders.card.soonBody', values) }
		: { title: i18next.t('reminders.card.todayTitle'), body: i18next.t('reminders.card.todayBody', values) };
};

/**
 * Remarca os lembretes das faturas dos cartões (`cardReminders`): cancela os `card:` e
 * agenda os dos próximos 45 dias, no mesmo canal e na mesma fila das contas a pagar. Os
 * `bill:` não são tocados, nem o contrário: cada lado remarca o seu.
 *
 * Chamar sempre que as faturas mudarem (o `BillsContext` chama a cada recarga dos cartões).
 * Com as notificações desligadas, só cancela. No Expo Go não faz nada. Devolve quantos
 * lembretes ficaram agendados.
 */
export const scheduleCardReminders = (cards: CardReminderSource[], now: Date = new Date()): Promise<number> => {
	const run = billScheduling.then(() => rescheduleCardReminders(cards, now));
	billScheduling = run.catch(() => undefined);
	return run;
};

const rescheduleCardReminders = async (cards: CardReminderSource[], now: Date): Promise<number> => {
	const Notifications = getNotifications();
	if (!Notifications) return 0;

	try {
		const enabled = await areNotificationsEnabled();
		const names = new Map(cards.map((card) => [card.cardId, card.name]));
		const planned = (enabled ? cardReminders(cards, now) : []).map((reminder) => ({
			reminder,
			identifier: cardReminderIdentifier(reminder),
			content: cardReminderContent(names.get(reminder.cardId) ?? '', reminder),
		}));

		const signature = JSON.stringify([
			enabled,
			planned.map(({ identifier, content, reminder }) => [identifier, content.title, content.body, reminder.at.getTime()]),
		]);
		if (signature === cardSignature) return planned.length;
		cardSignature = null;

		const scheduled = await Notifications.getAllScheduledNotificationsAsync();
		for (const request of scheduled) {
			if (request.identifier.startsWith(CARD_IDENTIFIER_PREFIX)) {
				await Notifications.cancelScheduledNotificationAsync(request.identifier);
			}
		}

		if (planned.length > 0) await ensureBillsChannel(Notifications);
		for (const { reminder, identifier, content } of planned) {
			await Notifications.scheduleNotificationAsync({
				identifier,
				content: {
					...content,
					data: { cardId: reminder.cardId, invoice: reminder.invoice, kind: reminder.kind },
					sound: true,
				},
				trigger: {
					type: Notifications.SchedulableTriggerInputTypes.DATE,
					date: reminder.at,
					channelId: Platform.OS === 'android' ? BILLS_CHANNEL_ID : undefined,
				},
			});
		}

		cardSignature = signature;
		const permission = await permissionStatus(Notifications);
		log('reminders', 'card_reminders_rescheduled', {
			level: enabled && permission === 'denied' && planned.length > 0 ? 'warn' : 'info',
			data: { cards: cards.length, scheduled: planned.length, enabled, permission },
		});
		return planned.length;
	} catch (error) {
		console.error('Error scheduling card reminders:', error);
		log('reminders', 'card_reminders_failed', { level: 'error', data: { cards: cards.length, ...errorData(error) } });
		return 0;
	}
};

export default {
	registerForPushNotificationsAsync,
	areNotificationsEnabled,
	setNotificationsEnabled,
	cancelRecurringReminders,
	cancelAllNotifications,
	clearScheduledNotifications,
	scheduleBillReminders,
	scheduleCardReminders,
};
