import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';
import { parseCardNames } from '../utils/cardNames';
import { formatFullDate } from '../utils/dateUtils';
import { formatCents } from '../utils/money';

export default function TransactionDetailScreen() {
	const { id } = useLocalSearchParams();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { t } = useTranslation();
	const { transactions, categories, removeTransaction, removeInstallmentGroup } = useTransactions();
	const { accounts } = useAccounts();
	const [transaction, setTransaction] = useState<Transaction | null>(null);
	// biome-ignore lint/suspicious/noExplicitAny: external API shape unknown
	const [category, setCategory] = useState<any>(null);

	useEffect(() => {
		if (typeof id !== 'string') return;

		const foundTransaction = transactions.find((t) => t.id === id);
		if (foundTransaction) {
			setTransaction(foundTransaction);

			// Find category; sem ela, o nome de reserva vem da tradução ("Sem categoria").
			const foundCategory = categories.find((c) => c.id === foundTransaction.category);
			setCategory(
				foundCategory || {
					id: 'uncategorized',
					name: t('transactionsList.uncategorized'),
					color: '#9CA3AF',
					icon: 'help-circle',
				}
			);
		}
	}, [id, transactions, categories, t]);

	const handleEdit = () => {
		if (transaction) {
			router.push(`/transaction/edit/${transaction.id}`);
		}
	};

	const handleDelete = () => {
		if (!transaction) return;

		const run = (action: () => Promise<void>) => async () => {
			try {
				await action();
				router.back();
			} catch (error) {
				console.error('Failed to delete transaction:', error);
			}
		};

		// Parcela: apagar só uma deixa as outras inflando as faturas futuras. As duas opções
		// ficam explícitas.
		const group = transaction.installmentGroup;
		if (group) {
			Alert.alert(t('transactionDelete.installmentTitle'), t('transactionDelete.installmentBody', { count: transaction.installmentCount ?? 0 }), [
				{ text: t('transactionDelete.cancel'), style: 'cancel' },
				{ text: t('transactionDelete.onlyThis'), onPress: run(() => removeTransaction(transaction.id)) },
				{ text: t('transactionDelete.allInstallments'), style: 'destructive', onPress: run(() => removeInstallmentGroup(group)) },
			]);
			return;
		}

		Alert.alert(
			transaction.isIncome ? t('transactionDelete.incomeTitle') : t('transactionDelete.expenseTitle'),
			t('transactionDelete.body'),
			[
				{ text: t('transactionDelete.cancel'), style: 'cancel' },
				{ text: t('transactionDelete.confirm'), style: 'destructive', onPress: run(() => removeTransaction(transaction.id)) },
			]
		);
	};

	// A pilha da raiz não desenha cabeçalho: a tela desenha o seu, como Dívida e Cartão.
	const topBar = (title: string) => (
		<View style={styles.topBar}>
			<Pressable
				onPress={() => router.back()}
				accessibilityRole="button"
				accessibilityLabel={t('transactionDetail.back')}
				style={styles.iconButton}
			>
				<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
			</Pressable>
			<Text style={styles.topBarTitle} accessibilityRole="header" numberOfLines={1}>
				{title}
			</Text>
		</View>
	);

	if (!transaction || !category) {
		return (
			<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
				<Stack.Screen
					options={{
						title: t('transactionDetail.title'),
						headerStyle: {
							backgroundColor: '#1A1A1A',
						},
						headerTintColor: '#FFFFFF',
						headerShadowVisible: false,
					}}
				/>
				{topBar(t('transactionDetail.title'))}
				<View style={styles.loadingContainer}>
					<Text style={styles.loadingText}>{t('transactionDetail.loading')}</Text>
				</View>
			</SafeAreaView>
		);
	}

	// De onde saiu (ou para onde foi) o dinheiro: a conta, o cartão pelo nome dado ao final
	// (ou "final 1234") e, numa compra parcelada, qual parcela é esta.
	const account = transaction.accountId ? accounts.find((item) => item.id === transaction.accountId) : null;
	const accountLabel = !transaction.accountId
		? t('transactionDetail.noAccount')
		: (account?.name ?? t('transactionDetail.removedAccount'));
	const cardLabel = transaction.cardLast4
		? (parseCardNames(account?.cardNames)[transaction.cardLast4] ??
			t('transactionDetail.cardEnding', { last4: transaction.cardLast4 }))
		: null;
	const installmentLabel =
		transaction.installmentIndex && transaction.installmentCount && transaction.installmentCount > 1
			? t('transactionDetail.installmentOf', {
					index: transaction.installmentIndex,
					count: transaction.installmentCount,
				})
			: null;

	const title = transaction.isIncome ? t('transactionDetail.titleIncome') : t('transactionDetail.titleExpense');

	// O fim rola e para acima da barra de gestos do Android (`insets.bottom`): com conta,
	// cartão, parcela e observação, "Editar" e "Apagar" ficavam embaixo dela.
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
			{topBar(title)}

			<ScrollView
				contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}
				showsVerticalScrollIndicator={false}
			>
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
						{transaction.isIncome ? t('transactionDetail.income') : t('transactionDetail.expense')}
					</Text>
				</View>

				<View style={styles.amountContainer}>
					<Text style={styles.amountLabel}>{t('transactionDetail.amount')}</Text>
					<Text
						style={[
							styles.amount,
							transaction.isIncome ? styles.incomeAmount : styles.expenseAmount,
						]}
					>
						{transaction.isIncome ? '+' : '-'} {formatCents(transaction.amountCents)}
					</Text>
				</View>

				<View style={styles.detailItem}>
					<Text style={styles.detailLabel}>{t('transactionDetail.date')}</Text>
					<Text style={styles.detailValue}>{formatFullDate(transaction.date)}</Text>
				</View>

				<View style={styles.detailItem}>
					<Text style={styles.detailLabel}>{t('transactionDetail.account')}</Text>
					<Text style={styles.detailValue}>{accountLabel}</Text>
				</View>

				{cardLabel ? (
					<View style={styles.detailItem}>
						<Text style={styles.detailLabel}>{t('transactionDetail.card')}</Text>
						<Text style={styles.detailValue}>{cardLabel}</Text>
					</View>
				) : null}

				{installmentLabel ? (
					<View style={styles.detailItem}>
						<Text style={styles.detailLabel}>{t('transactionDetail.installment')}</Text>
						<Text style={styles.detailValue}>{installmentLabel}</Text>
					</View>
				) : null}

				{transaction.note ? (
					<View style={styles.detailItem}>
						<Text style={styles.detailLabel}>{t('transactionDetail.note')}</Text>
						<Text style={styles.detailValue}>{transaction.note}</Text>
					</View>
				) : null}

				<View style={styles.actions}>
					<TouchableOpacity style={[styles.actionButton, styles.editButton]} onPress={handleEdit}>
						<Ionicons name="pencil" size={20} color="#FFFFFF" />
						<Text style={styles.actionButtonText}>{t('transactionDetail.edit')}</Text>
					</TouchableOpacity>

					<TouchableOpacity
						style={[styles.actionButton, styles.deleteButton]}
						onPress={handleDelete}
					>
						<Ionicons name="trash-outline" size={20} color="#FFFFFF" />
						<Text style={styles.actionButtonText}>{t('transactionDetail.delete')}</Text>
					</TouchableOpacity>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	topBar: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 8,
		paddingVertical: 4,
		gap: 4,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	topBarTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
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
