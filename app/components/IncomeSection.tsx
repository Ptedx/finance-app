import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { formatCurrency } from '../utils/currencyUtils';
import TransactionEditor from './TransactionEditor';

interface IncomeSectionProps {
	onIncomePress?: () => void;
	onExpensePress?: () => void;
}

const IncomeSection: React.FC<IncomeSectionProps> = () => {
	const router = useRouter();
	const { t } = useTranslation();
	const { transactions } = useRecurringTransactions();
	const [showIncomeEditor, setShowIncomeEditor] = useState(false);
	const [showExpenseEditor, setShowExpenseEditor] = useState(false);

	const recurringIncome = transactions
		.filter((tx) => tx.isIncome && tx.active)
		.reduce((sum, tx) => sum + tx.amount, 0);

	const recurringExpenses = transactions
		.filter((tx) => !tx.isIncome && tx.active)
		.reduce((sum, tx) => sum + tx.amount, 0);

	const handleIncomePress = () => {
		setShowIncomeEditor(true);
	};

	const handleExpensePress = () => {
		setShowExpenseEditor(true);
	};

	const handleManageTransactions = () => {
		router.push('/screens/TransactionsScreen');
	};

	return (
		<View style={styles.container}>
			<View style={styles.headerRow}>
				<Text style={styles.title}>{t('incomeSection.periodicTransactions')}</Text>
				<TouchableOpacity style={styles.manageButton} onPress={handleManageTransactions}>
					<Text style={styles.manageButtonText}>{t('incomeSection.manageTransactions')}</Text>
				</TouchableOpacity>
			</View>

			{/* Summary row */}
			{(recurringIncome > 0 || recurringExpenses > 0) && (
				<View style={styles.summaryRow}>
					{recurringIncome > 0 && (
						<View style={styles.summaryItem}>
							<Text style={styles.summaryLabel}>{t('incomeSection.monthlyIncome')}</Text>
							<Text style={[styles.summaryValue, styles.incomeValue]}>
								+{formatCurrency(recurringIncome)}
							</Text>
						</View>
					)}

					{recurringExpenses > 0 && (
						<View style={styles.summaryItem}>
							<Text style={styles.summaryLabel2}>{t('incomeSection.monthlyExpenses')}</Text>
							<Text style={[styles.summaryValue2, styles.expenseValue]}>
								-{formatCurrency(recurringExpenses)}
							</Text>
						</View>
					)}
				</View>
			)}

			<View style={styles.buttonsContainer}>
				<TouchableOpacity style={[styles.button, styles.incomeButton]} onPress={handleIncomePress}>
					<Ionicons name="arrow-down-circle" size={20} color="#15E8FE" style={styles.buttonIcon} />
					<Text style={styles.buttonText}>{t('incomeSection.income')}</Text>
				</TouchableOpacity>

				<TouchableOpacity
					style={[styles.button, styles.expenseButton]}
					onPress={handleExpensePress}
				>
					<Ionicons name="arrow-up-circle" size={20} color="#FF6B6B" style={styles.buttonIcon} />
					<Text style={styles.buttonText}>{t('incomeSection.expense')}</Text>
				</TouchableOpacity>
			</View>

			<TransactionEditor
				isVisible={showIncomeEditor}
				onClose={() => setShowIncomeEditor(false)}
				isIncome={true}
			/>

			<TransactionEditor
				isVisible={showExpenseEditor}
				onClose={() => setShowExpenseEditor(false)}
				isIncome={false}
			/>
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 20,
	},
	title: {
		fontSize: 16,
		color: '#ffffff',
		fontWeight: '500',
		marginBottom: 12,
	},
	buttonsContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	button: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		paddingVertical: 12,
		borderRadius: 8,
		borderWidth: 1,
	},
	incomeButton: {
		marginRight: 8,
		borderColor: 'rgba(80, 224, 227, 0.3)',
		backgroundColor: 'rgba(21, 232, 254, 0.3)',
	},
	expenseButton: {
		marginLeft: 8,
		borderColor: 'rgba(255, 107, 107, 0.3)',
		backgroundColor: 'rgba(255, 107, 107, 0.1)',
	},
	buttonIcon: {
		marginRight: 8,
	},
	buttonText: {
		color: '#FFFFFF',
		fontWeight: '500',
	},
	headerRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 12,
	},
	manageButton: {
		paddingHorizontal: 12,
		paddingVertical: 6,
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		borderRadius: 4,
	},
	manageButtonText: {
		color: '#15E8FE',
		fontSize: 12,
		fontWeight: '600',
	},
	summaryRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginBottom: 16,
		paddingHorizontal: 4,
	},
	summaryItem: {
		flex: 1,
	},
	summaryLabel: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
		marginBottom: 4,
	},
	summaryValue: {
		fontSize: 16,
		fontWeight: '600',
	},
	summaryLabel2: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
		marginBottom: 4,
		marginLeft: 'auto',
	},
	summaryValue2: {
		fontSize: 16,
		fontWeight: '600',
		marginLeft: 'auto',
	},
	incomeValue: {
		color: '#15E8FE',
	},
	expenseValue: {
		color: '#FF6B6B',
	},
});

export default IncomeSection;
