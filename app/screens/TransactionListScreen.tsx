import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PeriodSelector from '../components/PeriodSelector';
import TransactionItem from '../components/TransactionItem';
import TransferItem from '../components/TransferItem';
import { useAccounts } from '../contexts/AccountsContext';
import { usePeriod } from '../contexts/PeriodContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Account, Transaction, Transfer } from '../database/schema';
import { addDays, formatFullDate, getMonthName, todayISO } from '../utils/dateUtils';
import { formatCents } from '../utils/money';

/**
 * Lançamentos: a lista de tudo o que entrou e saiu, com o extrato como referência.
 *
 * O que a tela responde, de cima para baixo: "de que mês estou falando" (o mesmo seletor
 * da tela inicial, para os números conversarem entre as telas), "quanto entrou e saiu
 * nele", "onde está aquele lançamento" (busca e filtros) e, por fim, a lista.
 *
 * A lista é agrupada por dia, com o total do dia no cabeçalho: é assim que se lê um
 * extrato, e é o que permite achar uma compra sem ler cada linha. Os cabeçalhos ficam
 * grudados no topo enquanto o dia rola.
 *
 * Filtros como escolha única (tudo, entradas ou saídas) em vez dos dois interruptores de
 * antes, que podiam ser desligados ao mesmo tempo e esvaziar a tela sem explicar por quê.
 *
 * Acessibilidade: cada grupo de filtro é um `radiogroup` com estado, os cabeçalhos de dia
 * são `header` (o leitor de tela pula de dia em dia), os alvos têm 48 pontos, e o vazio
 * diz qual é o caso — mês sem lançamento, filtro escondendo tudo ou carregando — com o
 * caminho para desfazer.
 */

const ACCENT = '#15E8FE';
const INCOME = '#4CAF50';
const EXPENSE = '#FF6B6B';

type Kind = 'all' | 'income' | 'expense';

/**
 * A lista mistura lançamentos e transferências. Transferência não é gasto nem receita —
 * entra para a conta não parecer parada quando o que passa por ela é dinheiro trocando de
 * bolso (mandar para o envelope, pagar a fatura) — e por isso fica fora dos totais.
 */
type Row = { type: 'transaction'; id: string; date: string; transaction: Transaction } | { type: 'transfer'; id: string; date: string; transfer: Transfer };

interface DaySection {
	title: string;
	date: string;
	totalCents: number;
	data: Row[];
}

const TransactionListScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { transactions, categories, isLoading, refreshData } = useTransactions();
	const { accounts, activeAccounts, periodTransfers } = useAccounts();
	const { startDate, endDate, selectedMonth } = usePeriod();

	const [refreshing, setRefreshing] = useState(false);
	// Chegar por um link (o insight de receita repetida) já abre no filtro certo.
	const params = useLocalSearchParams<{ kind?: string }>();
	const [kind, setKind] = useState<Kind>(params.kind === 'income' || params.kind === 'expense' ? params.kind : 'all');
	const [accountId, setAccountId] = useState<string | null>(null);
	const [search, setSearch] = useState('');

	const categoryNames = useMemo(
		() => new Map(categories.map((category) => [category.id, category.name.toLocaleLowerCase()])),
		[categories]
	);
	const passThroughCategories = useMemo(
		() => new Set(categories.filter((category) => category.nature === 'passthrough').map((category) => category.id)),
		[categories]
	);

	const inPeriod = useMemo(
		() => transactions.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate),
		[transactions, startDate, endDate]
	);

	const totals = useMemo(() => {
		let incomeCents = 0;
		let expenseCents = 0;
		for (const transaction of inPeriod) {
			if (transaction.isIncome) incomeCents += transaction.amountCents;
			// Repasse: entrou e foi adiante. Sai da receita e não é gasto — a mesma regra
			// do "Este mês" da Home, para os totais baterem entre as telas.
			else if (passThroughCategories.has(transaction.category)) incomeCents -= transaction.amountCents;
			else expenseCents += transaction.amountCents;
		}
		return { incomeCents, expenseCents, netCents: incomeCents - expenseCents };
	}, [inPeriod]);

	const accountsById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

	const filtered = useMemo<Row[]>(() => {
		const term = search.trim().toLocaleLowerCase();

		const rows: Row[] = inPeriod
			.filter((transaction) => {
				if (kind === 'income' && !transaction.isIncome) return false;
				if (kind === 'expense' && transaction.isIncome) return false;
				if (accountId && transaction.accountId !== accountId) return false;
				if (!term) return true;
				const note = transaction.note?.toLocaleLowerCase() ?? '';
				return note.includes(term) || (categoryNames.get(transaction.category) ?? '').includes(term);
			})
			.map((transaction) => ({ type: 'transaction' as const, id: transaction.id, date: transaction.date, transaction }));

		// "Entradas" e "Saídas" falam de receita e despesa; transferência não é nem uma nem
		// outra, então só aparece em "Tudo".
		if (kind === 'all') {
			for (const transfer of periodTransfers) {
				if (accountId && transfer.fromAccountId !== accountId && transfer.toAccountId !== accountId) continue;
				if (term) {
					const names = [transfer.note, accountsById.get(transfer.fromAccountId ?? '')?.name, accountsById.get(transfer.toAccountId ?? '')?.name]
						.filter(Boolean)
						.join(' ')
						.toLocaleLowerCase();
					if (!names.includes(term)) continue;
				}
				rows.push({ type: 'transfer', id: `transfer:${transfer.id}`, date: transfer.date, transfer });
			}
		}

		return rows;
	}, [inPeriod, periodTransfers, kind, accountId, search, categoryNames, accountsById]);

	const sections = useMemo<DaySection[]>(() => {
		const today = todayISO();
		const yesterday = addDays(today, -1);
		const byDay = new Map<string, DaySection>();

		for (const row of [...filtered].sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type))) {
			let day = byDay.get(row.date);
			if (!day) {
				day = {
					date: row.date,
					title:
						row.date === today
							? t('transactionsList.today')
							: row.date === yesterday
								? t('transactionsList.yesterday')
								: formatFullDate(row.date),
					totalCents: 0,
					data: [],
				};
				byDay.set(row.date, day);
			}
			if (row.type === 'transaction') {
				day.totalCents += row.transaction.isIncome ? row.transaction.amountCents : -row.transaction.amountCents;
			}
			day.data.push(row);
		}

		return [...byDay.values()];
	}, [filtered, t]);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refreshData();
		} catch (error) {
			console.error('Error refreshing data:', error);
		} finally {
			setRefreshing(false);
		}
	}, [refreshData]);

	const openTransaction = useCallback(
		(transaction: Transaction) => router.push({ pathname: '/transaction/[id]', params: { id: transaction.id } }),
		[router]
	);

	const isFiltered = kind !== 'all' || accountId !== null || search.trim() !== '';
	const clearFilters = () => {
		setKind('all');
		setAccountId(null);
		setSearch('');
	};

	const accountOptions = useMemo<Account[]>(() => {
		const moved = new Set<string>();
		for (const transaction of inPeriod) if (transaction.accountId) moved.add(transaction.accountId);
		for (const transfer of periodTransfers) {
			if (transfer.fromAccountId) moved.add(transfer.fromAccountId);
			if (transfer.toAccountId) moved.add(transfer.toAccountId);
		}
		// Oferecer uma conta parada no mês só levaria a uma lista vazia.
		return activeAccounts.filter((account) => moved.has(account.id) || account.id === accountId);
	}, [inPeriod, periodTransfers, activeAccounts, accountId]);

	const kinds: Array<{ value: Kind; label: string }> = [
		{ value: 'all', label: t('transactionsList.filterAll') },
		{ value: 'income', label: t('transactionsList.filterIncome') },
		{ value: 'expense', label: t('transactionsList.filterExpense') },
	];

	const header = (
		<View style={styles.header}>
			<View
				style={styles.totals}
				accessible
				accessibilityLabel={[
					`${t('transactionsList.income')} ${formatCents(totals.incomeCents)}`,
					`${t('transactionsList.expense')} ${formatCents(totals.expenseCents)}`,
					`${t('transactionsList.net')} ${formatCents(totals.netCents)}`,
				].join('. ')}
			>
				<View style={styles.total}>
					<Text style={styles.totalLabel}>{t('transactionsList.income')}</Text>
					<Text style={[styles.totalValue, styles.income]}>{formatCents(totals.incomeCents)}</Text>
				</View>
				<View style={styles.total}>
					<Text style={styles.totalLabel}>{t('transactionsList.expense')}</Text>
					<Text style={[styles.totalValue, styles.expense]}>{formatCents(totals.expenseCents)}</Text>
				</View>
				<View style={styles.total}>
					<Text style={styles.totalLabel}>{t('transactionsList.net')}</Text>
					<Text style={[styles.totalValue, totals.netCents < 0 && styles.expense]}>{formatCents(totals.netCents)}</Text>
				</View>
			</View>

			<View style={styles.searchRow}>
				<Ionicons name="search" size={18} color="rgba(255,255,255,0.6)" />
				<TextInput
					style={styles.search}
					value={search}
					onChangeText={setSearch}
					placeholder={t('transactionsList.searchPlaceholder')}
					placeholderTextColor="rgba(255,255,255,0.4)"
					accessibilityLabel={t('transactionsList.searchLabel')}
					returnKeyType="search"
					autoCorrect={false}
				/>
				{search ? (
					<Pressable
						onPress={() => setSearch('')}
						accessibilityRole="button"
						accessibilityLabel={t('transactionsList.clearSearch')}
						style={styles.clear}
					>
						<Ionicons name="close-circle" size={20} color="rgba(255,255,255,0.7)" />
					</Pressable>
				) : null}
			</View>

			<View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={t('transactionsList.filterLabel')}>
				{kinds.map((option) => {
					const selected = kind === option.value;
					return (
						<Pressable
							key={option.value}
							onPress={() => setKind(option.value)}
							accessibilityRole="radio"
							accessibilityState={{ checked: selected }}
							accessibilityLabel={option.label}
							style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
						>
							<Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
						</Pressable>
					);
				})}
			</View>

			{accountOptions.length > 1 ? (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.accountChips}
					accessibilityRole="radiogroup"
					accessibilityLabel={t('transactionsList.accountLabel')}
				>
					{[{ id: null as string | null, name: t('transactionsList.allAccounts'), color: ACCENT }, ...accountOptions].map(
						(account) => {
							const selected = accountId === account.id;
							return (
								<Pressable
									key={account.id ?? 'all'}
									onPress={() => setAccountId(account.id)}
									accessibilityRole="radio"
									accessibilityState={{ checked: selected }}
									accessibilityLabel={account.name}
									style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
								>
									<View style={[styles.dot, { backgroundColor: account.color }]} />
									<Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
										{account.name}
									</Text>
								</Pressable>
							);
						}
					)}
				</ScrollView>
			) : null}

			<Text style={styles.count} accessibilityLiveRegion="polite">
				{t('transactionsList.count', { count: filtered.length })}
			</Text>
		</View>
	);

	const empty = (
		<View style={styles.empty}>
			<Ionicons name={isLoading ? 'hourglass-outline' : 'receipt-outline'} size={32} color="rgba(255,255,255,0.5)" />
			<Text style={styles.emptyText}>
				{isLoading
					? t('transactionsList.loading')
					: accountId && kind === 'all' && !search.trim()
						? t('transactionsList.emptyAccount', { account: accountsById.get(accountId)?.name ?? '' })
						: isFiltered
							? t('transactionsList.emptyFiltered')
							: t('transactionsList.emptyPeriod', { month: getMonthName(selectedMonth) })}
			</Text>
			{!isLoading && isFiltered ? (
				<Pressable
					onPress={clearFilters}
					accessibilityRole="button"
					accessibilityLabel={t('transactionsList.clearFilters')}
					style={({ pressed }) => [styles.clearFilters, pressed && styles.pressed]}
				>
					<Text style={styles.clearFiltersText}>{t('transactionsList.clearFilters')}</Text>
				</Pressable>
			) : null}
		</View>
	);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<View style={styles.titleRow}>
				<Text style={styles.title} accessibilityRole="header">
					{t('transactionsList.title')}
				</Text>
				<PeriodSelector />
			</View>

			<SectionList
				sections={sections}
				keyExtractor={(item) => item.id}
				renderItem={({ item }) =>
					item.type === 'transaction' ? (
						<TransactionItem transaction={item.transaction} onPress={openTransaction} />
					) : (
						<TransferItem transfer={item.transfer} accountsById={accountsById} />
					)
				}
				renderSectionHeader={({ section }) => (
					<View
						style={styles.dayHeader}
						accessible
						accessibilityRole="header"
						accessibilityLabel={`${section.title}, ${formatCents(section.totalCents)}`}
					>
						<Text style={styles.dayTitle}>{section.title}</Text>
						<Text style={[styles.dayTotal, section.totalCents < 0 && styles.expense]}>{formatCents(section.totalCents)}</Text>
					</View>
				)}
				ListHeaderComponent={header}
				ListEmptyComponent={empty}
				stickySectionHeadersEnabled
				contentContainerStyle={styles.content}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} colors={[ACCENT]} />
				}
				keyboardShouldPersistTaps="handled"
				initialNumToRender={12}
				maxToRenderPerBatch={12}
				windowSize={7}
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	titleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: 16,
		paddingTop: 8,
		paddingBottom: 4,
		gap: 12,
	},
	title: {
		fontSize: 26,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	header: {
		gap: 12,
		paddingBottom: 8,
	},
	totals: {
		flexDirection: 'row',
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 14,
		gap: 8,
	},
	total: {
		flex: 1,
		gap: 2,
	},
	totalLabel: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	totalValue: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	income: {
		color: INCOME,
	},
	expense: {
		color: EXPENSE,
	},
	searchRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		paddingHorizontal: 12,
	},
	search: {
		flex: 1,
		minHeight: 48,
		color: '#FFFFFF',
		fontSize: 16,
	},
	clear: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	chips: {
		flexDirection: 'row',
		gap: 8,
	},
	accountChips: {
		gap: 8,
		paddingRight: 16,
	},
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 14,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
		backgroundColor: '#1E1E1E',
	},
	chipSelected: {
		borderColor: ACCENT,
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	chipText: {
		fontSize: 15,
		color: 'rgba(255,255,255,0.85)',
		maxWidth: 160,
	},
	chipTextSelected: {
		color: ACCENT,
		fontWeight: '600',
	},
	dot: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	pressed: {
		opacity: 0.85,
	},
	count: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.6)',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 90,
		flexGrow: 1,
	},
	dayHeader: {
		flexDirection: 'row',
		alignItems: 'baseline',
		justifyContent: 'space-between',
		gap: 12,
		paddingVertical: 8,
		backgroundColor: '#121212',
	},
	dayTitle: {
		fontSize: 14,
		fontWeight: '700',
		color: 'rgba(255,255,255,0.85)',
		textTransform: 'capitalize',
	},
	dayTotal: {
		fontSize: 14,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	empty: {
		alignItems: 'center',
		justifyContent: 'center',
		gap: 12,
		paddingTop: 48,
		paddingHorizontal: 24,
	},
	emptyText: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.7)',
		textAlign: 'center',
	},
	clearFilters: {
		minHeight: 48,
		justifyContent: 'center',
		paddingHorizontal: 18,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: ACCENT,
	},
	clearFiltersText: {
		fontSize: 15,
		fontWeight: '600',
		color: ACCENT,
	},
});

export default TransactionListScreen;
