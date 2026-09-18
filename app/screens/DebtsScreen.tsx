import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DebtRow from '../components/debts/DebtRow';
import { ACCENT } from '../components/cards/formParts';
import { useDebts } from '../contexts/DebtsContext';
import type { Debt } from '../database/schema';
import { formatMonthYear } from '../utils/dateUtils';
import { formatCents } from '../utils/money';
import { formatPercentBp } from '../utils/percent';

/**
 * As dívidas de longo prazo: quanto se deve no total, quanto sai por mês e quando a última
 * acaba, a lista das que estão sendo pagas e, embaixo, as quitadas. Tocar abre o detalhe,
 * onde ficam o cronograma e o "vale a pena amortizar?".
 */
const DebtsScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { debts, summary, isLoading } = useDebts();

	const active = debts.filter((debt) => !debt.archived);
	const paidOff = debts.filter((debt) => debt.archived);
	const openDebt = (debt: Debt) => router.push({ pathname: '/debts/[id]', params: { id: debt.id } });

	const totalsLabel = [
		`${t('debts.totals.balance')} ${formatCents(summary.balanceCents)}`,
		`${t('debts.totals.monthly')} ${formatCents(summary.monthlyCents)}`,
		summary.weightedRateBp !== null ? `${t('debts.totals.rate')} ${formatPercentBp(summary.weightedRateBp)}` : null,
		summary.lastPayoffDate ? `${t('debts.totals.lastPayoff')} ${formatMonthYear(summary.lastPayoffDate)}` : null,
	]
		.filter(Boolean)
		.join('. ');

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('debts.back')} hitSlop={12} style={styles.backButton}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('debts.screenTitle')}
				</Text>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				{active.length > 0 ? (
					<View style={styles.totals} accessible accessibilityLabel={totalsLabel}>
						<Text style={styles.totalsLabel}>{t('debts.totals.balance')}</Text>
						<Text style={styles.totalsValue}>{formatCents(summary.balanceCents)}</Text>
						<View style={styles.totalsRow}>
							<Text style={styles.totalsLine}>
								{t('debts.totals.monthly')}: {formatCents(summary.monthlyCents)}
							</Text>
							{summary.weightedRateBp !== null ? (
								<Text style={styles.totalsLine}>
									{t('debts.totals.rate')}: {formatPercentBp(summary.weightedRateBp)}
								</Text>
							) : null}
						</View>
						{summary.lastPayoffDate ? (
							<Text style={styles.totalsLine}>
								{t('debts.totals.lastPayoff')}: {formatMonthYear(summary.lastPayoffDate)}
							</Text>
						) : null}
					</View>
				) : null}

				<Pressable
					onPress={() => router.push('/debts/new')}
					accessibilityRole="button"
					accessibilityLabel={t('debts.add')}
					style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
				>
					<Ionicons name="add" size={20} color="#000000" />
					<Text style={styles.addButtonText}>{t('debts.add')}</Text>
				</Pressable>

				{!isLoading && active.length === 0 ? <Text style={styles.empty}>{t('debts.empty')}</Text> : null}

				{active.length > 0 ? (
					<View style={styles.list}>
						{active.map((debt) => (
							<DebtRow key={debt.id} debt={debt} onPress={openDebt} />
						))}
					</View>
				) : null}

				{paidOff.length > 0 ? (
					<View style={styles.list}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('debts.paidOff')}
						</Text>
						{paidOff.map((debt) => (
							<DebtRow key={debt.id} debt={debt} onPress={openDebt} />
						))}
					</View>
				) : null}
			</ScrollView>
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
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 24,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	totals: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 12,
		gap: 4,
	},
	totalsLabel: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
	},
	totalsValue: {
		fontSize: 30,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	totalsRow: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		columnGap: 16,
	},
	totalsLine: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	addButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		marginBottom: 12,
	},
	addButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
	empty: {
		fontSize: 15,
		lineHeight: 21,
		color: 'rgba(255,255,255,0.75)',
		marginVertical: 12,
	},
	list: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: 4,
		marginBottom: 12,
	},
	sectionTitle: {
		fontSize: 14,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.7)',
		paddingTop: 10,
	},
});

export default DebtsScreen;
