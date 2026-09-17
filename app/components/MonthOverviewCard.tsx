import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAccounts } from '../contexts/AccountsContext';
import { useBudget } from '../contexts/BudgetContext';
import { formatCents } from '../utils/money';
import BudgetEditor from './BudgetEditor';
import PeriodSelector from './PeriodSelector';

/**
 * O quadro do mês: quanto entrou, quanto saiu de verdade e por onde, quanto foi
 * guardado e quanto sobrou. É o card que responde "gastei 6.800 ou 10.200?".
 *
 * Ordem de leitura de cima para baixo, como uma conta de padaria: receita, cada
 * bolso de gasto, total, guardado, sobrou. O número grande é o "sobrou", porque é
 * ele que muda o comportamento. O orçamento, quando existe, compara com o gasto total
 * — não só com o cartão.
 */

const ACCENT = '#15E8FE';

const Row: React.FC<{ label: string; value: string; sub?: string; emphasis?: 'income' | 'expense' | 'neutral'; indent?: boolean }> = ({
	label,
	value,
	sub,
	emphasis = 'neutral',
	indent,
}) => (
	<View style={[styles.row, indent && styles.rowIndent]} accessible accessibilityLabel={`${label}, ${value}${sub ? `, ${sub}` : ''}`}>
		<View style={styles.rowText}>
			<Text style={[styles.rowLabel, indent && styles.rowLabelIndent]}>{label}</Text>
			{sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
		</View>
		<Text style={[styles.rowValue, emphasis === 'income' && styles.income, emphasis === 'expense' && styles.expense]}>{value}</Text>
	</View>
);

const MonthOverviewCard: React.FC = () => {
	const { t } = useTranslation();
	const { month } = useAccounts();
	const { currentBudgetCents } = useBudget();
	const [showBudgetEditor, setShowBudgetEditor] = useState(false);

	if (!month) return null;

	const budgetSet = currentBudgetCents !== null && currentBudgetCents > 0;
	const budgetPercent = budgetSet ? Math.round((month.totalSpendCents / (currentBudgetCents as number)) * 100) : 0;
	const overBudget = budgetSet && month.totalSpendCents > (currentBudgetCents as number);
	const ratePercent = month.savingsRateBp === null ? null : Math.round(month.savingsRateBp / 100);

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<Text style={styles.title} accessibilityRole="header">
					{t('month.title')}
				</Text>
				{/* Trocar de mês continua a um toque: o resumo antigo tinha o seletor, e o
				    quadro do mês é quem mais precisa dele. */}
				<PeriodSelector />
			</View>

			<Row label={t('month.income')} value={formatCents(month.incomeCents)} emphasis="income" />

			<View style={styles.groupHeader}>
				<Text style={styles.groupLabel}>{t('month.spending')}</Text>
				<Text style={[styles.groupValue, styles.expense]}>{formatCents(month.totalSpendCents)}</Text>
			</View>
			{month.cards.map((card) => (
				<Row
					key={card.accountId}
					label={card.name}
					value={formatCents(card.spendCents)}
					sub={t('month.cardPurchased', { amount: formatCents(card.purchasesCents) })}
					indent
				/>
			))}
			<Row label={t('month.pixDebit')} value={formatCents(month.mainSpendCents)} indent />
			{month.envelopes.map((envelope) => {
				const target = envelope.monthlyCents ?? envelope.fundedCents;
				const percent = target > 0 ? Math.min(100, Math.round((envelope.spentCents / target) * 100)) : 0;
				return (
					<View key={envelope.accountId} style={[styles.row, styles.rowIndent, styles.envelopeRow]} accessible accessibilityLabel={`${envelope.name}, ${formatCents(envelope.fundedCents)}, ${t('month.envelopeUsed', { spent: formatCents(envelope.spentCents), funded: formatCents(target) })}`}>
						<View style={styles.rowText}>
							<Text style={[styles.rowLabel, styles.rowLabelIndent]}>{envelope.name}</Text>
							<Text style={styles.rowSub}>
								{t('month.envelopeUsed', { spent: formatCents(envelope.spentCents), funded: formatCents(target) })}
							</Text>
							<View style={styles.track} accessible={false}>
								<View style={[styles.fill, { width: `${percent}%` }, percent >= 100 && styles.fillFull]} />
							</View>
						</View>
						<Text style={styles.rowValue}>{formatCents(envelope.fundedCents)}</Text>
					</View>
				);
			})}

			<Row
				label={t('month.saved')}
				value={formatCents(month.savedCents)}
				sub={month.yieldCents > 0 ? t('month.yield', { amount: formatCents(month.yieldCents) }) : undefined}
				emphasis="income"
			/>

			<View style={styles.leftover} accessible accessibilityLabel={`${t('month.leftover')}, ${formatCents(month.leftoverCents)}. ${ratePercent === null ? t('month.noIncome') : t('month.savingsRate', { percent: ratePercent })}`}>
				<Text style={styles.leftoverLabel}>{t('month.leftover')}</Text>
				<Text style={[styles.leftoverValue, month.leftoverCents < 0 && styles.expense]}>{formatCents(month.leftoverCents)}</Text>
				<Text style={styles.leftoverSub}>
					{ratePercent === null ? t('month.noIncome') : t('month.savingsRate', { percent: ratePercent })}
				</Text>
			</View>

			{budgetSet ? (
				<View style={styles.budget} accessible accessibilityLabel={`${t('summary.budget')} ${formatCents(currentBudgetCents as number)}, ${t('summary.percentUsed', { percent: budgetPercent })}`}>
					<View style={styles.budgetHeader}>
						<Text style={styles.budgetLabel}>{t('summary.budget')}</Text>
						<Pressable onPress={() => setShowBudgetEditor(true)} accessibilityRole="button" accessibilityLabel={t('summary.edit')} hitSlop={12} style={styles.budgetEdit}>
							<Text style={styles.budgetEditText}>{t('summary.edit')}</Text>
						</Pressable>
					</View>
					<View style={styles.track} accessible={false}>
						<View style={[styles.fill, { width: `${Math.min(100, budgetPercent)}%` }, overBudget && styles.fillFull]} />
					</View>
					<Text style={[styles.budgetText, overBudget && styles.expense]}>
						{t('summary.percentUsed', { percent: budgetPercent })} · {formatCents(month.totalSpendCents)} / {formatCents(currentBudgetCents as number)}
					</Text>
				</View>
			) : (
				<View style={styles.budgetEmpty}>
					<Text style={styles.budgetEmptyText}>{t('summary.noBudget')}</Text>
					<Pressable
						onPress={() => setShowBudgetEditor(true)}
						accessibilityRole="button"
						accessibilityLabel={t('summary.setBudget')}
						style={({ pressed }) => [styles.budgetButton, pressed && styles.pressed]}
					>
						<Ionicons name="flag-outline" size={16} color={ACCENT} />
						<Text style={styles.budgetButtonText}>{t('summary.setBudget')}</Text>
					</Pressable>
				</View>
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
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		marginBottom: 8,
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		minHeight: 40,
		paddingVertical: 6,
	},
	rowIndent: {
		paddingLeft: 12,
	},
	envelopeRow: {
		alignItems: 'flex-start',
	},
	rowText: {
		flex: 1,
		paddingRight: 12,
	},
	rowLabel: {
		fontSize: 15,
		color: '#FFFFFF',
	},
	rowLabelIndent: {
		color: 'rgba(255,255,255,0.85)',
	},
	rowSub: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
		marginTop: 2,
	},
	rowValue: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	income: {
		color: '#4CAF50',
	},
	expense: {
		color: '#FF6B6B',
	},
	groupHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginTop: 8,
		paddingTop: 8,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.1)',
	},
	groupLabel: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	groupValue: {
		fontSize: 15,
		fontWeight: '700',
	},
	track: {
		height: 5,
		borderRadius: 3,
		backgroundColor: 'rgba(255,255,255,0.12)',
		marginTop: 6,
		overflow: 'hidden',
	},
	fill: {
		height: 5,
		borderRadius: 3,
		backgroundColor: ACCENT,
	},
	fillFull: {
		backgroundColor: '#FF6B6B',
	},
	leftover: {
		marginTop: 12,
		paddingTop: 12,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.1)',
	},
	leftoverLabel: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	leftoverValue: {
		fontSize: 30,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	leftoverSub: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	budget: {
		marginTop: 12,
		paddingTop: 12,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.1)',
	},
	budgetHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	budgetLabel: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.8)',
	},
	budgetEdit: {
		minHeight: 44,
		justifyContent: 'center',
	},
	budgetEditText: {
		fontSize: 14,
		color: ACCENT,
	},
	budgetText: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 6,
	},
	budgetEmpty: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		marginTop: 12,
		paddingTop: 12,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.1)',
	},
	budgetEmptyText: {
		flex: 1,
		fontSize: 13,
		fontStyle: 'italic',
		color: 'rgba(255,255,255,0.6)',
	},
	budgetButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 44,
		paddingHorizontal: 12,
		borderRadius: 8,
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	budgetButtonText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.7,
	},
});

export default MonthOverviewCard;
