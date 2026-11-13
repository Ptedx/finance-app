import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	ActivityIndicator,
	Alert,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
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
import { usePeriod } from '../contexts/PeriodContext';
import { describeSync, useSync } from '../contexts/SyncContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import { claimSummaryParams } from '../sync/claim';
import { formatInstantDate } from '../utils/dateUtils';

type Mode = 'signIn' | 'signUp';

/** O que o modal da senha diz quando o servidor não apagou. */
type DeleteError = 'wrong_password' | 'unavailable';

/**
 * Entrar, criar conta e ver o estado da sincronização.
 *
 * A tela é opcional por definição: o app funciona inteiro sem passar por aqui, e sair
 * da conta devolve o usuário ao modo anônimo com os dados intactos. Apagar a conta
 * (SPD-084) também devolve, mas sem eles: a conta some do servidor e os dados, daqui.
 */
const AccountScreen: React.FC = () => {
	const { t } = useTranslation();
	const {
		account,
		isAvailable,
		signIn,
		signUp,
		signOut,
		deleteAccount,
		pendingClaim,
		claimCounts,
		resolveClaim,
	} = useAuth();
	/**
	 * `unsynced`: quantas linhas vivas ainda não subiram. Responde a pergunta que custou
	 * duas semanas de lançamentos ao dono: "o que existe aqui que não existe na minha
	 * conta?". É o que ele precisava ver antes de desinstalar o app.
	 *
	 * Vem do `SyncContext`, lido do banco na mesma leitura de `pending` (E2E-36): esta tela
	 * lia por conta própria, em outro momento, e mostrava "4 itens só existem neste
	 * aparelho" ao lado de "3 alterações aguardando envio". Lidos juntos, `unsynced` nunca
	 * passa de `pending`; a diferença são remoções esperando para subir.
	 */
	const { status, pending, unsynced: syncUnsynced, lastSyncedAt, syncNow } = useSync();
	const unsynced = account ? (syncUnsynced ?? null) : null;
	const { refreshData } = useTransactions();
	const { currentCurrency } = useCurrency();
	const { resetToCurrentMonth } = usePeriod();
	const { authenticate } = useBiometricAuth();

	const [mode, setMode] = useState<Mode>('signUp');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [name, setName] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	// "Apagar a conta": o modal da senha, a senha digitada nele e o que deu errado.
	const [deleteVisible, setDeleteVisible] = useState(false);
	const [deletePassword, setDeletePassword] = useState('');
	const [deleteError, setDeleteError] = useState<DeleteError | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

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
	 * Subir e descartar apagam um dos lados, então passam por uma confirmação que nomeia o
	 * que se perde. Juntar não precisa: nada some.
	 */
	const handleClaim = (choice: 'upload' | 'merge' | 'discard') => {
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

		if (choice === 'upload') {
			Alert.alert(t('account.uploadTitle'), t('account.uploadConfirm'), [
				{ text: t('account.cancel'), style: 'cancel' },
				{ text: t('account.uploadAction'), style: 'destructive', onPress: apply },
			]);
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

	/**
	 * "Apagar a conta" (SPD-084, DEC-35): a confirmação que diz o que some, a biometria
	 * como no "Apagar todos os dados" das Configurações e então a senha, num modal — o
	 * `Alert.prompt` só existe no iOS. O que acontece depois está em
	 * `utils/accountDeletion.ts`.
	 */
	const handleDeleteAccount = () => {
		Alert.alert(t('account.deleteTitle'), t('account.deleteConfirm'), [
			{ text: t('account.cancel'), style: 'cancel' },
			{
				text: t('account.deleteContinue'),
				style: 'destructive',
				onPress: async () => {
					await authenticate(
						t('account.deleteAuthMsg'),
						() => {
							setDeletePassword('');
							setDeleteError(null);
							setDeleteVisible(true);
						},
						() => {
							Alert.alert(t('settings.authFailed'), t('account.deleteAuthFailed'));
						}
					);
				},
			},
		]);
	};

	const closeDeleteModal = () => {
		if (isDeleting) return;
		setDeleteVisible(false);
		setDeletePassword('');
		setDeleteError(null);
	};

	/**
	 * Senha errada e "não deu agora" ficam no modal, para tentar de novo sem refazer a
	 * confirmação. Apagada, a tela da conta já não tem o que mostrar: vai para a inicial,
	 * e o aviso diz o que aconteceu.
	 */
	const confirmDeleteAccount = async () => {
		if (!deletePassword || isDeleting) return;

		setIsDeleting(true);
		setDeleteError(null);
		let result: Awaited<ReturnType<typeof deleteAccount>>;
		try {
			result = await deleteAccount(deletePassword);
		} catch (error) {
			// O `deleteAccountAndData` não deixa nada subir depois de o servidor apagar: um
			// erro aqui é de antes, e nada foi apagado.
			console.error('Error deleting account:', error);
			result = { ok: false, reason: 'unavailable' };
		}
		setIsDeleting(false);

		if (!result.ok && result.reason !== 'session_lost') {
			// A senha errada sai do campo, para ser digitada de novo; a do "não deu agora"
			// fica, para tentar de novo quando a internet voltar.
			if (result.reason === 'wrong_password') setDeletePassword('');
			setDeleteError(result.reason);
			return;
		}

		setDeleteVisible(false);
		setDeletePassword('');

		if (!result.ok) {
			// A sessão caiu no meio: a tela já voltou ao modo anônimo e a conta continua lá.
			Alert.alert(t('account.errorTitle'), t('account.deleteSessionLost'));
			return;
		}

		// As telas releem pelo aviso do `wipeDevice`; o mês volta para o atual, como no
		// "Apagar todos os dados".
		resetToCurrentMonth();
		router.dismissTo('/(tabs)');
		Alert.alert(
			t('account.deleteSuccessTitle'),
			t(result.deviceWiped ? 'account.deleteSuccessMsg' : 'account.deleteSuccessPartial')
		);
	};

	// O mesmo texto que a linha da conta em Ajustes usa, na versão longa (`describeSync`).
	const summary = describeSync(status, pending);
	const statusLabel = () => t(summary.label.key, { count: summary.label.count });

	const statusColor = () => {
		if (summary.tone === 'error') return '#FF6B6B';
		if (summary.tone === 'offline') return '#FFCC5C';
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

	// A pilha da raiz não desenha cabeçalho: a tela desenha o seu, como Configurações, de
	// onde se chega aqui.
	const topBar = (
		<View style={styles.topBar}>
			<Pressable
				onPress={() => router.back()}
				accessibilityRole="button"
				accessibilityLabel={t('account.back')}
				style={styles.iconButton}
			>
				<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
			</Pressable>
			<Text style={styles.topBarTitle} accessibilityRole="header" numberOfLines={1}>
				{t('account.screenTitle')}
			</Text>
		</View>
	);

	// Sem URL de API configurada não há o que oferecer: melhor dizer isso do que
	// mostrar um formulário que falharia em toda tentativa.
	if (!isAvailable) {
		return (
			<SafeAreaView style={styles.container}>
				{header}
				{topBar}
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
				{topBar}
				<ScrollView contentContainerStyle={styles.content}>
					<Ionicons name="git-merge-outline" size={40} color="#15E8FE" style={styles.heroIcon} />
					<Text style={styles.title}>{t('account.claimTitle')}</Text>
					<Text style={styles.paragraph}>{t('account.claimExplanation')}</Text>

					{/*
					 * Os dois lados no mesmo resumo, com a caixa de entrada, as contas e as
					 * dívidas: a pergunta passou a nascer de qualquer coleção, e mostrar só
					 * lançamentos fazia uma diferença na caixa de entrada parecer "0 e 0".
					 * O texto é o do resumo do backup, que já lista exatamente isso.
					 */}
					{claimCounts ? (
						<View style={styles.card} accessible>
							<Text style={styles.cardLabel}>{t('account.claimDevice')}</Text>
							<Text style={styles.paragraph}>
								{t('settings.exportSummary', claimSummaryParams(claimCounts.device))}
							</Text>
							<Text style={styles.cardLabel}>{t('account.claimAccount')}</Text>
							<Text style={styles.paragraph}>
								{t('settings.exportSummary', claimSummaryParams(claimCounts.account))}
							</Text>
						</View>
					) : null}

					{isSubmitting ? <ActivityIndicator color="#15E8FE" style={styles.heroIcon} /> : null}

					<TouchableOpacity
						style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]}
						onPress={() => handleClaim('upload')}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Text style={styles.primaryButtonText}>{t('account.claimUpload')}</Text>
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.claimUploadHint')}</Text>

					<TouchableOpacity
						style={[styles.dangerButton, isSubmitting && styles.buttonDisabled]}
						onPress={() => handleClaim('discard')}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Text style={styles.dangerButtonText}>{t('account.claimDiscard')}</Text>
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.claimDiscardHint')}</Text>

					<TouchableOpacity
						style={[styles.dangerButton, isSubmitting && styles.buttonDisabled]}
						onPress={() => handleClaim('merge')}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Text style={styles.dangerButtonText}>{t('account.claimMerge')}</Text>
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.claimMergeHint')}</Text>
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
				{topBar}
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
								{t('account.lastSynced', { date: formatInstantDate(lastSyncedAt) })}
							</Text>
						)}

						{unsynced === null ? null : unsynced > 0 ? (
							<Text style={styles.onlyHere} accessibilityLiveRegion="polite">
								{t('account.onlyHere', { count: unsynced })}
							</Text>
						) : (
							<Text style={styles.allSafe}>{t('account.allSafe')}</Text>
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

					{/*
					 * Longe do "Sair" e com outra cara: sair guarda tudo, apagar não deixa nada
					 * na conta. Um toque errado entre os dois não pode ser fácil.
					 */}
					<View style={styles.divider} />
					<TouchableOpacity
						style={styles.deleteAccountButton}
						onPress={handleDeleteAccount}
						accessibilityRole="button"
						accessibilityHint={t('account.deleteAccountHint')}
					>
						<Ionicons name="trash-outline" size={16} color="#FFFFFF" />
						<Text style={styles.deleteAccountButtonText}>{t('account.deleteAccount')}</Text>
					</TouchableOpacity>
					<Text style={styles.hint}>{t('account.deleteAccountHint')}</Text>
				</ScrollView>

				<Modal
					visible={deleteVisible}
					transparent
					animationType="fade"
					onRequestClose={closeDeleteModal}
					statusBarTranslucent
				>
					{/*
					 * E2E-47: no Android o teclado cobria o "Apagar a conta para sempre" e o
					 * modal não subia (sem `behavior` no Android, nada encolhia). O `height`
					 * encolhe a área, como na `Sheet`, e o cartão fica centrado no que sobra
					 * acima do teclado. A rolagem é para o celular pequeno, e o `handled` deixa
					 * o botão responder ao 1º toque com o teclado aberto.
					 */}
					<View style={styles.modalBackdrop}>
						<KeyboardAvoidingView
							style={styles.flex}
							behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
						>
							<ScrollView
								contentContainerStyle={styles.modalOverlay}
								keyboardShouldPersistTaps="handled"
							>
								<View style={styles.modalCard} accessibilityViewIsModal>
									<Text style={styles.modalTitle} accessibilityRole="header">
										{t('account.deletePasswordTitle')}
									</Text>
									<Text style={styles.paragraph}>
										{t('account.deletePasswordMsg', { email: account.email })}
									</Text>

									<TextInput
										style={styles.input}
										placeholder={t('account.passwordPlaceholder')}
										placeholderTextColor="#6B7280"
										value={deletePassword}
										onChangeText={(value) => {
											setDeletePassword(value);
											setDeleteError(null);
										}}
										secureTextEntry
										autoCapitalize="none"
										autoCorrect={false}
										// No Android o modal abre logo depois da biometria e o
										// `autoFocus` deixava o cursor no campo sem teclado
										// (E2E-47): ali o campo espera o toque, que abre o teclado.
										autoFocus={Platform.OS === 'ios'}
										textContentType="password"
										editable={!isDeleting}
										accessibilityLabel={t('account.deletePasswordLabel')}
										onSubmitEditing={confirmDeleteAccount}
										returnKeyType="done"
									/>

									{deleteError ? (
										<Text
											style={styles.modalError}
											accessibilityLiveRegion="polite"
											accessibilityRole="alert"
										>
											{t(
												deleteError === 'wrong_password'
													? 'account.deleteWrongPassword'
													: 'account.deleteUnavailable'
											)}
										</Text>
									) : null}

									<TouchableOpacity
										style={[
											styles.deleteAccountButton,
											(isDeleting || !deletePassword) && styles.buttonDisabled,
										]}
										onPress={confirmDeleteAccount}
										disabled={isDeleting || !deletePassword}
										accessibilityRole="button"
										accessibilityState={{ disabled: isDeleting || !deletePassword, busy: isDeleting }}
									>
										{isDeleting ? <ActivityIndicator color="#FFFFFF" /> : null}
										<Text style={styles.deleteAccountButtonText}>{t('account.deleteAction')}</Text>
									</TouchableOpacity>

									<TouchableOpacity
										style={styles.switchMode}
										onPress={closeDeleteModal}
										disabled={isDeleting}
										accessibilityRole="button"
									>
										<Text style={styles.switchModeText}>{t('account.cancel')}</Text>
									</TouchableOpacity>
								</View>
							</ScrollView>
						</KeyboardAvoidingView>
					</View>
				</Modal>
			</SafeAreaView>
		);
	}

	// ------------------------------------------------------------------
	// Modo anônimo: entrar ou criar conta
	// ------------------------------------------------------------------
	return (
		<SafeAreaView style={styles.container}>
			{header}
			{topBar}
			{/* No Android, sem `behavior` nada encolhia e o teclado cobria "Criar conta"/"Entrar" (SPD-121): o `height` encolhe a área, como no modal da senha. */}
			<KeyboardAvoidingView
				style={styles.flex}
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
	topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, gap: 4 },
	iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
	topBarTitle: { flex: 1, fontSize: 22, fontWeight: '700', color: '#FFFFFF' },
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
	divider: { height: 1, backgroundColor: '#2C2C2E', marginTop: 40 },
	// Cheio, não contornado como o "Sair": é o único botão da tela que não tem volta.
	deleteAccountButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		backgroundColor: '#D64545',
		borderRadius: 10,
		paddingVertical: 14,
		marginTop: 20,
	},
	deleteAccountButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
	modalBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.7)' },
	modalOverlay: { flexGrow: 1, justifyContent: 'center', padding: 24 },
	modalCard: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 20 },
	modalTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 8 },
	modalError: { color: '#FF6B6B', fontSize: 14, lineHeight: 20, marginBottom: 4 },
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
	onlyHere: {
		fontSize: 14,
		lineHeight: 20,
		color: '#FFCC5C',
		marginTop: 8,
	},
	allSafe: {
		fontSize: 14,
		lineHeight: 20,
		color: '#4CAF50',
		marginTop: 8,
	},
	cardSubvalue: { color: '#8E8E93', fontSize: 13, marginTop: 4 },
	statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	statusDot: { width: 8, height: 8, borderRadius: 4 },
});

export default AccountScreen;
