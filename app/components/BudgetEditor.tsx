import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { useBudget } from '../contexts/BudgetContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePeriod } from '../contexts/PeriodContext';
import { formatCurrency, parseAmount } from '../utils/currencyUtils';

interface BudgetEditorProps {
	isVisible: boolean;
	onClose: () => void;
}

const BudgetEditor: React.FC<BudgetEditorProps> = ({ isVisible, onClose }) => {
	const { t } = useTranslation();
	const { currentBudget, setBudgetForCurrentPeriod, clearBudgetForCurrentPeriod } = useBudget();
	const { selectedMonthName, selectedYear } = usePeriod();
	const { currentCurrency } = useCurrency();

	const [budgetInput, setBudgetInput] = useState(
		currentBudget !== null ? currentBudget.toString() : ''
	);

	const handleSave = async () => {
		try {
			const amount = parseAmount(budgetInput);

			if (Number.isNaN(amount) || amount <= 0) {
				Alert.alert(t('budgetEditor.invalidBudget'), t('budgetEditor.invalidBudgetMsg'));
				return;
			}

			await setBudgetForCurrentPeriod(amount);
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

	return (
		<Modal visible={isVisible} transparent={true} animationType="slide">
			<View style={styles.modalContainer}>
				<View style={styles.modalContent}>
					<Text style={styles.modalTitle}>{t('budgetEditor.modalTitle')}</Text>
					<Text style={styles.periodText}>
						{selectedMonthName} {selectedYear}
					</Text>

					<View style={styles.inputContainer}>
						<Text style={styles.currencySymbol}>{currentCurrency.symbol}</Text>
						<TextInput
							style={styles.input}
							value={budgetInput}
							onChangeText={setBudgetInput}
							placeholder={t('budgetEditor.placeholder')}
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
							keyboardType="decimal-pad"
							autoFocus
						/>
					</View>

					<View style={styles.currentBudgetContainer}>
						<Text style={styles.currentBudgetLabel}>{t('budgetEditor.currentBudget')}</Text>
						<Text style={styles.currentBudgetValue}>
							{currentBudget !== null ? formatCurrency(currentBudget) : t('budgetEditor.notSet')}
						</Text>
					</View>

					<View style={styles.buttonRow}>
						<TouchableOpacity style={styles.clearButton} onPress={handleClear}>
							<Text style={styles.clearButtonText}>{t('budgetEditor.clear')}</Text>
						</TouchableOpacity>

						<TouchableOpacity style={styles.cancelButton} onPress={onClose}>
							<Text style={styles.cancelButtonText}>{t('budgetEditor.cancel')}</Text>
						</TouchableOpacity>

						<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
							<Text style={styles.saveButtonText}>{t('budgetEditor.save')}</Text>
						</TouchableOpacity>
					</View>
				</View>
			</View>
		</Modal>
	);
};

const styles = StyleSheet.create({
	modalContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
	},
	modalContent: {
		width: '90%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 20,
	},
	modalTitle: {
		fontSize: 20,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 8,
	},
	periodText: {
		fontSize: 16,
		color: '#15E8FE',
		textAlign: 'center',
		marginBottom: 20,
	},
	inputContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginBottom: 16,
	},
	currencySymbol: {
		fontSize: 24,
		fontWeight: '600',
		color: '#FFFFFF',
		marginRight: 8,
	},
	input: {
		flex: 1,
		fontSize: 24,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	currentBudgetContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginBottom: 24,
	},
	currentBudgetLabel: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	currentBudgetValue: {
		fontSize: 14,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	buttonRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	clearButton: {
		flex: 1,
		padding: 12,
		borderRadius: 8,
		backgroundColor: 'rgba(255, 107, 107, 0.2)',
		marginRight: 8,
		alignItems: 'center',
	},
	clearButtonText: {
		color: '#FF6B6B',
		fontWeight: '600',
	},
	cancelButton: {
		flex: 1,
		padding: 12,
		borderRadius: 8,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 8,
		alignItems: 'center',
	},
	cancelButtonText: {
		color: '#FFFFFF',
		fontWeight: '600',
	},
	saveButton: {
		flex: 1,
		padding: 12,
		borderRadius: 8,
		backgroundColor: '#15E8FE',
		alignItems: 'center',
	},
	saveButtonText: {
		color: '#000000',
		fontWeight: '600',
	},
});

export default BudgetEditor;
