import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Text } from 'react-native';

import { useBudget } from '../contexts/BudgetContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePeriod } from '../contexts/PeriodContext';
import { getMonthName } from '../utils/dateUtils';
import {
	centsToDisplayInput,
	finaliseAmountInput,
	formatAmountInput,
	formatCents,
	parseAmountToCents,
} from '../utils/money';
import { Button, Field } from './cards/formParts';
import Sheet from './cards/Sheet';

interface BudgetEditorProps {
	isVisible: boolean;
	onClose: () => void;
}

/**
 * Definir o orçamento do mês escolhido.
 *
 * É uma `Sheet`, como as outras folhas do app: ela sobe com o teclado e o Salvar responde
 * com o teclado aberto — no modal antigo os botões ficavam atrás do teclado e o primeiro
 * toque só fechava o teclado. O mês vem de `getMonthName` na hora de desenhar, no idioma do
 * app; o `selectedMonthName` do `PeriodContext` podia ficar preso no inglês do arranque.
 */
const BudgetEditor: React.FC<BudgetEditorProps> = ({ isVisible, onClose }) => {
	const { t } = useTranslation();
	const { currentBudgetCents, budgetInheritedFrom, setBudgetForCurrentPeriod, clearBudgetForCurrentPeriod } =
		useBudget();
	const { selectedMonth, selectedYear } = usePeriod();
	const { currentCurrency } = useCurrency();

	const [budgetInput, setBudgetInput] = useState('');

	// A folha fica montada o tempo todo: o campo é preenchido de novo a cada abertura, com o
	// orçamento do mês que estiver escolhido agora.
	useEffect(() => {
		if (!isVisible) return;
		setBudgetInput(currentBudgetCents !== null ? centsToDisplayInput(currentBudgetCents) : '');
	}, [isVisible, currentBudgetCents]);

	const handleSave = async () => {
		try {
			const amountCents = parseAmountToCents(budgetInput);

			if (amountCents === null || amountCents <= 0) {
				Alert.alert(t('budgetEditor.invalidBudget'), t('budgetEditor.invalidBudgetMsg'));
				return;
			}

			await setBudgetForCurrentPeriod(amountCents);
			onClose();
		} catch (error) {
			console.error('Failed to save budget:', error);
			Alert.alert(t('budgetEditor.error'), t('budgetEditor.failedSave'));
		}
	};

	const handleClear = async () => {
		try {
			await clearBudgetForCurrentPeriod();
			onClose();
		} catch (error) {
			console.error('Failed to clear budget:', error);
			Alert.alert(t('budgetEditor.error'), t('budgetEditor.failedClear'));
		}
	};

	// Só o mês que tem orçamento próprio tem o que limpar; o que herda não grava nada.
	const ownBudget = currentBudgetCents !== null && budgetInheritedFrom === null;

	return (
		<Sheet
			visible={isVisible}
			onClose={onClose}
			title={t('budgetEditor.modalTitle')}
			subtitle={t('budgetEditor.period', { month: getMonthName(selectedMonth), year: selectedYear })}
		>
			<Field
				label={t('budgetEditor.amountLabel', { symbol: currentCurrency.symbol })}
				hint={t('budgetEditor.appliesFrom')}
				value={budgetInput}
				onChangeText={(text) => setBudgetInput(formatAmountInput(text))}
				onBlur={() => setBudgetInput(finaliseAmountInput(budgetInput))}
				placeholder={t('budgetEditor.placeholder')}
				keyboardType="decimal-pad"
				selectTextOnFocus
				autoFocus
			/>

			<Text style={styles.current}>
				{t('budgetEditor.currentBudget')}{' '}
				{currentBudgetCents !== null ? formatCents(currentBudgetCents) : t('budgetEditor.notSet')}
			</Text>
			{budgetInheritedFrom ? (
				<Text style={styles.inherited}>
					{t('budgetEditor.inheritedFrom', {
						month: getMonthName(budgetInheritedFrom.month),
						year: budgetInheritedFrom.year,
					})}
				</Text>
			) : null}

			<Button label={t('budgetEditor.save')} icon="checkmark" onPress={handleSave} />
			{ownBudget ? (
				<Button label={t('budgetEditor.clear')} icon="trash-outline" variant="danger" onPress={handleClear} />
			) : null}
			<Button label={t('budgetEditor.cancel')} variant="secondary" onPress={onClose} />
		</Sheet>
	);
};

const styles = StyleSheet.create({
	current: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.75)',
	},
	inherited: {
		fontSize: 14,
		lineHeight: 20,
		color: '#FFFFFF',
		backgroundColor: 'rgba(21, 232, 254, 0.1)',
		borderRadius: 10,
		padding: 12,
	},
});

export default BudgetEditor;
