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
import { formatCurrency } from '../utils/currencyUtils';
import { getMonthName } from '../utils/dateUtils';
import { exportFinancialReport } from '../utils/exportUtils';

const { width } = Dimensions.get('window');

const ReportsScreen = () => {
	const {
		categoryTotals,
		monthlyData,
		categories,
		monthlyTotal,
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

	const expensesPieChartData = useMemo(() => {
		return categoryTotals.expenses
			.filter(
				(item) =>
					item && typeof item.total === 'number' && !Number.isNaN(item.total) && item.total > 0
			)
			.map((item) => {
				const category = categories.find((c) => c.id === item.categoryId) || {
					id: 'uncategorized',
					name: 'Uncategorized',
					color: '#9CA3AF',
					icon: 'help-circle',
				};
				return {
					name: category.name,
					amount: item.total,
					color: category.color,
					legendFontColor: '#FFFFFF',
					legendFontSize: 12,
				};
			})
			.sort((a, b) => b.amount - a.amount);
	}, [categoryTotals.expenses, categories]);

	const incomesPieChartData = useMemo(() => {
		return categoryTotals.incomes
			.filter(
				(item) =>
					item && typeof item.total === 'number' && !Number.isNaN(item.total) && item.total > 0
			)
			.map((item) => {
				const category = categories.find((c) => c.id === item.categoryId) || {
					id: 'uncategorized',
					name: 'Uncategorized',
					color: '#9CA3AF',
					icon: 'help-circle',
				};
				return {
					name: category.name,
					amount: item.total,
					color: category.color,
					legendFontColor: '#FFFFFF',
					legendFontSize: 12,
				};
			})
			.sort((a, b) => b.amount - a.amount);
	}, [categoryTotals.incomes, categories]);

	const lineChartData = useMemo(() => {
		const validMonthlyExpenses = monthlyData.expenses
			.filter(
				(data) =>
					data &&
					typeof data.month === 'number' &&
					typeof data.total === 'number' &&
					!Number.isNaN(data.total)
			)
			.sort((a, b) => a.month - b.month);

		const validMonthlyIncomes = monthlyData.incomes
			.filter(
				(data) =>
					data &&
					typeof data.month === 'number' &&
					typeof data.total === 'number' &&
					!Number.isNaN(data.total)
			)
			.sort((a, b) => a.month - b.month);

		const monthLabels =
			validMonthlyExpenses.length > 0
				? validMonthlyExpenses.map((data) => getMonthName(data.month).substring(0, 3))
				: validMonthlyIncomes.length > 0
					? validMonthlyIncomes.map((data) => getMonthName(data.month).substring(0, 3))
					: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

		const expenseValues =
			validMonthlyExpenses.length > 0 ? validMonthlyExpenses.map((data) => data.total) : [0, 0, 0];

		const incomeValues =
			validMonthlyIncomes.length > 0 ? validMonthlyIncomes.map((data) => data.total) : [0, 0, 0];

		return {
			labels: monthLabels.length > 0 ? monthLabels : ['Jan', 'Feb', 'Mar'],
			datasets: [
				{
					data: expenseValues.length > 0 ? expenseValues : [0, 0, 0],
					color: () => '#FF6B6B',
					strokeWidth: 2,
				},
				{
					data: incomeValues.length > 0 ? incomeValues : [0, 0, 0],
					color: () => '#4CAF50',
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
		const hasExpenses = monthlyData.expenses.some((item) => item && item.total > 0);
		const hasIncomes = monthlyData.incomes.some((item) => item && item.total > 0);
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
	}, [lineChartData, chartConfig, trendChartError, monthlyData.expenses, monthlyData.incomes, width, t]);

	const renderCategoryBreakdown = useCallback(
		(
			data: Array<{ color: string; name: string; amount: number }>,
			total: number,
			emptyMessage: string,
			type: string
		) => {
			if (data.length === 0) {
				return <Text style={styles.emptyText}>{emptyMessage}</Text>;
			}
			return data.map((item, index) => (
				<View key={`${type}-${index}`} style={styles.categoryBreakdownItem}>
					<View style={styles.categoryLabelContainer}>
						<View style={[styles.categoryColorDot, { backgroundColor: item.color }]} />
						<Text style={styles.categoryLabel}>{item.name}</Text>
					</View>
					<View style={styles.categoryAmountContainer}>
						<Text style={styles.categoryAmount}>{formatCurrency(item.amount)}</Text>
						<Text style={styles.categoryPercentage}>
							{((item.amount / (total || 1)) * 100).toFixed(1)}%
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
				periodName
			);
		} catch (error) {
			console.error('Error exporting reports:', error);
		}
	}, [selectedMonthName, selectedYear, currentPeriodTransactions, categories, monthlyData, categoryTotals]);

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
										{formatCurrency(monthlyTotal.incomes)}
									</Text>
								</View>
								<View style={styles.summaryItem}>
									<Text style={styles.summaryLabel}>{t('reports.expenses')}</Text>
									<Text style={[styles.summaryValue, styles.expenseValue]}>
										{formatCurrency(monthlyTotal.expenses)}
									</Text>
								</View>
								<View style={styles.summaryItem}>
									<Text style={styles.summaryLabel}>{t('reports.net')}</Text>
									<Text
										style={[
											styles.summaryValue,
											monthlyTotal.net >= 0 ? styles.incomeValue : styles.expenseValue,
										]}
									>
										{formatCurrency(monthlyTotal.net)}
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
										expensesPieChartData,
										monthlyTotal.expenses,
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
										incomesPieChartData,
										monthlyTotal.incomes,
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
