import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatCents } from '../../utils/money';
import type { CategoryRankRow } from '../../utils/reportSeries';
import { EXPENSE_COLOR, INCOME_COLOR, MUTED_COLOR, reportStyles } from './reportStyles';

const COLLAPSED_ROWS = 6;

const deltaText = (row: CategoryRankRow, t: (key: string, options?: Record<string, unknown>) => string): string => {
	if (row.pct === null) return t('reports.categories.new');
	const percent = Math.round(row.pct * 100);
	return `${percent > 0 ? '▲' : percent < 0 ? '▼' : '='} ${Math.abs(percent)}% · ${percent >= 0 ? '+' : '−'}${formatCents(Math.abs(row.deltaCents))}`;
};

/**
 * As categorias do mês, da maior para a menor, com barra proporcional, fatia e a
 * variação contra o mês anterior. Barras em vez de pizza: dá para comparar e o leitor de
 * tela lê cada linha inteira.
 */
const CategoryRanking: React.FC<{ rows: CategoryRankRow[] }> = ({ rows }) => {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
	const hidden = rows.length - visible.length;

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.categories.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>{t('reports.categories.subtitle')}</Text>

			{rows.length === 0 ? (
				<Text style={reportStyles.empty}>{t('reports.categories.empty')}</Text>
			) : (
				visible.map((row) => {
					const name = row.name ?? t('transactionsList.uncategorized');
					const share = `${Math.round(row.shareBp / 100)}%`;
					const delta = deltaText(row, t);
					return (
						<View key={row.categoryId} style={styles.row} accessible accessibilityLabel={`${name}: ${formatCents(row.currentCents)}, ${share}. ${delta}`}>
							<View style={styles.rowHeader}>
								<View style={[styles.dot, { backgroundColor: row.color ?? MUTED_COLOR }]} accessible={false} />
								<Text style={styles.name} numberOfLines={1}>
									{name}
								</Text>
								<Text style={reportStyles.rowValue}>{formatCents(row.currentCents)}</Text>
							</View>
							<View style={reportStyles.track} accessible={false}>
								<View style={[reportStyles.fill, { width: `${Math.max(1, row.shareBp / 100)}%`, backgroundColor: row.color ?? MUTED_COLOR }]} />
							</View>
							<View style={styles.rowFooter}>
								<Text style={reportStyles.rowSub}>{share}</Text>
								<Text style={[reportStyles.rowSub, row.pct !== null && row.deltaCents > 0 && styles.up, row.pct !== null && row.deltaCents < 0 && styles.down]}>{delta}</Text>
							</View>
						</View>
					);
				})
			)}

			{hidden > 0 || expanded ? (
				<Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button" style={({ pressed }) => [styles.more, pressed && reportStyles.pressed]}>
					<Text style={styles.moreText}>{expanded ? t('reports.categories.less') : t('reports.categories.more', { count: hidden })}</Text>
				</Pressable>
			) : null}
		</View>
	);
};

const styles = StyleSheet.create({
	row: {
		paddingVertical: 8,
	},
	rowHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginBottom: 6,
	},
	dot: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	name: {
		flex: 1,
		fontSize: 15,
		color: '#FFFFFF',
	},
	rowFooter: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: 4,
	},
	up: {
		color: EXPENSE_COLOR,
	},
	down: {
		color: INCOME_COLOR,
	},
	more: {
		minHeight: 44,
		justifyContent: 'center',
		alignItems: 'center',
	},
	moreText: {
		fontSize: 14,
		fontWeight: '600',
		color: '#15E8FE',
	},
});

export default CategoryRanking;
