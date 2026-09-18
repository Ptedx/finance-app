import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Debt, DebtKind } from '../../database/schema';
import { formatMonthYear, todayISO } from '../../utils/dateUtils';
import { debtStateOn, termsOf } from '../../utils/debt';
import { formatCents } from '../../utils/money';
import { ACCENT } from '../cards/formParts';

export const DEBT_KIND_ICONS: Record<DebtKind, React.ComponentProps<typeof Ionicons>['name']> = {
	financing: 'document-text-outline',
	consortium: 'people-outline',
	loan: 'cash-outline',
};

/**
 * Uma dívida na lista: nome, parcela, quantas já foram e quando quita, a barra do que já
 * foi pago e o saldo devedor de hoje. O saldo sai da âncora projetada — nunca de um número
 * guardado que envelhece.
 */
const DebtRow: React.FC<{ debt: Debt; onPress: (debt: Debt) => void }> = ({ debt, onPress }) => {
	const { t } = useTranslation();
	const state = debtStateOn(termsOf(debt), todayISO());
	const paid = Math.max(0, debt.installmentsTotal - state.remaining);
	const progress = debt.installmentsTotal > 0 ? Math.min(100, Math.round((paid / debt.installmentsTotal) * 100)) : 0;
	const installment = state.next?.installmentCents ?? debt.installmentCents;
	const payoff = state.payoffDate ? formatMonthYear(state.payoffDate) : null;

	const detail = debt.archived
		? t('debts.row.paidOff')
		: [
				t('debts.row.installment', { amount: formatCents(installment) }),
				t('debts.row.progress', { paid, total: debt.installmentsTotal }),
				payoff ? t('debts.row.payoff', { date: payoff }) : t('debts.row.neverPays'),
			].join(' · ');

	return (
		<Pressable
			onPress={() => onPress(debt)}
			accessibilityRole="button"
			accessibilityLabel={`${debt.name}. ${t('debts.balance')} ${formatCents(state.balanceCents)}. ${detail}`}
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
		>
			<View style={styles.icon} accessible={false}>
				<Ionicons name={DEBT_KIND_ICONS[debt.kind]} size={20} color={ACCENT} />
			</View>
			<View style={styles.body}>
				<View style={styles.top}>
					<Text style={styles.name} numberOfLines={1}>
						{debt.name}
					</Text>
					<Text style={styles.balance}>{formatCents(state.balanceCents)}</Text>
				</View>
				<Text style={styles.detail} numberOfLines={2}>
					{detail}
				</Text>
				{!debt.archived ? (
					<View style={styles.track} accessible={false}>
						<View style={[styles.fill, { width: `${Math.max(2, progress)}%` }]} />
					</View>
				) : null}
			</View>
		</Pressable>
	);
};

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		minHeight: 64,
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.06)',
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
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	body: {
		flex: 1,
		gap: 4,
	},
	top: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
	},
	name: {
		flex: 1,
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	balance: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	detail: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.65)',
	},
	track: {
		height: 5,
		borderRadius: 3,
		backgroundColor: 'rgba(255,255,255,0.12)',
		overflow: 'hidden',
		marginTop: 2,
	},
	fill: {
		height: 5,
		borderRadius: 3,
		backgroundColor: ACCENT,
	},
});

export default DebtRow;
