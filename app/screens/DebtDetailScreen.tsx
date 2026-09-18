import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ACCENT, Button } from '../components/cards/formParts';
import AmortizeSheet from '../components/debts/AmortizeSheet';
import { useDebts } from '../contexts/DebtsContext';
import { useRetirementGoal } from '../hooks/useRetirementGoal';
import { formatDayMonth, formatMonthYear, formatShortDate, todayISO } from '../utils/dateUtils';
import { debtStateOn, termsOf, worthPayingOff } from '../utils/debt';
import { formatCents } from '../utils/money';
import { formatPercentBp } from '../utils/percent';
import { DEFAULT_EXPECTED_YIELD_BP } from '../utils/retirement';

const COLLAPSED_ROWS = 12;

const VERDICT_COLOR = { pay: '#4CAF50', invest: '#15E8FE', tie: '#FFCC5C' } as const;
const VERDICT_ICON = { pay: 'trending-down', invest: 'trending-up', tie: 'swap-horizontal' } as const;

/**
 * Uma dívida por inteiro: quanto se deve hoje, a próxima parcela, quando quita e quanto
 * ainda vai de juros; o veredito "amortizar ou investir" com os números por trás; e o
 * cronograma daqui até o fim. O rendimento comparado é o da meta de aposentadoria (ou 10%
 * ao ano sem meta), já descontado o IR.
 */
