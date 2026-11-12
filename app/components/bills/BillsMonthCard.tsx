import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useBills } from '../../contexts/BillsContext';
import { homeBills, type MonthBillRow, overdueBills } from '../../utils/billRules';
import { formatDayMonth, monthKeyOf } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import BillStatusPill from './BillStatusPill';

/**
 * "Contas do mês" na Home, enxuto (SPD-142): só o que pede atenção — as atrasadas e as que
 * vencem nos próximos 7 dias (`homeBills`), no máximo 3, com "e mais N" quando há mais — e,
 * embaixo, quanto ainda falta pagar no mês. As de valor variável aparecem como "varia" e
 * ficam fora do total — o rodapé diz quantas, para o total não parecer tudo. Atrasada vem
 * em vermelho, com o texto dizendo "Atrasada".
 *
 * Nada atrasado nem vencendo em 7 dias: uma linha só ("Nada vence nos próximos 7 dias ·
 * Falta pagar R$ 1.500,00"). Sem contas: uma linha com "Cadastrar". Tocar abre a tela de
 * contas a pagar, com todas as contas.
 *
 * Mês passado em aberto (SPD-145): a conta entra na lista como atrasada, com a data do mês
 * dela ("10/10"), e o rodapé ganha a linha "Em atraso" — o valor dos meses anteriores e
 * quantas contas —, separada de "Falta pagar este mês", que continua só o mês. Os avisos de
 * atraso param no D+3; é essa linha que lembra até quitar.
 *
 * Nada a pagar no mês com alguma conta pulada: "Nada em aberto este mês", não "Tudo pago"
 * (SPD-156).
 */

const ACCENT = '#15E8FE';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "Dia 10 · R$ 500,00 · Dívida"; o vencimento do mês seguinte (perto da virada) sai com o mês: "03/12". */
const subtitleOf = (row: MonthBillRow, month: string, t: Translate): string =>
	[
		monthKeyOf(row.dueDate) === month
			? t('bills.day', { day: Number(row.dueDate.slice(8, 10)) })
			: formatDayMonth(row.dueDate),
		row.bill.amountCents === null ? t('bills.variable') : formatCents(row.bill.amountCents),
		row.bill.debtId ? t('bills.fromDebt') : null,
	]
		.filter(Boolean)
		.join(' · ');

