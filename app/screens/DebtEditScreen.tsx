import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, ChipGroup, Field } from '../components/cards/formParts';
import { useAccounts } from '../contexts/AccountsContext';
import { draftOf, useDebts } from '../contexts/DebtsContext';
import type { AmortizationSystem, DebtDraft, DebtKind } from '../database/schema';
import { formatMonthYear, todayISO } from '../utils/dateUtils';
import {
	annualRateBpOf,
	buildSchedule,
	DEFAULT_CONSORTIUM_ADJUSTMENT_BP,
	debtStateOn,
	impliedRateBp,
	MAX_SCHEDULE_MONTHS,
	monthlyRateOf,
	principalFromRateCents,
	termsOf,
} from '../utils/debt';
import { centsToDisplayInput, finaliseAmountInput, formatAmountInput, formatCents, parseAmountToCents } from '../utils/money';
import { bpToPercentInput, formatPercentBp, percentInputToBp } from '../utils/percent';

/**
 * Cadastrar ou corrigir uma dívida.
 *
 * Pede só o que está no boleto ou no app do banco: a parcela, quantas faltam, o dia do
 * vencimento — e **o saldo devedor ou a taxa**, o que o usuário souber. O outro sai da
 * mesma conta (tabela Price, SAC) e aparece na hora, junto com a data de quitação e os
 * juros que ainda faltam, para conferir com o banco antes de salvar.
 *
 * Salvar ancora a dívida em hoje: os valores digitados são os de hoje. Numa dívida já
 * cadastrada, os campos já vêm com o saldo e o prazo projetados para hoje, então salvar
 * sem mexer não muda nada.
 */

type Known = 'balance' | 'rate';
type RatePeriod = 'month' | 'year';

const onlyDigits = (text: string, max: number) => text.replace(/\D/g, '').slice(0, max);

