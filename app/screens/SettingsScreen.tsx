import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	ActivityIndicator,
	Alert,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import CurrencySelector from '../components/CurrencySelector';
import LanguageSelector from '../components/LanguageSelector';
import { useCurrency } from '../contexts/CurrencyContext';
import { useLanguage } from '../contexts/LanguageContext';
import { usePeriod } from '../contexts/PeriodContext';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { resetDatabase } from '../database/database';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import * as biometricUtils from '../utils/biometricUtils';
import { exportDatabaseData, importDatabaseData } from '../utils/exportUtils';
import * as notificationUtils from '../utils/notificationUtils';
import { resetAsyncStorage } from '../utils/storageUtils';

const SettingsScreen = () => {
	const { t } = useTranslation();
	const { currentCurrency } = useCurrency();
	const { currentLanguage } = useLanguage();
	const { transactions, categories, refreshData } = useTransactions();
	const { transactions: recurringTransactions, refreshTransactions } = useRecurringTransactions();
	const { resetToCurrentMonth } = usePeriod();
	const { authenticate } = useBiometricAuth();

	const [_darkMode, _setDarkMode] = useState(true);
	const [notifications, setNotifications] = useState(true);
	const [showCurrencySelector, setShowCurrencySelector] = useState(false);
	const [showLanguageSelector, setShowLanguageSelector] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [isTogglingNotifications, setIsTogglingNotifications] = useState(false);

	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricEnabled, setBiometricEnabled] = useState(false);
	const [biometricType, setBiometricType] = useState('Biometric');

	useEffect(() => {
		const checkBiometrics = async () => {
			try {
				const available = await biometricUtils.isBiometricAvailable();
				setBiometricAvailable(available);
				if (available) {
					const type = await biometricUtils.getBiometricType();
					setBiometricType(type);
					const enabled = await biometricUtils.isBiometricEnabled();
					setBiometricEnabled(enabled);
				}
			} catch (error) {
				console.error('Error checking biometrics:', error);
			}
		};
		checkBiometrics();
	}, []);

	useEffect(() => {
		const checkNotificationSettings = async () => {
			try {
				const enabled = await notificationUtils.areNotificationsEnabled();
				setNotifications(enabled);
			} catch (error) {
				console.error('Error checking notification settings:', error);
			}
		};
		checkNotificationSettings();
	}, []);

	const refreshAppData = async () => {
		try {
			resetToCurrentMonth();
			await refreshData();
			await refreshTransactions();
		} catch (error) {
			console.error('Error refreshing app data:', error);
		}
	};

	const toggleNotifications = async () => {
		try {
			setIsTogglingNotifications(true);
			const newValue = !notifications;
			await notificationUtils.setNotificationsEnabled(newValue);
			if (newValue) {
				await notificationUtils.registerForPushNotificationsAsync();
				await notificationUtils.checkAndScheduleNotifications(recurringTransactions);
			} else {
				await notificationUtils.cancelAllNotifications();
			}
			setNotifications(newValue);
		} catch (error) {
			console.error('Error toggling notifications:', error);
			Alert.alert(t('settings.error'), t('settings.notificationError'));
		} finally {
			setIsTogglingNotifications(false);
		}
	};

	const handleExportData = async () => {
		try {
			if (biometricEnabled) {
				const authenticated = await authenticate(
					t('settings.exportAuthPrompt', { biometricType }),
					async () => { performExport(); },
					() => {
						Alert.alert(t('settings.authFailed'), t('settings.exportAuthMsg'));
					}
				);
				if (!authenticated && !biometricEnabled) performExport();
			} else {
				performExport();
			}
		} catch (error) {
			console.error('Error during export:', error);
			setIsExporting(false);
			Alert.alert(t('settings.exportFailed'), t('settings.exportError'));
		}
	};

	const performExport = async () => {
		try {
			setIsExporting(true);
			await exportDatabaseData(transactions, categories, recurringTransactions);
			setIsExporting(false);
		} catch (error) {
			console.error('Error during export:', error);
			setIsExporting(false);
			Alert.alert(t('settings.exportFailed'), t('settings.exportError'));
		}
	};

	const handleImportData = async () => {
		try {
			Alert.alert(t('settings.importTitle'), t('settings.importConfirmMsg'), [
				{ text: t('settings.cancel'), style: 'cancel' },
				{
					text: t('settings.continue'),
					onPress: async () => {
						if (biometricEnabled) {
							const authenticated = await authenticate(
								t('settings.importAuthPrompt', { biometricType }),
								async () => { performImport(); },
								() => {
									Alert.alert(t('settings.authFailed'), t('settings.importAuthMsg'));
								}
							);
							if (!authenticated && !biometricEnabled) performImport();
						} else {
							performImport();
						}
					},
				},
			]);
		} catch (error) {
			console.error('Error during import:', error);
			setIsImporting(false);
			Alert.alert(t('settings.importFailed'), t('settings.importError'));
		}
	};

	const performImport = async () => {
		try {
			setIsImporting(true);
			const result = await importDatabaseData();
			if (result.success) {
				await refreshAppData();
				Alert.alert(
					t('settings.importSuccess'),
					t('settings.importSuccessMsg', {
						transactions: result.stats?.transactions,
						recurringTransactions: result.stats?.recurringTransactions,
					})
				);
			} else {
				Alert.alert(t('settings.importFailed'), result.message);
			}
			setIsImporting(false);
		} catch (error) {
			console.error('Error during import:', error);
			setIsImporting(false);
			Alert.alert(t('settings.importFailed'), t('settings.importError'));
		}
	};

	const handleResetData = async () => {
		Alert.alert(t('settings.resetTitle'), t('settings.resetMsg'), [
			{ text: t('settings.cancel'), style: 'cancel' },
			{
				text: t('settings.reset'),
				style: 'destructive',
				onPress: async () => {
					await authenticate(
						t('settings.resetAuthMsg'),
						async () => {
							try {
								setIsResetting(true);
								await resetDatabase();
								await resetAsyncStorage(['@spendr_biometric_enabled', '@spendr_language']);
								await refreshAppData();
								setIsResetting(false);
								Alert.alert(t('settings.resetSuccess'), t('settings.resetSuccessMsg'), [
									{ onPress: () => { router.push('/onboarding'); } },
								]);
							} catch (error) {
								console.error('Error resetting data:', error);
								setIsResetting(false);
								Alert.alert(t('settings.resetFailed'), t('settings.resetError'));
							}
						},
						() => {
							Alert.alert(t('settings.authFailed'), t('settings.resetAuthFailed'));
						}
					);
				},
			},
		]);
	};

	const handleAbout = () => {
		Alert.alert(t('settings.aboutSpendr'), t('settings.aboutMsg'), [{ text: t('settings.ok') }]);
	};

	const handlePrivacyPolicy = () => {
		router.push('/screens/PrivacyPolicyScreen');
	};

	const toggleBiometricAuth = async (value: boolean) => {
		if (value && biometricAvailable) {
			const success = await biometricUtils.authenticateWithBiometrics(
				`Authenticate to ${value ? 'enable' : 'disable'} ${biometricType} authentication`
			);
			if (success) {
				await biometricUtils.setBiometricEnabled(value);
				setBiometricEnabled(value);
			} else {
				setBiometricEnabled(!value);
			}
		} else {
			await biometricUtils.setBiometricEnabled(value);
			setBiometricEnabled(value);
		}
	};

	const renderSettingsItem = (
		icon: string,
		title: string,
		onPress: () => void,
		rightElement?: React.ReactNode
	) => (
		<TouchableOpacity style={styles.settingItem} onPress={onPress}>
			<View style={styles.settingLeft}>
				{/* biome-ignore lint/suspicious/noExplicitAny: external API shape unknown */}
				<Ionicons name={icon as any} size={22} color="#15E8FE" style={styles.settingIcon} />
				<Text style={styles.settingTitle}>{title}</Text>
			</View>
			{rightElement ? (
				rightElement
			) : (
				<Ionicons name="chevron-forward" size={20} color="rgba(255, 255, 255, 0.5)" />
			)}
		</TouchableOpacity>
	);

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: t('settings.screenTitle'),
					headerStyle: { backgroundColor: '#1A1A1A' },
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<View style={styles.headerContainer}>
				<Text style={styles.headerTitle}>{t('settings.headerTitle')}</Text>
			</View>

			<ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
				{/* Preferences */}
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{t('settings.preferences')}</Text>
					{renderSettingsItem(
						'notifications',
						t('settings.notifications'),
						toggleNotifications,
						isTogglingNotifications ? (
							<ActivityIndicator size="small" color="#15E8FE" />
						) : (
							<Switch
								value={notifications}
								onValueChange={toggleNotifications}
								trackColor={{ false: '#3e3e3e', true: 'rgba(80, 171, 227, 0.3)' }}
								thumbColor={notifications ? '#15E8FE' : '#f4f3f4'}
								ios_backgroundColor="#3e3e3e"
								disabled={isTogglingNotifications}
							/>
						)
					)}
					{renderSettingsItem(
						'cash-outline',
						t('settings.currency'),
						() => setShowCurrencySelector(true),
						<View style={styles.currencyValue}>
							<Text style={styles.currencySymbol}>{currentCurrency.symbol}</Text>
							<Text style={styles.currencyCode}>{currentCurrency.code}</Text>
						</View>
					)}
					{renderSettingsItem(
						'language-outline',
						t('settings.language'),
						() => setShowLanguageSelector(true),
						<View style={styles.currencyValue}>
							<Text style={styles.currencyCode}>{currentLanguage.nativeName}</Text>
						</View>
					)}
				</View>

				{/* Security */}
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{t('settings.security')}</Text>
					{biometricAvailable
						? renderSettingsItem(
								biometricType === 'Face ID' ? 'scan-face' : 'finger-print',
								t('settings.biometricAuth', { biometricType }),
								() => toggleBiometricAuth(!biometricEnabled),
								<Switch
									value={biometricEnabled}
									onValueChange={toggleBiometricAuth}
									trackColor={{ false: '#3e3e3e', true: 'rgba(80, 171, 227, 0.3)' }}
									thumbColor={biometricEnabled ? '#15E8FE' : '#f4f3f4'}
									ios_backgroundColor="#3e3e3e"
								/>
							)
						: renderSettingsItem(
								'lock-closed',
								t('settings.biometricUnavailableLabel'),
								() => Alert.alert(t('settings.biometricNotAvailableTitle'), t('settings.biometricNotAvailableMsg')),
								<Text style={styles.settingUnavailableText}>{t('settings.biometricUnavailable')}</Text>
							)}
					{renderSettingsItem('shield-checkmark', t('settings.privacyPolicy'), handlePrivacyPolicy)}
				</View>

				{/* Data Management */}
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{t('settings.dataManagement')}</Text>
					{renderSettingsItem(
						'download-outline',
						t('settings.exportData'),
						handleExportData,
						isExporting ? <ActivityIndicator size="small" color="#15E8FE" /> : undefined
					)}
					{renderSettingsItem(
						'cloud-upload-outline',
						t('settings.importData'),
						handleImportData,
						isImporting ? <ActivityIndicator size="small" color="#15E8FE" /> : undefined
					)}
					{renderSettingsItem(
						'trash-outline',
						t('settings.resetAllData'),
						handleResetData,
						isResetting ? <ActivityIndicator size="small" color="#FF6B6B" /> : undefined
					)}
				</View>

				{/* About */}
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{t('settings.about')}</Text>
					{renderSettingsItem('information-circle-outline', t('settings.aboutSpendr'), handleAbout)}
				</View>

				<Text style={styles.versionText}>{t('settings.version')}</Text>
			</ScrollView>

			<CurrencySelector
				isVisible={showCurrencySelector}
				onClose={() => setShowCurrencySelector(false)}
			/>
			<LanguageSelector
				isVisible={showLanguageSelector}
				onClose={() => setShowLanguageSelector(false)}
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	headerContainer: {
		paddingHorizontal: 16,
		paddingVertical: 12,
		paddingTop: 60,
	},
	headerTitle: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	content: {
		flex: 1,
		padding: 16,
	},
	section: {
		marginBottom: 24,
	},
	sectionTitle: {
		fontSize: 14,
		fontWeight: '600',
		color: '#15E8FE',
		marginBottom: 8,
		textTransform: 'uppercase',
		letterSpacing: 1,
	},
	settingItem: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	settingLeft: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	settingIcon: {
		marginRight: 12,
	},
	settingTitle: {
		fontSize: 16,
		color: '#FFFFFF',
	},
	currencyValue: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	currencySymbol: {
		fontSize: 16,
		fontWeight: '600',
		color: '#15E8FE',
		marginRight: 4,
	},
	currencyCode: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	versionText: {
		textAlign: 'center',
		color: 'rgba(255, 255, 255, 0.5)',
		marginTop: 24,
		marginBottom: 64,
	},
	settingUnavailableText: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.4)',
		fontStyle: 'italic',
	},
});

export default SettingsScreen;