const BillsMonthCard: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { activeBills, payments, month, today, isLoading } = useBills();
	// Os meses pulados ou pagos fora de ordem (SPD-146) não são atraso nem "vence logo".
	const soon = useMemo(
		() => homeBills(activeBills, today, payments),
		[activeBills, today, payments]
	);
	const overdue = useMemo(
		() => overdueBills(activeBills, month.month, payments),
		[activeBills, month.month, payments]
	);

	if (isLoading) return null;

	const open = () => router.push('/bills');

	if (activeBills.length === 0) {
		return (
			<View style={[styles.container, styles.line]}>
				<Text style={styles.lineText} numberOfLines={2}>
					{t('bills.home.none')}
				</Text>
				<Pressable
					onPress={() => router.push('/bills/new')}
					accessibilityRole="button"
					accessibilityLabel={t('bills.home.inviteAction')}
					accessibilityHint={t('bills.home.invite')}
					style={({ pressed }) => [styles.inviteButton, pressed && styles.pressed]}
				>
					<Ionicons name="add" size={16} color={ACCENT} />
					<Text style={styles.inviteButtonText}>{t('bills.home.inviteAction')}</Text>
				</Pressable>
			</View>
		);
	}

	const allPaid = month.dueCents === 0 && month.variableCount === 0;
	// Nada a pagar porque uma conta do mês foi pulada não é "Tudo pago" (SPD-156).
	const allPaidText = month.rows.some((row) => row.status === 'skipped')
		? t('bills.nothingOpen')
		: t('bills.allPaid');
	const variableNote = month.variableCount > 0 ? t('bills.variableNote', { count: month.variableCount }) : null;
	const lateNote = month.lateCount > 0 ? t('bills.lateCount', { count: month.lateCount }) : null;

	if (soon.rows.length === 0) {
		const left = allPaid
			? allPaidText
			: [
					t('bills.home.leftToPay', { amount: formatCents(month.dueCents) }),
					month.variableCount > 0 ? t('bills.home.plusVariable', { count: month.variableCount }) : null,
				]
					.filter(Boolean)
					.join(' ');
		const line = `${t('bills.home.nothingSoon')} · ${left}`;
		return (
			<Pressable
				onPress={open}
				accessibilityRole="button"
				accessibilityLabel={[`${t('bills.home.title')}. ${line}`, variableNote].filter(Boolean).join('. ')}
				accessibilityHint={t('bills.home.open')}
				style={({ pressed }) => [styles.container, styles.line, pressed && styles.pressed]}
			>
				<Text style={styles.lineText} numberOfLines={2}>
					{line}
				</Text>
				<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.5)" />
			</Pressable>
		);
	}

	const more = soon.moreCount > 0 ? t('bills.home.more', { count: soon.moreCount }) : null;
	// "Em atraso": os meses anteriores em aberto, à parte do mês. Só de valor variável, sem soma.
	const hasOverdue = overdue.billCount > 0;
	const overdueValue = overdue.cents > 0 ? formatCents(overdue.cents) : t('bills.variable');
	const overdueCount = hasOverdue ? t('bills.home.overdueBills', { count: overdue.billCount }) : null;
	const overdueVariable =
		hasOverdue && overdue.cents > 0 && overdue.variableCount > 0
			? t('bills.variableNote', { count: overdue.variableCount })
			: null;
	const summary = [
		t('bills.home.title'),
		...soon.rows.map(
			(row) => `${row.bill.name}, ${subtitleOf(row, month.month, t)}, ${t(`bills.status.${row.status}`)}`
		),
		more,
		`${t('bills.toPay')}, ${allPaid ? allPaidText : formatCents(month.dueCents)}`,
		variableNote,
		lateNote,
		hasOverdue ? `${t('bills.home.overdue')}, ${overdueValue}` : null,
		overdueCount,
		overdueVariable,
	]
		.filter(Boolean)
		.join('. ');

	return (
		<Pressable
			onPress={open}
			accessibilityRole="button"
			accessibilityLabel={summary}
			accessibilityHint={t('bills.home.open')}
			style={({ pressed }) => [styles.container, pressed && styles.pressed]}
		>
			<View style={styles.header}>
				<Text style={styles.title} accessibilityRole="header">
					{t('bills.home.title')}
				</Text>
				<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.5)" />
			</View>

			{soon.rows.map((row) => {
				const late = row.status === 'late';
				return (
					<View key={row.bill.id} style={styles.row}>
						<View style={styles.rowText}>
							<Text style={[styles.rowName, late && styles.late]} numberOfLines={1}>
								{row.bill.name}
							</Text>
							<Text style={styles.rowSub}>{subtitleOf(row, month.month, t)}</Text>
						</View>
						<BillStatusPill status={row.status} />
					</View>
				);
			})}

			{more ? <Text style={styles.more}>{more}</Text> : null}

			<View style={styles.footer}>
				<View style={styles.footerLine}>
					<Text style={styles.footerLabel}>{t('bills.toPay')}</Text>
					<Text style={styles.footerValue}>{allPaid ? allPaidText : formatCents(month.dueCents)}</Text>
				</View>
				{variableNote ? <Text style={styles.footerSub}>{variableNote}</Text> : null}
				{lateNote ? <Text style={[styles.footerSub, styles.late, styles.lateStrong]}>{lateNote}</Text> : null}
			</View>

			{hasOverdue ? (
				<View style={styles.overdue}>
					<View style={styles.footerLine}>
						<Text style={[styles.footerLabel, styles.late]}>{t('bills.home.overdue')}</Text>
						<Text style={[styles.footerValue, styles.late]}>{overdueValue}</Text>
					</View>
					<Text style={styles.footerSub}>{overdueCount}</Text>
					{overdueVariable ? <Text style={styles.footerSub}>{overdueVariable}</Text> : null}
				</View>
			) : null}
		</Pressable>
	);
};

const styles = StyleSheet.create({
	container: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 20,
	},
	line: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		minHeight: 56,
		paddingVertical: 8,
	},
	lineText: {
		flex: 1,
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: 8,
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		minHeight: 44,
		paddingVertical: 6,
	},
	rowText: {
		flex: 1,
	},
	rowName: {
		fontSize: 15,
		color: '#FFFFFF',
	},
	rowSub: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
		marginTop: 2,
	},
	more: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		paddingVertical: 4,
	},
	late: {
		color: '#FF6B6B',
	},
	lateStrong: {
		fontWeight: '600',
	},
	footer: {
		marginTop: 8,
		paddingTop: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.1)',
		gap: 2,
	},
	footerLine: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	footerLabel: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	footerValue: {
		fontSize: 17,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	footerSub: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
	},
	overdue: {
		marginTop: 8,
		paddingTop: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,107,107,0.4)',
		gap: 2,
	},
	inviteButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 44,
		paddingHorizontal: 12,
		borderRadius: 8,
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	inviteButtonText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.7,
	},
});

export default BillsMonthCard;
