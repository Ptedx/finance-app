import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DebtReportItem } from '../../hooks/useReportsData';
import { formatMonthYear } from '../../utils/dateUtils';
import type { DebtsSummary, DebtVerdict } from '../../utils/debt';
import { formatCents } from '../../utils/money';
import { formatPercentBp } from '../../utils/percent';
import { ACCENT, INCOME_COLOR, reportStyles, WARN_COLOR } from './reportStyles';

const VERDICT_COLOR: Record<DebtVerdict, string> = { pay: INCOME_COLOR, invest: ACCENT, tie: WARN_COLOR };
const VERDICT_ICON: Record<DebtVerdict, React.ComponentProps<typeof Ionicons>['name']> = {
	pay: 'trending-down',
	invest: 'trending-up',
	tie: 'swap-horizontal',
};

/**
 * As dívidas vistas dos Relatórios: quanto se deve, quanto sai por mês, e para cada uma a
 * resposta de "vale a pena amortizar?". Embaixo, o próximo alívio no mês: quando a primeira
 * parcela deixa de sair. Tocar numa dívida abre o detalhe, com o simulador.
 */
const DebtsSection: React.FC<{ summary: DebtsSummary; items: DebtReportItem[] }> = ({ summary, items }) => {
	const { t } = useTranslation();
	const router = useRouter();
	if (items.length === 0) return null;
	const nextRelease = summary.releases[0];

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.debts.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>
				{t('reports.debts.subtitle', { balance: formatCents(summary.balanceCents), monthly: formatCents(summary.monthlyCents) })}
			</Text>

			{items.map((item) => {
				const verdict = t(`reports.debts.verdict.${item.verdict}`);
				const payoff = item.payoffDate ? t('reports.debts.payoff', { date: formatMonthYear(item.payoffDate) }) : t('debts.row.neverPays');
				return (
					<Pressable
						key={item.id}
						onPress={() => router.push({ pathname: '/debts/[id]', params: { id: item.id } })}
						accessibilityRole="button"
						accessibilityLabel={`${item.name}: ${formatCents(item.balanceCents)}. ${payoff}. ${formatPercentBp(item.rateBp)} ${t('reports.debts.perYear')}. ${verdict}`}
						style={({ pressed }) => [styles.row, pressed && reportStyles.pressed]}
					>
						<View style={styles.rowTop}>
							<Text style={styles.name} numberOfLines={1}>
								{item.name}
							</Text>
							<Text style={reportStyles.rowValue}>{formatCents(item.balanceCents)}</Text>
						</View>
						<View style={styles.rowBottom}>
							<Text style={reportStyles.rowSub}>
								{payoff} · {formatPercentBp(item.rateBp)} {t('reports.debts.perYear')}
							</Text>
							<View style={styles.verdict}>
								<Ionicons name={VERDICT_ICON[item.verdict]} size={14} color={VERDICT_COLOR[item.verdict]} />
								<Text style={[styles.verdictText, { color: VERDICT_COLOR[item.verdict] }]}>{verdict}</Text>
							</View>
						</View>
					</Pressable>
				);
			})}

			{nextRelease ? (
				<Text style={styles.release}>
					{t('reports.debts.release', {
						date: formatMonthYear(`${nextRelease.fromMonth}-01`),
						amount: formatCents(nextRelease.cents),
						name: nextRelease.name,
					})}
				</Text>
			) : null}
		</View>
	);
};

const styles = StyleSheet.create({
	row: {
		paddingVertical: 10,
		minHeight: 48,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.06)',
		gap: 4,
	},
	rowTop: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: 8,
	},
	name: {
		flex: 1,
		fontSize: 15,
		color: '#FFFFFF',
	},
	rowBottom: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: 8,
	},
	verdict: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
	},
	verdictText: {
		fontSize: 12,
		fontWeight: '700',
	},
	release: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.8)',
		marginTop: 10,
	},
});

export default DebtsSection;
