import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Debt } from '../../database/schema';
import { formatMonthYear } from '../../utils/dateUtils';
import type { DebtsSummary, DebtVerdict } from '../../utils/debt';
import { formatCents } from '../../utils/money';
import { ACCENT } from '../cards/formParts';
import DebtRow from '../debts/DebtRow';

/**
 * As dívidas dentro do Patrimônio: o resumo (parcelas por mês, quando a última acaba), uma
 * linha por dívida com o veredito "amortizar ou investir", o botão de cadastrar e as
 * quitadas, recolhidas. Sem dívida, o convite explica para que serve o cadastro.
 */
const DebtsPanel: React.FC<{
	debts: Debt[];
	summary: DebtsSummary;
	verdictOf: (debt: Debt) => DebtVerdict;
}> = ({ debts, summary, verdictOf }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const [showPaidOff, setShowPaidOff] = useState(false);
	const active = debts.filter((debt) => !debt.archived);
	const paidOff = debts.filter((debt) => debt.archived);
	const openDebt = (debt: Debt) => router.push({ pathname: '/debts/[id]', params: { id: debt.id } });

	return (
		<View style={styles.card}>
			<Text style={styles.title} accessibilityRole="header">
				{t('debts.screenTitle')}
			</Text>
			{active.length > 0 ? (
				<Text style={styles.subtitle}>
					{summary.lastPayoffDate
						? t('netWorth.debtsSummary', { monthly: formatCents(summary.monthlyCents), date: formatMonthYear(summary.lastPayoffDate) })
						: t('netWorth.debtsSummaryNoDate', { monthly: formatCents(summary.monthlyCents) })}
				</Text>
			) : (
				<Text style={styles.subtitle}>{t('debts.empty')}</Text>
			)}

			{active.map((debt) => (
				<DebtRow key={debt.id} debt={debt} onPress={openDebt} verdict={verdictOf(debt)} />
			))}

			<Pressable
				onPress={() => router.push('/debts/new')}
				accessibilityRole="button"
				style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
			>
				<Ionicons name="add" size={20} color="#000000" />
				<Text style={styles.addButtonText}>{t('debts.add')}</Text>
			</Pressable>

			{paidOff.length > 0 ? (
				<>
					<Pressable
						onPress={() => setShowPaidOff((value) => !value)}
						accessibilityRole="button"
						accessibilityState={{ expanded: showPaidOff }}
						style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
					>
						<Text style={styles.toggleText}>{t('netWorth.paidOffToggle', { count: paidOff.length })}</Text>
						<Ionicons name={showPaidOff ? 'chevron-up' : 'chevron-down'} size={18} color={ACCENT} />
					</Pressable>
					{showPaidOff ? paidOff.map((debt) => <DebtRow key={debt.id} debt={debt} onPress={openDebt} />) : null}
				</>
			) : null}
		</View>
	);
};

const styles = StyleSheet.create({
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: 16,
		marginBottom: 16,
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	subtitle: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.65)',
		marginTop: 4,
		marginBottom: 4,
	},
	addButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		marginTop: 12,
	},
	addButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	toggle: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 6,
		minHeight: 44,
		marginTop: 8,
	},
	toggleText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.7,
	},
});

export default DebtsPanel;
