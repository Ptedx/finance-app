import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Alert,
	FlatList,
	RefreshControl,
	SafeAreaView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import TransactionEditor from '../components/TransactionEditor';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { RecurringTransaction } from '../database/schema';
import { formatCurrency } from '../utils/currencyUtils';

const TransactionsScreen = () => {
	const _router = useRouter();
	const { t } = useTranslation();
	const { transactions, isLoading, refreshTransactions, removeTransaction, processTransactions } =
		useRecurringTransactions();
	const { categories } = useTransactions();

	const [showEditor, setShowEditor] = useState<boolean>(false);
	const [isAddingIncome, setIsAddingIncome] = useState<boolean>(true);
	const [selectedTransaction, setSelectedTransaction] = useState<RecurringTransaction | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		const checkAndProcessTransactions = async () => {
			try {
				await processTransactions();
			} catch (error) {
				console.error('Failed to process recurring transactions:', error);
			}
		};

		checkAndProcessTransactions();
	}, []);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await processTransactions();
			await refreshTransactions();
		} catch (error) {
			console.error('Error refreshing data:', error);
		} finally {
			setRefreshing(false);
		}
	};

	const handleAddIncome = () => {
		setSelectedTransaction(null);
		setIsAddingIncome(true);
		setShowEditor(true);
	};

	const handleAddExpense = () => {
		setSelectedTransaction(null);
		setIsAddingIncome(false);
		setShowEditor(true);
	};

	const handleEditTransaction = (transaction: RecurringTransaction) => {
		setSelectedTransaction(transaction);
		setIsAddingIncome(transaction.isIncome);
		setShowEditor(true);
	};

	const handleDeleteTransaction = (id: string) => {
		Alert.alert(t('transactions.deleteTitle'), t('transactions.deleteMsg'), [
			{ text: t('transactions.cancel'), style: 'cancel' },
			{
				text: t('transactions.delete'),
				style: 'destructive',
				onPress: async () => {
					try {
						await removeTransaction(id);
					} catch (error) {
						console.error('Failed to delete transaction:', error);
						Alert.alert(t('transactions.error'), t('transactions.failedDelete'));
					}
				},
			},
		]);
	};

	const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
	const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

	const renderTransactionItem = ({ item }: { item: RecurringTransaction }) => {
		const iconName = item.isIncome ? 'arrow-down-circle' : 'arrow-up-circle';
		const iconColor = item.isIncome ? '#15E8FE' : '#FF6B6B';
		const amountPrefix = item.isIncome ? '+ ' : '- ';
		const amountColor = item.isIncome ? '#15E8FE' : '#FF6B6B';

		let categoryName = '';
		if (!item.isIncome && item.category) {
			const category = categories.find((c) => c.id === item.category);
			if (category) categoryName = category.name;
		}

		let recurrenceText = '';
		if (item.recurrenceType === 'monthly') {
			recurrenceText = t('transactions.monthly', { day: item.day });
		} else if (item.recurrenceType === 'yearly') {
			const monthKey = item.month && item.month >= 1 && item.month <= 12
				? monthKeys[item.month - 1]
				: 'jan';
			recurrenceText = t('transactions.yearly', {
				month: t(`transactions.months.${monthKey}`),
				day: item.day,
			});
		} else if (item.recurrenceType === 'weekly') {
			const weekdayKey = item.weekday && item.weekday >= 1 && item.weekday <= 7
				? weekdayKeys[item.weekday - 1]
				: 'mon';
			recurrenceText = t('transactions.weekly', {
				weekday: t(`transactions.weekdays.${weekdayKey}`),
			});
		}

		return (
			<TouchableOpacity style={styles.transactionItem} onPress={() => handleEditTransaction(item)}>
				<View style={styles.transactionIconContainer}>
					<Ionicons name={iconName} size={24} color={iconColor} />
				</View>

				<View style={styles.transactionDetails}>
					<Text style={styles.transactionNote}>{item.note}</Text>
					<View style={styles.transactionMeta}>
						<Text style={styles.transactionRecurrence}>{recurrenceText}</Text>
						{!item.isIncome && categoryName && (
							<Text style={styles.transactionCategory}>• {categoryName}</Text>
						)}
					</View>
					{item.nextDue && <Text style={styles.nextDueDate}>Next due: {item.nextDue}</Text>}
				</View>

				<View style={styles.transactionAmount}>
					<Text style={[styles.transactionAmountText, { color: amountColor }]}>
						{amountPrefix}
						{formatCurrency(item.amount)}
					</Text>
				</View>

				<TouchableOpacity
					style={styles.deleteButton}
					onPress={() => handleDeleteTransaction(item.id)}
				>
					<Ionicons name="trash-outline" size={18} color="#FF6B6B" />
				</TouchableOpacity>
			</TouchableOpacity>
		);
	};

	const handleEditorClose = () => {
		setShowEditor(false);
		setSelectedTransaction(null);
	};

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: t('transactions.screenTitle'),
					headerStyle: { backgroundColor: '#1A1A1A' },
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<View style={styles.headerContainer}>
				<Text style={styles.headerTitle}>{t('transactions.headerTitle')}</Text>
				<Text style={styles.headerSubtitle}>{t('transactions.headerSubtitle')}</Text>
			</View>

			<View style={styles.content}>
				<View style={styles.actionButtons}>
					<TouchableOpacity
						style={[styles.actionButton, styles.incomeButton]}
						onPress={handleAddIncome}
					>
						<Ionicons name="add-circle" size={18} color="#15E8FE" style={styles.actionButtonIcon} />
						<Text style={styles.incomeButtonText}>{t('transactions.addIncome')}</Text>
					</TouchableOpacity>

					<TouchableOpacity
						style={[styles.actionButton, styles.expenseButton]}
						onPress={handleAddExpense}
					>
						<Ionicons name="add-circle" size={18} color="#FF6B6B" style={styles.actionButtonIcon} />
						<Text style={styles.expenseButtonText}>{t('transactions.addExpense')}</Text>
					</TouchableOpacity>
				</View>

				<View style={styles.transactionListContainer}>
					{isLoading ? (
						<View style={styles.emptyContainer}>
							<Text style={styles.emptyText}>{t('transactions.loading')}</Text>
						</View>
					) : transactions.length > 0 ? (
						<FlatList
							data={transactions}
							renderItem={renderTransactionItem}
							keyExtractor={(item) => item.id}
							showsVerticalScrollIndicator={false}
							refreshControl={
								<RefreshControl
									refreshing={refreshing}
									onRefresh={handleRefresh}
									tintColor="#15E8FE"
									colors={['#15E8FE']}
								/>
							}
						/>
					) : (
						<View style={styles.emptyContainer}>
							<Text style={styles.emptyText}>{t('transactions.empty')}</Text>
							<Text style={styles.emptySubText}>{t('transactions.emptySubtitle')}</Text>
						</View>
					)}
				</View>
			</View>

			<TransactionEditor
				isVisible={showEditor}
				onClose={handleEditorClose}
				isIncome={isAddingIncome}
				initialTransaction={selectedTransaction}
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
		marginBottom: 8,
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
	},
	content: {
		flex: 1,
		padding: 16,
	},
	actionButtons: {
		flexDirection: 'row',
		marginBottom: 16,
	},
	actionButton: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		paddingVertical: 12,
		borderRadius: 8,
	},
	actionButtonIcon: {
		marginRight: 8,
	},
	incomeButton: {
		marginRight: 8,
		backgroundColor: 'rgba(21, 232, 254, 0.1)',
		borderWidth: 1,
		borderColor: 'rgba(21, 232, 254, 0.3)',
	},
	expenseButton: {
		marginLeft: 8,
		backgroundColor: 'rgba(255, 107, 107, 0.1)',
		borderWidth: 1,
		borderColor: 'rgba(255, 107, 107, 0.3)',
	},
	incomeButtonText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	expenseButtonText: {
		color: '#FF6B6B',
		fontWeight: '600',
	},
	transactionListContainer: {
		flex: 1,
	},
	transactionItem: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	transactionIconContainer: {
		marginRight: 12,
	},
	transactionDetails: {
		flex: 1,
	},
	transactionNote: {
		fontSize: 16,
		fontWeight: '500',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	transactionMeta: {
		flexDirection: 'row',
		alignItems: 'center',
		marginBottom: 2,
	},
	transactionRecurrence: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	transactionCategory: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
		marginLeft: 4,
	},
	nextDueDate: {
		fontSize: 11,
		color: 'rgba(21, 232, 254, 0.8)',
	},
	transactionAmount: {
		marginRight: 12,
	},
	transactionAmountText: {
		fontSize: 16,
		fontWeight: '600',
	},
	deleteButton: {
		padding: 8,
	},
	emptyContainer: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingVertical: 24,
	},
	emptyText: {
		fontSize: 16,
		fontWeight: '500',
		color: '#FFFFFF',
		marginBottom: 8,
		textAlign: 'center',
	},
	emptySubText: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.6)',
		textAlign: 'center',
		paddingHorizontal: 24,
	},
});

export default TransactionsScreen;
