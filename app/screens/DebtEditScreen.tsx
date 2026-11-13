import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { accountSelectOptions } from '../components/AccountPicker';
import { Button, ChipGroup, Field } from '../components/cards/formParts';
import { SelectField } from '../components/SelectField';
import HelpButton from '../components/tour/HelpButton';
import { TourTarget, useScreenTour, useTourScroll } from '../components/tour/TourContext';
import { SampleBanner, useSampleDebt, useSampleForm } from '../components/tour/TrailSample';
import { useAccounts } from '../contexts/AccountsContext';
import { draftOf, useDebts } from '../contexts/DebtsContext';
import type { AmortizationSystem, DebtDraft, DebtKind } from '../database/schema';
import { formatMonthYear, todayISO } from '../utils/dateUtils';
import { DEFAULT_CONSORTIUM_ADJUSTMENT_BP, debtStateOn, MAX_SCHEDULE_MONTHS, monthlyRateBpOf } from '../utils/debt';
import { debtFieldsOfTerms, debtFormFieldsOf, deriveDebtForm, formRateBp, formTerms, type PrefilledRate, type RatePeriod } from '../utils/debtForm';
import { finaliseAmountInput, formatAmountInput, formatCents, parseAmountToCents } from '../utils/money';
import { bpToPercentInput, formatPercentBp, percentInputToBp } from '../utils/percent';
import { SAMPLE_IDS } from '../utils/trailSample';

/**
 * Cadastrar ou corrigir uma dívida.
 *
 * Pede só o que está no boleto ou no app do banco: a parcela, quantas faltam, o dia do
 * vencimento, o saldo devedor e a taxa do contrato — os dois últimos, o que o usuário
 * souber. Com os dois, a diferença entre a parcela cobrada e a que a taxa daria vira
 * "seguro e tarifas": é o caso comum, e é por isso que estimar a taxa só pela parcela sai
 * mais alto que a do contrato. Com um só, o outro é estimado e a tela diz que é estimativa.
 *
 * Salvar ancora a dívida em hoje: os valores digitados são os de hoje. Numa dívida já
 * cadastrada, os campos já vêm com o saldo e o prazo projetados para hoje, então salvar
 * sem mexer não muda nada.
 *
 * Nas trilhas (SPD-147), a tela também mostra o exemplo só em memória: a dívida de exemplo
 * (`debtId` de exemplo) ou o cadastro já preenchido com ela (`sampleForm`, o `exemplo=1` da
 * rota), para a prévia aparecer. Com o exemplo, nada grava: salvar, quitar e excluir não fazem nada.
 */

const onlyDigits = (text: string, max: number) => text.replace(/\D/g, '').slice(0, max);

