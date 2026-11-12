import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import BillStatusPill from '../components/bills/BillStatusPill';
import { useAccounts } from '../contexts/AccountsContext';
import { type BillPaymentPlan, markPaidTransactionId, useBills } from '../contexts/BillsContext';
import type { Bill } from '../database/schema';
import { BILL_OVERDUE_MONTHS } from '../utils/billReminders';
import {
	type BillFilter,
	billsOfMonth,
	canUndoMonth,
	filterMonthRows,
	type MonthBillRow,
	overdueBills,
	payableMonth,
} from '../utils/billRules';
import { formatDayMonth, getMonthName, shiftMonthKey } from '../utils/dateUtils';
import { formatCents } from '../utils/money';

/**
 * Contas a pagar: boletos, contas fixas e as parcelas das dívidas, com a situação do mês.
 *
 * Em cima, quanto ainda falta pagar no mês (as de valor variável ficam fora do total, e a
 * tela diz quantas). Cada conta tem "Já paguei" — é o que cala os lembretes do mês — e,
 * paga, "Desfazer". Tocar na conta abre a edição. As desativadas ficam no fim.
 *
 * "Já paguei" lança a saída (E2E-23): antes de lançar, a tela pergunta, com o valor e a
 * conta que paga, e deixa só marcar. Quando já há lançamento que casa, marca sem perguntar;
 * quando o aviso do banco está na caixa de entrada, marca e diz que o lançamento vem de lá.
 * "Desfazer" tira o lançamento que o "Já paguei" criou.
 *
 * As setas ‹ › trocam o mês (SPD-142): o total e a lista seguem o mês escolhido
 * (`billsOfMonth`). Para trás, no máximo 3 meses — o mesmo limite do atraso. Em cima da lista,
 * os filtros Todas / A vencer / Atrasadas / Pagas ("A vencer" inclui a que vence hoje).
 *
 * Mês atrasado (SPD-145): a conta guarda só "pago até", então "Já paguei" quita sempre o mês
 * mais antigo em aberto, um por vez, com a data de hoje, e "Desfazer" reabre o último mês pago.
 * Por isso "Já paguei" aparece no mês mais antigo em aberto de cada conta e, no mês atual, também
 * quando há um mês anterior em aberto — aí o botão diz "Quitar outubro" e a pergunta diz o mês
 * antes de marcar. Num mês passado, a conta com um mês ainda mais antigo em aberto fica sem ação,
 * com uma frase dizendo qual quitar antes; "Desfazer" fica no mês que é o último pago. No mês
 * atual, o atraso de meses anteriores aparece à parte do total, e tocar nele vai ao mais antigo.
 */

/** A escolha na pergunta de lançar: lançar, só marcar, ou nada. */
type PostChoice = 'post' | 'onlyMark' | 'cancel';

const ACCENT = '#15E8FE';

const FILTERS: BillFilter[] = ['all', 'upcoming', 'late', 'paid'];

/** O nome do mês de uma chave `YYYY-MM`, como o idioma escreve ("novembro", "November"). */
const monthNameOf = (key: string): string => getMonthName(Number(key.slice(5, 7)));

/** Quantos meses de `from` até `to` (chaves `YYYY-MM`); negativo quando `to` vem antes. */
const monthsBetween = (from: string, to: string): number =>
	Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)));

