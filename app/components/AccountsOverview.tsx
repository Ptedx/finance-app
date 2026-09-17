import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAccounts } from '../contexts/AccountsContext';
import type { Account } from '../database/schema';
import { formatCents } from '../utils/money';
import type { EnvelopeMonth } from '../utils/monthOverview';
import { ACCOUNT_KIND_ICONS } from './AccountPicker';

/**
 * "Contas" na tela inicial. Só contas: cartões têm a própria seção, com limite e fatura.
 *
 * No topo, dois números que respondem "quanto eu tenho": **em caixa** (a soma das
 * contas) e **depois das faturas** (o caixa menos o que os cartões devem hoje). Abaixo,
 * uma linha por conta, com o que o papel dela acrescenta: o envelope mostra quanto já
 * foi usado do mês, a reserva mostra quanto entrou.
 *
 * Lista vertical: cada linha é um botão de 56 pontos com rótulo completo. Valores
 * negativos têm sinal no texto, não só cor.
 */

const ACCENT = '#15E8FE';

interface AccountRowProps {
	account: Account;
	balanceCents: number;
	envelope?: EnvelopeMonth;
	/** Entrou na reserva neste mês (líquido). */
	savedThisMonthCents?: number;
	onPress: (account: Account) => void;
}

export const AccountRow: React.FC<AccountRowProps> = ({ account, balanceCents, envelope, savedThisMonthCents, onPress }) => {
	const { t } = useTranslation();
	const amount = `${balanceCents < 0 ? '− ' : ''}${formatCents(Math.abs(balanceCents))}`;

	let secondary = t(`accounts.role.${account.role}`);
	let barPercent: number | null = null;
	if (account.role === 'envelope' && envelope) {
		const target = envelope.targetCents;
		secondary = t('month.envelopeUsed', { spent: formatCents(envelope.spentCents), funded: formatCents(target) });
		barPercent = target > 0 ? Math.round((envelope.spentCents / target) * 100) : null;
	} else if (account.role === 'reserve' && savedThisMonthCents !== undefined && savedThisMonthCents !== 0) {
		secondary = t('accounts.savedThisMonth', { amount: formatCents(savedThisMonthCents) });
	}

	return (
		<Pressable
			onPress={() => onPress(account)}
			accessibilityRole="button"
			accessibilityLabel={`${t('accounts.accountSummary', { name: account.name, balance: amount })}. ${secondary}`}
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
				<Text style={styles.secondary} numberOfLines={2}>
					{secondary}
				</Text>
				{barPercent !== null && (
					<View style={styles.track}>
						<View
							style={[
								styles.fill,
								{ width: `${Math.min(100, barPercent)}%`, backgroundColor: barPercent >= 90 ? '#FF6B6B' : ACCENT },
							]}
						/>
					</View>
				)}
			</View>
			<Text style={[styles.amount, balanceCents < 0 && styles.negative]}>{amount}</Text>
		</Pressable>
	);
};

const AccountsOverview: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { bankAccounts, balances, overview, month, unassignedNetCents, isLoading } = useAccounts();

	if (isLoading) return null;

	const envelopes = new Map((month?.envelopes ?? []).map((envelope) => [envelope.accountId, envelope]));
	const openAccount = (account: Account) => router.push({ pathname: '/accounts/[id]', params: { id: account.id } });

	return (
		<View style={styles.section}>
			<View style={styles.header}>
				<Text style={styles.title} accessibilityRole="header">
					{t('accounts.groupAccounts')}
				</Text>
				<Pressable
					onPress={() => router.push('/accounts/index')}
					accessibilityRole="button"
					accessibilityLabel={t('accounts.manage')}
					hitSlop={12}
					style={styles.link}
				>
					<Text style={styles.linkText}>{t('accounts.manage')}</Text>
				</Pressable>
			</View>

			<View style={styles.card}>
				{bankAccounts.length === 0 ? (
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
							accessibilityLabel={`${t('accounts.cash')} ${formatCents(overview.cashCents)}. ${t('accounts.afterCards')} ${formatCents(overview.netCents)}`}
						>
							<View style={styles.total}>
								<Text style={styles.totalLabel}>{t('accounts.cash')}</Text>
								<Text style={[styles.totalValue, overview.cashCents < 0 && styles.negative]}>{formatCents(overview.cashCents)}</Text>
							</View>
							<View style={styles.total}>
								<Text style={styles.totalLabel}>{t('accounts.afterCards')}</Text>
								<Text style={[styles.totalValue, overview.netCents < 0 && styles.negative]}>{formatCents(overview.netCents)}</Text>
							</View>

						</View>

						{bankAccounts.map((account) => (
							<AccountRow
								key={account.id}
								account={account}
								balanceCents={balances.get(account.id) ?? account.openingBalanceCents}
								envelope={envelopes.get(account.id)}
								savedThisMonthCents={account.role === 'reserve' && month ? month.savedCents : undefined}
								onPress={openAccount}
							/>
						))}

						{unassignedNetCents !== 0 && (
							<Pressable
								onPress={() => router.push('/accounts/unassigned')}
								accessibilityRole="button"
								accessibilityLabel={`${t('accounts.unassigned')}, ${formatCents(unassignedNetCents)}`}
								accessibilityHint={t('accounts.unassignedAction')}
								style={({ pressed }) => [styles.row, pressed && styles.pressed]}
							>
								<View style={[styles.icon, styles.iconMuted]}>
									<Ionicons name="help-outline" size={20} color="#FFFFFF" />
								</View>
								<View style={styles.info}>
									<Text style={styles.name}>{t('accounts.unassigned')}</Text>
									<Text style={styles.secondary}>{t('accounts.unassignedAction')}</Text>
								</View>
								<Text style={[styles.amount, unassignedNetCents < 0 && styles.negative]}>
									{`${unassignedNetCents < 0 ? '− ' : ''}${formatCents(Math.abs(unassignedNetCents))}`}
								</Text>
							</Pressable>
						)}
					</>
				)}
			</View>
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
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		paddingHorizontal: 16,
		paddingVertical: 8,
	},
	totals: {
		flexDirection: 'row',
		gap: 8,
		paddingVertical: 8,
	},
	total: {
		flex: 1,
	},
	totalLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.75)',
		marginBottom: 2,
	},
	totalValue: {
		fontSize: 20,
		fontWeight: '800',
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
		lineHeight: 18,
		color: 'rgba(255,255,255,0.75)',
		marginTop: 2,
	},
	track: {
		height: 4,
		borderRadius: 2,
		backgroundColor: 'rgba(255,255,255,0.12)',
		marginTop: 6,
		overflow: 'hidden',
	},
	fill: {
		height: 4,
		borderRadius: 2,
	},
	amount: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	negative: {
		color: '#FF8A80',
	},
	empty: {
		gap: 12,
		paddingVertical: 8,
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
