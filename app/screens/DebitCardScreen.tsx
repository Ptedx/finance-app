import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DebitCardFace from '../components/cards/DebitCardFace';
import RenameCardSheet from '../components/cards/RenameCardSheet';
import TransactionItem from '../components/TransactionItem';
import { useAccounts } from '../contexts/AccountsContext';
import { usePeriod } from '../contexts/PeriodContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { formatMonthLong, getMonthName } from '../utils/dateUtils';
import { formatCents } from '../utils/money';

/**
 * Um cartão de débito por inteiro: o que ele gastou, mês a mês, com cada compra.
 *
 * Débito não tem fatura — o dinheiro sai da conta na hora, e o saldo da conta já mostra
 * isso. O que esta tela responde é outra pergunta: "quanto e onde esse cartão gastou?".
 * Por isso o histórico é agrupado por mês de calendário, com o total no título de cada
 * mês, e as compras continuam editáveis tocando nelas.
 */

interface DebitCardScreenProps {
	accountId: string;
	last4: string;
}

const DebitCardScreen: React.FC<DebitCardScreenProps> = ({ accountId, last4 }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { debitCards, renameCard } = useAccounts();
	const { transactions } = useTransactions();
	const { selectedMonth } = usePeriod();
	const [renaming, setRenaming] = useState(false);

	const card = debitCards.find((candidate) => candidate.account.id === accountId && candidate.last4 === last4);

	const months = useMemo(() => {
		const byMonth = new Map<string, { key: string; totalCents: number; items: typeof transactions }>();
		for (const tx of transactions) {
			if (tx.accountId !== accountId || tx.cardLast4 !== last4) continue;
			const key = tx.date.slice(0, 7);
			const month = byMonth.get(key) ?? { key, totalCents: 0, items: [] };
			month.totalCents += tx.isIncome ? -tx.amountCents : tx.amountCents;
			month.items.push(tx);
			byMonth.set(key, month);
		}
		return [...byMonth.values()]
			.sort((a, b) => b.key.localeCompare(a.key))
			.map((month) => ({ ...month, items: [...month.items].sort((a, b) => b.date.localeCompare(a.date)) }));
	}, [transactions, accountId, last4]);

	const title = card?.name ?? t('cards.finalLabel', { last4 });

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={styles.header}>
				<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('cards.back')} style={styles.iconButton}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
					{title}
				</Text>
				<Pressable
					onPress={() => setRenaming(true)}
					accessibilityRole="button"
					accessibilityLabel={t('cards.rename.action')}
					style={styles.iconButton}
				>
					<Ionicons name="create-outline" size={24} color="#FFFFFF" />
				</Pressable>
			</View>

			{card ? (
				<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
					<DebitCardFace card={card} monthLabel={getMonthName(selectedMonth)} onPress={() => setRenaming(true)} />
					<Text style={styles.explain}>{t('cards.debit.explain', { account: card.account.name })}</Text>

					<Text style={styles.sectionTitle} accessibilityRole="header">
						{t('cards.debit.history')}
					</Text>
					{months.length === 0 ? <Text style={styles.empty}>{t('cards.debit.empty')}</Text> : null}
					{months.map((month) => (
						<View key={month.key} style={styles.panel}>
							<View
								style={styles.monthHeader}
								accessible
								accessibilityRole="header"
								accessibilityLabel={`${formatMonthLong(`${month.key}-01`)} ${month.key.slice(0, 4)}, ${formatCents(month.totalCents)}`}
							>
								<Text style={styles.monthTitle}>
									{formatMonthLong(`${month.key}-01`)} {month.key.slice(0, 4)}
								</Text>
								<Text style={styles.monthTotal}>{formatCents(month.totalCents)}</Text>
							</View>
							{month.items.map((transaction) => (
								<TransactionItem
									key={transaction.id}
									transaction={transaction}
									onPress={(tx) => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } })}
								/>
							))}
						</View>
					))}
				</ScrollView>
			) : (
				<Text style={styles.empty}>{t('cards.notFound')}</Text>
			)}

			<RenameCardSheet
				visible={renaming}
				last4={last4}
				currentName={card?.name ?? null}
				onClose={() => setRenaming(false)}
				onSave={async (name) => {
					await renameCard(accountId, last4, name);
					setRenaming(false);
				}}
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	header: {
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
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 60,
		gap: 16,
	},
	explain: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.75)',
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '700',
		color: '#FFFFFF',
		marginTop: 4,
	},
	panel: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
		gap: 4,
	},
	monthHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'baseline',
		paddingBottom: 8,
	},
	monthTitle: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
		textTransform: 'capitalize',
	},
	monthTotal: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	empty: {
		fontSize: 15,
		color: 'rgba(255,255,255,0.7)',
		padding: 16,
	},
});

export default DebitCardScreen;
