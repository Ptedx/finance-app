import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { HealthIndicator, HealthStatus } from '../../utils/healthScore';
import { reportStyles, STATUS_COLOR } from './reportStyles';

const STATUS_ICON: Record<HealthStatus, React.ComponentProps<typeof Ionicons>['name']> = {
	good: 'checkmark-circle',
	warn: 'alert-circle',
	bad: 'close-circle',
	unknown: 'help-circle',
};

const valueText = (indicator: HealthIndicator): string => {
	if (indicator.value === null) return '—';
	if (indicator.unit === 'months') return indicator.value.toFixed(1);
	const percent = Math.round(indicator.value / 100);
	return indicator.id === 'spending-trend' && percent > 0 ? `+${percent}%` : `${percent}%`;
};

/**
 * Os cinco indicadores em duas colunas. Cada um diz o status com ícone e palavra, não
 * só com cor; o valor; o alvo; e uma linha de porquê traduzida por status.
 */
const HealthGrid: React.FC<{ indicators: HealthIndicator[] }> = ({ indicators }) => {
	const { t } = useTranslation();

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.health.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>{t('reports.health.subtitle')}</Text>
			<View style={styles.grid}>
				{indicators.map((indicator) => {
					const label = t(`reports.health.${indicator.id}.label`);
					const status = t(`reports.health.status.${indicator.status}`);
					const why = t(`reports.health.${indicator.id}.${indicator.variant ? `${indicator.variant}.` : ''}${indicator.status}`, indicator.params);
					const target = indicator.unit === 'months' ? t('reports.health.targetMonths', { target: indicator.target }) : t('reports.health.target', { target: `${indicator.direction === 'atMost' ? '≤' : '≥'} ${Math.round(indicator.target / 100)}%` });
					const needed = indicator.id === 'savings-rate' && indicator.neededBp !== null && indicator.neededBp !== undefined ? t('reports.health.savings-rate.needed', { needed: `${Math.round(indicator.neededBp / 100)}%` }) : null;
					return (
						<View key={indicator.id} style={styles.tile} accessible accessibilityLabel={`${label}: ${valueText(indicator)}, ${status}. ${target}. ${why}${needed ? ` ${needed}` : ''}`}>
							<View style={styles.tileHeader}>
								<Ionicons name={STATUS_ICON[indicator.status]} size={16} color={STATUS_COLOR[indicator.status]} />
								<Text style={[styles.status, { color: STATUS_COLOR[indicator.status] }]}>{status}</Text>
							</View>
							<Text style={styles.label}>{label}</Text>
							<Text style={styles.value}>{valueText(indicator)}</Text>
							<Text style={styles.target}>{target}</Text>
							<Text style={styles.why}>{why}</Text>
							{needed ? <Text style={styles.needed}>{needed}</Text> : null}
						</View>
					);
				})}
			</View>
		</View>
	);
};

const styles = StyleSheet.create({
	grid: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 10,
	},
	tile: {
		width: '48%',
		flexGrow: 1,
		backgroundColor: 'rgba(255, 255, 255, 0.05)',
		borderRadius: 10,
		padding: 12,
	},
	tileHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
		marginBottom: 4,
	},
	status: {
		fontSize: 12,
		fontWeight: '600',
	},
	label: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.75)',
	},
	value: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
		marginTop: 2,
	},
	target: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.5)',
	},
	why: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.75)',
		lineHeight: 17,
		marginTop: 6,
	},
	needed: {
		fontSize: 12,
		color: '#15E8FE',
		marginTop: 4,
	},
});

export default HealthGrid;
