import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CardFace from '../components/cards/CardFace';
import { Button } from '../components/cards/formParts';
import { useAccounts } from '../contexts/AccountsContext';
import { formatCents } from '../utils/money';

/**
 * Todos os cartões, um abaixo do outro. É a alternativa ao carrossel da tela inicial
 * para quem prefere rolar na vertical, e o lugar dos cartões arquivados.
 */
const CardsScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, creditCards, cardSummaries, cardsTotals } = useAccounts();
	const archived = accounts.filter((account) => account.kind === 'credit_card' && account.archived);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={styles.header}>
				<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('cards.back')} style={styles.iconButton}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('cards.sectionTitle')}
				</Text>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				{creditCards.length > 0 ? (
					<View
						style={styles.totals}
						accessible
						accessibilityLabel={`${t('cards.toPayNow')} ${formatCents(cardsTotals.toPayCents)}. ${t('cards.openInvoices')} ${formatCents(cardsTotals.openInvoicesCents)}`}
					>
						<Text style={styles.totalsLine}>
							{t('cards.toPayNow')}: {formatCents(cardsTotals.toPayCents)}
						</Text>
						<Text style={styles.totalsLine}>
							{t('cards.openInvoices')}: {formatCents(cardsTotals.openInvoicesCents)}
						</Text>
						{cardsTotals.limitAvailableCents !== null ? (
							<Text style={styles.totalsLine}>
								{t('cards.limitAvailable')}: {formatCents(cardsTotals.limitAvailableCents)}
							</Text>
						) : null}
					</View>
				) : (
					<Text style={styles.empty}>{t('cards.emptyBody')}</Text>
				)}

				<Button label={t('cards.add')} icon="add" onPress={() => router.push('/cards/new')} />

				{creditCards.map((card, index) => (
					<CardFace
						key={card.id}
						card={card}
						summary={cardSummaries.get(card.id)}
						position={{ index, total: creditCards.length }}
						onPress={() => router.push({ pathname: '/cards/[id]', params: { id: card.id } })}
					/>
				))}

				{archived.length > 0 ? (
					<>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.archived')}
						</Text>
						{archived.map((card) => (
							<CardFace
								key={card.id}
								card={card}
								summary={cardSummaries.get(card.id)}
								onPress={() => router.push({ pathname: '/cards/[id]', params: { id: card.id } })}

							/>
						))}
					</>
				) : null}
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
	totals: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
		gap: 4,
	},
	totalsLine: {
		fontSize: 15,
		color: '#FFFFFF',
	},
	empty: {
		fontSize: 15,
		lineHeight: 21,
		color: 'rgba(255,255,255,0.8)',
	},
	sectionTitle: {
		fontSize: 16,
		fontWeight: '700',
		color: 'rgba(255,255,255,0.8)',
		marginTop: 8,
	},
});

export default CardsScreen;
