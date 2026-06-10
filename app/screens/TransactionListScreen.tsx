import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
	FlatList,
	RefreshControl,
	SafeAreaView,
	StyleSheet,
	Switch,
	Text,
	View,
} from 'react-native';
import TransactionItem from '../components/TransactionItem';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';

const TransactionListScreen = () => {
	const router = useRouter();
	const { transactions, isLoading, refreshData } = useTransactions();
	const [refreshing, setRefreshing] = useState(false);
	const [showIncomes, setShowIncomes] = useState(true);
	const [showExpenses, setShowExpenses] = useState(true);

	// Filter transactions based on toggle settings - memoized to prevent recalculation on every render
	const filteredTransactions = useMemo(() => {
		return transactions.filter(
			(transaction) =>
				(transaction.isIncome && showIncomes) || (!transaction.isIncome && showExpenses)
		);
	}, [transactions, showIncomes, showExpenses]);

	// Sort transactions by date, newest first - memoized to prevent resorting on every render
	const sortedTransactions = useMemo(() => {
		return [...filteredTransactions].sort(
			(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
		);
	}, [filteredTransactions]);

	// Create callback functions with useCallback to prevent recreation on every render
	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refreshData();
		} catch (error) {
			console.error('Error refreshing data:', error);
		} finally {
			setRefreshing(false);
		}
	}, [refreshData]);

	const handleTransactionPress = useCallback(
		(transaction: Transaction) => {
			router.push({
				pathname: '/transaction/[id]',
				params: { id: transaction.id },
			});
		},
		[router]
	);

	const toggleIncome = useCallback(() => {
		setShowIncomes((prev) => !prev);
	}, []);

	const toggleExpense = useCallback(() => {
		setShowExpenses((prev) => !prev);
	}, []);

	// Memoize the empty list component to prevent recreation on every render
	const renderEmptyList = useCallback(() => {
		if (isLoading || refreshing) {
			return (
				<View style={styles.emptyContainer}>
					<Text style={styles.emptyText}>Loading transactions...</Text>
				</View>
			);
		}

		return (
			<View style={styles.emptyContainer}>
				<Text style={styles.emptyText}>
					{!showIncomes && !showExpenses
						? 'Enable income or expense to see transactions'
						: 'No transactions yet. Tap the "+" button to add one.'}
				</Text>
			</View>
		);
	}, [isLoading, refreshing, showIncomes, showExpenses]);

	// Memoize the render item function to prevent recreation on every render
	const renderItem = useCallback(
		({ item }: { item: Transaction }) => (
			<TransactionItem transaction={item} onPress={handleTransactionPress} />
		),
		[handleTransactionPress]
	);

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: 'Transactions',
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<View style={styles.headerContainer}>
				<Text style={styles.headerTitle}>Transactions</Text>
				<Text style={styles.headerSubtitle}>View and manage all your transactions</Text>
			</View>

			<View style={styles.filterContainer}>
				<View style={styles.filterOption}>
					<Text style={styles.filterLabel}>Incomes</Text>
					<Switch
						value={showIncomes}
						onValueChange={toggleIncome}
						trackColor={{ false: '#3e3e3e', true: 'rgba(76, 175, 80, 0.3)' }}
						thumbColor={showIncomes ? '#4CAF50' : '#f4f3f4'}
					/>
				</View>

				<View style={styles.filterOption}>
					<Text style={styles.filterLabel}>Expenses</Text>
					<Switch
						value={showExpenses}
						onValueChange={toggleExpense}
						trackColor={{ false: '#3e3e3e', true: 'rgba(255, 107, 107, 0.3)' }}
						thumbColor={showExpenses ? '#FF6B6B' : '#f4f3f4'}
					/>
				</View>
			</View>

			<FlatList
				data={sortedTransactions}
				renderItem={renderItem}
				keyExtractor={(item) => item.id}
				contentContainerStyle={styles.listContent}
				ListEmptyComponent={renderEmptyList}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						onRefresh={handleRefresh}
						tintColor="#15E8FE"
						colors={['#15E8FE']}
					/>
				}
				removeClippedSubviews={true} // Optimize memory usage for lists
				maxToRenderPerBatch={10} // Limit number of items rendered per batch
				initialNumToRender={8} // Limit initial render amount
				windowSize={5} // Reduce rendering window
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
		paddingTop: 60,
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
	filterContainer: {
		flexDirection: 'row',
		justifyContent: 'space-around',
		paddingVertical: 10,
		marginHorizontal: 16,
		marginBottom: 10,
		backgroundColor: '#1E1E1E',
		borderRadius: 8,
	},
	filterOption: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	filterLabel: {
		color: '#FFFFFF',
		marginRight: 8,
		fontSize: 16,
	},
	listContent: {
		padding: 16,
		paddingBottom: 80,
		flexGrow: 1,
	},
	emptyContainer: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingTop: 60,
	},
	emptyText: {
		color: 'rgba(255, 255, 255, 0.6)',
		textAlign: 'center',
		fontSize: 16,
		marginBottom: 20,
	},
});

export default TransactionListScreen;
