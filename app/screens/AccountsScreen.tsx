import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AccountRow, useDismissedBalanceUnset } from '../components/AccountsOverview';
import HelpButton from '../components/tour/HelpButton';
import { TourTarget, useScreenTour, useTourScroll, useTourTarget } from '../components/tour/TourContext';
import { useAccounts } from '../contexts/AccountsContext';
import type { Account } from '../database/schema';
import { type DuplicateAccounts, duplicateAccountPairs } from '../utils/accountBinding';
import { showsBalanceUnset } from '../utils/balanceUnset';
import { getBusinessFeeds } from '../utils/businessFeedPreference';
import { getDistinctAccountPairs, markAccountsDistinct } from '../utils/distinctAccounts';
import { formatCents } from '../utils/money';

/**
 * Gerenciar contas (cartões têm tela própria): a lista completa, inclusive as arquivadas, e o botão de
 * adicionar. Tocar numa conta abre a edição, onde fica o "definir saldo".
 */

const ACCENT = '#15E8FE';

const AccountsScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, balances, overview, provisionalOverview, mergeAccounts, autoMergeNotices, dismissAutoMergeNotices } = useAccounts();

	// "Em caixa" e "Depois das faturas" já contam as compras a revisar, como na Home.
	const pendingOf = (cents: number) =>
		cents !== 0 ? t('cards.pendingIncluded', { amount: formatCents(Math.abs(cents)), defaultValue: 'Inclui {{amount}} a revisar' }) : null;
	const cashPending = pendingOf(provisionalOverview.cashCents);
	const netPending = pendingOf(provisionalOverview.netCents);

	// Só contas: cartões vivem em /cards.
	const bankOnly = accounts.filter((account) => account.kind !== 'credit_card');
	const active = bankOnly.filter((account) => !account.archived);
	const archived = bankOnly.filter((account) => account.archived);
	const openAccount = (account: Account) =>
		router.push({ pathname: '/accounts/[id]', params: { id: account.id } });

	/**
	 * Duas fichas da mesma conta do banco mostram metade do dinheiro cada uma, e o que o
	 * banco avisa cai só numa delas. O aviso aparece aqui porque é a tela onde as duas
	 * estão lado a lado — quem escolhe qual fica é o usuário, não o app. PF e PJ do mesmo
	 * banco também parecem par; "são contas diferentes" tira o aviso daquele par (SPD-072).
	 */
	const [distinct, setDistinct] = useState<string[]>([]);
	// A conta dos avisos da PJ (SPD-074) também recebe avisos: com ela, PF e PJ não são par.
	const [businessFed, setBusinessFed] = useState<string[]>([]);
	// No foco: a resposta dada em outro aparelho chega pelo sync enquanto esta tela está fechada.
	useFocusEffect(
		useCallback(() => {
			void getDistinctAccountPairs().then(setDistinct);
			void getBusinessFeeds().then((feeds) => setBusinessFed(Object.values(feeds)));
		}, [])
	);
	const duplicates = duplicateAccountPairs(accounts, distinct, businessFed);
	// "Saldo não informado" (SPD-114): a conta que a captura criou com saldo 0, até ser acertada.
	const dismissedBalanceUnset = useDismissedBalanceUnset();
	// A trilha de Contas (SPD-131) passa por aqui; "?" ao lado do título.
	useScreenTour('accounts');
	const tourScroll = useTourScroll('accounts');
	const totalsTarget = useTourTarget('accounts.totals');
	const addTarget = useTourTarget('accounts.add');
	// A conta ligada ao app de um banco (Trilha 6, "conta arquivada").
	const linkedId = bankOnly.find((account) => account.packageName !== null)?.id;

	/**
	 * "Juntamos X em Y" (SPD-116): a ficha duplicada vazia que o app juntou sozinho. Aparece
	 * aqui, no lugar do aviso de duplicadas que ela teria disparado, e uma vez só: sai ao tocar
	 * em "Entendi" ou ao deixar a tela. Não bloqueia nada — a lista continua embaixo.
	 */
	const noticesShown = useRef(false);
	noticesShown.current = autoMergeNotices.length > 0;
	useFocusEffect(
		useCallback(
			() => () => {
				if (noticesShown.current) dismissAutoMergeNotices();
			},
			[dismissAutoMergeNotices]
		)
	);

	const keepBoth = (pair: DuplicateAccounts) => {
		void markAccountsDistinct(pair.fed.id, pair.loose.id).then(setDistinct);
	};

	const askMerge = (pair: DuplicateAccounts) => {
		Alert.alert(
			t('accounts.duplicate.title'),
			t('accounts.duplicate.confirm', { fed: pair.fed.name, loose: pair.loose.name }),
			[
				{ text: t('accounts.duplicate.cancel'), style: 'cancel' },
				{
					text: t('accounts.duplicate.keep', { name: pair.fed.name }),
					onPress: () => {
						void mergeAccounts(pair.loose.id, pair.fed.id);
					},
				},
				{
					text: t('accounts.duplicate.keep', { name: pair.loose.name }),
					onPress: () => {
						void mergeAccounts(pair.fed.id, pair.loose.id);
					},
				},
			]
		);
	};

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
				<HelpButton trail="accounts" here={{ screen: 'accounts' }} />
			</View>

			<ScrollView ref={tourScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View
					{...totalsTarget}
					style={styles.totals}
					accessible
					accessibilityLabel={`${t('accounts.cash')} ${formatCents(overview.cashCents)}${cashPending ? `, ${cashPending}` : ''}. ${t('accounts.afterCards')} ${formatCents(overview.netCents)}${netPending ? `, ${netPending}` : ''}`}
				>
					<Text style={styles.totalsLine}>
						{t('accounts.cash')}: {formatCents(overview.cashCents)}
					</Text>
					{cashPending ? <Text style={styles.totalsPending}>{cashPending}</Text> : null}
					<Text style={[styles.totalsLine, styles.totalsNet]}>
						{t('accounts.afterCards')}: {formatCents(overview.netCents)}
					</Text>
					{netPending ? <Text style={styles.totalsPending}>{netPending}</Text> : null}

				</View>

				{autoMergeNotices.length > 0 && (
					<View style={styles.merged} accessibilityLiveRegion="polite">
						{autoMergeNotices.map((notice) => (
							<View key={`${notice.from}|${notice.into}`} style={styles.mergedItem}>
								<Text style={styles.mergedTitle} accessibilityRole="header">
									{t('accounts.duplicate.autoMerged', { from: notice.from, into: notice.into })}
								</Text>
								<Text style={styles.mergedBody}>
									{t('accounts.duplicate.autoMergedBody', { from: notice.from, into: notice.into })}
								</Text>
							</View>
						))}
						<Pressable
							onPress={dismissAutoMergeNotices}
							accessibilityRole="button"
							accessibilityLabel={t('accounts.duplicate.autoMergedOk')}
							style={({ pressed }) => [styles.mergedButton, pressed && styles.pressed]}
						>
							<Text style={styles.mergedButtonText}>{t('accounts.duplicate.autoMergedOk')}</Text>
						</Pressable>
					</View>
				)}

				{duplicates.map((pair, index) => (
					<TourTarget key={pair.loose.id} id={index === 0 ? 'accounts.duplicate' : undefined} style={styles.duplicate}>
						<Text style={styles.duplicateTitle} accessibilityRole="header">
							{t('accounts.duplicate.title')}
						</Text>
						<Text style={styles.duplicateBody}>
							{t('accounts.duplicate.body', { fed: pair.fed.name, loose: pair.loose.name })}
						</Text>
						<Pressable
							onPress={() => askMerge(pair)}
							accessibilityRole="button"
							accessibilityLabel={t('accounts.duplicate.action')}
							accessibilityHint={t('accounts.duplicate.hint')}
							style={({ pressed }) => [styles.duplicateButton, pressed && styles.pressed]}
						>
							<Ionicons name="git-merge-outline" size={18} color="#000000" />
							<Text style={styles.duplicateButtonText}>{t('accounts.duplicate.action')}</Text>
						</Pressable>
						<Pressable
							onPress={() => keepBoth(pair)}
							accessibilityRole="button"
							accessibilityLabel={t('accounts.duplicate.distinct')}
							accessibilityHint={t('accounts.duplicate.distinctHint')}
							style={({ pressed }) => [styles.duplicateButton, styles.duplicateSecondary, pressed && styles.pressed]}
						>
							<Text style={styles.duplicateButtonText}>{t('accounts.duplicate.distinct')}</Text>
						</Pressable>
					</TourTarget>
				))}

				<Pressable
					{...addTarget}
					onPress={() => router.push('/accounts/new')}
					accessibilityRole="button"
					accessibilityLabel={t('accounts.add')}
					style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
				>
					<Ionicons name="add" size={20} color="#000000" />
					<Text style={styles.addButtonText}>{t('accounts.add')}</Text>
				</Pressable>

				{active.length === 0 && (
					<TourTarget id="accounts.empty">
						<Text style={styles.empty}>{t('accounts.empty')}</Text>
					</TourTarget>
				)}

				<View style={styles.list}>
					{active.map((account) => (
						<TourTarget key={account.id} id={account.id === linkedId ? 'accounts.linked' : undefined}>
							<AccountRow
								account={account}
								balanceCents={balances.get(account.id) ?? account.openingBalanceCents}
								balanceUnset={showsBalanceUnset(account, dismissedBalanceUnset)}
								onPress={openAccount}
							/>
						</TourTarget>
					))}
				</View>

				{archived.length > 0 && (
					<View style={styles.list}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('accounts.archived')}
						</Text>
						{archived.map((account) => (
							<TourTarget key={account.id} id={account.id === linkedId ? 'accounts.linked' : undefined}>
								<AccountRow
									account={account}
									balanceCents={balances.get(account.id) ?? account.openingBalanceCents}
									onPress={openAccount}
								/>
							</TourTarget>
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
	totalsPending: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.6)',
	},
	duplicate: {
		backgroundColor: '#FFB74D',
		borderRadius: 12,
		padding: 16,
		marginBottom: 12,
		gap: 8,
	},
	duplicateTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#000000',
	},
	duplicateBody: {
		fontSize: 14,
		lineHeight: 20,
		color: '#000000',
	},
	duplicateButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: '#FFFFFF',
	},
	duplicateSecondary: {
		backgroundColor: 'transparent',
		borderWidth: 1,
		borderColor: '#000000',
	},
	duplicateButtonText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#000000',
	},
	merged: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		borderWidth: 1,
		borderColor: ACCENT,
		padding: 16,
		marginBottom: 12,
		gap: 12,
	},
	mergedItem: {
		gap: 4,
	},
	mergedTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	mergedBody: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.85)',
	},
	mergedButton: {
		alignItems: 'center',
		justifyContent: 'center',
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
	},
	mergedButtonText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#000000',
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
