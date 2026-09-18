import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AccountReminderBanner from '../components/AccountReminderBanner';
import AccountsOverview from '../components/AccountsOverview';
import CaptureReviewBanner from '../components/CaptureReviewBanner';
import CardsSection from '../components/cards/CardsSection';
import IncomeSection from '../components/IncomeSection';
import MonthOverviewCard from '../components/MonthOverviewCard';
import { useAccounts } from '../contexts/AccountsContext';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { useSync } from '../contexts/SyncContext';
import { useTransactions } from '../contexts/TransactionsContext';

/**
 * Tela inicial, organizada pela ordem das perguntas de quem abre o app:
 *
 *  1. **Tem algo para eu fazer?** — lançamentos capturados esperando revisão.
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
	const { refreshData } = useTransactions();
	const { refresh: refreshAccounts } = useAccounts();
	const { processTransactions } = useRecurringTransactions();
	const { syncNow } = useSync();
	const [refreshing, setRefreshing] = useState(false);

	// Recorrências vencidas são lançadas uma vez, ao abrir.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		processTransactions().catch((error) => console.error('Failed to process recurring transactions:', error));
	}, []);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await processTransactions();
			await refreshData();
			await refreshAccounts();
			// Puxar para atualizar também alinha com o servidor, quando há sessão.
			syncNow();
		} catch (error) {
			console.error('Error during refresh:', error);
		} finally {
			setRefreshing(false);
		}
	}, [refreshData, refreshAccounts, processTransactions, syncNow]);

	return (
		<View style={styles.container}>
			<StatusBar barStyle="light-content" />

			<View style={[styles.header, { paddingTop: Math.max(insets.top, 16) + 12 }]}>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('home.title')}
				</Text>
				<Pressable
					onPress={() => router.push({ pathname: '/settings' })}
					accessibilityRole="button"
					accessibilityLabel={t('tabs.settings')}
					style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
				>
					<Ionicons name="settings-outline" size={24} color="#FFFFFF" />
				</Pressable>
			</View>

			<ScrollView
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#15E8FE" colors={['#15E8FE']} />
				}
			>
				<AccountReminderBanner />
				<CaptureReviewBanner />
				<MonthOverviewCard />
				<CardsSection />
				<AccountsOverview />
				<IncomeSection />
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
