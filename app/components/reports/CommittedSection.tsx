import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { monthKeyName } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import type { CommittedMonth } from '../../utils/reportSeries';
import { reportStyles } from './reportStyles';

/**
 * O que já está comprometido para os próximos meses: as faturas que vencem em cada um
 * (parcelas já compradas, menos o que já foi pago) e o custo fixo das recorrências. É
 * o que sobra da renda antes de qualquer escolha.
 */
const CommittedSection: React.FC<{ months: CommittedMonth[] }> = ({ months }) => {
	const { t } = useTranslation();
	const hasAnything = months.some((month) => month.totalCents > 0);

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.committed.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>{t('reports.committed.subtitle')}</Text>

			{!hasAnything ? (
				<Text style={reportStyles.empty}>{t('reports.committed.empty')}</Text>
			) : (
				months.map((month) => {
					const name = `${monthKeyName(month.month)} ${month.month.slice(0, 4)}`;
					return (
						<View key={month.month} style={styles.month} accessible accessibilityLabel={`${name}: ${t('reports.committed.total')} ${formatCents(month.totalCents)}. ${t('reports.committed.cards')} ${formatCents(month.cardCents)}, ${t('reports.committed.fixed')} ${formatCents(month.fixedCents)}.`}>
							<View style={styles.monthHeader}>
								<Text style={styles.monthName}>{name}</Text>
								<Text style={reportStyles.rowValue}>{formatCents(month.totalCents)}</Text>
							</View>
							{month.cards.map((card) => (
								<View key={card.accountId} style={styles.line}>
									<Text style={styles.lineLabel}>{card.name}</Text>
									<Text style={styles.lineValue}>{formatCents(card.cents)}</Text>
								</View>
							))}
							{month.fixedCents > 0 ? (
								<View style={styles.line}>
									<Text style={styles.lineLabel}>{t('reports.committed.fixed')}</Text>
									<Text style={styles.lineValue}>{formatCents(month.fixedCents)}</Text>
								</View>
							) : null}
						</View>
					);
				})
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	month: {
		paddingVertical: 8,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.06)',
	},
	monthHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 4,
	},
	monthName: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
		textTransform: 'capitalize',
	},
	line: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		paddingLeft: 12,
		paddingVertical: 2,
	},
	lineLabel: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.7)',
	},
	lineValue: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.85)',
	},
});

export default CommittedSection;
