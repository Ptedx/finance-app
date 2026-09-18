import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePeriod } from '../../contexts/PeriodContext';
import { monthKeyName } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import type { MonthPoint } from '../../utils/reportSeries';
import { ACCENT, EXPENSE_COLOR, INCOME_COLOR, reportStyles } from './reportStyles';

const BAR_MAX_HEIGHT = 110;

/**
 * Entrou, gastou e guardou, mês a mês, em barras de Views: cada coluna é um botão com o
 * rótulo inteiro (o leitor de tela lê os três números) e tocar nela seleciona o mês na
 * tela toda. "Gastou" no cartão é a fatura que fecha no mês — a regra da Home.
 */
const TrendBars: React.FC<{ series: MonthPoint[] }> = ({ series }) => {
	const { t } = useTranslation();
	const { setSelectedPeriod } = usePeriod();

	const max = Math.max(1, ...series.flatMap((point) => [point.overview.incomeCents, point.overview.totalSpendCents, Math.max(0, point.overview.savedCents)]));
	const heightOf = (cents: number) => Math.max(cents > 0 ? 2 : 0, Math.round((Math.max(0, cents) / max) * BAR_MAX_HEIGHT));
	const selected = series[series.length - 1];

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.trend.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>{t('reports.trend.subtitle')}</Text>

			{series.length === 0 ? (
				<Text style={reportStyles.empty}>{t('reports.trend.empty')}</Text>
			) : (
				<>
					<View style={styles.chart}>
						{series.map((point) => {
							const { overview } = point;
							const [year, month] = point.month.split('-').map(Number);
							const label = t('reports.trend.columnLabel', {
								month: `${monthKeyName(point.month)} ${year}`,
								income: formatCents(overview.incomeCents),
								spent: formatCents(overview.totalSpendCents),
								saved: formatCents(overview.savedCents),
							});
							return (
								<Pressable
									key={point.month}
									style={({ pressed }) => [styles.column, pressed && reportStyles.pressed]}
									onPress={() => setSelectedPeriod(month, year)}
									accessibilityRole="button"
									accessibilityLabel={label}
									accessibilityHint={t('reports.trend.hint')}
									accessibilityState={{ selected: point === selected }}
								>
									<View style={styles.bars} accessible={false}>
										<View style={[styles.bar, { height: heightOf(overview.incomeCents), backgroundColor: INCOME_COLOR }]} />
										<View style={[styles.bar, { height: heightOf(overview.totalSpendCents), backgroundColor: EXPENSE_COLOR }]} />
										<View style={[styles.bar, { height: heightOf(overview.savedCents), backgroundColor: ACCENT }]} />
									</View>
									<Text style={[styles.monthLabel, point === selected && styles.monthLabelSelected]} numberOfLines={1}>
										{monthKeyName(point.month).slice(0, 3)}
									</Text>
								</Pressable>
							);
						})}
					</View>

					<View style={styles.legend} accessible={false}>
						<Legend color={INCOME_COLOR} label={t('reports.trend.income')} />
						<Legend color={EXPENSE_COLOR} label={t('reports.trend.spent')} />
						<Legend color={ACCENT} label={t('reports.trend.saved')} />
					</View>

					{selected ? (
						<View style={styles.selectedRow} accessible accessibilityLabel={t('reports.trend.columnLabel', { month: `${monthKeyName(selected.month)} ${selected.month.slice(0, 4)}`, income: formatCents(selected.overview.incomeCents), spent: formatCents(selected.overview.totalSpendCents), saved: formatCents(selected.overview.savedCents) })}>
							<Text style={styles.selectedMonth}>{`${monthKeyName(selected.month)} ${selected.month.slice(0, 4)}`}</Text>
							<View style={styles.selectedValues}>
								<Text style={[styles.selectedValue, { color: INCOME_COLOR }]}>{formatCents(selected.overview.incomeCents)}</Text>
								<Text style={[styles.selectedValue, { color: EXPENSE_COLOR }]}>{formatCents(selected.overview.totalSpendCents)}</Text>
								<Text style={[styles.selectedValue, { color: ACCENT }]}>{formatCents(selected.overview.savedCents)}</Text>
							</View>
						</View>
					) : null}
				</>
			)}
		</View>
	);
};

const Legend: React.FC<{ color: string; label: string }> = ({ color, label }) => (
	<View style={styles.legendItem}>
		<View style={[styles.swatch, { backgroundColor: color }]} />
		<Text style={reportStyles.muted}>{label}</Text>
	</View>
);

const styles = StyleSheet.create({
	chart: {
		flexDirection: 'row',
		alignItems: 'flex-end',
		justifyContent: 'space-between',
		gap: 4,
		height: BAR_MAX_HEIGHT + 24,
	},
	column: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'flex-end',
		minHeight: 44,
	},
	bars: {
		flexDirection: 'row',
		alignItems: 'flex-end',
		gap: 2,
		height: BAR_MAX_HEIGHT,
	},
	bar: {
		width: 8,
		borderTopLeftRadius: 3,
		borderTopRightRadius: 3,
	},
	monthLabel: {
		fontSize: 11,
		color: 'rgba(255, 255, 255, 0.6)',
		marginTop: 6,
		textTransform: 'capitalize',
	},
	monthLabelSelected: {
		color: '#FFFFFF',
		fontWeight: '700',
	},
	legend: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 14,
		marginTop: 12,
	},
	legendItem: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
	},
	swatch: {
		width: 10,
		height: 10,
		borderRadius: 2,
	},
	selectedRow: {
		marginTop: 12,
		paddingTop: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255, 255, 255, 0.1)',
	},
	selectedMonth: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.7)',
		textTransform: 'capitalize',
		marginBottom: 4,
	},
	selectedValues: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		gap: 8,
	},
	selectedValue: {
		fontSize: 14,
		fontWeight: '600',
	},
});

export default TrendBars;
