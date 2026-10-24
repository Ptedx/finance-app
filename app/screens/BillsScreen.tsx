import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import BillStatusPill from '../components/bills/BillStatusPill';
import { useBills } from '../contexts/BillsContext';
import type { Bill } from '../database/schema';
import type { MonthBillRow } from '../utils/billRules';
import { formatCents } from '../utils/money';

/**
 * Contas a pagar: boletos, contas fixas e as parcelas das dívidas, com a situação do mês.
 *
 * Em cima, quanto ainda falta pagar no mês (as de valor variável ficam fora do total, e a
 * tela diz quantas). Cada conta tem "Já paguei" — é o que cala os lembretes do mês — e,
 * paga, "Desfazer". Tocar na conta abre a edição. As desativadas ficam no fim.
 */

const ACCENT = '#15E8FE';

/** "Dia 10 · R$ 500,00 · Dívida" — o dia é o do mês, já preso ao fim do mês. */
const subtitleOf = (
	bill: Bill,
	dueDate: string | null,
	t: (key: string, options?: Record<string, unknown>) => string
): string =>
	[
		t('bills.day', { day: dueDate ? Number(dueDate.slice(8, 10)) : bill.dueDay }),
		bill.amountCents === null ? t('bills.variable') : formatCents(bill.amountCents),
		bill.debtId ? t('bills.fromDebt') : null,
	]
		.filter(Boolean)
		.join(' · ');

