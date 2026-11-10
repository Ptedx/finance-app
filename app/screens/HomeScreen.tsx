import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AccountReminderBanner from '../components/AccountReminderBanner';
import AccountsOverview from '../components/AccountsOverview';
import BillsMonthCard from '../components/bills/BillsMonthCard';
import CaptureReviewBanner from '../components/CaptureReviewBanner';
import CardsSection from '../components/cards/CardsSection';
import MonthOverviewCard from '../components/MonthOverviewCard';
import { TourTarget, useScreenTour, useTourScroll, useTourTarget } from '../components/tour/TourContext';
import TourNotice from '../components/tour/TourNotice';
import { useAccounts } from '../contexts/AccountsContext';
import { useBills } from '../contexts/BillsContext';
import { useSync } from '../contexts/SyncContext';
import { useTransactions } from '../contexts/TransactionsContext';

/**
 * Tela inicial, organizada pela ordem das perguntas de quem abre o app:
 *
 *  1. **Tem algo para eu fazer?** — lançamentos capturados esperando revisão e as
 *     contas do mês: o que vence, o que atrasou e quanto ainda falta pagar.
 *  2. **Como está o mês?** — receita, gastos por bolso, guardado, sobrou.
 *  3. **O que os cartões pedem?** — fatura aberta, o que vence, limite. Visual de
 *     carteira: a cor do banco identifica o cartão antes de qualquer texto.
 *  4. **Quanto eu tenho?** — contas, caixa e o que sobra depois das faturas.
 *  5. **O que se repete?** — recorrências, no fim, porque se mexe pouco nelas.
 *
 * O histórico de lançamentos saiu daqui: vive na aba Lançamentos, que é onde se procura
 * um lançamento. A taxa de poupança e o fôlego foram para Relatórios — o "Este mês" já
 * diz quanto da receita ficou com você.
 *
 * Acessibilidade: cada seção começa com um título marcado como cabeçalho, então o
 * leitor de tela pula de seção em seção; o botão de ajustes tem rótulo e 48 pontos.
 */
const HomeScreen = () => {
	const router = useRouter();
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();
	const { refreshData, isLoading: transactionsLoading } = useTransactions();
	const { refresh: refreshAccounts, isLoading: accountsLoading } = useAccounts();
	const { refresh: refreshBills } = useBills();
	const { syncNow } = useSync();
	const [refreshing, setRefreshing] = useState(false);
	// O guia da tela inicial (SPD-129): abre depois de carregar; os alvos estão marcados abaixo
	// e na barra de abas.
	useScreenTour('home', { ready: !transactionsLoading && !accountsLoading });
	const tourScroll = useTourScroll('home');
	const settingsTarget = useTourTarget('home.settings');

	// Abrir ou puxar a Início não lança mais as recorrências antigas (SPD-113): o `[Auto]`
	// virava gasto dobrado quando a cobrança de verdade chegava.
	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refreshData();
			await refreshAccounts();
			await refreshBills();
			// Puxar para atualizar também alinha com o servidor, quando há sessão.
			syncNow();
		} catch (error) {
			console.error('Error during refresh:', error);
		} finally {
			setRefreshing(false);
		}
	}, [refreshData, refreshAccounts, refreshBills, syncNow]);

	return (
		<View style={styles.container}>
			<StatusBar barStyle="light-content" />

			<View style={[styles.header, { paddingTop: Math.max(insets.top, 16) + 12 }]}>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('home.title')}
				</Text>
				<Pressable
					{...settingsTarget}
					onPress={() => router.push({ pathname: '/settings' })}
					accessibilityRole="button"
					accessibilityLabel={t('tabs.settings')}
					style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
				>
					<Ionicons name="settings-outline" size={24} color="#FFFFFF" />
				</Pressable>
			</View>

			<ScrollView
				ref={tourScroll}
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#15E8FE" colors={['#15E8FE']} />
				}
			>
				<TourNotice />
				<AccountReminderBanner />
				<CaptureReviewBanner />
				<TourTarget id="home.bills">
					<BillsMonthCard />
				</TourTarget>
				<TourTarget id="home.month">
					<MonthOverviewCard />
				</TourTarget>
				<CardsSection />
				<AccountsOverview />
			</ScrollView>
		</View>
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
		justifyContent: 'space-between',
		paddingHorizontal: 16,
		paddingBottom: 12,
	},
	headerTitle: {
		fontSize: 28,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	iconButton: {
		width: 48,
		height: 48,
		borderRadius: 24,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pressed: {
		opacity: 0.6,
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
});

export default HomeScreen;
