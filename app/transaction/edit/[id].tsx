import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TransactionForm from '../../components/TransactionForm';
import { useTransactions } from '../../contexts/TransactionsContext';
import type { Transaction } from '../../database/schema';

export default function EditTransactionScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams();
	const { transactions } = useTransactions();
	const [initialTransaction, setInitialTransaction] = useState<Transaction | undefined>(undefined);

	useEffect(() => {
		if (typeof id !== 'string') return;

		const transactionToEdit = transactions.find((transaction) => transaction.id === id);
		if (transactionToEdit) {
			setInitialTransaction(transactionToEdit);
		} else {
			// If transaction not found, navigate back
			router.back();
		}
	}, [id, transactions, router]);

	const handleSubmit = () => {
		router.back();
	};

	const handleCancel = () => {
		router.back();
	};

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: initialTransaction?.isIncome ? 'Edit Income' : 'Edit Expense',
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>
			<View style={styles.content}>
				{initialTransaction && (
					<TransactionForm
						initialTransaction={initialTransaction}
						onSubmit={handleSubmit}
						onCancel={handleCancel}
					/>
				)}
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
		paddingTop: 60,
		paddingBottom: 60,
	},
	content: {
		flex: 1,
	},
});
