import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DebtsPanel from '../components/wealth/DebtsPanel';
import NetWorthCard from '../components/wealth/NetWorthCard';
import { useAccounts } from '../contexts/AccountsContext';
import { useDebts } from '../contexts/DebtsContext';
import type { Debt } from '../database/schema';
import { useRetirementGoal } from '../hooks/useRetirementGoal';
import { netWorth } from '../utils/accountMath';
import { worthPayingOff } from '../utils/debt';
import { DEFAULT_EXPECTED_YIELD_BP } from '../utils/retirement';

/**
 * Patrimônio: o que você tem e o que você deve.
 *
 * Cada aba responde uma pergunta — Início, "como está hoje?"; Lançamentos, "o que
 * aconteceu?"; Relatórios, "estou no caminho?". Esta responde "quanto eu valho, e o que me
 * prende?": o patrimônio líquido no topo e, embaixo, as dívidas com a resposta de "vale a
 * pena amortizar?". A reserva de emergência entra aqui quando existir.
 *
 * O que se deve nos cartões inclui as parcelas que ainda vão cair: a compra parcelada já
 * foi feita, e fingir que ela não é dívida deixaria o balanço mais bonito do que é.
 */
const WealthScreen = () => {
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();
	const { overview, cardSummaries, refresh: refreshAccounts } = useAccounts();
	const { debts, summary, refresh: refreshDebts } = useDebts();
	const { goal } = useRetirementGoal();
	const [refreshing, setRefreshing] = useState(false);

	const cardsCents = useMemo(() => {
		let total = 0;
		for (const card of cardSummaries.values()) total += card.owedCents + card.futureCommittedCents;
		return total;
	}, [cardSummaries]);

	const parts = {
		cashCents: overview.cashCents,
		savedCents: overview.savedCents,
		outsideCents: goal?.outsideCapitalCents ?? 0,
		cardsCents,
		debtsCents: summary.balanceCents,
	};
	const worth = netWorth(parts);

	// O rendimento contra o qual cada dívida é comparada: o da meta, ou 10% sem meta.
	const yieldBp = goal?.expectedYieldBp ?? DEFAULT_EXPECTED_YIELD_BP;
	const verdictOf = useCallback((debt: Debt) => worthPayingOff({ debtRateBp: debt.rateBp, investmentYieldBp: yieldBp }).verdict, [yieldBp]);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await Promise.all([refreshAccounts(), refreshDebts()]);
		} finally {
			setRefreshing(false);
		}
	}, [refreshAccounts, refreshDebts]);

	return (
		<View style={styles.container}>
			<StatusBar barStyle="light-content" />
			<View style={[styles.header, { paddingTop: Math.max(insets.top, 16) + 12 }]}>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('netWorth.screenTitle')}
				</Text>
				<Text style={styles.headerSubtitle}>{t('netWorth.screenSubtitle')}</Text>
			</View>

			<ScrollView
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#15E8FE" colors={['#15E8FE']} />}
			>
				<NetWorthCard worth={worth} parts={parts} />
				<DebtsPanel debts={debts} summary={summary} verdictOf={verdictOf} />
			</ScrollView>
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	header: {
		paddingHorizontal: 16,
		paddingBottom: 12,
	},
	headerTitle: {
		fontSize: 28,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	headerSubtitle: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
		marginTop: 2,
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
});

export default WealthScreen;
