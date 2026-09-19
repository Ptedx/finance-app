import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import PeriodSelector from '../components/PeriodSelector';
import CategoryRanking from '../components/reports/CategoryRanking';
import CommittedSection from '../components/reports/CommittedSection';
import DebtsSection from '../components/reports/DebtsSection';
import FreedomHero from '../components/reports/FreedomHero';
import GoalSheet from '../components/reports/GoalSheet';
import HealthGrid from '../components/reports/HealthGrid';
import InsightsList from '../components/reports/InsightsList';
import ProjectionChart from '../components/reports/ProjectionChart';
import RangeChips from '../components/reports/RangeChips';
import { ACCENT, reportStyles } from '../components/reports/reportStyles';
import SourceRanking from '../components/reports/SourceRanking';
import TrendBars from '../components/reports/TrendBars';
import { usePeriod } from '../contexts/PeriodContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { type TrendRange, useReportsData } from '../hooks/useReportsData';
import { useRetirementGoal } from '../hooks/useRetirementGoal';
import { getMonthName } from '../utils/dateUtils';
import { exportFinancialReport } from '../utils/exportUtils';

/**
 * Relatórios: a tela de decisão.
 *
 * A Home diz o que aconteceu neste mês; aqui a pergunta é "estou no caminho?". De cima
 * para baixo: a meta de liberdade financeira (quão perto, quando chega, quanto guardar),
 * a saúde financeira em cinco indicadores, o histórico de meses, a projeção do capital,
 * onde o dinheiro foi (categorias e origens), o que já está comprometido para os
 * próximos meses e as frases que os números sustentam.
 *
 * Fina de propósito: cada seção é um componente e cada número vem de um módulo puro,
 * via `useReportsData`.
 */
const ReportsScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { selectedMonth, selectedYear } = usePeriod();
	const { currentPeriodTransactions, categories, monthlyData, categoryTotals } = useTransactions();
	const { goal, save: saveGoal, clear: clearGoal } = useRetirementGoal();
	const [range, setRange] = useState<TrendRange>(6);
	const [goalSheetOpen, setGoalSheetOpen] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const data = useReportsData(range, goal);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await data.refresh();
		} finally {
			setRefreshing(false);
		}
	}, [data.refresh]);

	const handleExport = useCallback(async () => {
		try {
			await exportFinancialReport(currentPeriodTransactions, categories, monthlyData, categoryTotals, getMonthName(selectedMonth), selectedYear);
		} catch (error) {
			console.error('Error exporting reports:', error);
		}
	}, [currentPeriodTransactions, categories, monthlyData, categoryTotals, selectedMonth, selectedYear]);

	const openIncomes = useCallback(() => {
		router.push({ pathname: '/(tabs)/transactions', params: { kind: 'income' } });
	}, [router]);

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: t('reports.screenTitle'),
					headerStyle: { backgroundColor: '#1A1A1A' },
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<View style={styles.header}>
				<View style={styles.headerText}>
					<Text style={styles.headerTitle} accessibilityRole="header">
						{t('reports.headerTitle')}
					</Text>
					<Text style={styles.headerSubtitle}>{t('reports.headerSubtitle')}</Text>
				</View>
				<PeriodSelector />
			</View>

			<ScrollView
				contentContainerStyle={styles.scrollContent}
				showsVerticalScrollIndicator={false}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
			>
				{data.isLoading ? (
					<Text style={styles.loadingText}>{t('reports.loading')}</Text>
				) : (
					<>
						<FreedomHero model={data.retirement} goal={goal} income={data.income} scenario={data.debtScenario} onEditGoal={() => setGoalSheetOpen(true)} />

						<HealthGrid indicators={data.health} />

						<DebtsSection summary={data.debts.summary} items={data.debts.items} />

						<View style={styles.rangeRow}>
							<RangeChips value={range} onChange={setRange} />
						</View>
						<TrendBars series={data.series} />

						{data.retirement && data.retirement.reach.kind !== 'reached' ? (
							<ProjectionChart points={data.retirement.projection} goalCents={data.retirement.requiredCapitalCents} scenario={data.debtScenario?.projection} />
						) : null}

						<CategoryRanking rows={data.categories} />
						<SourceRanking rows={data.sources} />
						<CommittedSection months={data.committed} />
						<InsightsList insights={data.insights} onPress={openIncomes} />

						<Pressable style={({ pressed }) => [styles.exportButton, pressed && reportStyles.pressed]} onPress={handleExport} accessibilityRole="button">
							<Ionicons name="download-outline" size={20} color="#FFFFFF" />
							<Text style={styles.exportText}>{t('reports.exportReports')}</Text>
						</Pressable>
					</>
				)}
			</ScrollView>

			<GoalSheet visible={goalSheetOpen} goal={goal} onSave={saveGoal} onClear={clearGoal} onClose={() => setGoalSheetOpen(false)} />
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
		paddingTop: 60,
		paddingBottom: 100,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	headerText: {
		flex: 1,
	},
	headerTitle: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	headerSubtitle: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.7)',
		marginTop: 2,
	},
	scrollContent: {
		padding: 16,
		paddingBottom: 40,
	},
	rangeRow: {
		marginBottom: 12,
	},
	loadingText: {
		fontSize: 16,
		color: 'rgba(255, 255, 255, 0.7)',
		textAlign: 'center',
		paddingVertical: 40,
	},
	exportButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.08)',
		marginTop: 4,
	},
	exportText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
});

export default ReportsScreen;
