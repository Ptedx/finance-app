import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import type { RetirementGoalDraft } from '../../database/database';
import { centsToDisplayInput, finaliseAmountInput, formatAmountInput, formatCents, parseAmountToCents } from '../../utils/money';
import { bpToPercentInput, percentInputToBp } from '../../utils/percent';
import { DEFAULT_EXPECTED_YIELD_BP, DEFAULT_REINVEST_BP, type RetirementGoal, requiredCapitalCents, requiredMonthlyCents } from '../../utils/retirement';
import { Button, Field } from '../cards/formParts';
import Sheet from '../cards/Sheet';

/**
 * Definir a meta: a renda que se quer, a margem reinvestida, o rendimento esperado e o
 * que já está investido fora do app. A prévia mostra na hora o capital necessário, para o
 * usuário ver o efeito de cada número antes de salvar.
 *
 * A renda **não** é pedida aqui: ela vem do livro, e um segundo lugar para digitá-la
 * seria um segundo lugar para ela divergir.
 */
const GoalSheet: React.FC<{
	visible: boolean;
	goal: RetirementGoal | null;
	onSave: (draft: RetirementGoalDraft) => Promise<void>;
	onClear: () => Promise<void>;
	onClose: () => void;
}> = ({ visible, goal, onSave, onClear, onClose }) => {
	const { t } = useTranslation();
	const [target, setTarget] = useState('');
	const [reinvest, setReinvest] = useState('');
	const [yieldInput, setYieldInput] = useState('');
	const [outside, setOutside] = useState('');
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!visible) return;
		setTarget(goal ? centsToDisplayInput(goal.targetMonthlyCents) : '');
		setReinvest(bpToPercentInput(goal?.reinvestBp ?? DEFAULT_REINVEST_BP));
		setYieldInput(bpToPercentInput(goal?.expectedYieldBp ?? DEFAULT_EXPECTED_YIELD_BP));
		setOutside(goal && goal.outsideCapitalCents > 0 ? centsToDisplayInput(goal.outsideCapitalCents) : '');
		setError(undefined);
	}, [visible, goal]);

	const targetCents = parseAmountToCents(target);
	const reinvestBp = percentInputToBp(reinvest);
	const expectedYieldBp = percentInputToBp(yieldInput);
	const outsideCents = outside.trim() === '' ? 0 : parseAmountToCents(outside);

	const preview = (() => {
		if (targetCents === null || targetCents <= 0 || reinvestBp === null || expectedYieldBp === null) return null;
		const gross = requiredMonthlyCents(targetCents, reinvestBp);
		const capital = requiredCapitalCents(gross, expectedYieldBp);
		return capital === null ? t('reports.goalSheet.previewNoYield', { gross: formatCents(gross) }) : t('reports.goalSheet.preview', { gross: formatCents(gross), capital: formatCents(capital) });
	})();

	const submit = async () => {
		if (targetCents === null || targetCents <= 0 || reinvestBp === null || expectedYieldBp === null || expectedYieldBp <= 0 || outsideCents === null || outsideCents < 0) {
			setError(t('reports.goalSheet.invalid'));
			AccessibilityInfo.announceForAccessibility(t('reports.goalSheet.invalid'));
			return;
		}
		await onSave({ targetMonthlyCents: targetCents, reinvestBp, expectedYieldBp, outsideCapitalCents: outsideCents });
		AccessibilityInfo.announceForAccessibility(t('reports.goalSheet.saved'));
		onClose();
	};

	return (
		<Sheet visible={visible} onClose={onClose} title={t('reports.goalSheet.title')} subtitle={t('reports.goalSheet.subtitle')}>
			<Field
				label={t('reports.goalSheet.targetMonthly')}
				hint={t('reports.goalSheet.targetMonthlyHint')}
				value={target}
				onChangeText={(text) => setTarget(formatAmountInput(text))}
				onBlur={() => setTarget(finaliseAmountInput(target))}
				keyboardType="decimal-pad"
				selectTextOnFocus
				placeholder="10.000,00"
				placeholderTextColor="rgba(255,255,255,0.35)"
			/>
			<Field
				label={t('reports.goalSheet.reinvest')}
				hint={t('reports.goalSheet.reinvestHint')}
				value={reinvest}
				onChangeText={setReinvest}
				keyboardType="decimal-pad"
				selectTextOnFocus
			/>
			<Field
				label={t('reports.goalSheet.expectedYield')}
				hint={t('reports.goalSheet.expectedYieldHint')}
				value={yieldInput}
				onChangeText={setYieldInput}
				keyboardType="decimal-pad"
				selectTextOnFocus
			/>
			<Field
				label={t('reports.goalSheet.outsideCapital')}
				hint={t('reports.goalSheet.outsideCapitalHint')}
				optionalLabel={t('reports.goalSheet.optional')}
				value={outside}
				onChangeText={(text) => setOutside(formatAmountInput(text))}
				onBlur={() => setOutside(outside.trim() === '' ? '' : finaliseAmountInput(outside))}
				keyboardType="decimal-pad"
				selectTextOnFocus
				error={error}
			/>
			{preview ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{preview}
				</Text>
			) : null}
			<Button label={t('reports.goalSheet.save')} icon="checkmark" onPress={submit} />
			{goal ? (
				<Button
					label={t('reports.goalSheet.clear')}
					icon="trash-outline"
					variant="danger"
					onPress={async () => {
						await onClear();
						onClose();
					}}
				/>
			) : null}
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

export default GoalSheet;
