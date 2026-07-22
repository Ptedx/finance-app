import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	ActivityIndicator,
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
// O `SafeAreaView` do react-native não faz nada no Android (é iOS-only, e está
// depreciado), e por isso a tela encostava na barra de status. Todas as demais telas
// deste app já usam o do safe-area-context, que respeita os insets nas duas plataformas.
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useSync } from '../contexts/SyncContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { formatFullDate } from '../utils/dateUtils';

type Mode = 'signIn' | 'signUp';

/**
 * Entrar, criar conta e ver o estado da sincronização.
 *
 * A tela é opcional por definição: o app funciona inteiro sem passar por aqui, e sair
 * da conta devolve o usuário ao modo anônimo com os dados intactos.
 */
const AccountScreen: React.FC = () => {
	const { t } = useTranslation();
	const { account, isAvailable, signIn, signUp, signOut, pendingClaim, resolveClaim } = useAuth();
	const { status, pending, lastSyncedAt, syncNow } = useSync();
	const { refreshData } = useTransactions();
	const { currentCurrency } = useCurrency();

	const [mode, setMode] = useState<Mode>('signUp');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [name, setName] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	const showError = (error: unknown) => {
		const message =
			error instanceof ApiError ? error.message : t('account.genericError');
		Alert.alert(t('account.errorTitle'), message);
	};

	const handleSubmit = async () => {
		const trimmedEmail = email.trim();

		if (!trimmedEmail || !password || (mode === 'signUp' && !name.trim())) {
			Alert.alert(t('account.errorTitle'), t('account.fillAllFields'));
			return;
		}

		if (mode === 'signUp' && password.length < 8) {
			Alert.alert(t('account.errorTitle'), t('account.passwordTooShort'));
			return;
		}

		try {
			setIsSubmitting(true);

			if (mode === 'signUp') {
				await signUp({ email: trimmedEmail, password, name: name.trim() });
			} else {
				await signIn({ email: trimmedEmail, password });
			}

			setPassword('');
		} catch (error) {
			showError(error);
		} finally {
			setIsSubmitting(false);
		}
	};

	/**
	 * Descartar é destrutivo e irreversível, então passa por uma confirmação explícita
	 * que nomeia o que se perde. Mesclar não precisa: nada some.
	 */
	const handleClaim = (choice: 'merge' | 'discard') => {
		const apply = async () => {
			try {
				setIsSubmitting(true);
				await resolveClaim(choice);
				await refreshData();
			} catch (error) {
				showError(error);
			} finally {
				setIsSubmitting(false);
			}
		};

		if (choice === 'merge') {
			apply();
			return;
		}

		Alert.alert(t('account.discardTitle'), t('account.discardConfirm'), [
			{ text: t('account.cancel'), style: 'cancel' },
			{ text: t('account.discardAction'), style: 'destructive', onPress: apply },
		]);
	};

	const handleSignOut = () => {
		Alert.alert(t('account.signOutTitle'), t('account.signOutConfirm'), [
			{ text: t('account.cancel'), style: 'cancel' },
			{
				text: t('account.signOut'),
				style: 'destructive',
				onPress: async () => {
					try {
						await signOut();
					} catch (error) {
						showError(error);
					}
				},
			},
		]);
	};

	const statusLabel = () => {
		if (status === 'syncing') return t('account.statusSyncing');
		if (status === 'offline') return t('account.statusOffline', { count: pending });
		if (status === 'error') return t('account.statusError');
		return pending > 0 ? t('account.statusPending', { count: pending }) : t('account.statusSynced');
	};

	const statusColor = () => {
		if (status === 'error') return '#FF6B6B';
		if (status === 'offline') return '#FFCC5C';
		return pending > 0 ? '#FFCC5C' : '#4CAF50';
	};

	const header = (
		<Stack.Screen
			options={{
				title: t('account.screenTitle'),
				headerStyle: { backgroundColor: '#121212' },
				headerTintColor: '#FFFFFF',
			}}
		/>
	);

	// Sem URL de API configurada não há o que oferecer: melhor dizer isso do que
	// mostrar um formulário que falharia em toda tentativa.
	if (!isAvailable) {
		return (
			<SafeAreaView style={styles.container}>
				{header}
				<View style={styles.centered}>
					<Ionicons name="cloud-offline-outline" size={48} color="#8E8E93" />
					<Text style={styles.unavailable}>{t('account.unavailable')}</Text>
				</View>
			</SafeAreaView>
		);
	}

	// ------------------------------------------------------------------
	// Conta conectada, mas com dados locais esperando decisão
	// ------------------------------------------------------------------
	if (account && pendingClaim) {
		return (
			<SafeAreaView style={styles.container}>
				{header}
				<ScrollView contentContainerStyle={styles.content}>
					<Ionicons name="git-merge-outline" size={40} color="#15E8FE" style={styles.heroIcon} />
					<Text style={styles.title}>{t('account.claimTitle')}</Text>
					<Text style={styles.paragraph}>{t('account.claimExplanation')}</Text>

					<TouchableOpacity
						style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]}
						onPress={() => handleClaim('merge')}
						disabled={isSubmitting}
					>
						{isSubmitting ? (
							<ActivityIndicator color="#121212" />
						) : (
							<Text style={styles.primaryButtonText}>{t('account.claimMerge')}</Text>
						)}
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.claimMergeHint')}</Text>

					<TouchableOpacity
						style={[styles.dangerButton, isSubmitting && styles.buttonDisabled]}
						onPress={() => handleClaim('discard')}
						disabled={isSubmitting}
					>
						<Text style={styles.dangerButtonText}>{t('account.claimDiscard')}</Text>
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.claimDiscardHint')}</Text>
				</ScrollView>
			</SafeAreaView>
		);
	}

	// ------------------------------------------------------------------
	// Conta conectada
	// ------------------------------------------------------------------
	if (account) {
		return (
			<SafeAreaView style={styles.container}>
				{header}
				<ScrollView contentContainerStyle={styles.content}>
					<View style={styles.card}>
						<Text style={styles.cardLabel}>{t('account.signedInAs')}</Text>
						<Text style={styles.cardValue}>{account.email}</Text>
						<Text style={styles.cardSubvalue}>{account.name}</Text>
					</View>

					<View style={styles.card}>
						<View style={styles.statusRow}>
							<View style={[styles.statusDot, { backgroundColor: statusColor() }]} />
							<Text style={styles.cardValue}>{statusLabel()}</Text>
						</View>

						{lastSyncedAt && (
							<Text style={styles.cardSubvalue}>
								{t('account.lastSynced', { date: formatFullDate(lastSyncedAt) })}
							</Text>
						)}

						<TouchableOpacity
							style={styles.secondaryButton}
							onPress={syncNow}
							disabled={status === 'syncing'}
						>
							<Ionicons name="sync" size={16} color="#15E8FE" />
							<Text style={styles.secondaryButtonText}>{t('account.syncNow')}</Text>
						</TouchableOpacity>
					</View>

					<TouchableOpacity style={styles.dangerButton} onPress={handleSignOut}>
						<Text style={styles.dangerButtonText}>{t('account.signOut')}</Text>
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.signOutHint')}</Text>
				</ScrollView>
			</SafeAreaView>
		);
	}

	// ------------------------------------------------------------------
	// Modo anônimo: entrar ou criar conta
	// ------------------------------------------------------------------
	return (
		<SafeAreaView style={styles.container}>
			{header}
			<KeyboardAvoidingView
				style={styles.flex}
				behavior={Platform.OS === 'ios' ? 'padding' : undefined}
			>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<Text style={styles.title}>
						{mode === 'signUp' ? t('account.signUpTitle') : t('account.signInTitle')}
					</Text>
					<Text style={styles.paragraph}>{t('account.intro')}</Text>

					{mode === 'signUp' && (
						<TextInput
							style={styles.input}
							placeholder={t('account.namePlaceholder')}
							placeholderTextColor="#6B7280"
							value={name}
							onChangeText={setName}
							autoCapitalize="words"
							textContentType="name"
						/>
					)}

					<TextInput
						style={styles.input}
						placeholder={t('account.emailPlaceholder')}
						placeholderTextColor="#6B7280"
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="email-address"
						textContentType="emailAddress"
					/>

					<TextInput
						style={styles.input}
						placeholder={t('account.passwordPlaceholder')}
						placeholderTextColor="#6B7280"
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						autoCapitalize="none"
						textContentType={mode === 'signUp' ? 'newPassword' : 'password'}
					/>

					<TouchableOpacity
						style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]}
						onPress={handleSubmit}
						disabled={isSubmitting}
					>
						{isSubmitting ? (
							<ActivityIndicator color="#121212" />
						) : (
							<Text style={styles.primaryButtonText}>
								{mode === 'signUp' ? t('account.signUp') : t('account.signIn')}
							</Text>
						)}
					</TouchableOpacity>

					<TouchableOpacity
						style={styles.switchMode}
						onPress={() => setMode(mode === 'signUp' ? 'signIn' : 'signUp')}
						disabled={isSubmitting}
					>
						<Text style={styles.switchModeText}>
							{mode === 'signUp' ? t('account.haveAccount') : t('account.noAccount')}
						</Text>
					</TouchableOpacity>

					<Text style={styles.footnote}>
						{t('account.currencyNote', { currency: currentCurrency.code })}
					</Text>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: '#121212' },
	flex: { flex: 1 },
	content: { padding: 20, paddingBottom: 40 },
	centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
	heroIcon: { alignSelf: 'center', marginBottom: 16 },
	title: { color: '#FFFFFF', fontSize: 24, fontWeight: '700', marginBottom: 8 },
	paragraph: { color: '#8E8E93', fontSize: 14, lineHeight: 20, marginBottom: 24 },
	unavailable: { color: '#8E8E93', fontSize: 14, textAlign: 'center', marginTop: 16 },
	input: {
		backgroundColor: '#1C1C1E',
		borderRadius: 10,
		borderWidth: 1,
		borderColor: '#2C2C2E',
		color: '#FFFFFF',
		fontSize: 16,
		paddingHorizontal: 16,
		paddingVertical: 14,
		marginBottom: 12,
	},
	primaryButton: {
		backgroundColor: '#15E8FE',
		borderRadius: 10,
		paddingVertical: 16,
		alignItems: 'center',
		marginTop: 8,
	},
	primaryButtonText: { color: '#121212', fontSize: 16, fontWeight: '700' },
	buttonDisabled: { opacity: 0.6 },
	secondaryButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		marginTop: 16,
		paddingVertical: 10,
	},
	secondaryButtonText: { color: '#15E8FE', fontSize: 15, fontWeight: '600' },
	dangerButton: {
		borderRadius: 10,
		borderWidth: 1,
		borderColor: '#FF6B6B',
		paddingVertical: 14,
		alignItems: 'center',
		marginTop: 20,
	},
	dangerButtonText: { color: '#FF6B6B', fontSize: 15, fontWeight: '600' },
	switchMode: { marginTop: 20, alignItems: 'center' },
	switchModeText: { color: '#15E8FE', fontSize: 14 },
	hint: { color: '#6B7280', fontSize: 12, lineHeight: 16, marginTop: 8, textAlign: 'center' },
	footnote: { color: '#6B7280', fontSize: 12, marginTop: 28, textAlign: 'center' },
	card: {
		backgroundColor: '#1C1C1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
	},
	cardLabel: {
		color: '#15E8FE',
		fontSize: 12,
		fontWeight: '600',
		textTransform: 'uppercase',
		letterSpacing: 1,
		marginBottom: 6,
	},
	cardValue: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
	cardSubvalue: { color: '#8E8E93', fontSize: 13, marginTop: 4 },
	statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	statusDot: { width: 8, height: 8, borderRadius: 4 },
});

export default AccountScreen;
