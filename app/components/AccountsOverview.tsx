import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type CardStatus, useAccounts } from '../contexts/AccountsContext';
import type { Account } from '../database/schema';
import { limitUsagePercent } from '../utils/accountMath';
import { formatCents } from '../utils/money';
import { ACCOUNT_KIND_ICONS } from './AccountPicker';

/**
 * "Contas e cartões" na tela inicial.
 *
 * Três números no topo (em caixa, cartões a pagar, líquido) e uma linha por conta.
 * Cartão mostra o que deve e, quando tem dia de fechamento, a fatura aberta e quanto
 * falta para fechar — a informação que muda a decisão de gastar hoje ou amanhã.
 *
 * Desenho: lista vertical, não carrossel. Carrossel esconde contas e é ruim para o
 * leitor de tela; a lista lê de cima a baixo e cada linha é um botão de 56 pontos com
 * rótulo completo. Vermelho e verde nunca são a única pista: o texto diz "a pagar" e
 * o sinal aparece no número.
 */

const ACCENT = '#15E8FE';

interface AccountRowProps {
	account: Account;
	balanceCents: number;
	card: CardStatus | undefined;
	onPress: (account: Account) => void;
}

export const AccountRow: React.FC<AccountRowProps> = ({ account, balanceCents, card, onPress }) => {
	const { t } = useTranslation();
	const isCard = account.kind === 'credit_card';
	const owed = card?.owedCents ?? Math.max(0, -balanceCents);
	const percent = isCard ? limitUsagePercent(owed, account.creditLimitCents) : null;

	const primary = isCard
		? owed > 0
			? formatCents(owed)
			: balanceCents > 0
				? `+ ${formatCents(balanceCents)}`
				: formatCents(0)
		: `${balanceCents < 0 ? '− ' : ''}${formatCents(Math.abs(balanceCents))}`;
	const primaryLabel = isCard ? (owed > 0 ? t('accounts.owed') : t('accounts.credit')) : t('accounts.balance');

	let secondary = t(`accounts.kind.${account.kind}`);
	if (isCard && card) {
		const closing =
			card.cycle.daysToClosing === 0
				? t('accounts.closesToday')
				: t('accounts.closesIn', { count: card.cycle.daysToClosing });
		secondary = `${t('accounts.openInvoice')} ${formatCents(card.openInvoiceCents)} · ${closing}`;
	}

	const summary = isCard
		? t('accounts.cardSummary', {
				name: account.name,
				owed: formatCents(owed),
				invoice: card ? formatCents(card.openInvoiceCents) : formatCents(0),
			})
		: t('accounts.accountSummary', { name: account.name, balance: primary });

	return (
		<Pressable
			onPress={() => onPress(account)}
			accessibilityRole="button"
			accessibilityLabel={`${summary}. ${secondary}`}
			accessibilityHint={t('accounts.accountHint')}
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
		>
			<View style={[styles.icon, { backgroundColor: account.color }]}>
				<Ionicons name={ACCOUNT_KIND_ICONS[account.kind]} size={20} color="#000000" />
			</View>
			<View style={styles.info}>
				<Text style={styles.name} numberOfLines={1}>
					{account.name}
				</Text>
				<Text style={styles.secondary} numberOfLines={1}>
					{secondary}
				</Text>
				{percent !== null && (
					<View style={styles.limitTrack} accessible={false}>
						<View style={[styles.limitFill, { width: `${Math.min(100, percent)}%`, backgroundColor: percent >= 90 ? '#FF6B6B' : account.color }]} />
					</View>
				)}
			</View>
			<View style={styles.amounts}>
				<Text style={[styles.amount, isCard && owed > 0 ? styles.owed : balanceCents < 0 ? styles.owed : styles.positive]}>
					{primary}
				</Text>
				<Text style={styles.amountLabel}>
					{primaryLabel}
					{percent !== null ? ` · ${t('accounts.limitUsed', { percent })}` : ''}
				</Text>
			</View>
		</Pressable>
	);
};

