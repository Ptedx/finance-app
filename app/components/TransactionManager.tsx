import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useState } from 'react';
import { Alert, FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { formatCurrency } from '../utils/currencyUtils';
import TransactionEditor from './TransactionEditor';

// Temporary mock data for transactions
const MOCK_TRANSACTIONS = [
	{ id: '1', amount: 1200, note: 'Salary', isIncome: true, recurrenceType: 'monthly' },
	{ id: '2', amount: 500, note: 'Rent', isIncome: false, recurrenceType: 'monthly' },
	{ id: '3', amount: 3000, note: 'Bonus', isIncome: true, recurrenceType: 'yearly' },
	{ id: '4', amount: 200, note: 'Insurance', isIncome: false, recurrenceType: 'monthly' },
];

interface TransactionManagerProps {
	isVisible: boolean;
	onClose: () => void;
}

const TransactionManager: React.FC<TransactionManagerProps> = ({ isVisible, onClose }) => {
	const [transactions] = useState(MOCK_TRANSACTIONS);
	const [showEditor, setShowEditor] = useState(false);
	const [isAddingIncome, setIsAddingIncome] = useState(true);

	const handleAddIncome = () => {
		setIsAddingIncome(true);
		setShowEditor(true);
	};

	const handleAddTransaction = () => {
		setIsAddingIncome(false);
		setShowEditor(true);
	};

	const handleDeleteTransaction = (id: string) => {
		Alert.alert(
			'Delete Transaction',
			'Are you sure you want to delete this recurring transaction?',
			[
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Delete',
					style: 'destructive',
					onPress: () => {
						// In a real app, would call a function to delete the transaction
						console.log('Deleting transaction', id);
					},
				},
			]
		);
	};

	// biome-ignore lint/suspicious/noExplicitAny: external API shape unknown
	const renderTransactionItem = ({ item }: { item: any }) => {
		const iconName = item.isIncome ? 'arrow-down-circle' : 'arrow-up-circle';
		const iconColor = item.isIncome ? '#15E8FE' : '#FF6B6B';
		const amountPrefix = item.isIncome ? '+ ' : '- ';
		const amountColor = item.isIncome ? '#15E8FE' : '#FF6B6B';

		let recurrenceText = 'Monthly';
		if (item.recurrenceType === 'yearly') {
			recurrenceText = 'Yearly';
		} else if (item.recurrenceType === 'custom') {
			recurrenceText = 'Custom';
		}

		return (
			<View style={styles.transactionItem}>
				<View style={styles.transactionIconContainer}>
					<Ionicons name={iconName} size={24} color={iconColor} />
				</View>

				<View style={styles.transactionDetails}>
					<Text style={styles.transactionNote}>{item.note}</Text>
					<Text style={styles.transactionRecurrence}>{recurrenceText}</Text>
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
			</View>
		);
	};

	return (
		<>
			<Modal visible={isVisible} transparent={true} animationType="slide">
				<View style={styles.modalContainer}>
					<View style={styles.modalContent}>
						<View style={styles.modalHeader}>
							<Text style={styles.modalTitle}>Recurring Transactions</Text>
							<TouchableOpacity onPress={onClose} style={styles.closeButton}>
								<Ionicons name="close" size={24} color="#FFFFFF" />
							</TouchableOpacity>
						</View>

						<View style={styles.actionButtons}>
							<TouchableOpacity
								style={[styles.actionButton, styles.incomeButton]}
								onPress={handleAddIncome}
							>
								<Ionicons
									name="add-circle"
									size={18}
									color="#15E8FE"
									style={styles.actionButtonIcon}
								/>
								<Text style={styles.incomeButtonText}>Add Income</Text>
							</TouchableOpacity>

							<TouchableOpacity
								style={[styles.actionButton, styles.expenseButton]}
								onPress={handleAddTransaction}
							>
								<Ionicons
									name="add-circle"
									size={18}
									color="#FF6B6B"
									style={styles.actionButtonIcon}
								/>
								<Text style={styles.expenseButtonText}>Add Expense</Text>
							</TouchableOpacity>
						</View>

						<View style={styles.transactionListContainer}>
							{transactions.length > 0 ? (
								<FlatList
									data={transactions}
									renderItem={renderTransactionItem}
									keyExtractor={(item) => item.id}
									showsVerticalScrollIndicator={false}
								/>
							) : (
								<View style={styles.emptyContainer}>
									<Text style={styles.emptyText}>No recurring transactions yet.</Text>
									<Text style={styles.emptySubText}>
										Add your recurring incomes and expenses to better track your finances.
									</Text>
								</View>
							)}
						</View>
					</View>
				</View>
			</Modal>

			<TransactionEditor
				isVisible={showEditor}
				onClose={() => setShowEditor(false)}
				isIncome={isAddingIncome}
			/>
		</>
	);
};

const styles = StyleSheet.create({
	modalContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
	},
	modalContent: {
		width: '90%',
		maxHeight: '80%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		overflow: 'hidden',
	},
	modalHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	modalTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	closeButton: {
		padding: 4,
	},
	actionButtons: {
		flexDirection: 'row',
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
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
		padding: 16,
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
	transactionRecurrence: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
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

export default TransactionManager;
