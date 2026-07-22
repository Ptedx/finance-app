import './i18n';
import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import { Slot, SplashScreen, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import BiometricAuthScreen from './components/BiometricAuthScreen';
import { AuthProvider } from './contexts/AuthContext';
import { BudgetProvider } from './contexts/BudgetContext';
import { CurrencyProvider } from './contexts/CurrencyContext';
import { LanguageProvider } from './contexts/LanguageContext';
import { PeriodProvider } from './contexts/PeriodContext';
import { RecurringTransactionsProvider } from './contexts/RecurringTransactionsContext';
import { SyncProvider } from './contexts/SyncContext';
import { TransactionsProvider } from './contexts/TransactionsContext';
import { initDatabase } from './database/database';
import biometricUtils from './utils/biometricUtils';
import { isOnboardingCompleted } from './utils/onboardingUtils';

// Prevent the splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
	const router = useRouter();
	const [fontsLoaded] = useFonts({
		// If you want to add custom fonts, add them here
	});
	const [isDbInitialized, setIsDbInitialized] = useState(false);
	const [initError, setInitError] = useState<string | null>(null);
	const [showBiometricAuth, setShowBiometricAuth] = useState(false);
	const [biometricCheckComplete, setBiometricCheckComplete] = useState(false);
	const [onboardingChecked, setOnboardingChecked] = useState(false);
	const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);

	const handleBiometricSuccess = () => {
		setShowBiometricAuth(false);
		setBiometricCheckComplete(true);
	};

	// Check if user has completed onboarding
	useEffect(() => {
		const checkOnboardingStatus = async () => {
			try {
				const completed = await isOnboardingCompleted();
				setHasCompletedOnboarding(completed);
				setOnboardingChecked(true);
			} catch (error) {
				console.error('Error checking onboarding status:', error);
				setHasCompletedOnboarding(false);
				setOnboardingChecked(true);
			}
		};

		checkOnboardingStatus();
	}, []);

	// Redirect to onboarding if not completed
	useEffect(() => {
		if (onboardingChecked && !hasCompletedOnboarding && isDbInitialized && fontsLoaded) {
			// Hide splash screen before redirecting
			SplashScreen.hideAsync().catch((e) => console.warn('SplashScreen.hideAsync failed:', e));

			// Use a timeout to ensure the splash screen has a chance to hide
			const timer = setTimeout(() => {
				router.replace('/onboarding');
			}, 100);

			return () => clearTimeout(timer);
		}
	}, [onboardingChecked, hasCompletedOnboarding, isDbInitialized, fontsLoaded, router]);

	useEffect(() => {
		const checkBiometricSettings = async () => {
			try {
				const available = await biometricUtils.isBiometricAvailable();
				const enabled = available ? await biometricUtils.isBiometricEnabled() : false;

				// Only show the auth screen if biometrics are available, enabled, and onboarding is completed
				setShowBiometricAuth(available && enabled && hasCompletedOnboarding);

				// If biometrics aren't enabled, mark the check as complete
				if (!available || !enabled || !hasCompletedOnboarding) {
					setBiometricCheckComplete(true);
				}
			} catch (error) {
				console.error('Error checking biometric settings:', error);
				setShowBiometricAuth(false);
				setBiometricCheckComplete(true);
			}
		};

		if (onboardingChecked) {
			checkBiometricSettings();
		}
	}, [onboardingChecked, hasCompletedOnboarding]);

	useEffect(() => {
		const migrateStorageKeys = async () => {
			const keyMap: Record<string, string> = {
				'@expensify_biometric_enabled': '@spendr_biometric_enabled',
				'@expensify_notifications_enabled': '@spendr_notifications_enabled',
				'@expensify_push_token': '@spendr_push_token',
				'@expensify_scheduled_notifications': '@spendr_scheduled_notifications',
				'@expensify_onboarding_completed': '@spendr_onboarding_completed',
			};
			try {
				for (const [oldKey, newKey] of Object.entries(keyMap)) {
					const value = await AsyncStorage.getItem(oldKey);
					if (value !== null) {
						await AsyncStorage.setItem(newKey, value);
						await AsyncStorage.removeItem(oldKey);
					}
				}
			} catch (error) {
				console.warn('Storage migration error:', error);
			}
		};

		const initializeApp = async () => {
			try {
				await migrateStorageKeys();
				// Initialize the database
				await initDatabase();
				setIsDbInitialized(true);
			} catch (error) {
				console.error('Error initializing the app:', error);

				// A mensagem real vai para a tela, não só um "falhou" genérico: numa build
				// release não há redbox nem console, e esta é a única pista que o usuário
				// (ou quem for depurar) tem sobre o que aconteceu.
				setInitError(
					`Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`
				);

				// Sem isto a splash screen fica por cima da mensagem de erro, e o app
				// continua parecendo travado em vez de explicado.
				SplashScreen.hideAsync().catch(() => {});
			}
		};

		initializeApp();
	}, []);

	useEffect(() => {
		if (
			fontsLoaded &&
			isDbInitialized &&
			onboardingChecked &&
			(hasCompletedOnboarding ? biometricCheckComplete : true)
		) {
			// Hide the splash screen once everything is loaded
			SplashScreen.hideAsync().catch((e) => console.warn('SplashScreen.hideAsync failed:', e));
		}
	}, [
		fontsLoaded,
		isDbInitialized,
		onboardingChecked,
		hasCompletedOnboarding,
		biometricCheckComplete,
	]);

	// O erro vem ANTES da tela de carregamento, e não depois.
	//
	// Na ordem inversa este branch era inalcançável: uma falha em `initDatabase` deixa
	// `isDbInitialized` em false, o `return null` abaixo assumia, e o app ficava parado
	// na splash screen — sem crash, sem log, sem nada na tela. Um app que não abre e não
	// diz por quê é indistinguível de um app travado.
	if (initError) {
		return (
			<View
				style={{
					flex: 1,
					justifyContent: 'center',
					alignItems: 'center',
					backgroundColor: '#121212',
					padding: 24,
				}}
			>
				<Text style={{ color: '#ffffff', fontSize: 16, textAlign: 'center' }}>
					{initError}. Please restart the app.
				</Text>
			</View>
		);
	}

	if (!fontsLoaded || !isDbInitialized || !onboardingChecked) {
		return null;
	}

	// AuthProvider fica acima de CurrencyProvider porque a moeda e o idioma passam a vir
	// do perfil quando há sessão; SyncProvider só expõe o estado da fila, que é um módulo.
	return (
		<AuthProvider>
		<SyncProvider>
		<LanguageProvider>
		<CurrencyProvider>
			<PeriodProvider>
				<BudgetProvider>
					<TransactionsProvider>
						<RecurringTransactionsProvider>
							<StatusBar style="light" />
							<Slot />
							{showBiometricAuth && <BiometricAuthScreen onSuccess={handleBiometricSuccess} />}
						</RecurringTransactionsProvider>
					</TransactionsProvider>
				</BudgetProvider>
			</PeriodProvider>
		</CurrencyProvider>
		</LanguageProvider>
		</SyncProvider>
		</AuthProvider>
	);
}