const AccountsOverview: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { activeAccounts, balances, cards, overview, unassignedNetCents, isLoading } = useAccounts();

	if (isLoading) return null;

	const ordered = [...activeAccounts].sort((a, b) => {
		const rank = (account: Account) => (account.kind === 'credit_card' ? 1 : 0);
		return rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
	});

	const openAccount = (account: Account) =>
		router.push({ pathname: '/accounts/[id]', params: { id: account.id } });

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<Text style={styles.title} accessibilityRole="header">
					{t('accounts.sectionTitle')}
				</Text>
				<Pressable
					onPress={() => router.push('/accounts')}
					accessibilityRole="button"
					accessibilityLabel={t('accounts.manage')}
					hitSlop={12}
					style={styles.manage}
				>
					<Text style={styles.manageText}>{t('accounts.manage')}</Text>
				</Pressable>
			</View>

			{ordered.length === 0 ? (
				<View style={styles.empty}>
					<Text style={styles.emptyText}>{t('accounts.empty')}</Text>
					<Pressable
						onPress={() => router.push('/accounts/new')}
						accessibilityRole="button"
						accessibilityLabel={t('accounts.add')}
						style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
					>
						<Ionicons name="add" size={20} color="#000000" />
						<Text style={styles.addButtonText}>{t('accounts.add')}</Text>
					</Pressable>
				</View>
			) : (
				<>
					<View
						style={styles.totals}
						accessible
						accessibilityLabel={t('accounts.overviewLabel', {
							cash: formatCents(overview.cashCents),
							cards: formatCents(overview.cardsOwedCents),
							net: formatCents(overview.netCents),
						})}
					>
						<View style={styles.total}>
							<Text style={styles.totalLabel}>{t('accounts.cash')}</Text>
							<Text style={[styles.totalValue, overview.cashCents < 0 && styles.owed]}>{formatCents(overview.cashCents)}</Text>
						</View>
						<View style={styles.total}>
							<Text style={styles.totalLabel}>{t('accounts.cards')}</Text>
							<Text style={[styles.totalValue, overview.cardsOwedCents > 0 && styles.owed]}>{formatCents(overview.cardsOwedCents)}</Text>
						</View>
						<View style={styles.total}>
							<Text style={styles.totalLabel}>{t('accounts.net')}</Text>
							<Text style={[styles.totalValue, overview.netCents < 0 && styles.owed]}>{formatCents(overview.netCents)}</Text>
						</View>
					</View>

					{ordered.map((account) => (
						<AccountRow
							key={account.id}
							account={account}
							balanceCents={balances.get(account.id) ?? account.openingBalanceCents}
							card={cards.get(account.id)}
							onPress={openAccount}
						/>
					))}

					{unassignedNetCents !== 0 && (
						<View style={styles.row} accessible accessibilityLabel={`${t('accounts.unassigned')}, ${formatCents(unassignedNetCents)}`}>
							<View style={[styles.icon, styles.iconMuted]}>
								<Ionicons name="help-outline" size={20} color="#FFFFFF" />
							</View>
							<View style={styles.info}>
								<Text style={styles.name}>{t('accounts.unassigned')}</Text>
								<Text style={styles.secondary}>{t('accounts.unassignedHint')}</Text>
							</View>
							<View style={styles.amounts}>
								<Text style={[styles.amount, unassignedNetCents < 0 ? styles.owed : styles.positive]}>
									{formatCents(unassignedNetCents)}
								</Text>
							</View>
						</View>
					)}
				</>
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 20,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: 12,
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	manage: {
		minHeight: 44,
		justifyContent: 'center',
	},
	manageText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	totals: {
		flexDirection: 'row',
		gap: 8,
		marginBottom: 8,
	},
	total: {
		flex: 1,
		backgroundColor: 'rgba(255,255,255,0.05)',
		borderRadius: 10,
		paddingVertical: 10,
		paddingHorizontal: 10,
	},
	totalLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.7)',
		marginBottom: 4,
	},
	totalValue: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		minHeight: 56,
		paddingVertical: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
	},
	pressed: {
		opacity: 0.7,
	},
	icon: {
		width: 40,
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
	},
	iconMuted: {
		backgroundColor: 'rgba(255,255,255,0.15)',
	},
	info: {
		flex: 1,
	},
	name: {
		fontSize: 16,
		fontWeight: '500',
		color: '#FFFFFF',
	},
	secondary: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	limitTrack: {
		height: 4,
		borderRadius: 2,
		backgroundColor: 'rgba(255,255,255,0.12)',
		marginTop: 6,
		overflow: 'hidden',
	},
	limitFill: {
		height: 4,
		borderRadius: 2,
	},
	amounts: {
		alignItems: 'flex-end',
	},
	amount: {
		fontSize: 16,
		fontWeight: '700',
	},
	positive: {
		color: '#FFFFFF',
	},
	owed: {
		color: '#FF6B6B',
	},
	amountLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	empty: {
		gap: 12,
	},
	emptyText: {
		fontSize: 15,
		lineHeight: 21,
		color: 'rgba(255,255,255,0.8)',
	},
	addButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
	},
	addButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
});

export default AccountsOverview;
