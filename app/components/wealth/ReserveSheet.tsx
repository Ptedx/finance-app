import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import type { ReserveGoalDraft } from '../../database/database';
import type { ReserveGoal } from '../../hooks/useReserveGoal';
import { centsToDisplayInput, finaliseAmountInput, formatAmountInput, formatCents, parseAmountToCents } from '../../utils/money';
import { Button, ChipGroup, Field } from '../cards/formParts';
import Sheet from '../cards/Sheet';

const MONTH_PRESETS = ['3', '6', '12'] as const;

/**
 * O tamanho da reserva: quantos meses de custo essencial e, se o usuário quiser, o custo
 * mensal à mão (vazio = o app calcula pelos lançamentos). A prévia mostra a meta em reais.
 */
const ReserveSheet: React.FC<{
	visible: boolean;
	goal: ReserveGoal;
	/** O custo que o app calculou, para a dica e a prévia sem valor à mão. */
	computedCostCents: number | null;
	onSave: (draft: ReserveGoalDraft) => Promise<void>;
	onClose: () => void;
}> = ({ visible, goal, computedCostCents, onSave, onClose }) => {
	const { t } = useTranslation();
	const [months, setMonths] = useState('');
	const [cost, setCost] = useState('');
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!visible) return;
		setMonths(String(goal.targetMonths));
		setCost(goal.customMonthlyCostCents ? centsToDisplayInput(goal.customMonthlyCostCents) : '');
		setError(undefined);
	}, [visible, goal]);

	const monthsValue = /^\d{1,3}$/.test(months.trim()) ? Number(months.trim()) : null;
	const costCents = cost.trim() === '' ? null : parseAmountToCents(cost);
	const effectiveCost = costCents ?? computedCostCents;

	const preview =
		monthsValue && monthsValue > 0 && effectiveCost && effectiveCost > 0
			? t('reserve.sheet.preview', { target: formatCents(effectiveCost * monthsValue), months: monthsValue, cost: formatCents(effectiveCost) })
			: null;

	const submit = async () => {
		const invalidCost = cost.trim() !== '' && (costCents === null || costCents <= 0);
		if (monthsValue === null || monthsValue < 1 || monthsValue > 120 || invalidCost) {
			setError(t('reserve.sheet.invalid'));
			AccessibilityInfo.announceForAccessibility(t('reserve.sheet.invalid'));
			return;
		}
		await onSave({ targetMonths: monthsValue, customMonthlyCostCents: costCents });
		AccessibilityInfo.announceForAccessibility(t('reserve.sheet.saved'));
		onClose();
	};

	return (
		<Sheet visible={visible} onClose={onClose} title={t('reserve.sheet.title')} subtitle={t('reserve.sheet.subtitle')}>
			<ChipGroup
				label={t('reserve.sheet.months')}
				hint={t('reserve.sheet.monthsHint')}
				options={MONTH_PRESETS.map((value) => ({ value, label: t('reserve.sheet.monthsOption', { count: Number(value) }) }))}
				selected={MONTH_PRESETS.find((value) => value === months.trim()) ?? null}
				onSelect={setMonths}
			/>
			<Field
				label={t('reserve.sheet.monthsOther')}
				value={months}
				onChangeText={(text) => setMonths(text.replace(/\D/g, '').slice(0, 3))}
				keyboardType="number-pad"
				selectTextOnFocus
			/>
			<Field
				label={t('reserve.sheet.cost')}
				hint={computedCostCents ? t('reserve.sheet.costHint', { amount: formatCents(computedCostCents) }) : t('reserve.sheet.costHintUnknown')}
				optionalLabel={t('reports.goalSheet.optional')}
				value={cost}
				onChangeText={(text) => setCost(formatAmountInput(text))}
				onBlur={() => setCost(cost.trim() === '' ? '' : finaliseAmountInput(cost))}
				keyboardType="decimal-pad"
				selectTextOnFocus
				placeholder={computedCostCents ? centsToDisplayInput(computedCostCents) : '4.000,00'}
				placeholderTextColor="rgba(255,255,255,0.35)"
				error={error}
			/>
			{preview ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{preview}
				</Text>
			) : null}
			<Button label={t('reserve.sheet.save')} icon="checkmark" onPress={submit} />
		</Sheet>
	);
};

const styles = StyleSheet.create({
	preview: {
		fontSize: 14,
		color: '#FFFFFF',
		backgroundColor: 'rgba(21, 232, 254, 0.1)',
		borderRadius: 10,
		padding: 12,
		lineHeight: 20,
	},
});

export default ReserveSheet;
