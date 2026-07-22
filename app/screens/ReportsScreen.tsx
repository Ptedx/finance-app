import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Dimensions,
	RefreshControl,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import { LineChart, PieChart } from 'react-native-chart-kit';
import { usePeriod } from '../contexts/PeriodContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { getMonthName } from '../utils/dateUtils';
import { exportFinancialReport } from '../utils/exportUtils';
import { formatCents } from '../utils/money';

const { width } = Dimensions.get('window');

/** Fallback for a total whose category has since been deleted. */
const UNKNOWN_CATEGORY = { name: 'Uncategorized' };

/**
 * Slice palettes for the category pies.
 *
 * Each side of the ledger gets its own hue family so the two charts read at a glance —
 * red for money going out, green for money coming in. A category's own colour is not
 * used here: those are chosen for identity in the pickers and say nothing about which
 * side of the ledger a slice belongs to, so an expense pie could come out mostly green.
 *
 * Both ramps are single-hue with monotone lightness and validated against the #1E1E1E
 * chart surface for step separation and contrast (dataviz ordinal checks).
 */
const EXPENSE_SLICE_COLORS = ['#FFC9C7', '#FF9C99', '#F8756F', '#E5484D', '#BC383D'];
const INCOME_SLICE_COLORS = ['#C6F6D5', '#92E6B4', '#5FD394', '#30A46C', '#1D7A4E'];

/** Aggregated tail, kept visually recessive so it never competes with a real category. */
const OTHER_SLICE_COLOR = '#8A8A8A';

/**
 * A pie stops being readable past about six wedges, and neither ramp carries more than
 * five distinguishable steps. Anything beyond that is summed into "Other" rather than
 * cycling the palette, which would paint two categories the same shade.
 */
const MAX_SLICES = EXPENSE_SLICE_COLORS.length;

