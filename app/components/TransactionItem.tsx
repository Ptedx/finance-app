import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';
import { formatDate } from '../utils/dateUtils';
import { formatCents } from '../utils/money';

interface TransactionItemProps {
	transaction: Transaction;
	onPress?: (transaction: Transaction) => void;
}

const TransactionItem: React.FC<TransactionItemProps> = ({ transaction, onPress }) => {
	const { t } = useTranslation();
	const { categories } = useTransactions();

	// Categoria apagada, ou lançamento antigo sem categoria: mostra "Sem categoria".
	const category = categories.find((c) => c.id === transaction.category) || {
		id: 'uncategorized',
		name: t('transactionsList.uncategorized'),
		color: '#9CA3AF',
		icon: 'help-circle',
	};
	const note = transaction.note || t('transactionsList.noDescription');
	const amount = `${transaction.isIncome ? '+' : '-'} ${formatCents(transaction.amountCents)}`;

	const handlePress = () => {
		if (onPress) {
			onPress(transaction);
		}
	};

	return (
		<TouchableOpacity
			style={styles.container}
			onPress={handlePress}
			accessibilityRole="button"
			accessibilityLabel={`${note}, ${category.name}, ${amount}, ${formatDate(transaction.date)}`}
			accessibilityHint={onPress ? t('transactionsList.openHint') : undefined}
		>
			<View style={[styles.categoryIcon, { backgroundColor: category.color }]}>
				{/* biome-ignore lint/suspicious/noExplicitAny: external API shape unknown */}
				<Ionicons name={category.icon as any} size={18} color="#000000" />
			</View>

			<View style={styles.detailsContainer}>
				<Text style={styles.categoryName} numberOfLines={1}>
					{note}
				</Text>
				<Text style={styles.note} numberOfLines={1}>
					{category.name}
				</Text>
			</View>

			<View style={styles.amountContainer}>
				<Text style={[styles.amount, transaction.isIncome ? styles.incomeAmount : styles.expenseAmount]}>{amount}</Text>
				<Text style={styles.date}>{formatDate(transaction.date)}</Text>
			</View>
		</TouchableOpacity>
	);
};

const styles = StyleSheet.create({
	container: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	categoryIcon: {
		width: 36,
		height: 36,
		borderRadius: 18,
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: 12,
	},
	detailsContainer: {
		flex: 1,
	},
	categoryName: {
		fontSize: 16,
		fontWeight: '500',
		color: '#ffffff',
		marginBottom: 4,
	},
	note: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	amountContainer: {
		alignItems: 'flex-end',
	},
	amount: {
		fontSize: 16,
		fontWeight: '600',
		marginBottom: 4,
	},
	incomeAmount: {
		color: '#4CAF50', // Green color for income
	},
	expenseAmount: {
		color: '#FF6B6B', // Red color for expense
	},
	date: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
	},
});

// Using memo to prevent unnecessary re-renders when props don't change
export default memo(TransactionItem, (prevProps, nextProps) => {
	// Custom comparison function for deeper comparison
	return (
		prevProps.transaction.id === nextProps.transaction.id &&
		prevProps.transaction.amountCents === nextProps.transaction.amountCents &&
		prevProps.transaction.category === nextProps.transaction.category &&
		prevProps.transaction.date === nextProps.transaction.date &&
		prevProps.transaction.note === nextProps.transaction.note &&
		prevProps.transaction.isIncome === nextProps.transaction.isIncome
	);
});
