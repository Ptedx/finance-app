import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTransactions } from '../../contexts/TransactionsContext';
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
 *
 * A cobrança dupla (um `[Auto]` de recorrência antiga e a cobrança de verdade) tem um
 * botão "Apagar o [Auto]" (SPD-113): com confirmação, apaga pela exclusão de sempre
 * (`removeTransaction`, lógica e com sync) só o `[Auto]` do par. O insight some na hora;
 * a lista recalculada depois da exclusão já não tem o par.
 */
const InsightsList: React.FC<{ insights: Insight[]; onPress?: (insight: Insight) => void }> = ({ insights, onPress }) => {
	const { t } = useTranslation();
	const { removeTransaction } = useTransactions();
	// Os `[Auto]` já apagados aqui: o insight sai antes de a lista recalculada chegar.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

	const confirmDeleteAuto = (insight: Insight, transactionId: string) => {
		Alert.alert(
			t('reports.insights.doubleCharge.confirmTitle'),
			t('reports.insights.doubleCharge.confirmMessage', { note: insight.params.note, amount: insight.params.amount }),
			[
				{ text: t('reports.insights.doubleCharge.cancel'), style: 'cancel' },
				{
					text: t('reports.insights.doubleCharge.confirm'),
					style: 'destructive',
					onPress: async () => {
						setRemoved((current) => new Set(current).add(transactionId));
						try {
							await removeTransaction(transactionId);
						} catch {
							// `removeTransaction` já avisou o erro; o insight volta, porque o `[Auto]` ficou.
							setRemoved((current) => {
								const next = new Set(current);
								next.delete(transactionId);
								return next;
							});
						}
					},
				},
			]
		);
	};

	const visible = insights.filter((insight) => insight.transactionId === undefined || !removed.has(insight.transactionId));

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.insights.title')}
			</Text>
			{visible.length === 0 ? (
				<Text style={reportStyles.empty}>{t('reports.insights.empty')}</Text>
			) : (
				visible.map((insight, index) => {
					const text = t(`wealth.insights.${insight.id}`, { ...insight.params, defaultValue: insight.title });
					const severity = t(`reports.insights.severity.${insight.severity}`);
					const pressable = onPress !== undefined && insight.id === 'income-possibly-duplicated';
					const autoId = insight.id === 'expense-possibly-duplicated' ? insight.transactionId : undefined;
					return (
						<View key={`${insight.id}-${index}`}>
							<Pressable
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
							{autoId !== undefined ? (
								<Pressable
									style={({ pressed }) => [styles.action, pressed && reportStyles.pressed]}
									onPress={() => confirmDeleteAuto(insight, autoId)}
									accessibilityRole="button"
									accessibilityLabel={t('reports.insights.doubleCharge.deleteAuto')}
									accessibilityHint={t('reports.insights.doubleCharge.deleteAutoHint')}
								>
									<Text style={styles.actionText}>{t('reports.insights.doubleCharge.deleteAuto')}</Text>
								</Pressable>
							) : null}
						</View>
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
	// Alinhado ao texto (ponto de 8 + espaço de 10) e com 44 pontos de altura para o toque.
	action: {
		alignSelf: 'flex-start',
		justifyContent: 'center',
		minHeight: 44,
		marginLeft: 18,
		paddingHorizontal: 12,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: EXPENSE_COLOR,
	},
	actionText: {
		fontSize: 14,
		fontWeight: '600',
		color: EXPENSE_COLOR,
	},
});

export default InsightsList;
