import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
	View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, ChipGroup, Field } from '../components/cards/formParts';
import { useAccounts } from '../contexts/AccountsContext';
import { useBills } from '../contexts/BillsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { billDueDate } from '../utils/billReminders';
import {
	type BillInput,
	canDeleteBill,
	canToggleActive,
	dueDatePassed,
	isLockedByDebt,
	isValidDueDay,
} from '../utils/billRules';
import { formatDayMonth, monthKeyOf, todayISO } from '../utils/dateUtils';
import {
	centsToDisplayInput,
	finaliseAmountInput,
	formatAmountInput,
	parseAmountToCents,
} from '../utils/money';

/**
 * Cadastrar ou corrigir uma conta a pagar.
 *
 * Pede o que está no boleto: o nome, o dia do vencimento e o valor — este, só se for
 * fixo; em branco é "varia" (a conta de celular). A conta que paga, a categoria e as
 * palavras com que o pagamento aparece no banco são opcionais e servem para a baixa
 * automática achar o pagamento.
 *
 * Conta nova nasce com o mês anterior pago. Se o vencimento deste mês já passou, a tela
 * pergunta se este mês já está pago — o padrão é sim, para não acender um "atrasado" de
 * algo que a pessoa já pagou.
 *
 * A conta que vem de uma dívida mostra nome, dia e valor sem deixar editar: eles seguem a
 * dívida. Enquanto a dívida estiver viva, a conta também não se desliga nem se apaga.
 */

const onlyDigits = (text: string, max: number) => text.replace(/\D/g, '').slice(0, max);

