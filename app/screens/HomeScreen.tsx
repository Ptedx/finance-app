import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
	RefreshControl,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import IncomeSection from '../components/IncomeSection';
import Summary from '../components/Summary';
import TransactionItem from '../components/TransactionItem';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';

const HomeScreen = () => {
	const router = useRouter();
	const { t } = useTranslation();
	const { currentPeriodTransactions, monthlyTotal, isLoading, refreshData } = useTransactions();

	const { processTransactions } = useRecurringTransactions();
	const [refreshing, setRefreshing] = React.useState(false);

	// Process recurring transactions when the app starts
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		const processRecurring = async () => {
			try {
				await processTransactions();
			} catch (error) {
				console.error('Failed to process recurring transactions:', error);
			}
		};

		processRecurring();
	}, []);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await processTransactions();
			await refreshData();
		} catch (error) {
			console.error('Error during refresh:', error);
		} finally {
			setRefreshing(false);
		}
	}, [refreshData, processTransactions]);

	const handleTransactionPress = (transaction: Transaction) => {
		router.push({
			pathname: '/transaction/[id]',
			params: { id: transaction.id },
		});
	};

	const handleViewAllTransactions = () => {
		router.push({ pathname: '/transactions' });
	};

	const handleOpenSettings = () => {
		router.push({ pathname: '/settings' });
	};

	const recentTransactions = [...currentPeriodTransactions]
		.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
		.slice(0, 5);

	return (
		<View style={styles.container}>
			<StatusBar barStyle="light-content" />

			{/* Header */}
			<View style={styles.header}>
				<Text style={styles.headerTitle}>{t('home.title')}</Text>
				<TouchableOpacity onPress={handleOpenSettings}>
					<Ionicons name="settings-outline" size={24} color="#ffffff" />
				</TouchableOpacity>
			</View>

			<ScrollView
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						onRefresh={handleRefresh}
						tintColor="#15E8FE"
						colors={['#15E8FE']}
					/>
				}
			>
				{/* Budget Summary */}
				<Summary
					spent={monthlyTotal.expenses}
					income={monthlyTotal.incomes}
					net={monthlyTotal.net}
				/>
				<IncomeSection />

				{/* Recent Transactions */}
				<View style={styles.sectionHeader}>
					<Text style={styles.sectionTitle}>{t('home.recentTransactions')}</Text>
					<TouchableOpacity onPress={handleViewAllTransactions}>
						<Text style={styles.seeAllText}>{t('home.seeAll')}</Text>
					</TouchableOpacity>
				</View>

				<View style={styles.transactionsContainer}>
					{isLoading ? (
						<Text style={styles.emptyText}>{t('home.loading')}</Text>
					) : recentTransactions.length === 0 ? (
						<Text style={styles.emptyText}>{t('home.empty')}</Text>
					) : (
						recentTransactions.map((transaction) => (
							<TransactionItem
								key={transaction.id}
								transaction={transaction}
								onPress={handleTransactionPress}
							/>
						))
					)}
				</View>
			</ScrollView>
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
		paddingHorizontal: 16,
	},
	header: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 20,
		paddingTop: 60,
	},
	headerTitle: {
		fontSize: 28,
		fontWeight: '700',
		color: '#ffffff',
		letterSpacing: 0.5,
	},
	sectionHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 12,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#ffffff',
	},
	seeAllText: {
		fontSize: 14,
		color: '#15E8FE',
	},
	transactionsContainer: {
		marginBottom: 80,
	},
	emptyText: {
		color: 'rgba(255, 255, 255, 0.6)',
		textAlign: 'center',
		marginTop: 20,
		fontSize: 16,
	},
});

export default HomeScreen;