const DebtDetailScreen: React.FC<{ debtId: string }> = ({ debtId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { debts, recordExtraPayment } = useDebts();
	const { goal } = useRetirementGoal();
	const [sheetOpen, setSheetOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const debt = debts.find((item) => item.id === debtId);
	const today = todayISO();

	const state = useMemo(() => (debt ? debtStateOn(termsOf(debt), today) : null), [debt, today]);
	const investmentYieldBp = goal?.expectedYieldBp ?? DEFAULT_EXPECTED_YIELD_BP;

	if (!debt || !state) {
		return (
			<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
				<Stack.Screen options={{ headerShown: false }} />
				<Text style={styles.missing}>{t('debts.detail.missing')}</Text>
			</SafeAreaView>
		);
	}

	const isConsortium = debt.kind === 'consortium';
	const verdict = worthPayingOff({ debtRateBp: debt.rateBp, investmentYieldBp });
	const paid = Math.max(0, debt.installmentsTotal - state.remaining);
	const progress = debt.installmentsTotal > 0 ? Math.min(100, Math.round((paid / debt.installmentsTotal) * 100)) : 0;
	const rows = expanded ? state.upcoming : state.upcoming.slice(0, COLLAPSED_ROWS);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={styles.header}>
				<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('debts.back')} style={styles.iconButton}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
					{debt.name}
				</Text>
				<Pressable
					onPress={() => router.push({ pathname: '/debts/edit/[id]', params: { id: debt.id } })}
					accessibilityRole="button"
					accessibilityLabel={t('debts.detail.edit')}
					style={styles.iconButton}
				>
					<Ionicons name="create-outline" size={22} color="#FFFFFF" />
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				{debt.archived ? <Text style={styles.banner}>{t('debts.detail.paidOffBanner')}</Text> : null}

				<View
					style={styles.card}
					accessible
					accessibilityLabel={[
						`${t('debts.detail.balanceToday')} ${formatCents(state.balanceCents)}`,
						t('debts.row.progress', { paid, total: debt.installmentsTotal }),
						state.next ? t('debts.detail.next', { amount: formatCents(state.next.installmentCents), date: formatDayMonth(state.next.date) }) : '',
						state.payoffDate ? t('debts.detail.payoff', { date: formatMonthYear(state.payoffDate) }) : t('debts.row.neverPays'),
						t(isConsortium ? 'debts.detail.adjustmentAhead' : 'debts.detail.interestAhead', { amount: formatCents(state.interestAheadCents) }),
					].join('. ')}
				>
					<Text style={styles.label}>{t('debts.detail.balanceToday')}</Text>
					<Text style={styles.hero}>{formatCents(state.balanceCents)}</Text>
					<View style={styles.track} accessible={false}>
						<View style={[styles.fill, { width: `${Math.max(2, progress)}%` }]} />
					</View>
					<Text style={styles.muted}>{t('debts.row.progress', { paid, total: debt.installmentsTotal })}</Text>
					<View style={styles.hairline} />
					{state.next ? <Text style={styles.line}>{t('debts.detail.next', { amount: formatCents(state.next.installmentCents), date: formatDayMonth(state.next.date) })}</Text> : null}
					<Text style={styles.line}>{state.payoffDate ? t('debts.detail.payoff', { date: formatMonthYear(state.payoffDate) }) : t('debts.row.neverPays')}</Text>
					<Text style={styles.line}>{t(isConsortium ? 'debts.detail.adjustmentAhead' : 'debts.detail.interestAhead', { amount: formatCents(state.interestAheadCents) })}</Text>
					<Text style={styles.muted}>
						{isConsortium
							? t('debts.detail.adjustmentRate', { rate: formatPercentBp(debt.rateBp) })
							: t('debts.detail.rate', { rate: formatPercentBp(debt.rateBp), system: t(`debts.system.${debt.system}`) })}
					</Text>
				</View>

				{!debt.archived && state.amortizes ? (
					<View style={styles.card}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('debts.verdict.title')}
						</Text>
						<View style={styles.verdictRow} accessible accessibilityLabel={`${t(`debts.verdict.${verdict.verdict}`)}. ${t('debts.verdict.why', { debt: formatPercentBp(debt.rateBp), gross: formatPercentBp(investmentYieldBp), net: formatPercentBp(verdict.netYieldBp) })}`}>
							<Ionicons name={VERDICT_ICON[verdict.verdict]} size={22} color={VERDICT_COLOR[verdict.verdict]} />
							<Text style={[styles.verdict, { color: VERDICT_COLOR[verdict.verdict] }]}>{t(`debts.verdict.${verdict.verdict}`)}</Text>
						</View>
						<Text style={styles.body}>
							{t(isConsortium ? 'debts.verdict.whyConsortium' : 'debts.verdict.why', {
								debt: formatPercentBp(debt.rateBp),
								gross: formatPercentBp(investmentYieldBp),
								net: formatPercentBp(verdict.netYieldBp),
							})}
						</Text>
						{verdict.verdict !== 'tie' ? (
							<Text style={styles.body}>
								{t(verdict.verdict === 'pay' ? 'debts.verdict.perThousandPay' : 'debts.verdict.perThousandInvest', {
									amount: formatCents(Math.abs(verdict.perThousandCents)),
								})}
							</Text>
						) : null}
						<Text style={styles.muted}>{goal ? t('debts.verdict.yieldFromGoal') : t('debts.verdict.yieldDefault')}</Text>
						<Button label={t('debts.detail.simulate')} icon="calculator-outline" variant="secondary" onPress={() => setSheetOpen(true)} />
					</View>
				) : null}

				{!state.amortizes ? <Text style={styles.warning}>{t('debts.detail.neverPays')}</Text> : null}

				{state.upcoming.length > 0 ? (
					<View style={styles.card}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('debts.detail.schedule')}
						</Text>
						<View style={styles.scheduleHeader} accessible={false}>
							<Text style={[styles.cellDate, styles.headCell]}>{t('debts.detail.col.date')}</Text>
							<Text style={[styles.cell, styles.headCell]}>{t('debts.detail.col.installment')}</Text>
							<Text style={[styles.cell, styles.headCell]}>{isConsortium ? t('debts.detail.col.adjustment') : t('debts.detail.col.interest')}</Text>
							<Text style={[styles.cell, styles.headCell]}>{t('debts.detail.col.balance')}</Text>
						</View>
						{rows.map((entry) => (
							<View
								key={entry.index}
								style={styles.scheduleRow}
								accessible
								accessibilityLabel={t('debts.detail.rowLabel', {
									date: formatShortDate(entry.date),
									installment: formatCents(entry.installmentCents),
									interest: formatCents(entry.interestCents),
									balance: formatCents(entry.balanceCents),
								})}
							>
								<Text style={styles.cellDate}>{formatMonthYear(entry.date)}</Text>
								<Text style={styles.cell}>{formatCents(entry.installmentCents)}</Text>
								<Text style={[styles.cell, styles.cellMuted]}>{formatCents(entry.interestCents)}</Text>
								<Text style={styles.cell}>{formatCents(entry.balanceCents)}</Text>
							</View>
						))}
						{state.upcoming.length > COLLAPSED_ROWS ? (
							<Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button" style={({ pressed }) => [styles.more, pressed && styles.pressed]}>
								<Text style={styles.moreText}>{expanded ? t('debts.detail.showLess') : t('debts.detail.showAll', { count: state.upcoming.length })}</Text>
							</Pressable>
						) : null}
					</View>
				) : null}
			</ScrollView>

			<AmortizeSheet
				visible={sheetOpen}
				debt={debt}
				investmentYieldBp={investmentYieldBp}
				onClose={() => setSheetOpen(false)}
				onConfirm={(result) => recordExtraPayment(debt.id, result)}
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 8,
		paddingVertical: 4,
		gap: 4,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 60,
		gap: 16,
	},
	missing: {
		fontSize: 16,
		color: 'rgba(255,255,255,0.75)',
		textAlign: 'center',
		marginTop: 40,
	},
	banner: {
		fontSize: 15,
		fontWeight: '600',
		color: '#4CAF50',
		backgroundColor: 'rgba(76,175,80,0.12)',
		borderRadius: 12,
		padding: 12,
		textAlign: 'center',
	},
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		gap: 6,
	},
	label: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
	},
	hero: {
		fontSize: 32,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 6,
	},
	track: {
		height: 6,
		borderRadius: 3,
		backgroundColor: 'rgba(255,255,255,0.12)',
		overflow: 'hidden',
	},
	fill: {
		height: 6,
		borderRadius: 3,
		backgroundColor: ACCENT,
	},
	muted: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.6)',
	},
	hairline: {
		height: 1,
		backgroundColor: 'rgba(255,255,255,0.1)',
		marginVertical: 6,
	},
	line: {
		fontSize: 15,
		lineHeight: 21,
		color: '#FFFFFF',
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	verdictRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	verdict: {
		flex: 1,
		fontSize: 17,
		fontWeight: '700',
	},
	body: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.85)',
	},
	warning: {
		fontSize: 14,
		lineHeight: 20,
		color: '#FF8A80',
		backgroundColor: 'rgba(255,138,128,0.14)',
		borderRadius: 12,
		padding: 12,
	},
	scheduleHeader: {
		flexDirection: 'row',
		paddingBottom: 6,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.1)',
	},
	scheduleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		minHeight: 36,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.05)',
	},
	headCell: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.55)',
	},
	cellDate: {
		width: 72,
		fontSize: 13,
		color: 'rgba(255,255,255,0.85)',
	},
	cell: {
		flex: 1,
		fontSize: 13,
		color: '#FFFFFF',
		textAlign: 'right',
	},
	cellMuted: {
		color: 'rgba(255,255,255,0.6)',
	},
	more: {
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
	},
	moreText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.6,
	},
});

export default DebtDetailScreen;