const DebtEditScreen: React.FC<{ debtId?: string; sampleForm?: string }> = ({ debtId, sampleForm }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { debts, createDebt, saveDebt, removeDebt } = useDebts();
	const { bankAccounts } = useAccounts();
	// O exemplo das trilhas (SPD-147): a dívida de exemplo, ou o cadastro preenchido com ela.
	const formSample = useSampleForm(sampleForm);
	const sample = useSampleDebt(formSample ? SAMPLE_IDS.debt : debtId);
	const found = useMemo(() => debts.find((debt) => debt.id === debtId), [debts, debtId]);
	const existing = formSample ? undefined : (sample ?? found);
	const filled = existing ?? sample;
	const today = todayISO();

	const [kind, setKind] = useState<DebtKind>('financing');
	const [name, setName] = useState('');
	const [system, setSystem] = useState<Exclude<AmortizationSystem, 'none'>>('price');
	const [installment, setInstallment] = useState('');
	const [remaining, setRemaining] = useState('');
	const [total, setTotal] = useState('');
	const [dueDay, setDueDay] = useState('');
	const [balance, setBalance] = useState('');
	const [rate, setRate] = useState('');
	const [ratePeriod, setRatePeriod] = useState<RatePeriod>('month');
	const [prefilledRate, setPrefilledRate] = useState<PrefilledRate | null>(null);
	const [adjustment, setAdjustment] = useState(bpToPercentInput(DEFAULT_CONSORTIUM_ADJUSTMENT_BP));
	const [adminFee, setAdminFee] = useState('');
	const [accountId, setAccountId] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});
	const [saving, setSaving] = useState(false);
	// A trilha de dívidas (SPD-131) passa por aqui: a nova abre na hora; a cadastrada, quando a dívida chegou.
	useScreenTour('debtEdit', { ready: debtId ? Boolean(existing) : true });
	const tourScroll = useTourScroll('debtEdit');

	// Uma dívida já cadastrada abre com o estado de hoje: saldo e prazo projetados. O cadastro
	// de exemplo abre do mesmo jeito, com a dívida de exemplo.
	useEffect(() => {
		if (!filled) return;
		const fields = debtFormFieldsOf(filled, today);
		setKind(filled.kind);
		setName(filled.name);
		setSystem(filled.system === 'sac' ? 'sac' : 'price');
		setInstallment(fields.installment);
		setRemaining(fields.remaining);
		setTotal(fields.total);
		setDueDay(fields.dueDay);
		setBalance(fields.balance);
		setRate(fields.rate.text);
		setRatePeriod(fields.rate.period);
		setPrefilledRate(fields.rate);
		if (fields.adjustment !== null) setAdjustment(fields.adjustment);
		setAdminFee(fields.adminFee);
		setAccountId(filled.accountId);
	}, [filled, today]);

	const isConsortium = kind === 'consortium';
	const effectiveSystem: AmortizationSystem = isConsortium ? 'none' : system;
	const installmentCents = parseAmountToCents(installment);
	const remainingCount = Number(remaining);
	const validRemaining = Number.isInteger(remainingCount) && remainingCount >= 1 && remainingCount <= MAX_SCHEDULE_MONTHS;
	const dueDayNumber = Number(dueDay);
	const validDueDay = Number.isInteger(dueDayNumber) && dueDayNumber >= 1 && dueDayNumber <= 31;

	// A taxa digitada, sempre convertida para "ao ano" em pontos-base.
	const typedRateBp = formRateBp(rate, ratePeriod, prefilledRate);

	/** O que a tela deriva: o saldo, a taxa e os encargos que valem, e de onde cada um veio. */
	const derived = useMemo(
		() => deriveDebtForm({ system: effectiveSystem, installmentCents, remaining: remainingCount, validRemaining, balance, typedRateBp, adjustment }),
		[installmentCents, validRemaining, adjustment, balance, remainingCount, effectiveSystem, typedRateBp]
	);

	// A prévia é o estado de hoje dos termos que salvar grava, pela mesma conta da tela da dívida.
	const preview = useMemo(() => {
		if (!validDueDay) return null;
		const terms = formTerms(derived, { system: effectiveSystem, installmentCents, remaining: remainingCount, dueDay: dueDayNumber, today });
		if (!terms || !derived) return null;
		return { terms, state: debtStateOn(terms, today), balanceCents: derived.balanceCents };
	}, [derived, validDueDay, installmentCents, effectiveSystem, today, remainingCount, dueDayNumber]);

	const previewText = (() => {
		if (!derived) return null;
		if (derived.rateBp === null) return t('debts.edit.previewInconsistent');
		if (!preview) return null;
		const lines: string[] = [];
		if (!isConsortium) {
			lines.push(
				t(derived.estimated === 'rate' ? 'debts.edit.previewRateEstimated' : 'debts.edit.previewRate', {
					monthly: formatPercentBp(monthlyRateBpOf(preview.terms.rateBp), 2),
					yearly: formatPercentBp(preview.terms.rateBp),
				})
			);
			if (derived.estimated === 'balance') lines.push(t('debts.edit.previewBalance', { amount: formatCents(preview.balanceCents) }));
			if (derived.feeCents > 0) lines.push(t('debts.edit.previewFee', { amount: formatCents(derived.feeCents) }));
		}
		if (preview.state.payoffDate) {
			lines.push(
				t(isConsortium ? 'debts.edit.previewPayoffConsortium' : 'debts.edit.previewPayoff', {
					date: formatMonthYear(preview.state.payoffDate),
					interest: formatCents(preview.state.interestAheadCents),
				})
			);
		} else {
			lines.push(t('debts.edit.previewNeverPays'));
		}
		return lines.join('\n');
	})();

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	const handleSave = async () => {
		if (sample) return;
		const next: Record<string, string | undefined> = {};
		if (!name.trim()) next.name = t('debts.edit.errors.name');
		if (installmentCents === null || installmentCents <= 0) next.installment = t('debts.edit.errors.installment');
		if (!validRemaining) next.remaining = t('debts.edit.errors.remaining');
		const totalCount = total.trim() === '' ? remainingCount : Number(total);
		if (!Number.isInteger(totalCount) || totalCount < remainingCount) next.total = t('debts.edit.errors.total');
		if (!validDueDay) next.dueDay = t('debts.edit.errors.dueDay');
		if (!derived || derived.rateBp === null || !preview?.state.amortizes) next.values = t('debts.edit.errors.values');
		const adminFeeBp = adminFee.trim() === '' ? null : percentInputToBp(adminFee, 100);
		if (adminFee.trim() !== '' && adminFeeBp === null) next.adminFee = t('debts.edit.errors.percent');

		setErrors(next);
		const messages = Object.values(next).filter(Boolean);
		if (messages.length > 0 || !preview) {
			announce(messages.join('. '));
			return;
		}

		// Grava exatamente os termos da prévia: o que ela mostrou é o que a tela da dívida vai mostrar.
		const draft: DebtDraft = {
			...(existing ? draftOf(existing) : { archived: false, sortOrder: debts.length, category: null }),
			...debtFieldsOfTerms(preview.terms),
			name: name.trim(),
			kind,
			installmentsTotal: totalCount,
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
		if (!existing || sample) return;
		await saveDebt(existing.id, { ...draftOf(existing), archived: !existing.archived });
		announce(existing.archived ? t('debts.edit.unarchived') : t('debts.edit.archived'));
		router.back();
	};

	const handleDelete = () => {
		if (!existing || sample) return;
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
			{/* No Android, sem `behavior` nada encolhia e o teclado cobria o salvar no fim da rolagem (SPD-121): o `height` encolhe a área, como na `Sheet`. */}
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
				<View style={styles.header}>
					<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('debts.back')} style={styles.iconButton}>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
						{existing ? t('debts.edit.title') : t('debts.edit.newTitle')}
					</Text>
					{debtId ? null : <HelpButton trail="debts" here={{ screen: 'debtNew' }} from="2" />}
				</View>
				{sample ? <SampleBanner /> : null}

				<ScrollView ref={tourScroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<TourTarget id="debtEdit.kind">
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
					</TourTarget>

					<Field
						label={t('debts.edit.name')}
						value={name}
						onChangeText={setName}
						placeholder={t(`debts.edit.namePlaceholder.${kind}`)}
						placeholderTextColor="rgba(255,255,255,0.35)"
						error={errors.name}
					/>

					{!isConsortium ? (
						<TourTarget id="debtEdit.system">
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
						</TourTarget>
					) : null}

					<TourTarget id="debtEdit.installment">
						<Field
							label={system === 'sac' && !isConsortium ? t('debts.edit.nextInstallment') : t('debts.edit.installment')}
							value={installment}
							onChangeText={(text) => setInstallment(formatAmountInput(text))}
							onBlur={() => setInstallment(finaliseAmountInput(installment))}
							keyboardType="decimal-pad"
							selectTextOnFocus
							error={errors.installment}
						/>
					</TourTarget>

					<TourTarget id="debtEdit.remaining" style={styles.twoColumns}>
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
					</TourTarget>

					<TourTarget id="debtEdit.dueDay">
						<Field
							label={t('debts.edit.dueDay')}
							value={dueDay}
							onChangeText={(text) => setDueDay(onlyDigits(text, 2))}
							keyboardType="number-pad"
							maxLength={2}
							error={errors.dueDay}
						/>
					</TourTarget>

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
							<TourTarget id="debtEdit.adjustment">
								<Field
									label={t('debts.edit.adjustment')}
									hint={t('debts.edit.adjustmentHint')}
									value={adjustment}
									onChangeText={setAdjustment}
									keyboardType="decimal-pad"
									selectTextOnFocus
								/>
							</TourTarget>
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
							<TourTarget id="debtEdit.balance">
								<Field
									label={t('debts.edit.balance')}
									hint={t('debts.edit.balanceHint')}
									optionalLabel={t('debts.edit.optional')}
									value={balance}
									onChangeText={(text) => setBalance(formatAmountInput(text))}
									onBlur={() => setBalance(balance.trim() === '' ? '' : finaliseAmountInput(balance))}
									keyboardType="decimal-pad"
									selectTextOnFocus
								/>
							</TourTarget>
							<TourTarget id="debtEdit.rate">
								<Field
									label={t('debts.edit.rate')}
									hint={t('debts.edit.rateHint')}
									optionalLabel={t('debts.edit.optional')}
									value={rate}
									onChangeText={setRate}
									keyboardType="decimal-pad"
									selectTextOnFocus
								/>
							</TourTarget>
							<TourTarget id="debtEdit.ratePeriod">
								<ChipGroup<RatePeriod>
									label={t('debts.edit.ratePeriod')}
									options={[
										{ value: 'month', label: t('debts.edit.perMonth') },
										{ value: 'year', label: t('debts.edit.perYear') },
									]}
									selected={ratePeriod}
									onSelect={setRatePeriod}
								/>
							</TourTarget>
						</>
					)}

					{previewText ? (
						<TourTarget id="debtEdit.preview">
							<Text style={[styles.preview, derived?.rateBp === null && styles.previewWarning]} accessibilityLiveRegion="polite">
								{previewText}
							</Text>
						</TourTarget>
					) : null}
					{errors.values ? (
						<Text style={styles.error} accessibilityLiveRegion="polite">
							{errors.values}
						</Text>
					) : null}

					{bankAccounts.length > 0 ? (
						<TourTarget id="debtEdit.account">
							<SelectField
								label={t('debts.edit.account')}
								hint={t('debts.edit.accountHint')}
								options={accountSelectOptions(bankAccounts)}
								selected={accountId}
								onSelect={setAccountId}
								clearLabel={t('select.none')}
								onClear={() => setAccountId(null)}
							/>
						</TourTarget>
					) : null}

					<Button label={t('debts.edit.save')} onPress={handleSave} disabled={saving || Boolean(sample)} icon="checkmark" />

					{existing ? (
						<View style={styles.secondary}>
							<TourTarget id="debtEdit.archive">
								<Button
									label={existing.archived ? t('debts.edit.unarchive') : t('debts.edit.archive')}
									hint={t('debts.edit.archiveHint')}
									onPress={handleArchive}
									variant="secondary"
									icon={existing.archived ? 'arrow-undo-outline' : 'checkmark-done-outline'}
								/>
							</TourTarget>
							<TourTarget id="debtEdit.delete">
								<Button label={t('debts.edit.delete')} onPress={handleDelete} variant="danger" icon="trash-outline" />
							</TourTarget>
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
