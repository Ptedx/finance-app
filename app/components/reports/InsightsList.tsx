import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Insight, InsightSeverity } from '../../utils/insights';
import { EXPENSE_COLOR, INCOME_COLOR, MUTED_COLOR, reportStyles, WARN_COLOR } from './reportStyles';

const SEVERITY_COLOR: Record<InsightSeverity, string> = {
	critical: EXPENSE_COLOR,
	attention: WARN_COLOR,
	positive: INCOME_COLOR,
	neutral: MUTED_COLOR,
};

/**
 * As frases do mês, da mais urgente para a menos. A frase preferida é a tradução por
 * `id`; `title` (em inglês, montado pelo módulo) é o fallback. Um insight pode levar a
 * algum lugar — a receita repetida abre a lista de entradas.
 */
const InsightsList: React.FC<{ insights: Insight[]; onPress?: (insight: Insight) => void }> = ({ insights, onPress }) => {
	const { t } = useTranslation();

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.insights.title')}
			</Text>
			{insights.length === 0 ? (
				<Text style={reportStyles.empty}>{t('reports.insights.empty')}</Text>
			) : (
				insights.map((insight, index) => {
					const text = t(`wealth.insights.${insight.id}`, { ...insight.params, defaultValue: insight.title });
					const severity = t(`reports.insights.severity.${insight.severity}`);
					const pressable = onPress !== undefined && insight.id === 'income-possibly-duplicated';
					return (
						<Pressable
							key={`${insight.id}-${index}`}
							style={({ pressed }) => [styles.row, pressable && pressed && reportStyles.pressed]}
							onPress={pressable ? () => onPress(insight) : undefined}
							disabled={!pressable}
							accessibilityRole={pressable ? 'button' : 'text'}
							accessibilityLabel={`${severity}: ${text}`}
							accessibilityHint={pressable ? t('reports.insights.openHint') : undefined}
						>
							<View style={[styles.dot, { backgroundColor: SEVERITY_COLOR[insight.severity] }]} accessible={false} />
							<Text style={styles.text}>{text}</Text>
						</Pressable>
					);
				})
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 10,
		paddingVertical: 8,
		minHeight: 44,
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: 4,
		marginTop: 6,
	},
	text: {
		flex: 1,
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255, 255, 255, 0.9)',
	},
});

export default InsightsList;
