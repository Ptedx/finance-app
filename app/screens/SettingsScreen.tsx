import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router, Stack } from 'expo-router';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	ActivityIndicator,
	Alert,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
// iOS-only e depreciado no react-native; o do safe-area-context respeita os insets
// no Android tambem, que e o que o resto do app ja usa.
import { SafeAreaView } from 'react-native-safe-area-context';
import CurrencySelector from '../components/CurrencySelector';
import LanguageSelector from '../components/LanguageSelector';
import OwnNameSheet from '../components/OwnNameSheet';
import HelpButton from '../components/tour/HelpButton';
import { TourTarget, useScreenTour, useTourScroll } from '../components/tour/TourContext';
import { useAuth } from '../contexts/AuthContext';
import { useBills } from '../contexts/BillsContext';
import { useCaptures } from '../contexts/CapturesContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useLanguage } from '../contexts/LanguageContext';
import { usePeriod } from '../contexts/PeriodContext';
import { describeSync, useSync } from '../contexts/SyncContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { exportDiagnostics } from '../diagnostics/export';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import type { StatementAccountChooser } from '../utils/accountResolver';
import {
	type BiometricKind,
	biometricIcon,
	biometricKindOf,
	changeBiometricLock,
} from '../utils/biometricLock';
import * as biometricUtils from '../utils/biometricUtils';
import { eraseAllData } from '../utils/dataWipe';
import { formatMonthYear } from '../utils/dateUtils';
import { exportDatabaseData, importDatabaseData } from '../utils/exportUtils';
import { formatCents } from '../utils/money';
import * as notificationUtils from '../utils/notificationUtils';
import { getOwnBankName, setOwnBankName } from '../utils/ownNamePreference';
import {
	createStatementInstallments,
	type StatementChoiceAnswer,
	StatementImportError,
	type StatementInstallmentOffer,
	walkStatementChoice,
	withStatementAccountChooser,
} from '../utils/statementImport';

