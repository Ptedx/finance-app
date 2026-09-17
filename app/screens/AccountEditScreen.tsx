import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	Alert,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ACCOUNT_KIND_ICONS } from '../components/AccountPicker';
import TransactionItem from '../components/TransactionItem';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import {
	type Account,
	type AccountDraft,
	type AccountKind,
	type AccountRole,
	defaultRoleFor,
	type Transaction,
} from '../database/schema';
import { ACCOUNT_COLORS } from '../utils/accountResolver';
import { brandFor } from '../utils/bankBrands';
import { formatDate, todayISO } from '../utils/dateUtils';
import { centsToDisplayInput, formatCents, parseAmountToCents } from '../utils/money';

/**
 * Criar ou editar uma conta ou cartão.
 *
 * A ação mais importante da tela é "definir saldo": é o que deixa o app 100% alinhado
 * com o banco num toque, sem reescrever lançamento nenhum. Para o cartão, o campo é
 * "valor a pagar agora" — o usuário pensa em quanto deve, não em saldo negativo.
 *
 * Acessibilidade: todo campo tem rótulo visível e `accessibilityLabel`; o tipo é um
 * grupo de rádio; erros aparecem abaixo do campo e são anunciados; alvos de 48 pt.
 */

const ACCENT = '#15E8FE';
// Cartão não é conta: tem tela e cadastro próprios em /cards.
const KINDS: AccountKind[] = ['checking', 'savings', 'investment', 'cash'];
const ROLES: AccountRole[] = ['main', 'envelope', 'reserve', 'external'];
const ROLE_ICONS: Record<AccountRole, React.ComponentProps<typeof Ionicons>['name']> = {
	main: 'home-outline',
	card: 'card-outline',
	envelope: 'mail-outline',
	reserve: 'shield-checkmark-outline',
	external: 'log-out-outline',
};

interface AccountEditScreenProps {
	accountId?: string;
}