const BillsScreen: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { bills, month, isLoading, markPaid, undoPaid } = useBills();
	const [busyId, setBusyId] = useState<string | null>(null);

	const inactive = bills.filter((bill) => !bill.active);
	const openBill = (bill: Bill) =>
		router.push({ pathname: '/bills/edit/[id]', params: { id: bill.id } });

	const toggle = async (row: MonthBillRow) => {
		setBusyId(row.bill.id);
		try {
			if (row.status === 'paid') {
				await undoPaid(row.bill.id);
				AccessibilityInfo.announceForAccessibility(
					t('bills.unmarkedPaid', { name: row.bill.name })
				);
			} else {
				await markPaid(row.bill.id);
				AccessibilityInfo.announceForAccessibility(t('bills.markedPaid', { name: row.bill.name }));
			}
		} finally {
			setBusyId(null);
		}
	};

	const empty = !isLoading && bills.length === 0;

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('bills.back')}
					style={styles.iconButton}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
					{t('bills.title')}
				</Text>
				<Pressable
					onPress={() => router.push('/bills/new')}
					accessibilityRole="button"
					accessibilityLabel={t('bills.add')}
					style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
				>
					<Ionicons name="add" size={28} color={ACCENT} />
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				{empty ? (
					<View style={styles.emptyBox}>
						<Text style={styles.emptyText}>{t('bills.empty')}</Text>
						<Pressable
							onPress={() => router.push('/bills/new')}
							accessibilityRole="button"
							accessibilityLabel={t('bills.emptyAction')}
							style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
						>
							<Ionicons name="add" size={20} color="#000000" />
							<Text style={styles.primaryButtonText}>{t('bills.emptyAction')}</Text>
						</Pressable>
					</View>
				) : null}

				{month.rows.length > 0 ? (
					<View
						style={styles.totals}
						accessible
						accessibilityLabel={[
							`${t('bills.toPay')}, ${formatCents(month.dueCents)}`,
							month.variableCount > 0
								? t('bills.variableNote', { count: month.variableCount })
								: null,
							month.lateCount > 0 ? t('bills.lateCount', { count: month.lateCount }) : null,
						]
							.filter(Boolean)
							.join('. ')}
					>
						<Text style={styles.totalsLabel}>{t('bills.toPay')}</Text>
						<Text style={styles.totalsValue}>
							{month.dueCents === 0 && month.variableCount === 0
								? t('bills.allPaid')
								: formatCents(month.dueCents)}
						</Text>
						{month.variableCount > 0 ? (
							<Text style={styles.totalsSub}>
								{t('bills.variableNote', { count: month.variableCount })}
							</Text>
						) : null}
						{month.lateCount > 0 ? (
							<Text style={[styles.totalsSub, styles.late]}>
								{t('bills.lateCount', { count: month.lateCount })}
							</Text>
						) : null}
					</View>
				) : null}

				{month.rows.length > 0 ? (
					<View style={styles.list}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('bills.thisMonth')}
						</Text>
						{month.rows.map((row) => {
							const paid = row.status === 'paid';
							const subtitle = subtitleOf(row.bill, row.dueDate, t);
							return (
								<View
									key={row.bill.id}
									style={[styles.row, row.status === 'late' && styles.rowLate]}
								>
									<Pressable
										onPress={() => openBill(row.bill)}
										accessibilityRole="button"
										accessibilityLabel={`${row.bill.name}, ${subtitle}, ${t(`bills.status.${row.status}`)}`}
										style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
									>
										<View style={styles.rowText}>
											<Text style={styles.rowName} numberOfLines={1}>
												{row.bill.name}
											</Text>
											<Text style={styles.rowSub}>{subtitle}</Text>
										</View>
										<BillStatusPill status={row.status} />
									</Pressable>
									<Pressable
										onPress={() => toggle(row)}
										disabled={busyId === row.bill.id}
										accessibilityRole="button"
										accessibilityLabel={paid ? t('bills.undoPaid') : t('bills.markPaid')}
										accessibilityHint={t(paid ? 'bills.undoPaidHint' : 'bills.markPaidHint', {
											name: row.bill.name,
										})}
										style={({ pressed }) => [
											styles.rowAction,
											paid ? styles.rowActionUndo : styles.rowActionPay,
											pressed && styles.pressed,
										]}
									>
										<Ionicons
											name={paid ? 'arrow-undo-outline' : 'checkmark'}
											size={18}
											color={paid ? '#FFFFFF' : '#000000'}
										/>
										<Text style={[styles.rowActionText, !paid && styles.rowActionTextPay]}>
											{paid ? t('bills.undoPaid') : t('bills.markPaid')}
										</Text>
									</Pressable>
								</View>
							);
						})}
					</View>
				) : null}

				{inactive.length > 0 ? (
					<View style={styles.list}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('bills.inactive')}
						</Text>
						{inactive.map((bill) => {
							const subtitle = subtitleOf(bill, null, t);
							return (
								<Pressable
									key={bill.id}
									onPress={() => openBill(bill)}
									accessibilityRole="button"
									accessibilityLabel={`${bill.name}, ${subtitle}, ${t('bills.inactiveLabel')}`}
									style={({ pressed }) => [
										styles.row,
										styles.rowMain,
										styles.rowInactive,
										pressed && styles.pressed,
									]}
								>
									<View style={styles.rowText}>
										<Text style={styles.rowName} numberOfLines={1}>
											{bill.name}
										</Text>
										<Text style={styles.rowSub}>{subtitle}</Text>
									</View>
									<Text style={styles.inactiveLabel}>{t('bills.inactiveLabel')}</Text>
								</Pressable>
							);
						})}
					</View>
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
		paddingBottom: 120,
		gap: 16,
	},
	emptyBox: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		gap: 14,
	},
	emptyText: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.85)',
	},
	primaryButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 50,
		borderRadius: 12,
		backgroundColor: ACCENT,
	},
	primaryButtonText: {
		fontSize: 16,
		fontWeight: '700',
		color: '#000000',
	},
	totals: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		gap: 4,
	},
	totalsLabel: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	totalsValue: {
		fontSize: 28,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	totalsSub: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	late: {
		color: '#FF6B6B',
		fontWeight: '600',
	},
	list: {
		gap: 8,
	},
	sectionTitle: {
		fontSize: 16,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
		marginBottom: 2,
	},
	row: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		overflow: 'hidden',
	},
	rowLate: {
		borderWidth: 1,
		borderColor: 'rgba(255,107,107,0.6)',
	},
	rowInactive: {
		opacity: 0.7,
	},
	rowMain: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		minHeight: 56,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	rowText: {
		flex: 1,
	},
	rowName: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	rowSub: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
		marginTop: 2,
	},
	rowAction: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 6,
		minHeight: 44,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
	},
	rowActionPay: {
		backgroundColor: ACCENT,
	},
	rowActionUndo: {
		backgroundColor: 'rgba(255,255,255,0.06)',
	},
	rowActionText: {
		fontSize: 14,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	rowActionTextPay: {
		color: '#000000',
	},
	inactiveLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
	},
	pressed: {
		opacity: 0.7,
	},
});

export default BillsScreen;
