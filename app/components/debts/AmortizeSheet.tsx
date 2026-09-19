import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, StyleSheet, Text } from 'react-native';
import type { Debt } from '../../database/schema';
import { formatMonthYear, todayISO } from '../../utils/dateUtils';
import { debtStateOn, type ExtraPaymentMode, monthlyRateOf, simulateExtraPayment, termsOf, worthPayingOff } from '../../utils/debt';
import { finaliseAmountInput, formatAmountInput, formatCents, parseAmountToCents } from '../../utils/money';
import { formatPercentBp } from '../../utils/percent';
import { Button, ChipGroup, Field } from '../cards/formParts';
import Sheet from '../cards/Sheet';

/**
 * "E se eu antecipar R$ X?" — reduzindo o prazo ou a parcela, quanto sai do bolso a menos
 * até quitar, e quanto o mesmo dinheiro renderia investido pelo mesmo prazo. Registrar a
 * amortização move a âncora da dívida para hoje; o débito do banco continua chegando como
 * um lançamento qualquer.
 */
const AmortizeSheet: React.FC<{
	visible: boolean;
	debt: Debt;
	investmentYieldBp: number;
	onClose: () => void;
	onConfirm: (result: NonNullable<ReturnType<typeof simulateExtraPayment>>) => Promise<void>;
}> = ({ visible, debt, investmentYieldBp, onClose, onConfirm }) => {
	const { t } = useTranslation();
	const [amount, setAmount] = useState('');
	const [mode, setMode] = useState<ExtraPaymentMode>('shorten');
	const today = todayISO();

	useEffect(() => {
		if (!visible) return;
		setAmount('');
		setMode('shorten');
	}, [visible]);

	const extraCents = parseAmountToCents(amount);
	const terms = useMemo(() => termsOf(debt), [debt]);
	const state = useMemo(() => debtStateOn(terms, today), [terms, today]);
	const result = useMemo(
		() => (extraCents !== null && extraCents > 0 ? simulateExtraPayment(terms, today, extraCents, mode) : null),
		[terms, today, extraCents, mode]
	);

	// O mesmo dinheiro investido, pelo prazo que a dívida ainda tem, no rendimento líquido.
	const investedGainCents = useMemo(() => {
		if (extraCents === null || extraCents <= 0) return null;
		const { netYieldBp } = worthPayingOff({ debtRateBp: debt.rateBp, investmentYieldBp });
		const months = state.remaining;
		return Math.round(extraCents * ((1 + monthlyRateOf(netYieldBp)) ** months - 1));
	}, [extraCents, debt.rateBp, investmentYieldBp, state.remaining]);

	const resultText = (() => {
		if (!result) return null;
		const lines: string[] = [];
		if (result.newBalanceCents <= 0) {
			lines.push(t('debts.amortize.paysOff'));
		} else if (mode === 'shorten') {
			lines.push(
				t('debts.amortize.shortenResult', {
					count: result.monthsSaved,
					date: result.newPayoffDate ? formatMonthYear(result.newPayoffDate) : '—',
				})
			);
		} else {
			lines.push(t('debts.amortize.lowerResult', { amount: formatCents(result.newInstallmentCents) }));
		}
		lines.push(t(debt.kind === 'consortium' ? 'debts.amortize.savedAdjustment' : 'debts.amortize.saved', { amount: formatCents(result.savedCents) }));
		if (investedGainCents !== null) {
			lines.push(
				t('debts.amortize.invested', {
					amount: formatCents(investedGainCents),
					rate: formatPercentBp(worthPayingOff({ debtRateBp: debt.rateBp, investmentYieldBp }).netYieldBp),
				})
			);
		}
		return lines.join('\n');
	})();

	const confirm = () => {
		if (!result) return;
		Alert.alert(t('debts.amortize.confirmTitle'), t('debts.amortize.confirmBody', { amount: formatCents(extraCents ?? 0), name: debt.name }), [
			{ text: t('debts.edit.cancel'), style: 'cancel' },
			{
				text: t('debts.amortize.confirm'),
				onPress: async () => {
					await onConfirm(result);
					AccessibilityInfo.announceForAccessibility(t('debts.amortize.recorded'));
					onClose();
				},
			},
		]);
	};

	return (
		<Sheet visible={visible} onClose={onClose} title={t('debts.amortize.title')} subtitle={t('debts.amortize.subtitle', { balance: formatCents(state.balanceCents) })}>
			<Field
				label={t('debts.amortize.amount')}
				value={amount}
				onChangeText={(text) => setAmount(formatAmountInput(text))}
				onBlur={() => setAmount(amount.trim() === '' ? '' : finaliseAmountInput(amount))}
				keyboardType="decimal-pad"
				selectTextOnFocus
			/>
			<ChipGroup<ExtraPaymentMode>
				label={t('debts.amortize.mode')}
				hint={t('debts.amortize.modeHint')}
				options={[
					{ value: 'shorten', label: t('debts.amortize.shorten') },
					{ value: 'lower', label: t('debts.amortize.lower') },
				]}
				selected={mode}
				onSelect={setMode}
			/>
			{resultText ? (
				<Text style={styles.result} accessibilityLiveRegion="polite">
					{resultText}
				</Text>
			) : null}
			<Button label={t('debts.amortize.record')} icon="checkmark" onPress={confirm} disabled={!result} hint={t('debts.amortize.recordHint')} />
		</Sheet>
	);
};

const styles = StyleSheet.create({
	result: {
		fontSize: 15,
		lineHeight: 22,
		color: '#FFFFFF',
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		padding: 12,
	},
});

export default AmortizeSheet;