const AccountEditScreen: React.FC<AccountEditScreenProps> = ({ accountId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, balances, createAccount, saveAccount, removeAccount, setBalanceToday } = useAccounts();
	const { transactions } = useTransactions();

	const existing: Account | undefined = useMemo(
		() => accounts.find((account) => account.id === accountId),
		[accounts, accountId]
	);
	const isEditing = Boolean(existing);

	const [name, setName] = useState(existing?.name ?? '');
	const [kind, setKind] = useState<AccountKind>(existing?.kind ?? 'checking');
	const [bankName, setBankName] = useState(existing?.bankName ?? '');
	const [role, setRole] = useState<AccountRole>(existing?.role ?? defaultRoleFor(existing?.kind ?? 'checking'));
	const [envelopeMonthly, setEnvelopeMonthly] = useState(
		existing?.envelopeMonthlyCents ? centsToDisplayInput(existing.envelopeMonthlyCents) : ''
	);
	const [balanceInput, setBalanceInput] = useState('');
	const [errors, setErrors] = useState<{ name?: string; day?: string; amount?: string; balance?: string }>({});
	const [saving, setSaving] = useState(false);

	// Quando a conta chega depois (a lista ainda carregava), preenche o formulário.
	useEffect(() => {
		if (!existing) return;
		setName(existing.name);
		setKind(existing.kind);
		setBankName(existing.bankName ?? '');
		setRole(existing.role);
		setEnvelopeMonthly(existing.envelopeMonthlyCents ? centsToDisplayInput(existing.envelopeMonthlyCents) : '');
	}, [existing]);

	useEffect(() => {
		if (existing?.kind === 'credit_card') router.replace({ pathname: '/cards/[id]', params: { id: existing.id } });
	}, [existing, router]);

	/** Trocar o tipo numa conta nova leva o papel junto; numa existente o papel é escolha do usuário. */
	const chooseKind = (next: AccountKind) => {
		setKind(next);
		if (!existing) setRole(defaultRoleFor(next));
	};

	const balanceCents = existing ? (balances.get(existing.id) ?? existing.openingBalanceCents) : 0;
	const recent: Transaction[] = useMemo(
		() => (existing ? transactions.filter((tx) => tx.accountId === existing.id).slice(0, 10) : []),
		[transactions, existing]
	);

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	const handleSave = async () => {
		const nextErrors: typeof errors = {};
		if (name.trim().length === 0) nextErrors.name = t('accounts.edit.invalidName');

		let envelopeCents: number | null = null;
		if (role === 'envelope' && envelopeMonthly.trim() !== '') {
			envelopeCents = parseAmountToCents(envelopeMonthly);
			if (envelopeCents === null || envelopeCents <= 0) nextErrors.amount = t('accounts.edit.invalidAmount');
		}

		setErrors(nextErrors);
		if (Object.keys(nextErrors).length > 0) {
			announce(Object.values(nextErrors).join('. '));
			return;
		}

		const draft: AccountDraft = {
			name: name.trim(),
			kind,
			role,
			envelopeMonthlyCents: role === 'envelope' ? envelopeCents : null,
			bankName: bankName.trim() || null,
			network: null,
			color: existing?.color ?? brandFor(bankName)?.color ?? ACCOUNT_COLORS[kind],
			last4: null,
			closingDay: null,
			closingDaysBefore: null,
			dueDay: null,
			creditLimitCents: null,
			packageName: existing?.packageName ?? null,
			accountKey: existing?.accountKey ?? null,
			openingBalanceCents: existing?.openingBalanceCents ?? 0,
			openingBalanceDate: existing?.openingBalanceDate ?? todayISO(),
			sortOrder: existing?.sortOrder ?? accounts.length,
			archived: existing?.archived ?? false,
		};

		try {
			setSaving(true);
			if (existing) {
				await saveAccount({ ...draft, id: existing.id });
				announce(t('accounts.edit.saved'));
			} else {
				const id = await createAccount(draft);
				router.replace({ pathname: '/accounts/[id]', params: { id } });
				return;
			}
		} finally {
			setSaving(false);
		}
	};

	const handleSetBalance = async () => {
		if (!existing) return;
		const cents = parseAmountToCents(balanceInput);
		if (cents === null) {
			setErrors((current) => ({ ...current, balance: t('accounts.edit.invalidAmount') }));
			announce(t('accounts.edit.invalidAmount'));
			return;
		}
		setErrors((current) => ({ ...current, balance: undefined }));
		await setBalanceToday(existing.id, cents);
		setBalanceInput('');
		announce(t('accounts.edit.balanceSet'));
	};

	const handleArchive = async () => {
		if (!existing) return;
		await saveAccount({ ...existing, archived: !existing.archived });
		announce(existing.archived ? t('accounts.edit.unarchive') : t('accounts.edit.archive'));
	};

	const handleDelete = () => {
		if (!existing) return;
		Alert.alert(t('accounts.edit.delete'), t('accounts.edit.deleteConfirm'), [
			{ text: t('accounts.edit.cancel'), style: 'cancel' },
			{
				text: t('accounts.edit.delete'),
				style: 'destructive',
				onPress: async () => {
					await removeAccount(existing.id);
					router.back();
				},
			},
		]);
	};

	const field = (
		label: string,
		value: string,
		onChange: (text: string) => void,
		options: { placeholder?: string; keyboardType?: 'default' | 'number-pad' | 'decimal-pad'; hint?: string; error?: string; optional?: boolean } = {}
	) => (
		<View style={styles.field}>
			<Text style={styles.label}>
				{label}
				{options.optional ? <Text style={styles.optional}> · {t('accounts.edit.optional')}</Text> : null}
			</Text>
			<TextInput
				style={[styles.input, options.error && styles.inputError]}
				value={value}
				onChangeText={onChange}
				placeholder={options.placeholder}
				placeholderTextColor="rgba(255,255,255,0.35)"
				keyboardType={options.keyboardType ?? 'default'}
				accessibilityLabel={label}
				accessibilityHint={options.hint}
			/>
			{options.error ? (
				<Text style={styles.error} accessibilityLiveRegion="polite">
					{options.error}
				</Text>
			) : null}
		</View>
	);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<View style={styles.header}>
					<Pressable
						onPress={() => router.back()}
						accessibilityRole="button"
						accessibilityLabel={t('accounts.back')}
						hitSlop={12}
						style={styles.backButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header">
						{isEditing ? existing?.name : t('accounts.edit.newTitle')}
					</Text>
				</View>

				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
					{existing && (
						<View style={styles.balanceCard}>
							<Text style={styles.balanceLabel}>{t('accounts.balance')}</Text>
							<Text style={[styles.balanceValue, balanceCents < 0 && styles.owed]}>
								{formatCents(balanceCents)}
							</Text>
							<Text style={styles.balanceMeta}>
								{t('accounts.anchoredOn', { date: formatDate(existing.openingBalanceDate) })}
							</Text>
							{existing.packageName && (
								<Text style={styles.balanceMeta}>
									{t('accounts.linkedNotifications', { app: existing.bankName ?? existing.packageName })}
								</Text>
							)}
							{existing.accountKey && <Text style={styles.balanceMeta}>{t('accounts.linkedStatement')}</Text>}

							<View style={styles.setBalanceRow}>
								<TextInput
									style={[styles.input, styles.setBalanceInput, errors.balance && styles.inputError]}
									value={balanceInput}
									onChangeText={setBalanceInput}
									placeholder={t('accounts.edit.currentBalance')}
									placeholderTextColor="rgba(255,255,255,0.35)"
									keyboardType="decimal-pad"
									accessibilityLabel={t('accounts.edit.currentBalance')}
									accessibilityHint={t('accounts.edit.setBalanceHint')}
								/>
								<Pressable
									onPress={handleSetBalance}
									accessibilityRole="button"
									accessibilityLabel={t('accounts.edit.setBalance')}
									accessibilityHint={t('accounts.edit.setBalanceHint')}
									style={({ pressed }) => [styles.primaryButton, styles.setBalanceButton, pressed && styles.pressed]}
								>
									<Text style={styles.primaryButtonText}>{t('accounts.edit.setBalance')}</Text>
								</Pressable>
							</View>
							{errors.balance ? (
								<Text style={styles.error} accessibilityLiveRegion="polite">
									{errors.balance}
								</Text>
							) : null}
						</View>
					)}

					{field(t('accounts.edit.name'), name, setName, {
						placeholder: t('accounts.edit.namePlaceholder'),
						error: errors.name,
					})}

					<View style={styles.field}>
						<Text style={styles.label}>{t('accounts.edit.kind')}</Text>
						<View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.edit.kind')}>
							{KINDS.map((option) => {
								const selected = kind === option;
								const color = ACCOUNT_COLORS[option];
								return (
									<Pressable
										key={option}
										onPress={() => chooseKind(option)}
										accessibilityRole="radio"
										accessibilityState={{ selected }}
										accessibilityLabel={t(`accounts.kind.${option}`)}
										style={({ pressed }) => [
											styles.kindChip,
											selected && { borderColor: color, backgroundColor: `${color}22` },
											pressed && styles.pressed,
										]}
									>
										<Ionicons name={selected ? 'checkmark-circle' : ACCOUNT_KIND_ICONS[option]} size={18} color={selected ? color : 'rgba(255,255,255,0.8)'} />
										<Text style={[styles.kindLabel, selected && { color }]}>{t(`accounts.kind.${option}`)}</Text>
									</Pressable>
								);
							})}
						</View>
					</View>

					<View style={styles.field}>
						<Text style={styles.label}>{t('accounts.edit.role')}</Text>
						<Text style={styles.roleHint}>{t('accounts.edit.roleHint')}</Text>
						<View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.edit.role')}>
							{ROLES.map((option) => {
								const selected = role === option;
								return (
									<Pressable
										key={option}
										onPress={() => setRole(option)}
										accessibilityRole="radio"
										accessibilityState={{ selected }}
										accessibilityLabel={t(`accounts.role.${option}`)}
										accessibilityHint={t(`accounts.roleDescription.${option}`)}
										style={({ pressed }) => [
											styles.kindChip,
											selected && { borderColor: ACCENT, backgroundColor: `${ACCENT}22` },
											pressed && styles.pressed,
										]}
									>
										<Ionicons name={selected ? 'checkmark-circle' : ROLE_ICONS[option]} size={18} color={selected ? ACCENT : 'rgba(255,255,255,0.8)'} />
										<Text style={[styles.kindLabel, selected && { color: ACCENT }]}>{t(`accounts.role.${option}`)}</Text>
									</Pressable>
								);
							})}
						</View>
						<Text style={styles.roleDescription} accessibilityLiveRegion="polite">
							{t(`accounts.roleDescription.${role}`)}
						</Text>
					</View>

					{role === 'envelope' &&
						field(t('accounts.edit.envelopeMonthly'), envelopeMonthly, setEnvelopeMonthly, {
							keyboardType: 'decimal-pad',
							hint: t('accounts.edit.envelopeMonthlyHint'),
							error: errors.amount,
						})}

					{field(t('accounts.edit.bank'), bankName, setBankName, {
						placeholder: t('accounts.edit.bankPlaceholder'),
						optional: true,
					})}

					<Pressable
						onPress={handleSave}
						disabled={saving}
						accessibilityRole="button"
						accessibilityLabel={t('accounts.edit.save')}
						accessibilityState={{ disabled: saving }}
						style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, saving && styles.disabled]}
					>
						<Text style={styles.primaryButtonText}>{t('accounts.edit.save')}</Text>
					</Pressable>

					{existing && (
						<View style={styles.secondaryActions}>
							<Pressable
								onPress={handleArchive}
								accessibilityRole="button"
								accessibilityLabel={existing.archived ? t('accounts.edit.unarchive') : t('accounts.edit.archive')}
								accessibilityHint={t('accounts.edit.archiveHint')}
								style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
							>
								<Ionicons name={existing.archived ? 'arrow-undo-outline' : 'archive-outline'} size={18} color="#FFFFFF" />
								<Text style={styles.secondaryButtonText}>
									{existing.archived ? t('accounts.edit.unarchive') : t('accounts.edit.archive')}
								</Text>
							</Pressable>
							<Pressable
								onPress={handleDelete}
								accessibilityRole="button"
								accessibilityLabel={t('accounts.edit.delete')}
								style={({ pressed }) => [styles.secondaryButton, styles.dangerButton, pressed && styles.pressed]}
							>
								<Ionicons name="trash-outline" size={18} color="#FF6B6B" />
								<Text style={[styles.secondaryButtonText, styles.dangerText]}>{t('accounts.edit.delete')}</Text>
							</Pressable>
						</View>
					)}

					{existing && (
						<View style={styles.section}>
							<Text style={styles.sectionTitle} accessibilityRole="header">
								{t('accounts.edit.transactions')}
							</Text>
							{recent.length === 0 ? (
								<Text style={styles.empty}>{t('accounts.edit.noTransactions')}</Text>
							) : (
								recent.map((transaction) => (
									<TransactionItem
										key={transaction.id}
										transaction={transaction}
										onPress={(tx) => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } })}
									/>
								))
							)}
						</View>
					)}
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	flex: {
		flex: 1,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	balanceCard: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 4,
	},
	balanceLabel: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	balanceValue: {
		fontSize: 30,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	owed: {
		color: '#FF6B6B',
	},
	balanceMeta: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
	},
	setBalanceRow: {
		flexDirection: 'row',
		gap: 8,
		marginTop: 10,
	},
	setBalanceInput: {
		flex: 1,
	},
	setBalanceButton: {
		paddingHorizontal: 14,
	},
	field: {
		marginBottom: 16,
	},
	label: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.75)',
		marginBottom: 6,
	},
	optional: {
		color: 'rgba(255,255,255,0.45)',
	},
	input: {
		minHeight: 48,
		borderRadius: 10,
		paddingHorizontal: 14,
		backgroundColor: 'rgba(255,255,255,0.06)',
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.12)',
		color: '#FFFFFF',
		fontSize: 16,
	},
	inputError: {
		borderColor: '#FF6B6B',
	},
	error: {
		fontSize: 13,
		color: '#FF6B6B',
		marginTop: 6,
	},
	kinds: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
	},
	roleHint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.55)',
		marginBottom: 8,
	},
	roleDescription: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.75)',
		marginTop: 8,
	},
	kindChip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 48,
		paddingHorizontal: 14,
		borderRadius: 24,
		borderWidth: 1.5,
		borderColor: 'rgba(255,255,255,0.2)',
		backgroundColor: 'rgba(255,255,255,0.05)',
	},
	kindLabel: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	column: {
		flex: 1,
	},
	primaryButton: {
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		alignItems: 'center',
		justifyContent: 'center',
	},
	primaryButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
	disabled: {
		opacity: 0.5,
	},
	secondaryActions: {
		flexDirection: 'row',
		gap: 8,
		marginTop: 12,
	},
	secondaryButton: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: 'rgba(255,255,255,0.08)',
	},
	secondaryButtonText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	dangerButton: {
		backgroundColor: 'rgba(255,107,107,0.12)',
	},
	dangerText: {
		color: '#FF6B6B',
	},
	section: {
		marginTop: 24,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 8,
	},
	empty: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.6)',
	},
});

export default AccountEditScreen;
