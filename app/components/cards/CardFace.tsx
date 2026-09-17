import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { Account } from '../../database/schema';
import { type CardNetwork, NETWORK_LABELS, readableTextOn } from '../../utils/bankBrands';
import type { CardSummary } from '../../utils/cardMath';
import { formatDayMonth } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';

/**
 * A face de um cartão, com a cor do banco.
 *
 * Hierarquia, de cima para baixo, pela pergunta que cada parte responde:
 *  1. **Qual cartão?** banco, apelido, bandeira e final — reconhecível de relance.
 *  2. **Quanto vou pagar?** a fatura aberta, o número grande, e quando fecha e vence.
 *  3. **Tem algo urgente?** um selo escuro para a fatura fechada em aberto ou vencida.
 *  4. **Posso gastar?** a barra do limite e o disponível.
 *
 * Acessibilidade: o texto sobre a cor é preto ou branco por contraste calculado
 * (≥ 4,5:1, testado para todas as marcas); o selo de urgência tem fundo escuro próprio
 * e ícone, então nunca depende só de cor; a face inteira é um único elemento com rótulo
 * completo, na ordem em que se lê; nada tem altura fixa, e o texto cresce com a fonte
 * do sistema.
 */

export interface CardFaceProps {
	card: Account;
	summary: CardSummary | undefined;
	onPress?: () => void;
	/** "Cartão 2 de 3", para o leitor de tela num carrossel. */
	position?: { index: number; total: number };
	style?: ViewStyle;
}

const STATUS_ICON = {
	due: 'time-outline',
	due_soon: 'alert-circle-outline',
	overdue: 'warning-outline',
} as const;

const STATUS_COLOR = {
	due: '#FFFFFF',
	due_soon: '#FFD166',
	overdue: '#FF8A80',
} as const;

export const useCardLabels = () => {
	const { t } = useTranslation();

	const closingLabel = (summary: CardSummary): string => {
		if (!summary.configured || !summary.openCycle || summary.daysToClosing === null) return t('cards.notConfigured');
		const closes =
			summary.daysToClosing === 1 ? t('cards.closesTomorrow') : t('cards.closesIn', { count: summary.daysToClosing });
		return `${closes} · ${t('cards.dueOn', { date: formatDayMonth(summary.openCycle.dueDate) })}`;
	};

	const closedLabel = (summary: CardSummary): string | null => {
		if (summary.toPayCents <= 0 || !summary.closedCycle) return null;
		const amount = formatCents(summary.toPayCents);
		if (summary.closedStatus === 'overdue') {
			return t('cards.overdue', { amount, count: Math.abs(summary.daysToDue ?? 0) });
		}
		if (summary.daysToDue === 0) return t('cards.dueToday', { amount });
		return t('cards.closedToPay', { amount, date: formatDayMonth(summary.closedCycle.dueDate) });
	};

	const availableLabel = (summary: CardSummary): string | null => {
		if (summary.limitAvailableCents === null || summary.limitCents === null) return null;
		if (summary.limitAvailableCents < 0) {
			return t('cards.overLimit', { amount: formatCents(-summary.limitAvailableCents) });
		}
		return t('cards.available', { amount: formatCents(summary.limitAvailableCents), limit: formatCents(summary.limitCents) });
	};

	return { t, closingLabel, closedLabel, availableLabel };
};