const SettingsScreen = () => {
	const { t } = useTranslation();
	const { account, isAvailable: isAuthAvailable } = useAuth();
	// A linha da conta diz o mesmo que a tela da conta, em versão curta (E2E-36): era
	// "Tudo salvo" fixo, até offline e com alterações presas.
	const { status: syncStatus, pending: syncPending } = useSync();
	const syncShort = describeSync(syncStatus, syncPending).short;
	const { currentCurrency } = useCurrency();
	const { currentLanguage } = useLanguage();
	// O backup não passa mais pelo estado da tela: `exportDatabaseData` lê o banco. A
	// tela entregava `transactions`/`categories` daqui, e um contexto que ainda não
	// carregou (ou que falhou) virava um arquivo válido e vazio.
	const { refreshData } = useTransactions();
	const { resetToCurrentMonth } = usePeriod();
	const { rescheduleReminders: rescheduleBillReminders } = useBills();
	const { authenticate } = useBiometricAuth();
	const {
		supported: captureSupported,
		enabled: captureEnabled,
		pendingCount: capturePending,
		openSettings: openCaptureSettings,
		importStatement,
	} = useCaptures();
	const [isImportingStatement, setIsImportingStatement] = useState(false);

	/**
	 * Extrato OFX: nada entra no livro sem revisão. O resumo diz quantas linhas o app
	 * já conhecia, quantas foram para a caixa de entrada e quantas ficaram de fora.
	 */
	/**
	 * "Este extrato é do cartão Nubank Teste (final 1111)?" (E2E-34): o import pergunta
	 * quando só o final bate, ou quando há mais de um candidato. Este / outro / criar novo,
	 * uma conta de cada vez (`walkStatementChoice`).
	 */
	const askStatementAccount: StatementAccountChooser = (question) =>
		walkStatementChoice(
			question,
			(candidate, hasMore) =>
				new Promise<StatementChoiceAnswer>((resolve) => {
					// Quem bateu pelo final mostra o do extrato (pode ser o de um virtual); os outros, o seu.
					const last4 = question.candidates.includes(candidate) ? (question.last4 ?? candidate.last4) : candidate.last4;
					const title =
						question.isCard && question.last4
							? t('captures.import.matchTitleCard', { bank: question.bankName, last4: question.last4 })
							: t('captures.import.matchTitle', { bank: question.bankName });
					const message = !question.isCard
						? t('captures.import.matchAccount', { name: candidate.name })
						: last4
							? t('captures.import.matchCard', { name: candidate.name, last4 })
							: t('captures.import.matchCardNoLast4', { name: candidate.name });
					const other = question.isCard ? t('captures.import.matchOtherCard') : t('captures.import.matchOtherAccount');
					Alert.alert(
						title,
						message,
						[
							{ text: t('captures.import.matchNew'), onPress: () => resolve('new') },
							...(hasMore ? [{ text: other, onPress: () => resolve('other') }] : []),
							{ text: t('captures.import.matchThis'), onPress: () => resolve('this') },
						],
						{ cancelable: false }
					);
				})
		);

	/**
	 * "PADARIA 3/10 de R$ 50,00 veio no extrato, mas o app não tem as outras parcelas"
	 * (SPD-117): uma pergunta por compra, depois do resumo. Só cria com o "Criar parcelas".
	 */
	const askInstallmentOffer = (offer: StatementInstallmentOffer) =>
		new Promise<boolean>((resolve) => {
			const first = offer.parcels[0];
			const last = offer.parcels[offer.parcels.length - 1];
			Alert.alert(
				t('captures.import.installmentsTitle'),
				t('captures.import.installmentsOffer', {
					count: offer.parcels.length,
					name: offer.description,
					index: offer.index,
					total: offer.count,
					amount: formatCents(offer.parcelCents),
					account: offer.accountName,
					first: first.index,
					firstMonth: formatMonthYear(first.date),
					lastMonth: formatMonthYear(last.date),
				}),
				[
					{ text: t('captures.import.installmentsSkip'), style: 'cancel', onPress: () => resolve(false) },
					{ text: t('captures.import.installmentsCreate'), onPress: () => resolve(true) },
				],
				{ cancelable: false }
			);
		});

	const handleImportStatement = async () => {
		try {
			setIsImportingStatement(true);
			const result = await withStatementAccountChooser(askStatementAccount, importStatement);
			if (!result) return;
			// O import terminou: o resumo e as ofertas não são mais "importando".
			setIsImportingStatement(false);

			const s = result.summary;
			const toReview = s.pending + s.questions;
			// Uma linha por número, cada uma no singular ou no plural dele: com uma chave só para
			// o resumo inteiro, um arquivo de uma linha dizia "1 linhas no arquivo" (E2E-51).
			const body = [
				t('captures.import.summaryTotal', { count: s.total }),
				t('captures.import.summaryKnown', { count: s.skippedExisting + s.matchedCaptures + s.matchedTransactions }),
				t('captures.import.summaryReview', { count: toReview }),
				t('captures.import.summaryAuto', { count: s.autoConfirmed }),
				t('captures.import.summaryIgnored', { count: s.ignored + s.transfers }),
			].join('\n');
			// O resumo primeiro; as ofertas de parcelas depois dele, e só então a revisão.
			const review = await new Promise<boolean>((resolve) =>
				Alert.alert(
					t('captures.import.title'),
					body,
					toReview > 0
						? [
								{ text: t('settings.ok'), onPress: () => resolve(false) },
								{ text: t('captures.import.review'), onPress: () => resolve(true) },
							]
						: [{ text: t('settings.ok'), onPress: () => resolve(false) }],
					{ cancelable: false }
				)
			);
			let created = 0;
			for (const offer of result.installmentOffers) {
				if (await askInstallmentOffer(offer)) created += await createStatementInstallments(offer);
			}
			if (created > 0) await refreshData();
			if (review) router.push('/inbox');
		} catch (error) {
			console.error('Error importing statement:', error);
			const code = error instanceof StatementImportError ? error.code : 'failed';
			Alert.alert(t('captures.import.failedTitle'), t(`captures.import.error_${code}`));
		} finally {
			setIsImportingStatement(false);
		}
	};

	const [_darkMode, _setDarkMode] = useState(true);
	const [notifications, setNotifications] = useState(true);
	const [showCurrencySelector, setShowCurrencySelector] = useState(false);
	const [showLanguageSelector, setShowLanguageSelector] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [isExportingDiagnostics, setIsExportingDiagnostics] = useState(false);
	const [isTogglingNotifications, setIsTogglingNotifications] = useState(false);

	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricEnabled, setBiometricEnabled] = useState(false);
	const [biometricKind, setBiometricKind] = useState<BiometricKind>('biometric');
	// O nome do método no meio da frase ("Autentique com biometria..."), no idioma do app.
	const biometricType = t(`settings.biometricMethod.${biometricKind}`);

	useEffect(() => {
		const checkBiometrics = async () => {
			try {
				const available = await biometricUtils.isBiometricAvailable();
				setBiometricAvailable(available);
				if (available) {
					const types = await biometricUtils.getSupportedAuthTypes();
					setBiometricKind(biometricKindOf(types, Platform.OS));
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

	// "Seu nome como aparece no banco" (SPD-115): a captura confere o nome dos avisos de Pix
	// com ele para juntar sem perguntar a transferência entre contas suas, inclusive de bancos
	// diferentes. Só aparece com a captura (a linha mora na seção dela).
	const [ownBankName, setOwnBankNameState] = useState<string | null>(null);
	const [showOwnNameSheet, setShowOwnNameSheet] = useState(false);
	// O guia dos Ajustes (SPD-129): abre sem seletor nem folha por cima.
	useScreenTour('settings', { blocked: showCurrencySelector || showLanguageSelector || showOwnNameSheet });
	const tourScroll = useTourScroll('settings');

	useEffect(() => {
		getOwnBankName().then(setOwnBankNameState);
	}, []);

	const saveOwnBankName = async (name: string) => {
		try {
			setOwnBankNameState(await setOwnBankName(name));
			setShowOwnNameSheet(false);
		} catch (error) {
			console.error('Error saving own bank name:', error);
			Alert.alert(t('settings.error'), t('ownName.saveError'));
		}
	};

	const refreshAppData = async () => {
		try {
			resetToCurrentMonth();
			await refreshData();
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
				// As recorrências antigas não lembram mais nada (SPD-122): ligar a chave só remarca
				// as contas a pagar e as faturas, logo abaixo.
				await notificationUtils.registerForPushNotificationsAsync();
			} else {
				await notificationUtils.cancelAllNotifications();
			}
			// Os lembretes das contas a pagar seguem a chave: ligada, voltam a ser agendados
			// com as contas atuais; desligada, a remarcação só cancela.
			await rescheduleBillReminders();
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
			await exportDatabaseData();
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
				// O resumo do que voltou (e do que não voltou) vem pronto e traduzido do import.
				Alert.alert(t('settings.importSuccess'), result.message);
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

	/**
	 * "Apagar todos os dados" (SPD-082, DEC-35): o que sai e o que fica está em
	 * `utils/dataWipe.ts`. Logado, apaga na conta e em todos os aparelhos — e, se o servidor
	 * não confirmar, nada sai daqui. A configuração fica, então o destino é a tela inicial,
	 * não o onboarding.
	 */
	const handleResetData = async () => {
		const signedIn = account !== null;
		const message = t(signedIn ? 'settings.resetMsgAccount' : 'settings.resetMsg');
		Alert.alert(t('settings.resetTitle'), message, [
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
								const result = await eraseAllData({ signedIn });
								setIsResetting(false);
								if (!result.ok) {
									Alert.alert(t('settings.resetFailed'), t('settings.resetServerError'));
									return;
								}
								// As telas releem pelo aviso do `eraseAllData`; o mês volta para o atual.
								resetToCurrentMonth();
								Alert.alert(
									t('settings.resetSuccess'),
									t(signedIn ? 'settings.resetSuccessMsgAccount' : 'settings.resetSuccessMsg'),
									[{ text: t('settings.ok'), onPress: () => router.dismissTo('/(tabs)') }]
								);
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

	/**
	 * O diário do aparelho num arquivo, para mandar a quem for depurar. Pede confirmação
	 * antes: o arquivo pode ter texto de notificação do banco (DEC-11 b).
	 */
	const handleExportDiagnostics = () => {
		Alert.alert(t('diagnostics.confirmTitle'), t('diagnostics.confirmMsg'), [
			{ text: t('settings.cancel'), style: 'cancel' },
			{
				text: t('diagnostics.confirmAction'),
				onPress: async () => {
					try {
						setIsExportingDiagnostics(true);
						const result = await exportDiagnostics(t('diagnostics.exportItem'));
						if (result.status === 'empty') {
							Alert.alert(t('diagnostics.emptyTitle'), t('diagnostics.emptyMsg'));
						} else if (result.status === 'unavailable') {
							Alert.alert(t('diagnostics.failedTitle'), t('diagnostics.unavailableMsg'));
						}
					} catch (error) {
						console.error('Error exporting diagnostics:', error);
						Alert.alert(t('diagnostics.failedTitle'), t('diagnostics.failedMsg'));
					} finally {
						setIsExportingDiagnostics(false);
					}
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

	// Ligar e desligar passam pela biometria (E2E-19): desligar era um toque, e quem pegasse
	// o celular com o app aberto tirava a trava. Falhou ou cancelou, fica como estava.
	const toggleBiometricAuth = async (value: boolean) => {
		const next = await changeBiometricLock(value, biometricEnabled, {
			authenticate: biometricUtils.authenticateWithBiometrics,
			save: biometricUtils.setBiometricEnabled,
			reason: (enabling) =>
				t(enabling ? 'settings.biometricEnablePrompt' : 'settings.biometricDisablePrompt'),
		});
		setBiometricEnabled(next);
	};

	// `tourId`: o passo do guia dos Ajustes que aponta este item (SPD-129).
	const renderSettingsItem = (
		icon: string,
		title: string,
		onPress: () => void,
		rightElement?: React.ReactNode,
		tourId?: string
	) => (
		<TourTarget id={tourId}>
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
		</TourTarget>
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
				<Pressable
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('debts.back')}
					hitSlop={12}
					style={styles.backButton}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('settings.headerTitle')}
				</Text>
			</View>

			<ScrollView ref={tourScroll} style={styles.content} showsVerticalScrollIndicator={false}>
				{/* Account. Escondida quando a build não tem API configurada: oferecer uma
				    tela que falharia em toda tentativa é pior do que não oferecer nada. */}
				{isAuthAvailable && (
					<View style={styles.section}>
						<Text style={styles.sectionTitle}>{t('account.screenTitle')}</Text>
						{renderSettingsItem(
							account ? 'cloud-done-outline' : 'cloud-upload-outline',
							account ? account.email : t('account.signUpTitle'),
							() => router.push('/account'),
							<Text style={styles.accountStatus}>
								{account ? t(syncShort.key, { count: syncShort.count }) : ''}
							</Text>,
							'settings.account'
						)}
					</View>
				)}

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
					{renderSettingsItem('wallet-outline', t('accounts.screenTitle'), () => router.push('/accounts'), undefined, 'settings.accounts')}
					{renderSettingsItem('card-outline', t('cards.sectionTitle'), () => router.push('/cards'), undefined, 'settings.cards')}
					{renderSettingsItem('receipt-outline', t('bills.title'), () => router.push('/bills'), undefined, 'settings.bills')}
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
								biometricIcon(biometricKind),
								t(`settings.biometricLock.${biometricKind}`),
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
						isExporting ? <ActivityIndicator size="small" color="#15E8FE" /> : undefined,
						'settings.backup'
					)}
					{renderSettingsItem(
						'cloud-upload-outline',
						t('settings.importData'),
						handleImportData,
						isImporting ? <ActivityIndicator size="small" color="#15E8FE" /> : undefined
					)}
					{/* O "?" da trilha do extrato (SPD-131c) fica no lugar da seta, ao lado do item. */}
					{renderSettingsItem(
						'document-text-outline',
						t('captures.import.item'),
						handleImportStatement,
						isImportingStatement ? (
							<ActivityIndicator size="small" color="#15E8FE" />
						) : (
							<View style={styles.helpInItem}>
								<HelpButton trail="ofx" here={{ screen: 'settings' }} />
							</View>
						),
						'settings.ofx'
					)}
					{renderSettingsItem(
						'trash-outline',
						t('settings.resetAllData'),
						handleResetData,
						isResetting ? <ActivityIndicator size="small" color="#FF6B6B" /> : undefined
					)}
				</View>

				{/* Captura automática: ligar o acesso a notificações e abrir a revisão.
				    Ligar é do sistema, não do app — o item leva para a tela do Android. */}
				{captureSupported && (
					<View style={styles.section}>
						{/* O "?" da trilha da captura (SPD-131), ao lado do título da seção. */}
						<TourTarget id="settings.captureSection" style={styles.sectionTitleRow}>
							<Text style={[styles.sectionTitle, styles.sectionTitleInRow]}>{t('captures.settingsSection')}</Text>
							<HelpButton trail="capture" here={{ screen: 'settings' }} />
						</TourTarget>
						{renderSettingsItem(
							'notifications-circle-outline',
							t('captures.settingsCapture'),
							openCaptureSettings,
							<Text style={captureEnabled ? styles.accountStatus : styles.settingUnavailableText}>
								{captureEnabled ? t('captures.statusOn') : t('captures.statusOff')}
							</Text>,
							'settings.capture'
						)}
						{renderSettingsItem(
							'checkmark-done-outline',
							t('captures.settingsReview'),
							() => router.push('/inbox'),
							capturePending > 0 ? (
								<Text style={styles.accountStatus}>{capturePending}</Text>
							) : undefined,
							'settings.review'
						)}
						{renderSettingsItem(
							'person-circle-outline',
							t('ownName.settingsItem'),
							() => setShowOwnNameSheet(true),
							<Text
								style={[ownBankName ? styles.accountStatus : styles.settingUnavailableText, styles.ownNameValue]}
								numberOfLines={1}
							>
								{ownBankName ?? t('ownName.notSet')}
							</Text>,
							'settings.ownName'
						)}
					</View>
				)}

				{/* About */}
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{t('settings.about')}</Text>
					{/* Ajustes › Como usar (SPD-129): os tópicos para ler e o guia de cada tela. */}
					{renderSettingsItem('help-circle-outline', t('tutorial.howTo.settingsItem'), () => router.push('/howto'))}
					{renderSettingsItem('information-circle-outline', t('settings.aboutSpendr'), handleAbout)}
					{renderSettingsItem(
						'bug-outline',
						t('diagnostics.exportItem'),
						handleExportDiagnostics,
						isExportingDiagnostics ? <ActivityIndicator size="small" color="#15E8FE" /> : undefined
					)}
				</View>

				{/* A versão do app instalado, lida da configuração embutida no build — é por ela que se
				    sabe se o celular está na 1.0 ou na 1.1 antes de reinstalar uma delas. */}
				<Text style={styles.versionText}>{t('settings.version', { version: Constants.expoConfig?.version ?? '—' })}</Text>
			</ScrollView>

			<CurrencySelector
				isVisible={showCurrencySelector}
				onClose={() => setShowCurrencySelector(false)}
			/>
			<LanguageSelector
				isVisible={showLanguageSelector}
				onClose={() => setShowLanguageSelector(false)}
			/>
			{captureSupported && (
				<OwnNameSheet
					visible={showOwnNameSheet}
					value={ownBankName}
					onClose={() => setShowOwnNameSheet(false)}
					onSave={saveOwnBankName}
				/>
			)}
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
		paddingHorizontal: 16,
		// Só o respiro do cabeçalho: a área segura já põe a tela abaixo da barra de status, e
		// os 60 que estavam aqui dobravam o vão no topo (SPD-121).
		paddingVertical: 12,
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
	accountStatus: {
		color: '#8E8E93',
		fontSize: 12,
	},
	sectionTitleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	sectionTitleInRow: {
		marginBottom: 0,
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
	// O "?" tem 48 de toque; a margem negativa não deixa ele aumentar a linha do item.
	helpInItem: {
		marginVertical: -12,
		marginRight: -12,
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
	// O nome salvo à direita da linha: um nome comprido não empurra o título para fora.
	ownNameValue: {
		flexShrink: 1,
		maxWidth: '45%',
		marginLeft: 12,
		textAlign: 'right',
	},
});

export default SettingsScreen;
