import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { monthKeyName } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import type { IncomeComposition } from '../../utils/reportSeries';
import type { RetirementGoal, RetirementReadModel } from '../../utils/retirement';
import { Button } from '../cards/formParts';
import { ACCENT, INCOME_COLOR, reportStyles } from './reportStyles';

const percent = (bp: number): string => `${Math.round(bp / 100)}%`;

const yearsText = (years: number): string => (Number.isInteger(years) ? String(years) : years.toFixed(1));

/**
 * O objetivo em um cartão: quão perto o capital está do necessário, quanto ele já rende
 * por mês, quando chega nesse ritmo e quanto seria preciso guardar para chegar antes.
 *
 * Sem meta, o cartão é o convite para definir uma — a tela inteira gira em torno dela.
 */
const FreedomHero: React.FC<{
	model: RetirementReadModel | null;
	goal: RetirementGoal | null;
	income: IncomeComposition;
	onEditGoal: () => void;
}> = ({ model, goal, income, onEditGoal }) => {
	const { t } = useTranslation();

	if (!model || !goal) {
		return (
			<View style={reportStyles.card}>
				<Text style={reportStyles.sectionTitle} accessibilityRole="header">
					{t('reports.freedom.title')}
				</Text>
				<Text style={styles.unsetBody}>{t('reports.freedom.unsetBody')}</Text>
				<Button label={t('reports.freedom.setGoal')} icon="flag" onPress={onEditGoal} />
			</View>
		);
	}

	const progress = model.progressBp ?? 0;
	const reach = (() => {
		switch (model.reach.kind) {
			case 'reached':
				return t('reports.freedom.reached');
			case 'eta':
				return t('reports.freedom.reachEta', {
					month: `${monthKeyName(model.reach.month)} ${model.reach.month.slice(0, 4)}`,
					years: yearsText(model.reach.years),
				});
			default:
				return t(`reports.freedom.never.${model.reach.reason}`);
		}
	})();

	return (
		<View style={reportStyles.card}>
			<View style={reportStyles.sectionHeader}>
				<Text style={reportStyles.sectionTitle} accessibilityRole="header">
					{t('reports.freedom.title')}
				</Text>
				<Pressable
					onPress={onEditGoal}
					accessibilityRole="button"
					accessibilityLabel={t('reports.freedom.editGoal')}
					style={({ pressed }) => [reportStyles.iconButton, pressed && reportStyles.pressed]}
				>
					<Ionicons name="create-outline" size={22} color="#FFFFFF" />
				</Pressable>
			</View>

			<View
				accessible
				accessibilityLabel={`${t('reports.freedom.progress', { percent: percent(progress) })}. ${t('reports.freedom.capital')} ${formatCents(model.capitalCents)}. ${t('reports.freedom.requiredCapital')} ${model.requiredCapitalCents === null ? '—' : formatCents(model.requiredCapitalCents)}.`}
			>
				<Text style={styles.hero}>{percent(progress)}</Text>
				<Text style={styles.heroCaption}>{t('reports.freedom.progressCaption')}</Text>
				<View style={[reportStyles.track, styles.track]} accessible={false}>
					<View style={[reportStyles.fill, { width: `${Math.max(1, progress / 100)}%` }]} />
				</View>
				<View style={styles.capitalRow}>
					<View style={styles.capitalCell}>
						<Text style={reportStyles.muted}>{t('reports.freedom.capital')}</Text>
						<Text style={reportStyles.rowValue}>{formatCents(model.capitalCents)}</Text>
						{goal.outsideCapitalCents > 0 ? <Text style={reportStyles.rowSub}>{t('reports.freedom.capitalOutside', { amount: formatCents(goal.outsideCapitalCents) })}</Text> : null}
					</View>
					<View style={[styles.capitalCell, styles.capitalCellRight]}>
						<Text style={reportStyles.muted}>{t('reports.freedom.requiredCapital')}</Text>
						<Text style={reportStyles.rowValue}>{model.requiredCapitalCents === null ? '—' : formatCents(model.requiredCapitalCents)}</Text>
						<Text style={reportStyles.rowSub}>{t('reports.freedom.assumedYield', { percent: percent(model.expectedYieldBp) })}</Text>
					</View>
				</View>
			</View>

			<View style={reportStyles.hairline} accessible={false} />

			<View style={reportStyles.row} accessible>
				<View style={styles.flex}>
					<Text style={reportStyles.rowLabel}>{t('reports.freedom.passiveIncomeNow')}</Text>
					<Text style={reportStyles.rowSub}>
						{t('reports.freedom.requiredMonthly', {
							gross: formatCents(model.requiredMonthlyCents),
							net: formatCents(model.targetMonthlyCents),
							reinvest: percent(goal.reinvestBp),
						})}
					</Text>
				</View>
				<Text style={[reportStyles.rowValue, styles.income]}>{formatCents(model.passiveIncomeNowCents)}</Text>
			</View>
			{model.realizedYieldBp !== null ? (
				<Text style={styles.chip}>{t('reports.freedom.realizedYield', { percent: percent(model.realizedYieldBp) })}</Text>
			) : null}

			<View style={reportStyles.hairline} accessible={false} />

			<Text style={styles.reach} accessibilityLiveRegion="polite">
				{reach}
			</Text>
			<Text style={reportStyles.muted}>{t('reports.freedom.pace', { amount: formatCents(Math.max(0, model.monthlyContributionCents)) })}</Text>

			{model.reach.kind !== 'reached' && model.contributionByHorizon.some((h) => h.monthlyCents !== null) ? (
				<View style={styles.horizons} accessible accessibilityLabel={`${t('reports.freedom.horizonsTitle')} ${model.contributionByHorizon.map((h) => `${t('reports.freedom.horizon', { years: h.years })}: ${h.monthlyCents === null ? '—' : t('reports.freedom.perMonth', { amount: formatCents(h.monthlyCents) })}`).join('; ')}`}>
					<Text style={styles.horizonsTitle}>{t('reports.freedom.horizonsTitle')}</Text>
					<View style={styles.horizonRow}>
						{model.contributionByHorizon.map((horizon) => (
							<View key={horizon.years} style={styles.horizon}>
								<Text style={styles.horizonYears}>{t('reports.freedom.horizon', { years: horizon.years })}</Text>
								<Text style={styles.horizonValue}>{horizon.monthlyCents === null ? '—' : t('reports.freedom.perMonth', { amount: formatCents(horizon.monthlyCents) })}</Text>
							</View>
						))}
					</View>
				</View>
			) : null}

			<View style={reportStyles.hairline} accessible={false} />

			<View accessible>
				<Text style={reportStyles.muted}>{t('reports.freedom.considered', { amount: formatCents(income.netCents) })}</Text>
				<Text style={reportStyles.rowSub}>{t('reports.freedom.consideredDetail', { incomes: income.incomeCount, passthrough: income.passThroughCount, gross: formatCents(income.grossCents) })}</Text>
			</View>
		</View>
	);
};