const CardFace: React.FC<CardFaceProps> = ({ card, summary, onPress, position, style }) => {
	const { t, closingLabel, closedLabel, availableLabel } = useCardLabels();
	const background = card.color;
	const ink = readableTextOn(background);
	const faint = ink === '#FFFFFF' ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';

	const bank = card.bankName ?? '';
	const showName = card.name.trim().length > 0 && card.name.trim() !== bank.trim();
	const network = card.network ? NETWORK_LABELS[card.network as CardNetwork] : null;

	const invoiceCents = summary ? Math.max(0, summary.configured ? summary.openInvoiceCents : summary.owedCents) : 0;
	const invoiceTitle = summary?.configured ? t('cards.openInvoice') : t('cards.owed');
	const closing = summary ? closingLabel(summary) : '';
	const closed = summary ? closedLabel(summary) : null;
	const available = summary ? availableLabel(summary) : null;
	const usage = summary?.limitUsagePercent ?? null;
	const status = summary && summary.toPayCents > 0 && summary.closedStatus !== 'paid' && summary.closedStatus !== 'none'
		? summary.closedStatus
		: null;

	const a11y = [
		[bank, showName ? card.name : null, card.last4 ? t('cards.endingIn', { last4: card.last4 }) : null].filter(Boolean).join(', '),
		`${invoiceTitle} ${formatCents(invoiceCents)}`,
		closing,
		closed,
		available,
		position ? t('cards.position', { index: position.index + 1, total: position.total }) : null,
	]
		.filter(Boolean)
		.join('. ');

	const content = (
		<>
			{/* Formas decorativas: dão cara de cartão, invisíveis para o leitor de tela. */}
			<View pointerEvents="none" style={[styles.orb, styles.orbLarge, { backgroundColor: faint }]} />
			<View pointerEvents="none" style={[styles.orb, styles.orbSmall, { backgroundColor: faint }]} />

			<View style={styles.topRow}>
				<View style={styles.identity}>
					<Text style={[styles.bank, { color: ink }]} numberOfLines={1}>
						{bank || card.name}
					</Text>
					{showName && bank ? (
						<Text style={[styles.nickname, { color: ink }]} numberOfLines={1}>
							{card.name}
						</Text>
					) : null}
				</View>
				{network ? <Text style={[styles.network, { color: ink }]}>{network}</Text> : null}
			</View>

			<View style={styles.middle}>
				<Text style={[styles.invoiceTitle, { color: ink }]}>{invoiceTitle}</Text>
				<Text style={[styles.invoiceValue, { color: ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
					{formatCents(invoiceCents)}
				</Text>
				<Text style={[styles.closing, { color: ink }]}>{closing}</Text>
			</View>

			{closed && status ? (
				<View style={styles.statusChip}>
					<Ionicons name={STATUS_ICON[status]} size={16} color={STATUS_COLOR[status]} />
					<Text style={[styles.statusText, { color: STATUS_COLOR[status] }]}>{closed}</Text>
				</View>
			) : null}

			{usage !== null ? (
				<View style={[styles.track, { backgroundColor: faint }]}>
					<View style={[styles.fill, { width: `${Math.min(100, Math.max(0, usage))}%`, backgroundColor: ink }]} />
				</View>
			) : null}

			<View style={styles.bottomRow}>
				<Text style={[styles.digits, { color: ink }]}>{card.last4 ? `•••• ${card.last4}` : ''}</Text>
				{available ? (
					<Text style={[styles.available, { color: ink }]} numberOfLines={2}>
						{available}
					</Text>
				) : null}
			</View>
		</>
	);

	if (!onPress) {
		return (
			<View style={[styles.face, { backgroundColor: background }, style]} accessible accessibilityLabel={a11y}>
				{content}
			</View>
		);
	}

	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={a11y}
			accessibilityHint={t('cards.openHint')}
			style={({ pressed }) => [styles.face, { backgroundColor: background }, pressed && styles.pressed, style]}
		>
			{content}
		</Pressable>
	);
};

const styles = StyleSheet.create({
	face: {
		borderRadius: 20,
		padding: 18,
		minHeight: 200,
		overflow: 'hidden',
		gap: 10,
	},
	pressed: {
		opacity: 0.85,
		transform: [{ scale: 0.99 }],
	},
	orb: {
		position: 'absolute',
		borderRadius: 999,
	},
	orbLarge: {
		width: 220,
		height: 220,
		right: -70,
		top: -90,
	},
	orbSmall: {
		width: 120,
		height: 120,
		right: 40,
		bottom: -70,
	},
	topRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		justifyContent: 'space-between',
		gap: 12,
	},
	identity: {
		flex: 1,
	},
	bank: {
		fontSize: 17,
		fontWeight: '700',
	},
	nickname: {
		fontSize: 13,
		marginTop: 1,
	},
	network: {
		fontSize: 14,
		fontWeight: '800',
		fontStyle: 'italic',
		letterSpacing: 0.5,
	},
	middle: {
		marginTop: 4,
	},
	invoiceTitle: {
		fontSize: 13,
		fontWeight: '600',
	},
	invoiceValue: {
		fontSize: 30,
		fontWeight: '800',
		marginTop: 2,
	},
	closing: {
		fontSize: 13,
		marginTop: 2,
	},
	statusChip: {
		flexDirection: 'row',
		alignItems: 'center',
		alignSelf: 'flex-start',
		gap: 6,
		paddingHorizontal: 10,
		paddingVertical: 6,
		borderRadius: 12,
		backgroundColor: 'rgba(18,18,18,0.88)',
		maxWidth: '100%',
	},
	statusText: {
		fontSize: 13,
		fontWeight: '600',
		flexShrink: 1,
	},
	track: {
		height: 6,
		borderRadius: 3,
		overflow: 'hidden',
		marginTop: 2,
	},
	fill: {
		height: 6,
		borderRadius: 3,
	},
	bottomRow: {
		flexDirection: 'row',
		alignItems: 'flex-end',
		justifyContent: 'space-between',
		gap: 12,
	},
	digits: {
		fontSize: 15,
		fontWeight: '600',
		letterSpacing: 1.5,
	},
	available: {
		flex: 1,
		fontSize: 13,
		fontWeight: '600',
		textAlign: 'right',
	},
});

export default CardFace;
