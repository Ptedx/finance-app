import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ScreenTopBar from '../../components/ScreenTopBar';
import TransactionForm from '../../components/TransactionForm';
import TransferForm from '../../components/TransferForm';
import { useTransactions } from '../../contexts/TransactionsContext';
import { getTransfer } from '../../database/database';
import type { Transaction, Transfer } from '../../database/schema';

export default function EditTransactionScreen() {
	const { t } = useTranslation();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	// `kind=transfer`: a linha de transferência de Lançamentos (E2E-28). Transferência não é
	// lançamento — mora em outra tabela e não está em `transactions`.
	const { id, kind } = useLocalSearchParams();
	const { transactions } = useTransactions();
	const [initialTransaction, setInitialTransaction] = useState<Transaction | undefined>(undefined);
	const [initialTransfer, setInitialTransfer] = useState<Transfer | undefined>(undefined);

	useEffect(() => {
		if (typeof id !== 'string') return;
		let cancelled = false;

		const transactionToEdit = kind === 'transfer' ? undefined : transactions.find((transaction) => transaction.id === id);
		if (transactionToEdit) {
			setInitialTransaction(transactionToEdit);
			return;
		}
		// Sem lançamento com esse id, pode ser uma transferência; apagada também volta.
		void getTransfer(id).then((transfer) => {
			if (cancelled) return;
			if (transfer && !transfer.deletedAt) {
				// A mesma linha relida não troca o objeto: o formulário não renasce a cada recarga.
				setInitialTransfer((previous) =>
					previous?.id === transfer.id && previous.updatedAt === transfer.updatedAt ? previous : transfer
				);
			} else {
				// If transaction not found, navigate back
				router.back();
			}
		});
		return () => {
			cancelled = true;
		};
	}, [id, kind, transactions, router]);

	const handleSubmit = () => {
		router.back();
	};

	const handleCancel = () => {
		router.back();
	};

	const title = initialTransfer
		? t('transactionForm.transfer.titleEdit')
		: initialTransaction?.isIncome
			? t('transactionForm.titleEditIncome')
			: t('transactionForm.titleEditExpense');

	// A pilha da raiz não desenha cabeçalho: a tela desenha o seu, como o detalhe de onde se
	// chega aqui. No lugar dos 60 fixos em cima e embaixo, a área segura cuida do topo e o fim
	// do formulário para acima da barra de gestos (`insets.bottom`; o respiro de 16 é o do
	// próprio formulário).
	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen
				options={{
					title,
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>
			<ScreenTopBar title={title} backLabel={t('transactionForm.back')} onBack={() => router.back()} />
			<View style={[styles.content, { paddingBottom: insets.bottom }]}>
				{initialTransaction && (
					<TransactionForm
						initialTransaction={initialTransaction}
						onSubmit={handleSubmit}
						onCancel={handleCancel}
					/>
				)}
				{!initialTransaction && initialTransfer && (
					<TransferForm initialTransfer={initialTransfer} onSubmit={handleSubmit} onCancel={handleCancel} />
				)}
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	content: {
		flex: 1,
	},
});
