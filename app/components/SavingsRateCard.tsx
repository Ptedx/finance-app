import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useWealthMetrics } from '../hooks/useWealthMetrics';
import {
	HEALTHY_SAVINGS_RATE_BASIS_POINTS,
	SOLID_RUNWAY_MONTHS,
	THIN_RUNWAY_MONTHS,
} from '../utils/insights';
import { formatCents } from '../utils/money';

/**
 * O KPI-herói da Home: que fração da renda virou patrimônio neste mês.
 *
 * Fica acima do resumo de propósito. "Sobrou R$ 800" é uma informação sobre o mês;
 * "converti 20% do que ganhei" é uma informação sobre a trajetória — é a segunda que
 * decide se o patrimônio cresce, e é ela que merece o topo da tela.
 *
 * O runway vem logo abaixo porque as duas respondem à mesma pergunta em escalas
 * diferentes: uma olha o fluxo do mês, a outra o estoque que ele acumulou.
 */
const SavingsRateCard: React.FC = () => {
	const { t } = useTranslation();
	const { metrics, isComparisonLoading } = useWealthMetrics();

	const { savingsRate: rate, savingsRateDeltaBasisPoints: delta, runwayMonths } = metrics;

	const rateTone =
		rate.basisPoints === null
			? styles.neutralValue
			: rate.netCents < 0
				? styles.negativeValue
				: rate.basisPoints >= HEALTHY_SAVINGS_RATE_BASIS_POINTS
					? styles.positiveValue
					: styles.warningValue;

	const runwayTone =
		runwayMonths === null
			? styles.neutralValue
			: runwayMonths < THIN_RUNWAY_MONTHS
				? styles.negativeValue
				: runwayMonths >= SOLID_RUNWAY_MONTHS
					? styles.positiveValue
					: styles.warningValue;

	/**
	 * A variação é mostrada em **pontos percentuais**, não em porcentagem da porcentagem:
	 * de 10% para 15% são 5 p.p., e chamar isso de "+50%" seria tecnicamente defensável e
	 * praticamente ilegível.
	 */
	const deltaPoints = delta === null ? null : delta / 100;

	const explainRunway = () => {
		Alert.alert(
			t('wealth.runway'),
			t('wealth.runwayExplanation', { amount: formatCents(metrics.monthlyFixedCents) })
		);
	};

	return (
		<View style={styles.container}>
			<View style={styles.headerRow}>
				<Text style={styles.title}>{t('wealth.savingsRate')}</Text>
				{rate.incomeCents > 0 && (
					<Text style={styles.subtitle}>
						{t('wealth.ofIncome', { amount: formatCents(rate.incomeCents) })}
					</Text>
				)}
			</View>

			<View style={styles.rateRow}>
				<Text style={[styles.rateValue, rateTone]}>
					{rate.basisPoints === null ? '—' : `${Math.round(rate.basisPoints / 100)}%`}
				</Text>

				{rate.basisPoints === null ? (
					<Text style={styles.hint}>{t('wealth.noIncome')}</Text>
				) : deltaPoints !== null && !isComparisonLoading ? (
					<View style={styles.deltaContainer}>
						<Ionicons
							name={deltaPoints >= 0 ? 'arrow-up' : 'arrow-down'}
							size={14}
							color={deltaPoints >= 0 ? '#4CAF50' : '#FF6B6B'}
						/>
						<Text
							style={[
								styles.deltaText,
								deltaPoints >= 0 ? styles.positiveValue : styles.negativeValue,
							]}
						>
							{t('wealth.deltaPoints', { points: Math.abs(deltaPoints).toFixed(1) })}
						</Text>
					</View>
				) : null}
			</View>

			{rate.basisPoints !== null && (
				<Text style={styles.hint}>
					{t('wealth.savingsRateHint', { amount: formatCents(rate.netCents) })}
				</Text>
			)}

			<View style={styles.divider} />

			<TouchableOpacity style={styles.runwayRow} onPress={explainRunway} activeOpacity={0.7}>
				<View style={styles.runwayLabelContainer}>
					<Text style={styles.runwayLabel}>{t('wealth.runway')}</Text>
					<Ionicons name="information-circle-outline" size={14} color="#888888" />
				</View>
				<Text style={[styles.runwayValue, runwayTone]}>
					{runwayMonths === null
						? t('wealth.runwayUnknown')
						: t('wealth.runwayMonths', { months: runwayMonths.toFixed(1) })}
				</Text>
			</TouchableOpacity>
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
	},
	title: {
		fontSize: 16,
		color: '#ffffff',
		fontWeight: '500',
	},
	subtitle: {
		fontSize: 12,
		color: '#888888',
	},
	rateRow: {
		flexDirection: 'row',
		alignItems: 'flex-end',
		gap: 12,
		marginTop: 8,
	},
	rateValue: {
		fontSize: 36,
		fontWeight: '700',
	},
	deltaContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 2,
		paddingBottom: 8,
	},
	deltaText: {
		fontSize: 13,
		fontWeight: '600',
	},
	hint: {
		fontSize: 12,
		color: '#888888',
		marginTop: 4,
	},
	divider: {
		height: 1,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginVertical: 12,
	},
	runwayRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	runwayLabelContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
	},
	runwayLabel: {
		fontSize: 14,
		color: '#888888',
	},
	runwayValue: {
		fontSize: 16,
		fontWeight: '700',
	},
	neutralValue: {
		color: '#ffffff',
	},
	positiveValue: {
		color: '#4CAF50',
	},
	warningValue: {
		color: '#FFCC5C',
	},
	negativeValue: {
		color: '#FF6B6B',
	},
});

export default SavingsRateCard;
