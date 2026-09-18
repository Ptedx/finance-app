import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
	type ViewToken,
} from 'react-native';
import { type DebitCard, useAccounts } from '../../contexts/AccountsContext';
import { usePeriod } from '../../contexts/PeriodContext';
import { getMonthName } from '../../utils/dateUtils';
import type { Account } from '../../database/schema';
import { formatCents } from '../../utils/money';
import CardFace from './CardFace';
import DebitCardFace from './DebitCardFace';

/**
 * "Cartões" na tela inicial: os cartões como na carteira, um ao lado do outro.
 *
 * Por que carrossel aqui, e lista nas contas: cartão é identidade visual (a cor do
 * banco é como se reconhece), e a face precisa de espaço para fatura, prazo e limite.
 * O carrossel mostra um cartão inteiro e a borda do próximo — a borda é o convite para
 * deslizar. Para quem não desliza bem, "Ver todos" abre a mesma coisa em lista.
 *
 * Acima dos cartões, o que importa sem abrir nenhum: quanto há para pagar agora, quanto
 * as faturas abertas somam, e o limite disponível.
 *
 * Acessibilidade: cada face é um botão com rótulo completo e "cartão 2 de 3"; os pontos
 * de paginação são decorativos e ficam fora do leitor de tela; no TalkBack e no
 * VoiceOver o gesto de próximo item percorre os cartões e rola a lista sozinho.
 */

const GUTTER = 16;
const GAP = 12;
const PEEK = 28;
const ACCENT = '#15E8FE';

type Item = { type: 'card'; card: Account } | { type: 'debit'; card: DebitCard } | { type: 'add' };

