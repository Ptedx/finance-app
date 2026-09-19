import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatMonthYear, monthKeyOf, shiftMonthKey, todayISO } from '../../utils/dateUtils';
import type { ReserveReadModel } from '../../utils/emergencyReserve';
import { formatCents } from '../../utils/money';
import { ACCENT } from '../cards/formParts';

/**
 * A reserva de emergência no Patrimônio: quanto ela tem contra a meta de meses de custo
 * essencial, de onde veio esse custo, quanto falta e quando enche no ritmo de hoje. E a
 * cascata em uma linha — o que passa da reserva é o capital que a meta de aposentadoria vê.
 *
 * Sem custo conhecido, o cartão pede o dado em vez de inventar um número.
 */
const ReserveCard: React.FC<{ reserve: ReserveReadModel; onEdit: () => void }> = ({ reserve, onEdit }) => {
	const { t } = useTranslation();
	const { split } = reserve;
	const investmentOnlyCents = split.investmentCents - (split.poolCents - split.reserveCents);

	const header = (
		<View style={styles.headerRow}>
			<Text style={styles.title} accessibilityRole="header">
				{t('reserve.title')}
			</Text>
			<Pressable
				onPress={onEdit}
				accessibilityRole="button"
				accessibilityLabel={t('reserve.edit')}
				hitSlop={12}
				style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
			>
				<Ionicons name="options-outline" size={20} color={ACCENT} />
			</Pressable>
		</View>
	);

	if (reserve.status === 'unknown' || reserve.targetCents === null || reserve.monthlyCostCents === null) {
		return (
			<View style={styles.card}>
				{header}
				<Text style={styles.body}>{t('reserve.unknown')}</Text>
				<Pressable onPress={onEdit} accessibilityRole="button" style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
					<Text style={styles.ctaText}>{t('reserve.setCost')}</Text>
				</Pressable>
			</View>
		);
	}

	const fillLine = (() => {
		if (reserve.status === 'ready') return t('reserve.ready', { amount: formatCents(split.poolCents - split.reserveCents) });
		if (reserve.monthsToFill === null) return t('reserve.noPace', { gap: formatCents(reserve.gapCents) });
		const month = formatMonthYear(`${shiftMonthKey(monthKeyOf(todayISO()), reserve.monthsToFill)}-01`);
		return t('reserve.pace', { gap: formatCents(reserve.gapCents), count: reserve.monthsToFill, month });
	})();

	return (
		<View style={styles.card}>
			{header}
			<View
				accessible
				accessibilityLabel={t('reserve.a11ySummary', {
					reserve: formatCents(split.reserveCents),
					target: formatCents(reserve.targetCents),
					months: reserve.monthsCovered ?? 0,
					targetMonths: reserve.targetMonths,
				})}
			>
				<Text style={styles.hero}>
					{formatCents(split.reserveCents)} <Text style={styles.heroOf}>{t('reserve.of', { target: formatCents(reserve.targetCents) })}</Text>
				</Text>
				<View style={styles.track}>
					<View style={[styles.fill, { width: `${reserve.progressBp / 100}%` }, reserve.status === 'thin' && styles.fillThin]} />
				</View>
				<Text style={styles.body}>
					{t('reserve.covers', {
						months: (reserve.monthsCovered ?? 0).toFixed(1),
						targetMonths: reserve.targetMonths,
						cost: formatCents(reserve.monthlyCostCents),
					})}
				</Text>
			</View>
			<Text style={styles.muted}>{t(`reserve.source.${reserve.costSource ?? 'history'}`)}</Text>
			<Text style={styles.body} accessibilityLiveRegion="polite">
				{fillLine}
			</Text>
			{reserve.status !== 'ready' ? <Text style={styles.muted}>{t('reserve.cascade')}</Text> : null}
			{investmentOnlyCents > 0 ? <Text style={styles.muted}>{t('reserve.investmentOnly', { amount: formatCents(investmentOnlyCents) })}</Text> : null}
		</View>
	);
};

const styles = StyleSheet.create({
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 8,
	},
	headerRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	editButton: {
		minWidth: 44,
		minHeight: 44,
		alignItems: 'flex-end',
		justifyContent: 'center',
	},
	hero: {
		fontSize: 26,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 8,
	},
	heroOf: {
		fontSize: 14,
		fontWeight: '400',
		color: 'rgba(255,255,255,0.65)',
	},
	track: {
		height: 6,
		borderRadius: 3,
		backgroundColor: 'rgba(255, 255, 255, 0.12)',
		overflow: 'hidden',
		marginBottom: 8,
	},
	fill: {
		height: 6,
		borderRadius: 3,
		backgroundColor: ACCENT,
	},
	fillThin: {
		backgroundColor: '#FFB74D',
	},
	body: {
		fontSize: 14,
		lineHeight: 20,
		color: '#FFFFFF',
	},
	muted: {
		fontSize: 12,
		lineHeight: 17,
		color: 'rgba(255,255,255,0.6)',
	},
	cta: {
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		alignItems: 'center',
		justifyContent: 'center',
		marginTop: 4,
	},
	ctaText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
});

export default ReserveCard;
