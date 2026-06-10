import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useBudget } from '../contexts/BudgetContext';
import { formatCurrency } from '../utils/currencyUtils';
import BudgetEditor from './BudgetEditor';
import PeriodSelector from './PeriodSelector';

interface SummaryProps {
	spent: number;
	income: number;
	net: number;
	title?: string;
	showPercentage?: boolean;
}

const Summary: React.FC<SummaryProps> = ({
	spent,
	income: _income,
	net,
	title,
	showPercentage = true,
}) => {
	const { t } = useTranslation();
	const [showBudgetEditor, setShowBudgetEditor] = useState(false);
	const { currentBudget } = useBudget();

	const displayTitle = title ?? t('summary.monthlySummary');

	const budget = currentBudget !== null ? currentBudget : 0;
	const isBudgetSet = currentBudget !== null;

	const percentUsed = isBudgetSet && budget > 0 ? (spent / budget) * 100 : 0;
	const remaining = isBudgetSet ? budget - spent : 0;
	const isOverBudget = isBudgetSet && spent > budget;

	const handleEditBudget = () => {
		setShowBudgetEditor(true);
	};

	return (
		<View style={styles.container}>
			<View style={styles.headerRow}>
				<Text style={styles.title}>{displayTitle}</Text>
				<View style={styles.headerActions}>
					<PeriodSelector style={styles.monthSelector} textStyle={styles.month} />
				</View>
			</View>

			{/* Net Value */}
			<View style={styles.netContainer}>
				<Text style={styles.netLabel}>{t('summary.balance')}</Text>
				<Text
					style={[
						styles.netValue,
						net === 0
							? styles.neutralValue
							: net > 0
								? styles.positiveNetValue
								: styles.negativeNetValue,
					]}
				>
					{formatCurrency(net)}
				</Text>
			</View>

			{/* Budget Section if budget is set */}
			{isBudgetSet && (
				<>
					<View style={styles.divider} />

					<View style={styles.budgetRow}>
						<Text style={styles.budgetLabel}>{t('summary.budget')}</Text>
						<View style={styles.budgetValueContainer}>
							<Text style={styles.budgetValue}>{formatCurrency(budget)}</Text>
							<TouchableOpacity onPress={handleEditBudget} style={styles.editButton}>
								<Text style={styles.editButtonText}>{t('summary.edit')}</Text>
							</TouchableOpacity>
						</View>
					</View>

					{/* Progress Bar */}
					<View style={styles.progressBarContainer}>
						<View
							style={[
								styles.progressBar,
								{ width: `${Math.min(percentUsed, 100)}%` },
								isOverBudget && styles.overBudgetBar,
							]}
						/>
					</View>

					{showPercentage && (
						<Text style={[styles.progressText, isOverBudget && styles.overBudgetText]}>
							{t('summary.percentUsed', { percent: percentUsed.toFixed(0) })} •{' '}
							{isOverBudget ? `${t('summary.overBudgetBy')} ` : ''}
							{formatCurrency(Math.abs(remaining))}{' '}
							{!isOverBudget ? t('summary.remaining') : ''}
						</Text>
					)}
				</>
			)}

			{/* No Budget Set Message */}
			{!isBudgetSet && (
				<>
					<View style={styles.divider} />
					<View style={styles.noBudgetContainer}>
						<Text style={styles.noBudgetText}>{t('summary.noBudget')}</Text>
						<TouchableOpacity onPress={handleEditBudget} style={styles.setBudgetButton}>
							<Text style={styles.setBudgetButtonText}>{t('summary.setBudget')}</Text>
						</TouchableOpacity>
					</View>
				</>
			)}

			<BudgetEditor isVisible={showBudgetEditor} onClose={() => setShowBudgetEditor(false)} />
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
	headerRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 16,
	},
	headerActions: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	title: {
		fontSize: 16,
		color: '#ffffff',
		fontWeight: '500',
	},
	month: {
		fontSize: 14,
		color: '#888888',
		fontWeight: '600',
		letterSpacing: 0.5,
	},
	monthSelector: {
		padding: 4,
	},
	netContainer: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		justifyContent: 'space-between',
		alignContent: 'center',
		paddingVertical: 8,
	},
	netLabel: {
		fontSize: 16,
		fontWeight: '600',
		color: '#ffffff',
		alignSelf: 'center',
	},
	netValue: {
		fontSize: 36,
		fontWeight: '700',
	},
	neutralValue: {
		color: '#ffffff',
	},
	positiveNetValue: {
		color: '#4CAF50',
	},
	negativeNetValue: {
		color: '#FF6B6B',
	},
	divider: {
		height: 1,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginVertical: 12,
	},
	budgetRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 8,
	},
	budgetLabel: {
		fontSize: 14,
		color: '#888888',
	},
	budgetValueContainer: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	budgetValue: {
		fontSize: 16,
		fontWeight: '600',
		color: '#ffffff',
		marginRight: 8,
	},
	editButton: {
		paddingHorizontal: 8,
		paddingVertical: 4,
		backgroundColor: 'rgba(80, 202, 227, 0.2)',
		borderRadius: 4,
	},
	editButtonText: {
		color: '#15E8FE',
		fontSize: 12,
		fontWeight: '600',
	},
	progressBarContainer: {
		height: 6,
		backgroundColor: '#333333',
		borderRadius: 3,
		marginBottom: 8,
		overflow: 'hidden',
	},
	progressBar: {
		height: '100%',
		backgroundColor: '#15E8FE',
		borderRadius: 3,
	},
	overBudgetBar: {
		backgroundColor: '#FF6B6B',
	},
	progressText: {
		fontSize: 14,
		color: '#888888',
	},
	overBudgetText: {
		color: '#FF6B6B',
	},
	noBudgetContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	noBudgetText: {
		fontSize: 14,
		color: '#888888',
		fontStyle: 'italic',
	},
	setBudgetButton: {
		paddingHorizontal: 12,
		paddingVertical: 6,
		backgroundColor: 'rgba(80, 202, 227, 0.2)',
		borderRadius: 4,
	},
	setBudgetButtonText: {
		color: '#15E8FE',
		fontSize: 12,
		fontWeight: '600',
	},
});

export default Summary;
