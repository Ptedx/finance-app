import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useBudget } from '../contexts/BudgetContext';
import { formatCents } from '../utils/money';
import BudgetEditor from './BudgetEditor';
import PeriodSelector from './PeriodSelector';

interface SummaryProps {
	/** Expenses in the selected period, in cents. */
	expenseCents: number;
	/** Income in the selected period, in cents. */
	incomeCents: number;
	/** Income minus expenses for the selected period, in cents. */
	netCents: number;
	/** All-time balance up to today, in cents. Not scoped to the period. */
	balanceCents: number;
	title?: string;
	showPercentage?: boolean;
}

const Summary: React.FC<SummaryProps> = ({
	expenseCents,
	incomeCents,
	netCents,
	balanceCents,
	title,
	showPercentage = true,
}) => {
	const { t } = useTranslation();
	const [showBudgetEditor, setShowBudgetEditor] = useState(false);
	const { currentBudgetCents } = useBudget();

	const displayTitle = title ?? t('summary.monthlySummary');

	const isBudgetSet = currentBudgetCents !== null;
	const budgetCents = currentBudgetCents ?? 0;

	// Integer cents throughout, so the over-budget comparison is exact at the boundary.
	const percentUsed = isBudgetSet && budgetCents > 0 ? (expenseCents / budgetCents) * 100 : 0;
	const remainingCents = isBudgetSet ? budgetCents - expenseCents : 0;
	const isOverBudget = isBudgetSet && expenseCents > budgetCents;

	const handleEditBudget = () => {
		setShowBudgetEditor(true);
	};

	const amountTone = (cents: number) =>
		cents === 0
			? styles.neutralValue
			: cents > 0
				? styles.positiveNetValue
				: styles.negativeNetValue;

	return (
		<View style={styles.container}>
			<View style={styles.headerRow}>
				<Text style={styles.title}>{displayTitle}</Text>
				<View style={styles.headerActions}>
					<PeriodSelector style={styles.monthSelector} textStyle={styles.month} />
				</View>
			</View>

			{/* Result for the selected period */}
			<View style={styles.netContainer}>
				<Text style={styles.netLabel}>{t('summary.monthResult')}</Text>
				<Text style={[styles.netValue, amountTone(netCents)]}>{formatCents(netCents)}</Text>
			</View>

			{/* The two components of that result, so the figures visibly add up */}
			<View style={styles.breakdownRow}>
				<View style={styles.breakdownItem}>
					<Text style={styles.breakdownLabel}>{t('summary.income')}</Text>
					<Text style={[styles.breakdownValue, styles.positiveNetValue]}>
						{formatCents(incomeCents)}
					</Text>
				</View>
				<View style={[styles.breakdownItem, styles.breakdownItemRight]}>
					<Text style={styles.breakdownLabel}>{t('summary.expenses')}</Text>
					<Text style={[styles.breakdownValue, styles.negativeNetValue]}>
						{formatCents(expenseCents)}
					</Text>
				</View>
			</View>

			<View style={styles.divider} />

			{/* All-time balance, kept visually separate from the period figures above */}
			<View style={styles.balanceRow}>
				<Text style={styles.balanceLabel}>{t('summary.accumulatedBalance')}</Text>
				<Text style={[styles.balanceValue, amountTone(balanceCents)]}>
					{formatCents(balanceCents)}
				</Text>
			</View>

			{/* Budget Section if budget is set */}
			{isBudgetSet && (
				<>
					<View style={styles.divider} />

					<View style={styles.budgetRow}>
						<Text style={styles.budgetLabel}>{t('summary.budget')}</Text>
						<View style={styles.budgetValueContainer}>
							<Text style={styles.budgetValue}>{formatCents(budgetCents)}</Text>
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
							{formatCents(Math.abs(remainingCents))} {!isOverBudget ? t('summary.remaining') : ''}
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
	breakdownRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		paddingTop: 4,
	},
	breakdownItem: {
		flex: 1,
	},
	breakdownItemRight: {
		alignItems: 'flex-end',
	},
	breakdownLabel: {
		fontSize: 12,
		color: '#888888',
		marginBottom: 2,
	},
	breakdownValue: {
		fontSize: 15,
		fontWeight: '600',
	},
	balanceRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	balanceLabel: {
		fontSize: 14,
		color: '#888888',
	},
	balanceValue: {
		fontSize: 18,
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
