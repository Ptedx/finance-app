import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AccountRow } from '../components/AccountsOverview';
import { useAccounts } from '../contexts/AccountsContext';
import type { Account } from '../database/schema';
import { formatCents } from '../utils/money';

/**
 * Gerenciar contas (cartões têm tela própria): a lista completa, inclusive as arquivadas, e o botão de
 * adicionar. Tocar numa conta abre a edição, onde fica o "definir saldo".
 */

const ACCENT = '#15E8FE';

const AccountsScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, balances, overview } = useAccounts();

	// Só contas: cartões vivem em /cards.
	const bankOnly = accounts.filter((account) => account.kind !== 'credit_card');
	const active = bankOnly.filter((account) => !account.archived);
	const archived = bankOnly.filter((account) => account.archived);
	const openAccount = (account: Account) =>
		router.push({ pathname: '/accounts/[id]', params: { id: account.id } });

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('accounts.back')}
					hitSlop={12}
					style={styles.backButton}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('accounts.screenTitle')}
				</Text>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View
					style={styles.totals}
					accessible
					accessibilityLabel={`${t('accounts.cash')} ${formatCents(overview.cashCents)}. ${t('accounts.afterCards')} ${formatCents(overview.netCents)}`}
				>
					<Text style={styles.totalsLine}>
						{t('accounts.cash')}: {formatCents(overview.cashCents)}
					</Text>
					<Text style={[styles.totalsLine, styles.totalsNet]}>
						{t('accounts.afterCards')}: {formatCents(overview.netCents)}
					</Text>

				</View>

				<Pressable
					onPress={() => router.push('/accounts/new')}
					accessibilityRole="button"
					accessibilityLabel={t('accounts.add')}
					style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
				>
					<Ionicons name="add" size={20} color="#000000" />
					<Text style={styles.addButtonText}>{t('accounts.add')}</Text>
				</Pressable>

				{active.length === 0 && <Text style={styles.empty}>{t('accounts.empty')}</Text>}

				<View style={styles.list}>
					{active.map((account) => (
						<AccountRow
							key={account.id}
							account={account}
							balanceCents={balances.get(account.id) ?? account.openingBalanceCents}
							onPress={openAccount}
						/>
					))}
				</View>

				{archived.length > 0 && (
					<View style={styles.list}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('accounts.archived')}
						</Text>
						{archived.map((account) => (
							<AccountRow
								key={account.id}
								account={account}
								balanceCents={balances.get(account.id) ?? account.openingBalanceCents}
								onPress={openAccount}
							/>
						))}
					</View>
				)}
			</ScrollView>
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
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 24,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	totals: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 12,
		gap: 4,
	},
	totalsLine: {
		fontSize: 15,
		color: 'rgba(255,255,255,0.85)',
	},
	totalsNet: {
		fontWeight: '700',
		color: '#FFFFFF',
	},
	addButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		marginBottom: 12,
	},
	addButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
	empty: {
		fontSize: 15,
		lineHeight: 21,
		color: 'rgba(255,255,255,0.75)',
		marginVertical: 12,
	},
	list: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: 4,
		marginBottom: 12,
	},
	sectionTitle: {
		fontSize: 14,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.7)',
		paddingTop: 10,
	},
});

export default AccountsScreen;