const BillEditScreen: React.FC<{ billId?: string }> = ({ billId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { bills, createBill, saveBill, setBillActive, removeBill } = useBills();
	const { bankAccounts } = useAccounts();
	const { categories } = useTransactions();
	const existing = useMemo(() => bills.find((bill) => bill.id === billId), [bills, billId]);
	const fromDebt = Boolean(existing?.debtId);
	const locked = existing ? isLockedByDebt(existing) : false;

	const [name, setName] = useState('');
	const [dueDay, setDueDay] = useState('');
	const [amount, setAmount] = useState('');
	const [accountId, setAccountId] = useState<string | null>(null);
	const [category, setCategory] = useState<string | null>(null);
	const [matchHint, setMatchHint] = useState('');
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});
	const [saving, setSaving] = useState(false);

	// Os campos abrem uma vez com a conta gravada; uma recarga depois não apaga o que se digitou.
	const loadedId = useRef<string | null>(null);
	useEffect(() => {
		if (!existing || loadedId.current === existing.id) return;
		loadedId.current = existing.id;
		setName(existing.name);
		setDueDay(String(existing.dueDay));
		setAmount(existing.amountCents === null ? '' : centsToDisplayInput(existing.amountCents));
		setAccountId(existing.accountId);
		setCategory(existing.category);
		setMatchHint(existing.matchHint ?? '');
	}, [existing]);

	const expenseCategories = useMemo(
		() => categories.filter((item) => item.type === 'expense' && item.id !== 'uncategorized'),
		[categories]
	);

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	const handleSave = async () => {
		const dueDayNumber = Number(dueDay);
		const amountCents = amount.trim() === '' ? null : parseAmountToCents(amount);
		const next: Record<string, string | undefined> = {};
		if (!fromDebt) {
			if (!name.trim()) next.name = t('bills.edit.errors.name');
			if (!isValidDueDay(dueDayNumber)) next.dueDay = t('bills.edit.errors.dueDay');
			if (amount.trim() !== '' && (amountCents === null || amountCents <= 0))
				next.amount = t('bills.edit.errors.amount');
		}
		setErrors(next);
		const messages = Object.values(next).filter(Boolean);
		if (messages.length > 0) {
			announce(messages.join('. '));
			return;
		}

		const input: BillInput = {
			name: name.trim(),
			dueDay: dueDayNumber,
			amountCents: amountCents !== null && amountCents > 0 ? amountCents : null,
			accountId,
			category,
			matchHint: matchHint.trim() === '' ? null : matchHint.trim(),
		};

		const finish = async (write: () => Promise<unknown>) => {
			setSaving(true);
			try {
				await write();
				announce(t('bills.edit.saved'));
				router.back();
			} finally {
				setSaving(false);
			}
		};

		if (existing) {
			await finish(() => saveBill(existing.id, input));
			return;
		}

		const today = todayISO();
		if (!dueDatePassed(input.dueDay, today)) {
			await finish(() => createBill(input, false));
			return;
		}

		// O vencimento deste mês já passou: pergunta, com "sim" como resposta preferida.
		Alert.alert(
			t('bills.edit.paidQuestionTitle'),
			t('bills.edit.paidQuestionBody', {
				date: formatDayMonth(billDueDate(input, monthKeyOf(today))),
			}),
			[
				{
					text: t('bills.edit.paidNo'),
					onPress: () => void finish(() => createBill(input, false)),
				},
				{
					text: t('bills.edit.paidYes'),
					isPreferred: true,
					onPress: () => void finish(() => createBill(input, true)),
				},
			]
		);
	};

	const handleToggleActive = async () => {
		if (!existing || !canToggleActive(existing)) return;
		await setBillActive(existing.id, !existing.active);
		announce(existing.active ? t('bills.edit.deactivated') : t('bills.edit.activated'));
		router.back();
	};

	const handleDelete = () => {
		if (!existing || !canDeleteBill(existing)) return;
		Alert.alert(t('bills.edit.deleteTitle'), t('bills.edit.deleteBody', { name: existing.name }), [
			{ text: t('bills.edit.cancel'), style: 'cancel' },
			{
				text: t('bills.edit.delete'),
				style: 'destructive',
				onPress: async () => {
					if (await removeBill(existing.id)) router.back();
				},
			},
		]);
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<KeyboardAvoidingView
				style={styles.flex}
				behavior={Platform.OS === 'ios' ? 'padding' : undefined}
			>
				<View style={styles.header}>
					<Pressable
						onPress={() => router.back()}
						accessibilityRole="button"
						accessibilityLabel={t('bills.back')}
						style={styles.iconButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
						{existing ? t('bills.edit.title') : t('bills.edit.newTitle')}
					</Text>
				</View>

				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					{existing && fromDebt ? (
						<View style={styles.note} accessible>
							<Ionicons name="information-circle-outline" size={20} color="#15E8FE" />
							<Text style={styles.noteText}>
								{locked
									? t('bills.edit.debtNote', { name: existing.name })
									: t('bills.edit.debtEndedNote')}
							</Text>
						</View>
					) : null}
					{existing?.debtId && locked ? (
						<Button
							label={t('bills.edit.openDebt')}
							onPress={() =>
								router.push({ pathname: '/debts/[id]', params: { id: existing.debtId as string } })
							}
							variant="secondary"
							icon="open-outline"
						/>
					) : null}

					<Field
						label={t('bills.edit.name')}
						value={name}
						onChangeText={setName}
						editable={!fromDebt}
						placeholder={t('bills.edit.namePlaceholder')}
						placeholderTextColor="rgba(255,255,255,0.35)"
						error={errors.name}
					/>

					<Field
						label={t('bills.edit.dueDay')}
						hint={t('bills.edit.dueDayHint')}
						value={dueDay}
						onChangeText={(text) => setDueDay(onlyDigits(text, 2))}
						editable={!fromDebt}
						keyboardType="number-pad"
						maxLength={2}
						error={errors.dueDay}
					/>

					<Field
						label={t('bills.edit.amount')}
						optionalLabel={fromDebt ? undefined : t('bills.edit.optional')}
						hint={fromDebt ? undefined : t('bills.edit.amountHint')}
						value={fromDebt && amount === '' ? t('bills.variable') : amount}
						onChangeText={(text) => setAmount(formatAmountInput(text))}
						onBlur={() => setAmount(amount.trim() === '' ? '' : finaliseAmountInput(amount))}
						editable={!fromDebt}
						keyboardType="decimal-pad"
						selectTextOnFocus
						error={errors.amount}
					/>

					{bankAccounts.length > 0 && !fromDebt ? (
						<ChipGroup<string>
							label={`${t('bills.edit.account')} · ${t('bills.edit.optional')}`}
							hint={t('bills.edit.accountHint')}
							options={bankAccounts.map((account) => ({
								value: account.id,
								label: account.name,
								color: account.color,
							}))}
							selected={accountId}
							onSelect={(value) => setAccountId(value === accountId ? null : value)}
						/>
					) : null}

					{expenseCategories.length > 0 ? (
						<ChipGroup<string>
							label={`${t('bills.edit.category')} · ${t('bills.edit.optional')}`}
							hint={t('bills.edit.accountHint')}
							options={expenseCategories.map((item) => ({
								value: item.id,
								label: item.name,
								color: item.color,
							}))}
							selected={category}
							onSelect={(value) => setCategory(value === category ? null : value)}
						/>
					) : null}

					<Field
						label={t('bills.edit.matchHint')}
						optionalLabel={t('bills.edit.optional')}
						hint={t('bills.edit.matchHintHint')}
						value={matchHint}
						onChangeText={setMatchHint}
						autoCapitalize="none"
						autoCorrect={false}
					/>

					<Button
						label={t('bills.edit.save')}
						onPress={handleSave}
						disabled={saving}
						icon="checkmark"
					/>

					{existing && (canToggleActive(existing) || canDeleteBill(existing)) ? (
						<View style={styles.secondary}>
							{canToggleActive(existing) ? (
								<Button
									label={existing.active ? t('bills.edit.deactivate') : t('bills.edit.activate')}
									hint={t('bills.edit.activeHint')}
									onPress={handleToggleActive}
									variant="secondary"
									icon={existing.active ? 'pause-circle-outline' : 'play-circle-outline'}
								/>
							) : null}
							{canDeleteBill(existing) ? (
								<Button
									label={t('bills.edit.delete')}
									onPress={handleDelete}
									variant="danger"
									icon="trash-outline"
								/>
							) : null}
						</View>
					) : null}
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
		paddingHorizontal: 8,
		paddingVertical: 4,
		gap: 4,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 60,
		gap: 18,
	},
	note: {
		flexDirection: 'row',
		gap: 10,
		alignItems: 'flex-start',
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		padding: 12,
	},
	noteText: {
		flex: 1,
		fontSize: 14,
		lineHeight: 20,
		color: '#FFFFFF',
	},
	secondary: {
		gap: 10,
	},
});

export default BillEditScreen;