const DebtEditScreen: React.FC<{ debtId?: string }> = ({ debtId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { debts, createDebt, saveDebt, removeDebt } = useDebts();
	const { bankAccounts } = useAccounts();
	const existing = useMemo(() => debts.find((debt) => debt.id === debtId), [debts, debtId]);
	const today = todayISO();

	const [kind, setKind] = useState<DebtKind>('financing');
	const [name, setName] = useState('');
	const [system, setSystem] = useState<Exclude<AmortizationSystem, 'none'>>('price');
	const [installment, setInstallment] = useState('');
	const [remaining, setRemaining] = useState('');
	const [total, setTotal] = useState('');
	const [dueDay, setDueDay] = useState('');
	const [known, setKnown] = useState<Known>('balance');
	const [balance, setBalance] = useState('');
	const [rate, setRate] = useState('');
	const [ratePeriod, setRatePeriod] = useState<RatePeriod>('month');
	const [adjustment, setAdjustment] = useState(bpToPercentInput(DEFAULT_CONSORTIUM_ADJUSTMENT_BP));
	const [adminFee, setAdminFee] = useState('');
	const [accountId, setAccountId] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});
	const [saving, setSaving] = useState(false);

	// Uma dívida já cadastrada abre com o estado de hoje: saldo e prazo projetados.
	useEffect(() => {
		if (!existing) return;
		const state = debtStateOn(termsOf(existing), today);
		setKind(existing.kind);
		setName(existing.name);
		setSystem(existing.system === 'sac' ? 'sac' : 'price');
		setInstallment(centsToDisplayInput(state.next?.installmentCents ?? existing.installmentCents));
		setRemaining(String(state.remaining));
		setTotal(String(existing.installmentsTotal));
		setDueDay(String(existing.dueDay));
		setKnown('balance');
		setBalance(centsToDisplayInput(state.balanceCents));
		setRate(bpToPercentInput(existing.rateBp));
		setRatePeriod('year');
		if (existing.kind === 'consortium') setAdjustment(bpToPercentInput(existing.rateBp));
		setAdminFee(existing.adminFeeBp !== null ? bpToPercentInput(existing.adminFeeBp) : '');
		setAccountId(existing.accountId);
	}, [existing, today]);

	const isConsortium = kind === 'consortium';
	const effectiveSystem: AmortizationSystem = isConsortium ? 'none' : system;
	const installmentCents = parseAmountToCents(installment);
	const remainingCount = Number(remaining);
	const validRemaining = Number.isInteger(remainingCount) && remainingCount >= 1 && remainingCount <= MAX_SCHEDULE_MONTHS;
	const dueDayNumber = Number(dueDay);
	const validDueDay = Number.isInteger(dueDayNumber) && dueDayNumber >= 1 && dueDayNumber <= 31;

	// A taxa digitada, sempre convertida para "ao ano" em pontos-base.
	const typedRateBp = (() => {
		const bp = percentInputToBp(rate, ratePeriod === 'month' ? 20 : 1_000);
		if (bp === null) return null;
		return ratePeriod === 'month' ? annualRateBpOf(bp / 10_000) : bp;
	})();

	/** O que a tela deriva: o saldo e a taxa que valem, e se a conta fecha. */
	const derived = useMemo(() => {
		if (installmentCents === null || installmentCents <= 0 || !validRemaining) return null;
		if (isConsortium) {
			const rateBp = percentInputToBp(adjustment, 100) ?? 0;
			const typed = balance.trim() === '' ? null : parseAmountToCents(balance);
			return { balanceCents: typed ?? installmentCents * remainingCount, rateBp };
		}
		if (known === 'balance') {
			const balanceCents = parseAmountToCents(balance);
			if (balanceCents === null || balanceCents <= 0) return null;
			const rateBp = impliedRateBp({ system: effectiveSystem, balanceCents, installmentCents, remaining: remainingCount });
			return rateBp === null ? { balanceCents, rateBp: null } : { balanceCents, rateBp };
		}
		if (typedRateBp === null) return null;
		return { balanceCents: principalFromRateCents({ system: effectiveSystem, installmentCents, remaining: remainingCount, rateBp: typedRateBp }), rateBp: typedRateBp };
	}, [installmentCents, validRemaining, isConsortium, adjustment, balance, remainingCount, known, effectiveSystem, typedRateBp]);

	const preview = useMemo(() => {
		if (!derived || derived.rateBp === null || !validDueDay || installmentCents === null) return null;
		const schedule = buildSchedule({
			system: effectiveSystem,
			balanceCents: derived.balanceCents,
			balanceDate: today,
			installmentCents,
			remaining: remainingCount,
			dueDay: dueDayNumber,
			rateBp: derived.rateBp,
		});
		return { schedule, rateBp: derived.rateBp, balanceCents: derived.balanceCents };
	}, [derived, validDueDay, installmentCents, effectiveSystem, today, remainingCount, dueDayNumber]);

	const previewText = (() => {
		if (!derived) return null;
		if (derived.rateBp === null) return t('debts.edit.previewInconsistent');
		if (!preview) return null;
		const lines: string[] = [];
		if (!isConsortium && known === 'balance') {
			lines.push(
				t('debts.edit.previewRate', {
					monthly: formatPercentBp(Math.round(monthlyRateOf(preview.rateBp) * 10_000), 2),
					yearly: formatPercentBp(preview.rateBp),
				})
			);
		}
		if (!isConsortium && known === 'rate') lines.push(t('debts.edit.previewBalance', { amount: formatCents(preview.balanceCents) }));
		if (preview.schedule.payoffDate) {
			lines.push(
				t(isConsortium ? 'debts.edit.previewPayoffConsortium' : 'debts.edit.previewPayoff', {
					date: formatMonthYear(preview.schedule.payoffDate),
					interest: formatCents(preview.schedule.totalInterestCents),
				})
			);
		} else {
			lines.push(t('debts.edit.previewNeverPays'));
		}
		return lines.join('\n');
	})();

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	const handleSave = async () => {
		const next: Record<string, string | undefined> = {};
		if (!name.trim()) next.name = t('debts.edit.errors.name');
		if (installmentCents === null || installmentCents <= 0) next.installment = t('debts.edit.errors.installment');
		if (!validRemaining) next.remaining = t('debts.edit.errors.remaining');
		const totalCount = total.trim() === '' ? remainingCount : Number(total);
		if (!Number.isInteger(totalCount) || totalCount < remainingCount) next.total = t('debts.edit.errors.total');
		if (!validDueDay) next.dueDay = t('debts.edit.errors.dueDay');
		if (!derived || derived.rateBp === null || !preview?.schedule.amortizes) next.values = t('debts.edit.errors.values');
		const adminFeeBp = adminFee.trim() === '' ? null : percentInputToBp(adminFee, 100);
		if (adminFee.trim() !== '' && adminFeeBp === null) next.adminFee = t('debts.edit.errors.percent');

		setErrors(next);
		const messages = Object.values(next).filter(Boolean);
		if (messages.length > 0 || !derived || derived.rateBp === null || installmentCents === null) {
			announce(messages.join('. '));
			return;
		}

		const draft: DebtDraft = {
			...(existing ? draftOf(existing) : { archived: false, sortOrder: debts.length, category: null }),
			name: name.trim(),
			kind,
			system: effectiveSystem,
			openingBalanceCents: derived.balanceCents,
			openingBalanceDate: today,
			installmentCents,
			remainingAtOpening: remainingCount,
			installmentsTotal: totalCount,
			dueDay: dueDayNumber,
			rateBp: derived.rateBp,
			adminFeeBp: isConsortium ? adminFeeBp : null,
			accountId,
		};

		setSaving(true);
		try {
			if (existing) {
				await saveDebt(existing.id, draft);
				announce(t('debts.edit.saved'));
				router.back();
			} else {
				const id = await createDebt(draft);
				announce(t('debts.edit.saved'));
				router.replace({ pathname: '/debts/[id]', params: { id } });
			}
		} finally {
			setSaving(false);
		}
	};

	const handleArchive = async () => {
		if (!existing) return;
		await saveDebt(existing.id, { ...draftOf(existing), archived: !existing.archived });
		announce(existing.archived ? t('debts.edit.unarchived') : t('debts.edit.archived'));
		router.back();
	};

	const handleDelete = () => {
		if (!existing) return;
		Alert.alert(t('debts.edit.deleteTitle'), t('debts.edit.deleteBody', { name: existing.name }), [
			{ text: t('debts.edit.cancel'), style: 'cancel' },
			{
				text: t('debts.edit.delete'),
				style: 'destructive',
				onPress: async () => {
					await removeDebt(existing.id);
					router.replace('/(tabs)/wealth');
				},
			},
		]);
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<View style={styles.header}>
					<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('debts.back')} style={styles.iconButton}>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
						{existing ? t('debts.edit.title') : t('debts.edit.newTitle')}
					</Text>
				</View>

				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<ChipGroup<DebtKind>
						label={t('debts.edit.kind')}
						options={[
							{ value: 'financing', label: t('debts.kind.financing') },
							{ value: 'consortium', label: t('debts.kind.consortium') },
							{ value: 'loan', label: t('debts.kind.loan') },
						]}
						selected={kind}
						onSelect={setKind}
					/>

					<Field
						label={t('debts.edit.name')}
						value={name}
						onChangeText={setName}
						placeholder={t(`debts.edit.namePlaceholder.${kind}`)}
						placeholderTextColor="rgba(255,255,255,0.35)"
						error={errors.name}
					/>

					{!isConsortium ? (
						<ChipGroup<'price' | 'sac'>
							label={t('debts.edit.system')}
							hint={t('debts.edit.systemHint')}
							options={[
								{ value: 'price', label: t('debts.system.price') },
								{ value: 'sac', label: t('debts.system.sac') },
							]}
							selected={system}
							onSelect={setSystem}
						/>
					) : null}

					<Field
						label={system === 'sac' && !isConsortium ? t('debts.edit.nextInstallment') : t('debts.edit.installment')}
						value={installment}
						onChangeText={(text) => setInstallment(formatAmountInput(text))}
						onBlur={() => setInstallment(finaliseAmountInput(installment))}
						keyboardType="decimal-pad"
						selectTextOnFocus
						error={errors.installment}
					/>

					<View style={styles.twoColumns}>
						<View style={styles.column}>
							<Field
								label={t('debts.edit.remaining')}
								hint={t('debts.edit.remainingHint')}
								value={remaining}
								onChangeText={(text) => setRemaining(onlyDigits(text, 3))}
								keyboardType="number-pad"
								maxLength={3}
								error={errors.remaining}
							/>
						</View>
						<View style={styles.column}>
							<Field
								label={t('debts.edit.total')}
								optionalLabel={t('debts.edit.optional')}
								value={total}
								onChangeText={(text) => setTotal(onlyDigits(text, 3))}
								keyboardType="number-pad"
								maxLength={3}
								error={errors.total}
							/>
						</View>
					</View>

					<Field
						label={t('debts.edit.dueDay')}
						value={dueDay}
						onChangeText={(text) => setDueDay(onlyDigits(text, 2))}
						keyboardType="number-pad"
						maxLength={2}
						error={errors.dueDay}
					/>

					{isConsortium ? (
						<>
							<Field
								label={t('debts.edit.consortiumBalance')}
								optionalLabel={t('debts.edit.optional')}
								hint={t('debts.edit.consortiumBalanceHint')}
								value={balance}
								onChangeText={(text) => setBalance(formatAmountInput(text))}
								onBlur={() => setBalance(balance.trim() === '' ? '' : finaliseAmountInput(balance))}
								keyboardType="decimal-pad"
								selectTextOnFocus
							/>
							<Field
								label={t('debts.edit.adjustment')}
								hint={t('debts.edit.adjustmentHint')}
								value={adjustment}
								onChangeText={setAdjustment}
								keyboardType="decimal-pad"
								selectTextOnFocus
							/>
							<Field
								label={t('debts.edit.adminFee')}
								optionalLabel={t('debts.edit.optional')}
								hint={t('debts.edit.adminFeeHint')}
								value={adminFee}
								onChangeText={setAdminFee}
								keyboardType="decimal-pad"
								error={errors.adminFee}
							/>
						</>
					) : (
						<>
							<ChipGroup<Known>
								label={t('debts.edit.known')}
								options={[
									{ value: 'balance', label: t('debts.edit.knownBalance') },
									{ value: 'rate', label: t('debts.edit.knownRate') },
								]}
								selected={known}
								onSelect={setKnown}
							/>
							{known === 'balance' ? (
								<Field
									label={t('debts.edit.balance')}
									hint={t('debts.edit.balanceHint')}
									value={balance}
									onChangeText={(text) => setBalance(formatAmountInput(text))}
									onBlur={() => setBalance(finaliseAmountInput(balance))}
									keyboardType="decimal-pad"
									selectTextOnFocus
								/>
							) : (
								<>
									<Field
										label={t('debts.edit.rate')}
										value={rate}
										onChangeText={setRate}
										keyboardType="decimal-pad"
										selectTextOnFocus
									/>
									<ChipGroup<RatePeriod>
										label={t('debts.edit.ratePeriod')}
										options={[
											{ value: 'month', label: t('debts.edit.perMonth') },
											{ value: 'year', label: t('debts.edit.perYear') },
										]}
										selected={ratePeriod}
										onSelect={setRatePeriod}
									/>
								</>
							)}
						</>
					)}

					{previewText ? (
						<Text style={[styles.preview, derived?.rateBp === null && styles.previewWarning]} accessibilityLiveRegion="polite">
							{previewText}
						</Text>
					) : null}
					{errors.values ? (
						<Text style={styles.error} accessibilityLiveRegion="polite">
							{errors.values}
						</Text>
					) : null}

					{bankAccounts.length > 0 ? (
						<ChipGroup<string>
							label={t('debts.edit.account')}
							hint={t('debts.edit.accountHint')}
							options={bankAccounts.map((account) => ({ value: account.id, label: account.name, color: account.color }))}
							selected={accountId}
							onSelect={(value) => setAccountId(value === accountId ? null : value)}
						/>
					) : null}

					<Button label={t('debts.edit.save')} onPress={handleSave} disabled={saving} icon="checkmark" />

					{existing ? (
						<View style={styles.secondary}>
							<Button
								label={existing.archived ? t('debts.edit.unarchive') : t('debts.edit.archive')}
								hint={t('debts.edit.archiveHint')}
								onPress={handleArchive}
								variant="secondary"
								icon={existing.archived ? 'arrow-undo-outline' : 'checkmark-done-outline'}
							/>
							<Button label={t('debts.edit.delete')} onPress={handleDelete} variant="danger" icon="trash-outline" />
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
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	column: {
		flex: 1,
	},
	preview: {
		fontSize: 15,
		lineHeight: 22,
		color: '#FFFFFF',
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		padding: 12,
	},
	previewWarning: {
		backgroundColor: 'rgba(255,138,128,0.14)',
	},
	error: {
		fontSize: 13,
		color: '#FF8A80',
		marginTop: -10,
	},
	secondary: {
		gap: 10,
	},
});

export default DebtEditScreen;
