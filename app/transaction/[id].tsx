import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';
import { formatCurrency } from '../utils/currencyUtils';
import { formatFullDate } from '../utils/dateUtils';

export default function TransactionDetailScreen() {
	const { id } = useLocalSearchParams();
	const router = useRouter();
	const { transactions, categories, removeTransaction } = useTransactions();
	const [transaction, setTransaction] = useState<Transaction | null>(null);
	// biome-ignore lint/suspicious/noExplicitAny: external API shape unknown
	const [category, setCategory] = useState<any>(null);

	useEffect(() => {
		if (typeof id !== 'string') return;

		const foundTransaction = transactions.find((t) => t.id === id);
		if (foundTransaction) {
			setTransaction(foundTransaction);

			// Find category, use default Uncategorized if not found
			const foundCategory = categories.find((c) => c.id === foundTransaction.category);
			setCategory(
				foundCategory || {
					id: 'uncategorized',
					name: 'Uncategorized',
					color: '#9CA3AF',
					icon: 'help-circle',
				}
			);
		}
	}, [id, transactions, categories]);

	const handleEdit = () => {
		if (transaction) {
			router.push(`/transaction/edit/${transaction.id}`);
		}
	};

	const handleDelete = () => {
		if (!transaction) return;

		Alert.alert(
			transaction.isIncome ? 'Delete Income' : 'Delete Expense',
			`Are you sure you want to delete this ${transaction.isIncome ? 'income' : 'expense'}? This action cannot be undone.`,
			[
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Delete',
					style: 'destructive',
					onPress: async () => {
						try {
							await removeTransaction(transaction.id);
							router.back();
						} catch (error) {
							console.error('Failed to delete transaction:', error);
						}
					},
				},
			]
		);
	};

	if (!transaction || !category) {
		return (
			<SafeAreaView style={styles.container}>
				<Stack.Screen
					options={{
						title: 'Transaction Details',
						headerStyle: {
							backgroundColor: '#1A1A1A',
						},
						headerTintColor: '#FFFFFF',
						headerShadowVisible: false,
					}}
				/>
				<View style={styles.loadingContainer}>
					<Text style={styles.loadingText}>Loading transaction details...</Text>
				</View>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: transaction.isIncome ? 'Income Details' : 'Expense Details',
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<View style={styles.content}>
				<View style={styles.header}>
					<View style={[styles.categoryIcon, { backgroundColor: category.color }]}>
						<Ionicons name={category.icon} size={32} color="#000000" />
					</View>
					<Text style={styles.categoryName}>{category.name}</Text>
					<Text
						style={[
							styles.transactionType,
							transaction.isIncome ? styles.incomeType : styles.expenseType,
						]}
					>
						{transaction.isIncome ? 'Income' : 'Expense'}
					</Text>
				</View>

				<View style={styles.amountContainer}>
					<Text style={styles.amountLabel}>Amount</Text>
					<Text
						style={[
							styles.amount,
							transaction.isIncome ? styles.incomeAmount : styles.expenseAmount,
						]}
					>
						{transaction.isIncome ? '+' : '-'} {formatCurrency(transaction.amount)}
					</Text>
				</View>

				<View style={styles.detailItem}>
					<Text style={styles.detailLabel}>Date</Text>
					<Text style={styles.detailValue}>{formatFullDate(transaction.date)}</Text>
				</View>

				{transaction.note ? (
					<View style={styles.detailItem}>
						<Text style={styles.detailLabel}>Note</Text>
						<Text style={styles.detailValue}>{transaction.note}</Text>
					</View>
				) : null}

				<View style={styles.actions}>
					<TouchableOpacity style={[styles.actionButton, styles.editButton]} onPress={handleEdit}>
						<Ionicons name="pencil" size={20} color="#FFFFFF" />
						<Text style={styles.actionButtonText}>Edit</Text>
					</TouchableOpacity>

					<TouchableOpacity
						style={[styles.actionButton, styles.deleteButton]}
						onPress={handleDelete}
					>
						<Ionicons name="trash-outline" size={20} color="#FFFFFF" />
						<Text style={styles.actionButtonText}>Delete</Text>
					</TouchableOpacity>
				</View>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
		paddingTop: 60,
	},
	loadingContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
	},
	loadingText: {
		color: 'rgba(255, 255, 255, 0.6)',
		fontSize: 16,
	},
	content: {
		flex: 1,
		padding: 16,
	},
	header: {
		alignItems: 'center',
		marginBottom: 32,
		marginTop: 16,
	},
	categoryIcon: {
		width: 80,
		height: 80,
		borderRadius: 40,
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 16,
	},
	categoryName: {
		fontSize: 20,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 8,
	},
	transactionType: {
		fontSize: 16,
		fontWeight: '500',
		paddingHorizontal: 16,
		paddingVertical: 4,
		borderRadius: 16,
		overflow: 'hidden',
	},
	incomeType: {
		backgroundColor: 'rgba(76, 175, 80, 0.2)',
		color: '#4CAF50',
	},
	expenseType: {
		backgroundColor: 'rgba(255, 107, 107, 0.2)',
		color: '#FF6B6B',
	},
	amountContainer: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 24,
	},
	amountLabel: {
		fontSize: 14,
		color: '#888888',
		marginBottom: 8,
	},
	amount: {
		fontSize: 36,
		fontWeight: '700',
	},
	incomeAmount: {
		color: '#4CAF50',
	},
	expenseAmount: {
		color: '#FF6B6B',
	},
	detailItem: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
	},
	detailLabel: {
		fontSize: 14,
		color: '#888888',
		marginBottom: 8,
	},
	detailValue: {
		fontSize: 16,
		fontWeight: '500',
		color: '#FFFFFF',
	},
	actions: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: 24,
	},
	actionButton: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 16,
		borderRadius: 8,
		marginHorizontal: 8,
	},
	actionButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
		marginLeft: 8,
	},
	editButton: {
		backgroundColor: '#5E5CE6',
	},
	deleteButton: {
		backgroundColor: '#FF6B6B',
	},
});
