import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { RecurringTransaction } from '../database/schema';
import { formatCurrency } from './currencyUtils';

// Keys for storing notification settings
const NOTIFICATIONS_ENABLED_KEY = '@spendr_notifications_enabled';
const PUSH_TOKEN_KEY = '@spendr_push_token';
const SCHEDULED_NOTIFICATIONS_KEY = '@spendr_scheduled_notifications';

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
		console.error('Error in registerForPushNotificationsAsync:', error);
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

		const scheduledNotifications = await getScheduledNotifications();
		if (scheduledNotifications[transaction.id]) return null;

		const notificationDate = new Date(dueDate);
		notificationDate.setDate(notificationDate.getDate() - 1);

		if (notificationDate < new Date()) return null;

		const amount = formatCurrency(transaction.amount);

		const content = {
			title: transaction.isIncome ? 'Upcoming Income' : 'Upcoming Expense',
			body: `${transaction.note || 'Recurring transaction'} - ${amount} due tomorrow`,
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

		await markNotificationScheduled(transaction.id);
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

			const dueDate = new Date(transaction.nextDue);
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

const getScheduledNotifications = async (): Promise<Record<string, boolean>> => {
	try {
		const value = await AsyncStorage.getItem(SCHEDULED_NOTIFICATIONS_KEY);
		return value ? JSON.parse(value) : {};
	} catch (error) {
		console.error('Error getting scheduled notifications:', error);
		return {};
	}
};

const markNotificationScheduled = async (transactionId: string): Promise<void> => {
	try {
		const scheduled = await getScheduledNotifications();
		scheduled[transactionId] = true;
		await AsyncStorage.setItem(SCHEDULED_NOTIFICATIONS_KEY, JSON.stringify(scheduled));
	} catch (error) {
		console.error('Error marking notification as scheduled:', error);
	}
};

const clearScheduledNotification = async (transactionId: string): Promise<void> => {
	try {
		const scheduled = await getScheduledNotifications();
		delete scheduled[transactionId];
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
};
