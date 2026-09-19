import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { NetWorth } from '../../utils/accountMath';
import { formatCents } from '../../utils/money';

export interface NetWorthParts {
	cashCents: number;
	savedCents: number;
	outsideCents: number;
	cardsCents: number;
	debtsCents: number;
}

/**
 * O balanço em um cartão: o patrimônio líquido em destaque e, embaixo, de onde ele vem —
 * o que se tem de um lado, o que se deve do outro. Bens (carro, imóvel) não entram, e a
 * nota no rodapé diz isso para o número não parecer um erro para quem financia um bem.
 */
const NetWorthCard: React.FC<{ worth: NetWorth; parts: NetWorthParts }> = ({ worth, parts }) => {
	const { t } = useTranslation();

	const have = [
		{ key: 'cash', label: t('netWorth.cash'), cents: parts.cashCents },
		{ key: 'saved', label: t('netWorth.saved'), cents: parts.savedCents },
		...(parts.outsideCents > 0 ? [{ key: 'outside', label: t('netWorth.outside'), cents: parts.outsideCents }] : []),
	];
	const owe = [
		{ key: 'cards', label: t('netWorth.cards'), cents: parts.cardsCents },
		{ key: 'debts', label: t('netWorth.debts'), cents: parts.debtsCents },
	];

	return (
		<View style={styles.card}>
			<View
				accessible
				accessibilityLabel={`${t('netWorth.title')}: ${formatCents(worth.netCents)}. ${t('netWorth.have')} ${formatCents(worth.assetsCents)}. ${t('netWorth.owe')} ${formatCents(worth.liabilitiesCents)}.`}
			>
				<Text style={styles.label}>{t('netWorth.title')}</Text>
				<Text style={[styles.hero, worth.netCents < 0 && styles.negative]}>{formatCents(worth.netCents)}</Text>
			</View>

			<View style={styles.columns}>
				<View style={styles.column}>
					<Text style={styles.columnTitle} accessibilityRole="header">
						{t('netWorth.have')} · {formatCents(worth.assetsCents)}
					</Text>
					{have.map((line) => (
						<View key={line.key} style={styles.line} accessible accessibilityLabel={`${line.label}: ${formatCents(line.cents)}`}>
							<Text style={styles.lineLabel} numberOfLines={2}>
								{line.label}
							</Text>
							<Text style={styles.lineValue}>{formatCents(line.cents)}</Text>
						</View>
					))}
				</View>
				<View style={styles.column}>
					<Text style={styles.columnTitle} accessibilityRole="header">
						{t('netWorth.owe')} · {formatCents(worth.liabilitiesCents)}
					</Text>
					{owe.map((line) => (
						<View key={line.key} style={styles.line} accessible accessibilityLabel={`${line.label}: ${formatCents(line.cents)}`}>
							<Text style={styles.lineLabel} numberOfLines={2}>
								{line.label}
							</Text>
							<Text style={styles.lineValue}>{formatCents(line.cents)}</Text>
						</View>
					))}
				</View>
			</View>

			<Text style={styles.note}>{t('netWorth.assetsNote')}</Text>
		</View>
	);
};

const styles = StyleSheet.create({
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 12,
	},
	label: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
	},
	hero: {
		fontSize: 32,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	negative: {
		color: '#FF6B6B',
	},
	columns: {
		flexDirection: 'row',
		gap: 16,
	},
	column: {
		flex: 1,
		gap: 6,
	},
	columnTitle: {
		fontSize: 13,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 2,
	},
	line: {
		gap: 1,
	},
	lineLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
	},
	lineValue: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	note: {
		fontSize: 12,
		lineHeight: 17,
		color: 'rgba(255,255,255,0.5)',
	},
});

export default NetWorthCard;
