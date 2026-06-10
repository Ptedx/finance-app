import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TransactionForm from '../components/TransactionForm';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';

const AddTransactionScreen = () => {
	const router = useRouter();
	const params = useLocalSearchParams();
	const { transactions } = useTransactions();
	const [initialTransaction, setInitialTransaction] = useState<Transaction | undefined>(undefined);
	const [defaultIsIncome, setDefaultIsIncome] = useState<boolean | undefined>(undefined);
	const isMounted = useRef(true);

	// Clear initial transaction when component mounts/unmounts
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		isMounted.current = true;

		// Check if we're being directed to add income specifically
		if (params.type && params.type === 'income') {
			setDefaultIsIncome(true);
		} else if (params.type && params.type === 'expense') {
			setDefaultIsIncome(false);
		}

		return () => {
			isMounted.current = false;
			setInitialTransaction(undefined);
		};
	}, []);

	useEffect(() => {
		// Check if we're editing an existing transaction
		if (params.transactionId && typeof params.transactionId === 'string') {
			const transactionToEdit = transactions.find((tx) => tx.id === params.transactionId);
			if (transactionToEdit && isMounted.current) {
				setInitialTransaction(transactionToEdit);
			}
		} else {
			// If not editing, clear any previous initial transaction
			setInitialTransaction(undefined);
		}
	}, [params.transactionId, transactions]);

	const handleSubmit = () => {
		// Clear initialTransaction before navigating back
		setInitialTransaction(undefined);
		router.back();
	};

	const handleCancel = () => {
		// Clear initialTransaction before navigating back
		setInitialTransaction(undefined);
		router.back();
	};

	const screenTitle = initialTransaction
		? 'Edit Transaction'
		: defaultIsIncome === true
			? 'Add Income'
			: defaultIsIncome === false
				? 'Add Expense'
				: 'Add Transaction';

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: screenTitle,
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>
			<View style={styles.content}>
				<TransactionForm
					initialTransaction={initialTransaction}
					onSubmit={handleSubmit}
					onCancel={handleCancel}
					defaultIsIncome={defaultIsIncome}
				/>
			</View>
		</SafeAreaView>
	);
};

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

export default AddTransactionScreen;