const CardsSection: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { width } = useWindowDimensions();
	const { creditCards, debitCards, cardSummaries, cardsTotals, isLoading } = useAccounts();
	const { selectedMonth } = usePeriod();
	const [activeIndex, setActiveIndex] = useState(0);

	const cardWidth = Math.max(260, width - GUTTER * 2 - PEEK);
	// Crédito primeiro (é onde há fatura e prazo), depois os de débito, que só mostram o gasto.
	const items: Item[] = [
		...creditCards.map((card) => ({ type: 'card' as const, card })),
		...debitCards.map((card) => ({ type: 'debit' as const, card })),
		{ type: 'add' },
	];
	const cardCount = creditCards.length + debitCards.length;

	const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
		const first = viewableItems.find((item) => item.isViewable);
		if (first?.index !== undefined && first.index !== null) setActiveIndex(first.index);
	}).current;

	const openCard = useCallback(
		(card: Account) => router.push({ pathname: '/cards/[id]', params: { id: card.id } }),
		[router]
	);

	if (isLoading) return null;

	const hasCards = cardCount > 0;

	return (
		<View style={styles.section}>
			<View style={styles.header}>
				<Text style={styles.title} accessibilityRole="header">
					{t('cards.sectionTitle')}
				</Text>
				{hasCards ? (
					<Pressable
						onPress={() => router.push('/cards/index')}
						accessibilityRole="button"
						accessibilityLabel={t('cards.seeAll')}
						hitSlop={12}
						style={styles.link}
					>
						<Text style={styles.linkText}>{t('cards.seeAll')}</Text>
					</Pressable>
				) : null}
			</View>

			{creditCards.length > 0 ? (
				<View
					style={styles.totals}
					accessible
					accessibilityLabel={[
						cardsTotals.toPayCents > 0 ? `${t('cards.toPayNow')} ${formatCents(cardsTotals.toPayCents)}` : null,
						`${t('cards.openInvoices')} ${formatCents(cardsTotals.openInvoicesCents)}`,
						cardsTotals.limitAvailableCents !== null
							? `${t('cards.limitAvailable')} ${formatCents(cardsTotals.limitAvailableCents)}`
							: null,
					]
						.filter(Boolean)
						.join('. ')}
				>
					{cardsTotals.toPayCents > 0 ? (
						<View style={styles.total}>
							<Text style={styles.totalLabel}>{t('cards.toPayNow')}</Text>
							<Text style={[styles.totalValue, styles.warning]}>{formatCents(cardsTotals.toPayCents)}</Text>
						</View>
					) : null}
					<View style={styles.total}>
						<Text style={styles.totalLabel}>{t('cards.openInvoices')}</Text>
						<Text style={styles.totalValue}>{formatCents(cardsTotals.openInvoicesCents)}</Text>
					</View>
					{cardsTotals.limitAvailableCents !== null ? (
						<View style={styles.total}>
							<Text style={styles.totalLabel}>{t('cards.limitAvailable')}</Text>
							<Text style={[styles.totalValue, cardsTotals.limitAvailableCents < 0 && styles.danger]}>
								{formatCents(cardsTotals.limitAvailableCents)}
							</Text>
						</View>
					) : null}
				</View>
			) : null}

			{hasCards ? (
				<>
					<FlatList
						data={items}
						horizontal
						keyExtractor={(item) => (item.type === 'card' ? item.card.id : item.type === 'debit' ? item.card.key : 'add')}
						showsHorizontalScrollIndicator={false}
						snapToInterval={cardWidth + GAP}
						snapToAlignment="start"
						decelerationRate="fast"
						disableIntervalMomentum
						contentContainerStyle={styles.carousel}
						style={styles.bleed}
						onViewableItemsChanged={onViewable}
						viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
						renderItem={({ item, index }) =>
							item.type === 'card' ? (
								<CardFace
									card={item.card}
									summary={cardSummaries.get(item.card.id)}
									onPress={() => openCard(item.card)}
									position={{ index, total: cardCount }}
									style={{ width: cardWidth, marginRight: GAP }}
								/>
							) : item.type === 'debit' ? (
								<DebitCardFace
									card={item.card}
									monthLabel={getMonthName(selectedMonth)}
									position={{ index, total: cardCount }}
									style={{ width: cardWidth, marginRight: GAP }}
									onPress={() =>
										router.push({
											pathname: '/cards/debit/[accountId]/[last4]',
											params: { accountId: item.card.account.id, last4: item.card.last4 },
										})
									}
								/>
							) : (
								<Pressable
									onPress={() => router.push('/cards/new')}
									accessibilityRole="button"
									accessibilityLabel={t('cards.add')}
									style={({ pressed }) => [styles.addTile, { width: cardWidth }, pressed && styles.pressed]}
								>
									<Ionicons name="add-circle-outline" size={32} color={ACCENT} />
									<Text style={styles.addTileText}>{t('cards.add')}</Text>
								</Pressable>
							)
						}
					/>
					<View style={styles.dots} accessible={false} importantForAccessibility="no-hide-descendants">
						{items.map((item, index) => (
							<View
								key={item.type === 'card' ? item.card.id : item.type === 'debit' ? item.card.key : 'add'}
								style={[styles.dot, index === activeIndex && styles.dotActive]}
							/>
						))}
					</View>
				</>
			) : (
				<Pressable
					onPress={() => router.push('/cards/new')}
					accessibilityRole="button"
					accessibilityLabel={`${t('cards.add')}. ${t('cards.emptyBody')}`}
					style={({ pressed }) => [styles.emptyTile, pressed && styles.pressed]}
				>
					<Ionicons name="card-outline" size={28} color={ACCENT} />
					<Text style={styles.emptyTitle}>{t('cards.add')}</Text>
					<Text style={styles.emptyBody}>{t('cards.emptyBody')}</Text>
				</Pressable>
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	section: {
		marginBottom: 24,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: 10,
	},
	title: {
		fontSize: 20,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	link: {
		minHeight: 44,
		justifyContent: 'center',
	},
	linkText: {
		fontSize: 15,
		fontWeight: '600',
		color: ACCENT,
	},
	totals: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
		marginBottom: 12,
	},
	total: {
		flexGrow: 1,
		flexBasis: 100,
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		paddingVertical: 10,
		paddingHorizontal: 12,
	},
	totalLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.75)',
		marginBottom: 2,
	},
	totalValue: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	warning: {
		color: '#FFD166',
	},
	danger: {
		color: '#FF8A80',
	},
	bleed: {
		marginHorizontal: -GUTTER,
	},
	carousel: {
		paddingHorizontal: GUTTER,
	},
	addTile: {
		minHeight: 200,
		borderRadius: 20,
		borderWidth: 2,
		borderStyle: 'dashed',
		borderColor: 'rgba(21,232,254,0.5)',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
	},
	addTileText: {
		fontSize: 16,
		fontWeight: '600',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.8,
	},
	dots: {
		flexDirection: 'row',
		justifyContent: 'center',
		gap: 6,
		marginTop: 12,
	},
	dot: {
		width: 6,
		height: 6,
		borderRadius: 3,
		backgroundColor: 'rgba(255,255,255,0.3)',
	},
	dotActive: {
		width: 18,
		backgroundColor: '#FFFFFF',
	},
	emptyTile: {
		borderRadius: 20,
		borderWidth: 2,
		borderStyle: 'dashed',
		borderColor: 'rgba(21,232,254,0.5)',
		padding: 20,
		gap: 6,
		alignItems: 'flex-start',
	},
	emptyTitle: {
		fontSize: 17,
		fontWeight: '700',
		color: ACCENT,
	},
	emptyBody: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.8)',
	},
});

export default CardsSection;