/** "Novembro 2026": o título das setas. */
const monthTitleOf = (key: string): string => {
	const name = monthNameOf(key);
	return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${key.slice(0, 4)}`;
};

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
	const { bills, month, today, isLoading, planPayment, markPaid, undoPaid } = useBills();
	const { accounts } = useAccounts();
	const [busyId, setBusyId] = useState<string | null>(null);
	// Quantos meses longe do atual (0 = o atual): segue o mês certo quando o dia vira.
	const [monthOffset, setMonthOffset] = useState(0);
	const [filter, setFilter] = useState<BillFilter>('all');

	const currentKey = month.month;
	const isCurrentMonth = monthOffset === 0;
	const shownKey = shiftMonthKey(currentKey, monthOffset);
	const shown = isCurrentMonth ? month : billsOfMonth(bills, shownKey, today);
	const shownRows = filterMonthRows(shown.rows, filter);
	const shownName = monthNameOf(shownKey);
	const toPayLabel = isCurrentMonth ? t('bills.toPay') : t('bills.toPayIn', { month: shownName });
	const allPaidLabel = isCurrentMonth ? t('bills.allPaid') : t('bills.allPaidIn', { month: shownName });
	const isPastMonth = shownKey < currentKey;
	// Para trás, só até onde o atraso conta (3 meses).
	const canGoBack = monthOffset > -BILL_OVERDUE_MONTHS;
	// O atraso de meses anteriores, à parte do total do mês (só no mês atual).
	const overdue = isCurrentMonth ? overdueBills(bills, currentKey) : null;
	const overdueText =
		overdue && overdue.billCount > 0
			? overdue.cents > 0
				? t('bills.overdueNote', { amount: formatCents(overdue.cents), count: overdue.billCount })
				: t('bills.overdueNoteVariable', { count: overdue.billCount })
			: null;

	const inactive = bills.filter((bill) => !bill.active);
	const openBill = (bill: Bill) =>
		router.push({ pathname: '/bills/edit/[id]', params: { id: bill.id } });

	/**
	 * A ação de uma linha no mês mostrado: "Já paguei" no mês mais antigo em aberto da conta (e,
	 * no mês atual, também quando o mais antigo é de antes: aí quita ele); "Desfazer" no último
	 * mês pago. `target` é o mês que o "Já paguei" quita; `blockedBy`, num mês passado, o mês
	 * mais antigo que tem de ser quitado antes.
	 */
	const actionOf = (
		row: MonthBillRow
	): { kind: 'pay' | 'undo' | null; target: string | null; blockedBy: string | null } => {
		if (row.status === 'paid') {
			return { kind: canUndoMonth(row.bill, shownKey) ? 'undo' : null, target: null, blockedBy: null };
		}
		const target = payableMonth(row.bill, currentKey);
		if (target !== null && (target === shownKey || (isCurrentMonth && target < shownKey))) {
			return { kind: 'pay', target, blockedBy: null };
		}
		return { kind: null, target: null, blockedBy: isPastMonth && target !== null && target < shownKey ? target : null };
	};

	/** "Achamos a saída de R$ 500,00 em 20/10: ela fica como o pagamento de outubro." */
	const foundBodyOf = (plan: Extract<BillPaymentPlan, { kind: 'matched' }>, target: string): string =>
		t('bills.pay.foundBody', {
			amount: formatCents(plan.amountCents),
			date: formatDayMonth(plan.date),
			month: monthNameOf(target),
		});

	/**
	 * "Lançar a saída de R$ 120,00 da conta Corrente Teste, com a data de hoje?" Quitando um
	 * mês que não é o atual, o título diz qual ("Quitar outubro?") e o texto, por quê.
	 */
	const askToPost = (
		plan: Extract<BillPaymentPlan, { kind: 'post' }>,
		older: { month: string; name: string } | null
	): Promise<PostChoice> =>
		new Promise((resolve) => {
			const amount = formatCents(plan.draft.amountCents);
			const account = accounts.find((item) => item.id === plan.draft.accountId)?.name;
			const body = account ? t('bills.pay.body', { amount, account }) : t('bills.pay.bodyNoAccount', { amount });
			Alert.alert(
				older ? t('bills.pay.titleMonth', { month: older.month }) : t('bills.pay.title'),
				older ? `${t('bills.pay.olderBody', older)}\n\n${body}` : body,
				[
					{ text: t('bills.pay.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
					{ text: t('bills.pay.onlyMark'), onPress: () => resolve('onlyMark') },
					{ text: t('bills.pay.post'), onPress: () => resolve('post') },
				],
				{ cancelable: true, onDismiss: () => resolve('cancel') }
			);
		});

	/** "Quitar outubro?" — quando o "Já paguei" não lança nada, mas o mês quitado não é o atual. */
	const confirmOlder = (plan: BillPaymentPlan, bill: Bill, target: string): Promise<boolean> =>
		new Promise((resolve) => {
			const month = monthNameOf(target);
			Alert.alert(
				t('bills.pay.titleMonth', { month }),
				plan.kind === 'matched' ? foundBodyOf(plan, target) : t('bills.pay.olderBody', { month, name: bill.name }),
				[
					{ text: t('bills.pay.cancel'), style: 'cancel', onPress: () => resolve(false) },
					{ text: t('bills.pay.confirmMonth', { month }), onPress: () => resolve(true) },
				],
				{ cancelable: true, onDismiss: () => resolve(false) }
			);
		});

	const pay = async (bill: Bill) => {
		const target = payableMonth(bill, currentKey);
		if (!target) return;
		const older = target !== currentKey;
		const plan = await planPayment(bill.id);
		if (!plan) return;

		let options: { post: boolean } | undefined;
		if (plan.kind === 'post') {
			const choice = await askToPost(plan, older ? { month: monthNameOf(target), name: bill.name } : null);
			if (choice === 'cancel') return;
			options = { post: choice === 'post' };
		} else if (older && !(await confirmOlder(plan, bill, target))) {
			return;
		}

		const result = await markPaid(bill.id, options);
		if (!result) return;
		const paidMonth = result.month ?? target;
		if (result.posted && result.kind === 'post') {
			AccessibilityInfo.announceForAccessibility(
				t('bills.pay.posted', { name: bill.name, amount: formatCents(result.draft.amountCents) })
			);
		} else if (older) {
			AccessibilityInfo.announceForAccessibility(
				t('bills.markedPaidMonth', { name: bill.name, month: monthNameOf(paidMonth) })
			);
		} else {
			AccessibilityInfo.announceForAccessibility(t('bills.markedPaid', { name: bill.name }));
		}
		if (result.kind === 'inbox') Alert.alert(t('bills.pay.inboxTitle'), t('bills.pay.inboxBody'));
		// O pagamento já estava lançado: diz o que achou (num mês anterior, a pergunta já disse).
		if (result.kind === 'matched' && !older) {
			Alert.alert(t('bills.pay.foundTitle'), foundBodyOf(result, paidMonth));
		}
	};

	const toggle = async (row: MonthBillRow) => {
		setBusyId(row.bill.id);
		try {
			if (row.status === 'paid') {
				// Desfazer tira o lançamento quando foi o "Já paguei" que o criou (o id diz).
				const removesPayment = row.bill.paidByRef === markPaidTransactionId(row.bill.id, shownKey);
				await undoPaid(row.bill.id);
				AccessibilityInfo.announceForAccessibility(
					t(removesPayment ? 'bills.pay.undonePosted' : 'bills.unmarkedPaid', { name: row.bill.name })
				);
			} else {
				await pay(row.bill);
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

				{shown.rows.length > 0 ? (
					<View style={styles.monthNav}>
						<Pressable
							onPress={() => setMonthOffset((offset) => Math.max(offset - 1, -BILL_OVERDUE_MONTHS))}
							disabled={!canGoBack}
							accessibilityRole="button"
							accessibilityLabel={t('bills.monthNav.previous')}
							accessibilityState={{ disabled: !canGoBack }}
							style={({ pressed }) => [styles.iconButton, !canGoBack && styles.disabled, pressed && styles.pressed]}
						>
							<Ionicons name="chevron-back" size={24} color="#FFFFFF" />
						</Pressable>
						<Text
							style={styles.monthTitle}
							accessibilityRole="header"
							accessibilityLiveRegion="polite"
							numberOfLines={1}
						>
							{monthTitleOf(shownKey)}
						</Text>
						<Pressable
							onPress={() => setMonthOffset((offset) => offset + 1)}
							accessibilityRole="button"
							accessibilityLabel={t('bills.monthNav.next')}
							style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
						>
							<Ionicons name="chevron-forward" size={24} color="#FFFFFF" />
						</Pressable>
					</View>
				) : null}

				{shown.rows.length > 0 && !isCurrentMonth ? (
					<View style={styles.otherMonth}>
						<Text style={styles.otherMonthText}>{t('bills.otherMonthNote')}</Text>
						<Pressable
							onPress={() => setMonthOffset(0)}
							accessibilityRole="button"
							accessibilityLabel={t('bills.monthNav.current')}
							hitSlop={6}
							style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
						>
							<Text style={styles.linkText}>{t('bills.monthNav.current')}</Text>
						</Pressable>
					</View>
				) : null}

				{shown.rows.length > 0 ? (
					<View
						style={styles.totals}
						accessible
						accessibilityLabel={[
							`${toPayLabel}, ${formatCents(shown.dueCents)}`,
							shown.variableCount > 0
								? t('bills.variableNote', { count: shown.variableCount })
								: null,
							shown.lateCount > 0 ? t('bills.lateCount', { count: shown.lateCount }) : null,
						]
							.filter(Boolean)
							.join('. ')}
					>
						<Text style={styles.totalsLabel}>{toPayLabel}</Text>
						<Text style={styles.totalsValue}>
							{shown.dueCents === 0 && shown.variableCount === 0
								? allPaidLabel
								: formatCents(shown.dueCents)}
						</Text>
						{shown.variableCount > 0 ? (
							<Text style={styles.totalsSub}>
								{t('bills.variableNote', { count: shown.variableCount })}
							</Text>
						) : null}
						{shown.lateCount > 0 ? (
							<Text style={[styles.totalsSub, styles.late]}>
								{t('bills.lateCount', { count: shown.lateCount })}
							</Text>
						) : null}
					</View>
				) : null}

				{overdue?.oldestMonth && overdueText ? (
					<Pressable
						onPress={() => setMonthOffset(monthsBetween(currentKey, overdue.oldestMonth ?? currentKey))}
						accessibilityRole="button"
						accessibilityLabel={overdueText}
						accessibilityHint={t('bills.overdueOpen')}
						style={({ pressed }) => [styles.overdue, pressed && styles.pressed]}
					>
						<Ionicons name="alert-circle-outline" size={18} color="#FF6B6B" />
						<Text style={[styles.overdueText, styles.late]}>{overdueText}</Text>
						<Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.5)" />
					</Pressable>
				) : null}

				{shown.rows.length > 0 ? (
					<View
						style={styles.filters}
						accessibilityRole="radiogroup"
						accessibilityLabel={t('bills.filter.label')}
					>
						{FILTERS.map((option) => {
							const selected = option === filter;
							return (
								<Pressable
									key={option}
									onPress={() => setFilter(option)}
									accessibilityRole="radio"
									accessibilityState={{ selected }}
									accessibilityLabel={t(`bills.filter.${option}`)}
									style={({ pressed }) => [
										styles.filter,
										selected && styles.filterSelected,
										pressed && styles.pressed,
									]}
								>
									<Text
										style={[styles.filterText, selected && styles.filterTextSelected]}
										numberOfLines={1}
									>
										{t(`bills.filter.${option}`)}
									</Text>
								</Pressable>
							);
						})}
					</View>
				) : null}

				{shown.rows.length > 0 && shownRows.length === 0 ? (
					<Text style={styles.filterEmpty}>{t('bills.filter.empty')}</Text>
				) : null}

				{shownRows.length > 0 ? (
					<View style={styles.list}>
						{shownRows.map((row) => {
							const paid = row.status === 'paid';
							const subtitle = subtitleOf(row.bill, row.dueDate, t);
							const action = actionOf(row);
							// No mês atual, com um mês anterior em aberto, o botão diz que quita esse.
							const olderTarget =
								action.kind === 'pay' && action.target !== shownKey ? action.target : null;
							const actionLabel = paid
								? t('bills.undoPaid')
								: olderTarget
									? t('bills.markPaidOlder', { month: monthNameOf(olderTarget) })
									: t('bills.markPaid');
							const actionHint = paid
								? t('bills.undoPaidHint', { name: row.bill.name, month: shownName })
								: olderTarget
									? t('bills.markPaidOlderHint', { name: row.bill.name, month: monthNameOf(olderTarget) })
									: t('bills.markPaidHint', { name: row.bill.name, month: shownName });
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
									{action.blockedBy ? (
										<Text style={styles.rowNote}>
											{t('bills.payOlderFirst', { month: monthNameOf(action.blockedBy) })}
										</Text>
									) : null}
									{action.kind ? (
										<Pressable
											onPress={() => toggle(row)}
											disabled={busyId === row.bill.id}
											accessibilityRole="button"
											accessibilityLabel={actionLabel}
											accessibilityHint={actionHint}
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
												{actionLabel}
											</Text>
										</Pressable>
									) : null}
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
	overdue: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 48,
		marginTop: -8,
		paddingHorizontal: 14,
		paddingVertical: 10,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: 'rgba(255,107,107,0.6)',
		backgroundColor: '#1E1E1E',
	},
	overdueText: {
		flex: 1,
		fontSize: 14,
	},
	disabled: {
		opacity: 0.3,
	},
	rowNote: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.65)',
		paddingHorizontal: 14,
		paddingBottom: 10,
	},
	monthNav: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: -8,
	},
	monthTitle: {
		flex: 1,
		textAlign: 'center',
		fontSize: 17,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	otherMonth: {
		gap: 4,
		alignItems: 'center',
	},
	otherMonthText: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		textAlign: 'center',
	},
	linkButton: {
		minHeight: 44,
		justifyContent: 'center',
		paddingHorizontal: 8,
	},
	linkText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	filters: {
		flexDirection: 'row',
		gap: 6,
	},
	filter: {
		flex: 1,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 4,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	filterSelected: {
		borderColor: ACCENT,
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	filterText: {
		fontSize: 13,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.8)',
	},
	filterTextSelected: {
		color: ACCENT,
	},
	filterEmpty: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.7)',
		textAlign: 'center',
		paddingVertical: 8,
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
