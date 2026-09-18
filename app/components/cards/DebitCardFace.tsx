import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { DebitCard } from '../../contexts/AccountsContext';
import { brandFor, readableTextOn } from '../../utils/bankBrands';
import { formatCents } from '../../utils/money';

/**
 * Face de um cartão de débito. Mesma família visual do cartão de crédito (a cor do banco),
 * mas sem fatura nem limite: o número grande é o que o cartão gastou no mês, e a linha de
 * baixo diz de qual conta o dinheiro sai — é isso que distingue débito de crédito de
 * relance, além da palavra "Débito" no canto.
 */
const DebitCardFace: React.FC<{
	card: DebitCard;
	monthLabel: string;
	onPress: () => void;
	position?: { index: number; total: number };
	style?: StyleProp<ViewStyle>;
}> = ({ card, monthLabel, onPress, position, style }) => {
	const { t } = useTranslation();
	const background = brandFor(card.account.bankName)?.color ?? card.account.color;
	const ink = readableTextOn(background);
	const faint = ink === '#FFFFFF' ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
	const title = card.name ?? t('cards.finalLabel', { last4: card.last4 });
	const spent = formatCents(card.periodSpentCents);

	const a11y = [
		`${title}, ${t('cards.debit.label')}`,
		t('cards.debit.spentIn', { month: monthLabel, amount: spent }),
		t('cards.debit.from', { account: card.account.name }),
		t('cards.endingIn', { last4: card.last4 }),
		position ? t('cards.position', { index: position.index + 1, total: position.total }) : null,
	]
		.filter(Boolean)
		.join('. ');

	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={a11y}
			accessibilityHint={t('cards.debit.openHint')}
			style={({ pressed }) => [styles.face, { backgroundColor: background }, pressed && styles.pressed, style]}
		>
			<View pointerEvents="none" style={[styles.orb, { backgroundColor: faint }]} />
			<View style={styles.topRow}>
				<View style={styles.flex}>
					<Text style={[styles.bank, { color: ink }]} numberOfLines={1}>
						{card.account.bankName ?? card.account.name}
					</Text>
					<Text style={[styles.name, { color: ink }]} numberOfLines={1}>
						{title}
					</Text>
				</View>
				<Text style={[styles.kind, { color: ink }]}>{t('cards.debit.label')}</Text>
			</View>

			<View>
				<Text style={[styles.caption, { color: ink }]}>{t('cards.debit.spentTitle', { month: monthLabel })}</Text>
				<Text style={[styles.value, { color: ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
					{spent}
				</Text>
				<Text style={[styles.caption, { color: ink }]}>{t('cards.debit.from', { account: card.account.name })}</Text>
			</View>

			<Text style={[styles.digits, { color: ink }]}>•••• {card.last4}</Text>
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
		justifyContent: 'space-between',
	},
	pressed: {
		opacity: 0.85,
		transform: [{ scale: 0.99 }],
	},
	orb: {
		position: 'absolute',
		width: 200,
		height: 200,
		borderRadius: 999,
		left: -60,
		bottom: -110,
	},
	topRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 12,
	},
	flex: {
		flex: 1,
	},
	bank: {
		fontSize: 17,
		fontWeight: '700',
	},
	name: {
		fontSize: 13,
		marginTop: 1,
	},
	kind: {
		fontSize: 13,
		fontWeight: '800',
		letterSpacing: 1,
		textTransform: 'uppercase',
	},
	caption: {
		fontSize: 13,
	},
	value: {
		fontSize: 30,
		fontWeight: '800',
		marginVertical: 2,
	},
	digits: {
		fontSize: 17,
		fontWeight: '700',
		letterSpacing: 2,
	},
});

export default DebitCardFace;