const styles = StyleSheet.create({
	flex: { flex: 1 },
	unsetBody: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.75)',
		lineHeight: 20,
		marginTop: 6,
		marginBottom: 14,
	},
	hero: {
		fontSize: 36,
		fontWeight: '700',
		color: ACCENT,
		marginTop: 4,
	},
	heroCaption: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.6)',
		marginBottom: 10,
	},
	track: {
		marginBottom: 12,
	},
	capitalRow: {
		flexDirection: 'row',
		gap: 12,
	},
	capitalCell: {
		flex: 1,
	},
	capitalCellRight: {
		alignItems: 'flex-end',
	},
	income: {
		color: INCOME_COLOR,
	},
	chip: {
		alignSelf: 'flex-start',
		fontSize: 12,
		color: '#FFFFFF',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		paddingHorizontal: 10,
		paddingVertical: 4,
		borderRadius: 12,
		overflow: 'hidden',
		marginTop: 4,
	},
	reach: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
		lineHeight: 21,
		marginBottom: 4,
	},
	horizons: {
		marginTop: 12,
	},
	horizonsTitle: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.6)',
		marginBottom: 8,
	},
	horizonRow: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
	},
	horizon: {
		minWidth: 72,
		flexGrow: 1,
		backgroundColor: 'rgba(255, 255, 255, 0.06)',
		borderRadius: 10,
		paddingVertical: 8,
		paddingHorizontal: 10,
	},
	horizonYears: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	horizonValue: {
		fontSize: 14,
		fontWeight: '600',
		color: '#FFFFFF',
		marginTop: 2,
	},
});

export default FreedomHero;