const ReportsScreen = () => {
	const {
		categoryTotals,
		monthlyData,
		categories,
		periodTotals,
		isLoading,
		refreshData,
		currentPeriodTransactions,
	} = useTransactions();
	const { selectedMonthName, selectedYear } = usePeriod();
	const { t } = useTranslation();

	const [refreshing, setRefreshing] = useState(false);
	const [showExpenses, setShowExpenses] = useState(true);
	const [showIncomes, setShowIncomes] = useState(true);
	const [expenseChartError, setExpenseChartError] = useState(false);
	const [incomeChartError, setIncomeChartError] = useState(false);
	const [trendChartError, setTrendChartError] = useState(false);

	/**
	 * Turns category totals into the two views of the same data.
	 *
	 * `slices` is capped and folded for the pie, which stops being readable past about
	 * six wedges. `breakdown` keeps every category, because it is a labelled list with
	 * no colour budget — folding it would hide detail for no benefit. Rows past the cap
	 * carry the same neutral grey as the "Other" wedge they were folded into.
	 */
	const buildCategoryViews = useCallback(
		(totals: typeof categoryTotals.expenses, palette: string[]) => {
			const named = totals
				.filter((item) => item && Number.isFinite(item.totalCents) && item.totalCents > 0)
				.map((item) => ({
					categoryId: item.categoryId,
					name: (categories.find((c) => c.id === item.categoryId) ?? UNKNOWN_CATEGORY).name,
					amountCents: item.totalCents,
				}))
				.sort((a, b) => b.amountCents - a.amountCents);

			const shown = named.slice(0, MAX_SLICES);
			const tail = named.slice(MAX_SLICES);

			// Palette steps are handed out in a stable order — by category id, not by this
			// period's ranking — so a category keeps the same shade from month to month.
			// Colouring by rank would repaint every slice whenever the amounts shuffled.
			const colourOrder = [...shown]
				.sort((a, b) => a.categoryId.localeCompare(b.categoryId))
				.map((item) => item.categoryId);

			const colourOf = (categoryId: string) => {
				const slot = colourOrder.indexOf(categoryId);
				return slot === -1 ? OTHER_SLICE_COLOR : palette[slot % palette.length];
			};

			const breakdown = named.map((item) => ({
				key: item.categoryId,
				name: item.name,
				amountCents: item.amountCents,
				color: colourOf(item.categoryId),
			}));

			const slices = shown.map((item) => ({
				name: item.name,
				amountCents: item.amountCents,
				// react-native-chart-kit sizes slices from this field; it only needs to be
				// proportional, so major units keep the numbers readable.
				amount: item.amountCents / 100,
				color: colourOf(item.categoryId),
				legendFontColor: '#FFFFFF',
				legendFontSize: 12,
			}));

			if (tail.length > 0) {
				const tailCents = tail.reduce((sum, item) => sum + item.amountCents, 0);
				slices.push({
					name: t('reports.otherCategories', { count: tail.length }),
					amountCents: tailCents,
					amount: tailCents / 100,
					color: OTHER_SLICE_COLOR,
					legendFontColor: '#FFFFFF',
					legendFontSize: 12,
				});
			}

			return { slices, breakdown };
		},
		[categories, t]
	);

	const expenseViews = useMemo(
		() => buildCategoryViews(categoryTotals.expenses, EXPENSE_SLICE_COLORS),
		[categoryTotals.expenses, buildCategoryViews]
	);

	const incomeViews = useMemo(
		() => buildCategoryViews(categoryTotals.incomes, INCOME_SLICE_COLORS),
		[categoryTotals.incomes, buildCategoryViews]
	);

	const expensesPieChartData = expenseViews.slices;
	const incomesPieChartData = incomeViews.slices;

	/**
	 * Both series now always carry twelve months, so point N of the income line and
	 * point N of the expense line refer to the same month. Previously the database
	 * returned only months that had rows, and the two lines were plotted against each
	 * other's months whenever their activity differed.
	 */
	const lineChartData = useMemo(() => {
		const byMonth = (data: typeof monthlyData.expenses) =>
			[...data].sort((a, b) => a.month - b.month).map((entry) => entry.totalCents / 100);

		return {
			labels: Array.from({ length: 12 }, (_, i) => getMonthName(i + 1).substring(0, 3)),
			datasets: [
				{
					data: byMonth(monthlyData.expenses),
					// Mid step of the expense ramp, so the trend lines and the pies agree.
					color: () => EXPENSE_SLICE_COLORS[3],
					strokeWidth: 2,
				},
				{
					data: byMonth(monthlyData.incomes),
					color: () => INCOME_SLICE_COLORS[3],
					strokeWidth: 2,
				},
			],
			legend: [t('reports.expenses'), t('reports.incomes')],
		};
	}, [monthlyData.expenses, monthlyData.incomes, t]);

	const chartConfig = useMemo(
		() => ({
			backgroundGradientFrom: '#1E1E1E',
			backgroundGradientTo: '#1E1E1E',
			decimalPlaces: 0,
			color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
			labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
			style: { borderRadius: 16 },
			propsForDots: { r: '6', strokeWidth: '2', stroke: '#5E5CE6' },
		}),
		[]
	);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refreshData();
			setExpenseChartError(false);
			setIncomeChartError(false);
			setTrendChartError(false);
		} catch (error) {
			console.error('Refresh error:', error);
		} finally {
			setRefreshing(false);
		}
	}, [refreshData]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	const renderExpensePieChart = useCallback(() => {
		if (expenseChartError) {
			return <Text style={styles.errorText}>{t('reports.errorExpenseChart')}</Text>;
		}
		if (expensesPieChartData.length === 0) {
			return <Text style={styles.emptyText}>{t('reports.noExpenseData')}</Text>;
		}
		try {
			return (
				<View style={styles.chartContainer}>
					<PieChart
						data={expensesPieChartData}
						width={width - 32}
						height={200}
						chartConfig={chartConfig}
						accessor="amount"
						backgroundColor="transparent"
						paddingLeft="15"
						absolute
					/>
				</View>
			);
		} catch (error) {
			console.error('Error rendering expense chart:', error);
			setExpenseChartError(true);
			return <Text style={styles.errorText}>{t('reports.renderErrorExpense')}</Text>;
		}
	}, [expensesPieChartData, chartConfig, expenseChartError, width, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	const renderIncomePieChart = useCallback(() => {
		if (incomeChartError) {
			return <Text style={styles.errorText}>{t('reports.errorIncomeChart')}</Text>;
		}
		if (incomesPieChartData.length === 0) {
			return <Text style={styles.emptyText}>{t('reports.noIncomeData')}</Text>;
		}
		try {
			return (
				<View style={styles.chartContainer}>
					<PieChart
						data={incomesPieChartData}
						width={width - 32}
						height={200}
						chartConfig={chartConfig}
						accessor="amount"
						backgroundColor="transparent"
						paddingLeft="15"
						absolute
					/>
				</View>
			);
		} catch (error) {
			console.error('Error rendering income chart:', error);
			setIncomeChartError(true);
			return <Text style={styles.errorText}>{t('reports.renderErrorIncome')}</Text>;
		}
	}, [incomesPieChartData, chartConfig, incomeChartError, width, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	const renderTrendChart = useCallback(() => {
		if (trendChartError) {
			return <Text style={styles.errorText}>{t('reports.errorTrendChart')}</Text>;
		}
		const hasExpenses = monthlyData.expenses.some((item) => item && item.totalCents > 0);
		const hasIncomes = monthlyData.incomes.some((item) => item && item.totalCents > 0);
		if (!hasExpenses && !hasIncomes) {
			return <Text style={styles.emptyText}>{t('reports.noTrendData')}</Text>;
		}
		try {
			return (
				<View style={styles.chartContainer}>
					<LineChart
						data={lineChartData}
						width={width - 32}
						height={220}
						chartConfig={chartConfig}
						bezier
						style={{ marginVertical: 8, borderRadius: 16 }}
						fromZero
					/>
				</View>
			);
		} catch (error) {
			console.error('Error rendering trend chart:', error);
			setTrendChartError(true);
			return <Text style={styles.errorText}>{t('reports.renderErrorTrend')}</Text>;
		}
	}, [
		lineChartData,
		chartConfig,
		trendChartError,
		monthlyData.expenses,
		monthlyData.incomes,
		width,
		t,
	]);

	const renderCategoryBreakdown = useCallback(
		(
			data: Array<{ key: string; color: string; name: string; amountCents: number }>,
			totalCents: number,
			emptyMessage: string,
			type: string
		) => {
			if (data.length === 0) {
				return <Text style={styles.emptyText}>{emptyMessage}</Text>;
			}
			return data.map((item) => (
				<View key={`${type}-${item.key}`} style={styles.categoryBreakdownItem}>
					<View style={styles.categoryLabelContainer}>
						<View style={[styles.categoryColorDot, { backgroundColor: item.color }]} />
						<Text style={styles.categoryLabel}>{item.name}</Text>
					</View>
					<View style={styles.categoryAmountContainer}>
						<Text style={styles.categoryAmount}>{formatCents(item.amountCents)}</Text>
						<Text style={styles.categoryPercentage}>
							{((item.amountCents / (totalCents || 1)) * 100).toFixed(1)}%
						</Text>
					</View>
				</View>
			));
		},
		[]
	);

	const handleExportReports = useCallback(async () => {
		try {
			const periodName = `${selectedMonthName}_${selectedYear}`;
			await exportFinancialReport(
				currentPeriodTransactions,
				categories,
				monthlyData,
				categoryTotals,
				periodName,
				selectedYear
			);
		} catch (error) {
			console.error('Error exporting reports:', error);
		}
	}, [
		selectedMonthName,
		selectedYear,
		currentPeriodTransactions,
		categories,
		monthlyData,
		categoryTotals,
	]);

	const handleToggleExpenses = useCallback(() => setShowExpenses((prev) => !prev), []);
	const handleToggleIncomes = useCallback(() => setShowIncomes((prev) => !prev), []);

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

			<View style={styles.headerContainer}>
				<Text style={styles.headerTitle}>{t('reports.headerTitle')}</Text>
				<Text style={styles.headerSubtitle}>{t('reports.headerSubtitle')}</Text>
			</View>

			<View style={styles.toggleContainer}>
				<View style={styles.toggleOption}>
					<Text style={styles.toggleLabel}>{t('reports.expenses')}</Text>
					<Switch
						value={showExpenses}
						onValueChange={handleToggleExpenses}
						trackColor={{ false: '#3e3e3e', true: 'rgba(255, 107, 107, 0.3)' }}
						thumbColor={showExpenses ? '#FF6B6B' : '#f4f3f4'}
					/>
				</View>
				<View style={styles.toggleOption}>
					<Text style={styles.toggleLabel}>{t('reports.incomes')}</Text>
					<Switch
						value={showIncomes}
						onValueChange={handleToggleIncomes}
						trackColor={{ false: '#3e3e3e', true: 'rgba(76, 175, 80, 0.3)' }}
						thumbColor={showIncomes ? '#4CAF50' : '#f4f3f4'}
					/>
				</View>
			</View>

			<ScrollView
				contentContainerStyle={styles.scrollContent}
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						onRefresh={handleRefresh}
						tintColor="#50E3C2"
						colors={['#50E3C2']}
					/>
				}
			>
				{isLoading ? (
					<Text style={styles.loadingText}>{t('reports.loading')}</Text>
				) : (
					<>
						{/* Summary Section */}
						<View style={styles.sectionContainer}>
							<Text style={styles.sectionTitle}>{t('reports.monthlySummary')}</Text>
							<View style={styles.summaryContainer}>
								<View style={styles.summaryItem}>
									<Text style={styles.summaryLabel}>{t('reports.income')}</Text>
									<Text style={[styles.summaryValue, styles.incomeValue]}>
										{formatCents(periodTotals.incomeCents)}
									</Text>
								</View>
								<View style={styles.summaryItem}>
									<Text style={styles.summaryLabel}>{t('reports.expenses')}</Text>
									<Text style={[styles.summaryValue, styles.expenseValue]}>
										{formatCents(periodTotals.expenseCents)}
									</Text>
								</View>
								<View style={styles.summaryItem}>
									<Text style={styles.summaryLabel}>{t('reports.net')}</Text>
									<Text
										style={[
											styles.summaryValue,
											periodTotals.netCents >= 0 ? styles.incomeValue : styles.expenseValue,
										]}
									>
										{formatCents(periodTotals.netCents)}
									</Text>
								</View>
							</View>
						</View>

						{/* Expenses by Category */}
						{showExpenses && (
							<View style={styles.sectionContainer}>
								<Text style={styles.sectionTitle}>{t('reports.expensesByCategory')}</Text>
								{renderExpensePieChart()}
								<View style={styles.categoryBreakdownContainer}>
									{renderCategoryBreakdown(
										expenseViews.breakdown,
										periodTotals.expenseCents,
										t('reports.noExpenseData'),
										'expense'
									)}
								</View>
							</View>
						)}

						{/* Income by Category */}
						{showIncomes && (
							<View style={styles.sectionContainer}>
								<Text style={styles.sectionTitle}>{t('reports.incomeByCategory')}</Text>
								{renderIncomePieChart()}
								<View style={styles.categoryBreakdownContainer}>
									{renderCategoryBreakdown(
										incomeViews.breakdown,
										periodTotals.incomeCents,
										t('reports.noIncomeData'),
										'income'
									)}
								</View>
							</View>
						)}

						{/* Monthly Spending Trend */}
						<View style={styles.sectionContainer}>
							<Text style={styles.sectionTitle}>{t('reports.monthlyTrends')}</Text>
							{renderTrendChart()}
						</View>

						{/* Export Options */}
						<View style={styles.exportContainer}>
							<TouchableOpacity style={styles.exportButton} onPress={handleExportReports}>
								<Ionicons name="download-outline" size={20} color="#FFFFFF" />
								<Text style={styles.exportButtonText}>{t('reports.exportReports')}</Text>
							</TouchableOpacity>
						</View>
					</>
				)}
			</ScrollView>
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
	headerContainer: {
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	headerTitle: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	headerSubtitle: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.7)',
		marginBottom: 8,
	},
	toggleContainer: {
		flexDirection: 'row',
		justifyContent: 'space-around',
		paddingVertical: 10,
		marginHorizontal: 16,
		marginBottom: 10,
		backgroundColor: '#1E1E1E',
		borderRadius: 8,
	},
	toggleOption: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	toggleLabel: {
		color: '#FFFFFF',
		marginRight: 8,
		fontSize: 16,
	},
	scrollContent: {
		padding: 16,
		paddingBottom: 40,
	},
	sectionContainer: {
		marginBottom: 24,
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 16,
	},
	summaryContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	summaryItem: {
		flex: 1,
		alignItems: 'center',
	},
	summaryLabel: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.7)',
		marginBottom: 8,
	},
	summaryValue: {
		fontSize: 16,
		fontWeight: '600',
	},
	incomeValue: {
		color: '#4CAF50',
	},
	expenseValue: {
		color: '#FF6B6B',
	},
	chartContainer: {
		alignItems: 'center',
		marginBottom: 16,
	},
	categoryBreakdownContainer: {
		marginTop: 8,
	},
	categoryBreakdownItem: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		paddingVertical: 8,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	categoryLabelContainer: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	categoryColorDot: {
		width: 12,
		height: 12,
		borderRadius: 6,
		marginRight: 8,
	},
	categoryLabel: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	categoryAmountContainer: {
		alignItems: 'flex-end',
	},
	categoryAmount: {
		fontSize: 14,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	categoryPercentage: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	loadingText: {
		color: 'rgba(255, 255, 255, 0.6)',
		textAlign: 'center',
		fontSize: 16,
		marginTop: 40,
	},
	emptyText: {
		color: 'rgba(255, 255, 255, 0.6)',
		textAlign: 'center',
		fontSize: 14,
		marginVertical: 20,
	},
	errorText: {
		color: '#FF6B6B',
		textAlign: 'center',
		fontSize: 14,
		marginVertical: 20,
	},
	exportContainer: {
		alignItems: 'center',
		marginTop: 8,
	},
	exportButton: {
		flexDirection: 'row',
		alignItems: 'center',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderRadius: 8,
	},
	exportButtonText: {
		color: '#FFFFFF',
		fontWeight: '500',
		marginLeft: 8,
	},
});

export default ReportsScreen;
