import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import BillStatusPill from '../components/bills/BillStatusPill';
import HelpButton from '../components/tour/HelpButton';
import { useScreenTour, useTourScroll, useTourTarget } from '../components/tour/TourContext';
import { SampleBanner, SampleTag, useSampleBills } from '../components/tour/TrailSample';
import { useAccounts } from '../contexts/AccountsContext';
import { type BillPaymentPlan, markPaidTransactionId, useBills } from '../contexts/BillsContext';
import type { Bill, BillPayment } from '../database/schema';
import { paymentFor } from '../utils/billPayments';
import { BILL_OVERDUE_MONTHS } from '../utils/billReminders';
import {
	type BillFilter,
	billsOfMonth,
	canUndoMonth,
	filterMonthRows,
	type MonthBillRow,
	monthBills,
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
 *
 * Mês pulado e fora de ordem (SPD-146): no mês atrasado que o "Já paguei" quitaria, a conta tem
 * também "Não vou pagar este mês" — a pergunta diz que nenhum lançamento é criado e o saldo não
 * muda. No mês atual, com um mês anterior em aberto, além de "Quitar outubro" há "Pagar só
 * novembro", e a pergunta diz que outubro continua em atraso. O mês pulado ou pago fora de ordem
 * tem "Desfazer", que reabre aquele mês.
 *
 * Quando não falta nada no mês e alguma conta dele foi pulada, o total diz "Nada em aberto",
 * não "Tudo pago" (SPD-156).
 *
 * O "?" do topo abre a trilha das contas a pagar (SPD-131c) no passo desta tela. Os passos
 * apontam o "+" (ou o "Cadastrar conta"), o "Já paguei" e o "Desfazer" da primeira conta que
 * tem cada um, e a lista.
 *
 * Sem nenhuma conta a pagar, com a trilha aberta, a tela mostra as contas a pagar de exemplo
 * (SPD-160) no lugar da lista vazia, com a faixa e o selo "Exemplo": "Aluguel exemplo", em aberto,
 * com "Já paguei", e "Internet exemplo", já paga, com "Desfazer". O total, os status e as setas do
 * mês saem só delas; "Já paguei", "Desfazer", "Não vou pagar", "Pagar só" e tocar na conta não
 * fazem nada — nada passa pelo `BillsContext`, que grava, lança e agenda os lembretes.
 */

/** O exemplo não tem mês registrado. */
const NO_PAYMENTS: readonly BillPayment[] = [];

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
	const {
		bills: ownBills,
		payments: ownPayments,
		month: ownMonth,
		today,
		isLoading,
		planPayment,
		markPaid,
		skipMonth,
		undoPaid,
	} = useBills();
	// As contas a pagar de exemplo (SPD-160): só na trilha, e só sem nenhuma conta de verdade.
	const sampleBills = useSampleBills(isLoading || ownBills.some((bill) => !bill.deletedAt), today);
	const sample = sampleBills !== undefined;
	const bills = sampleBills ?? ownBills;
	const payments = sample ? NO_PAYMENTS : ownPayments;
	const month = useMemo(
		() => (sampleBills ? monthBills(sampleBills, today) : ownMonth),
		[sampleBills, today, ownMonth]
	);
	const { accounts } = useAccounts();
	const [busyId, setBusyId] = useState<string | null>(null);
	// Quantos meses longe do atual (0 = o atual): segue o mês certo quando o dia vira.
	const [monthOffset, setMonthOffset] = useState(0);
	const [filter, setFilter] = useState<BillFilter>('all');
	// A trilha das contas a pagar (SPD-131c): a tela se anuncia depois de carregar.
	useScreenTour('bills', { ready: !isLoading });
	const tourScroll = useTourScroll('bills');
	const addTarget = useTourTarget('bills.add');
	const emptyAddTarget = useTourTarget('bills.emptyAdd');
	const payTarget = useTourTarget('bills.pay');
	const undoTarget = useTourTarget('bills.undo');
	const listTarget = useTourTarget('bills.list');

	const currentKey = month.month;
	const isCurrentMonth = monthOffset === 0;
	const shownKey = shiftMonthKey(currentKey, monthOffset);
	const shown = isCurrentMonth ? month : billsOfMonth(bills, shownKey, today, payments);
	const shownRows = filterMonthRows(shown.rows, filter);
	const shownName = monthNameOf(shownKey);
	const toPayLabel = isCurrentMonth ? t('bills.toPay') : t('bills.toPayIn', { month: shownName });
	// Nada a pagar no mês porque uma conta foi pulada não é "Tudo pago" (SPD-156).
	const anySkipped = shown.rows.some((row) => row.status === 'skipped');
	const allPaidLabel = anySkipped
		? isCurrentMonth
			? t('bills.nothingOpen')
			: t('bills.nothingOpenIn', { month: shownName })
		: isCurrentMonth
			? t('bills.allPaid')
			: t('bills.allPaidIn', { month: shownName });
	const isPastMonth = shownKey < currentKey;
	// Para trás, só até onde o atraso conta (3 meses).
	const canGoBack = monthOffset > -BILL_OVERDUE_MONTHS;
	// O atraso de meses anteriores, à parte do total do mês (só no mês atual).
	const overdue = isCurrentMonth ? overdueBills(bills, currentKey, payments) : null;
	const overdueText =
		overdue && overdue.billCount > 0
			? overdue.cents > 0
				? t('bills.overdueNote', { amount: formatCents(overdue.cents), count: overdue.billCount })
				: t('bills.overdueNoteVariable', { count: overdue.billCount })
			: null;

	const inactive = bills.filter((bill) => !bill.active);
	const openBill = (bill: Bill) => {
		// A conta de exemplo não abre: a trilha é quem leva à edição dela.
		if (sample) return;
		router.push({ pathname: '/bills/edit/[id]', params: { id: bill.id } });
	};

	/**
	 * A ação de uma linha no mês mostrado: "Já paguei" no mês mais antigo em aberto da conta (e,
	 * no mês atual, também quando o mais antigo é de antes: aí quita ele); "Desfazer" no mês pago
	 * que pode reabrir (o último pago, ou o que tem registro) e no pulado. `target` é o mês que o
	 * "Já paguei" quita; `blockedBy`, num mês passado, o mês mais antigo que tem de ser quitado
	 * antes. `secondary` (SPD-146): "Não vou pagar este mês" no mês atrasado que o "Já paguei"
	 * quitaria, ou "Pagar só novembro" no mês atual com um anterior em aberto.
	 */
	const actionOf = (
		row: MonthBillRow
	): {
		kind: 'pay' | 'undo' | null;
		target: string | null;
		blockedBy: string | null;
		secondary: 'skip' | 'payOnly' | null;
	} => {
		if (row.status === 'paid' || row.status === 'skipped') {
			const kind = canUndoMonth(row.bill, shownKey, payments) ? 'undo' : null;
			return { kind, target: null, blockedBy: null, secondary: null };
		}
		const target = payableMonth(row.bill, currentKey, payments);
		if (target !== null && (target === shownKey || (isCurrentMonth && target < shownKey))) {
			const secondary = target < shownKey ? 'payOnly' : row.status === 'late' ? 'skip' : null;
			return { kind: 'pay', target, blockedBy: null, secondary };
		}
		return {
			kind: null,
			target: null,
			blockedBy: isPastMonth && target !== null && target < shownKey ? target : null,
			secondary: null,
		};
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
	 * mês que não é o atual, o título diz qual ("Quitar outubro?") e o texto, por quê; pagando
	 * fora de ordem, que o mês anterior continua em atraso (`intro`).
	 */
	const askToPost = (
		plan: Extract<BillPaymentPlan, { kind: 'post' }>,
		intro: { title: string; text: string } | null
	): Promise<PostChoice> =>
		new Promise((resolve) => {
			const amount = formatCents(plan.draft.amountCents);
			const account = accounts.find((item) => item.id === plan.draft.accountId)?.name;
			const body = account ? t('bills.pay.body', { amount, account }) : t('bills.pay.bodyNoAccount', { amount });
			Alert.alert(
				intro ? intro.title : t('bills.pay.title'),
				intro ? `${intro.text}\n\n${body}` : body,
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

	/**
	 * "Pagar só novembro?" — pagar o mês atual com um anterior em aberto (SPD-146): diz que o
	 * anterior continua em atraso. Quando não lança nada; lançando, o texto vai na pergunta de
	 * lançar.
	 */
	const confirmOutOfOrder = (
		plan: BillPaymentPlan,
		bill: Bill,
		month: string,
		older: string
	): Promise<boolean> =>
		new Promise((resolve) => {
			const names = { name: bill.name, month: monthNameOf(month), older: monthNameOf(older) };
			const text = t('bills.payOnly.body', names);
			Alert.alert(
				t('bills.payOnly.title', names),
				plan.kind === 'matched' ? `${text}\n\n${foundBodyOf(plan, month)}` : text,
				[
					{ text: t('bills.pay.cancel'), style: 'cancel', onPress: () => resolve(false) },
					{ text: t('bills.payOnly.confirm', names), onPress: () => resolve(true) },
				],
				{ cancelable: true, onDismiss: () => resolve(false) }
			);
		});

	/** "Não vai pagar outubro?" — nenhum lançamento é criado e o saldo não muda (SPD-146). */
	const confirmSkip = (bill: Bill, month: string): Promise<boolean> =>
		new Promise((resolve) => {
			const names = { name: bill.name, month: monthNameOf(month) };
			Alert.alert(
				t('bills.skip.title', names),
				t('bills.skip.body', names),
				[
					{ text: t('bills.pay.cancel'), style: 'cancel', onPress: () => resolve(false) },
					{ text: t('bills.skip.confirm'), onPress: () => resolve(true) },
				],
				{ cancelable: true, onDismiss: () => resolve(false) }
			);
		});

	const skip = async (bill: Bill, month: string) => {
		if (!(await confirmSkip(bill, month))) return;
		const skipped = await skipMonth(bill.id, month);
		if (skipped) {
			AccessibilityInfo.announceForAccessibility(
				t('bills.skip.done', { name: bill.name, month: monthNameOf(skipped) })
			);
		}
	};

	/**
	 * "Já paguei": quita o mês mais antigo em aberto — ou, com `only`, só o mês atual, fora de
	 * ordem (SPD-146), deixando o anterior em atraso.
	 */
	const pay = async (bill: Bill, only?: string) => {
		const oldest = payableMonth(bill, currentKey, payments);
		const target = only ?? oldest;
		if (!target) return;
		const older = target !== currentKey;
		const outOfOrder = only !== undefined && oldest !== null && oldest < only ? oldest : null;
		const plan = await planPayment(bill.id, only);
		if (!plan) return;

		let options: { post?: boolean; month?: string } | undefined = only
			? { month: only }
			: undefined;
		if (plan.kind === 'post') {
			const names = {
				name: bill.name,
				month: monthNameOf(target),
				older: outOfOrder ? monthNameOf(outOfOrder) : '',
			};
			const intro = outOfOrder
				? { title: t('bills.payOnly.title', names), text: t('bills.payOnly.body', names) }
				: older
					? {
							title: t('bills.pay.titleMonth', { month: names.month }),
							text: t('bills.pay.olderBody', { month: names.month, name: bill.name }),
						}
					: null;
			const choice = await askToPost(plan, intro);
			if (choice === 'cancel') return;
			options = { ...options, post: choice === 'post' };
		} else if (outOfOrder) {
			if (!(await confirmOutOfOrder(plan, bill, target, outOfOrder))) return;
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
		// O pagamento já estava lançado: diz o que achou (num mês anterior ou fora de ordem, a
		// pergunta já disse).
		if (result.kind === 'matched' && !older && !outOfOrder) {
			Alert.alert(t('bills.pay.foundTitle'), foundBodyOf(result, paidMonth));
		}
	};

	const toggle = async (row: MonthBillRow) => {
		// "Já paguei" e "Desfazer" do exemplo: sem efeito.
		if (sample) return;
		setBusyId(row.bill.id);
		try {
			if (row.status === 'skipped') {
				await undoPaid(row.bill.id, shownKey);
				AccessibilityInfo.announceForAccessibility(
					t('bills.skip.undone', { name: row.bill.name, month: shownName })
				);
			} else if (row.status === 'paid') {
				// Desfazer tira o lançamento quando foi o "Já paguei" que o criou (o id diz).
				const created = markPaidTransactionId(row.bill.id, shownKey);
				const removesPayment =
					row.bill.paidByRef === created ||
					paymentFor(payments, row.bill.id, shownKey)?.transactionId === created;
				// O mês mostrado, não "o último pago": com registro, o desfazer reabre exatamente ele.
				await undoPaid(row.bill.id, shownKey);
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

	/** A ação de baixo (SPD-146): pular o mês mostrado, ou pagar só ele fora de ordem. */
	const runSecondary = async (row: MonthBillRow, kind: 'skip' | 'payOnly') => {
		if (sample) return;
		setBusyId(row.bill.id);
		try {
			if (kind === 'skip') await skip(row.bill, shownKey);
			else await pay(row.bill, shownKey);
		} finally {
			setBusyId(null);
		}
	};

	const empty = !isLoading && bills.length === 0;
	// A trilha aponta o "Já paguei" e o "Desfazer" da primeira conta que tem cada um: um alvo só
	// por nome.
	const firstPayId = shownRows.find((row) => actionOf(row).kind === 'pay')?.bill.id ?? null;
	const firstUndoId = shownRows.find((row) => actionOf(row).kind === 'undo')?.bill.id ?? null;

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
				{/* O "?" da trilha das contas a pagar (SPD-131c), ao lado do título. */}
				<HelpButton trail="bills" here={{ screen: 'bills' }} from="2" />
				<Pressable
					{...addTarget}
					onPress={() => router.push('/bills/new')}
					accessibilityRole="button"
					accessibilityLabel={t('bills.add')}
					style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
				>
					<Ionicons name="add" size={28} color={ACCENT} />
				</Pressable>
			</View>

			{sample ? <SampleBanner /> : null}
			<ScrollView ref={tourScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				{empty ? (
					<View style={styles.emptyBox}>
						<Text style={styles.emptyText}>{t('bills.empty')}</Text>
						<Pressable
							{...emptyAddTarget}
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
					<View {...listTarget} style={styles.list}>
						{shownRows.map((row) => {
							const paid = row.status === 'paid' || row.status === 'skipped';
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
								? t(row.status === 'skipped' ? 'bills.skip.undoHint' : 'bills.undoPaidHint', {
										name: row.bill.name,
										month: shownName,
									})
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
										accessibilityLabel={[
											sample ? t('trails.sample.tag') : null,
											row.bill.name,
											subtitle,
											t(`bills.status.${row.status}`),
										]
											.filter(Boolean)
											.join(', ')}
										style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
									>
										<View style={styles.rowText}>
											<Text style={styles.rowName} numberOfLines={1}>
												{row.bill.name}
											</Text>
											<Text style={styles.rowSub}>{subtitle}</Text>
										</View>
										{sample ? <SampleTag /> : null}
										<BillStatusPill status={row.status} />
									</Pressable>
									{action.blockedBy ? (
										<Text style={styles.rowNote}>
											{t('bills.payOlderFirst', { month: monthNameOf(action.blockedBy) })}
										</Text>
									) : null}
									{action.kind ? (
										<Pressable
											{...(action.kind === 'pay' && row.bill.id === firstPayId ? payTarget : {})}
											{...(action.kind === 'undo' && row.bill.id === firstUndoId ? undoTarget : {})}
											onPress={() => toggle(row)}
											disabled={busyId === row.bill.id}
											accessibilityRole="button"
											accessibilityLabel={actionLabel}
											accessibilityHint={actionHint}
											style={({ pressed }) => [
												styles.rowAction,
												paid ? styles.rowActionUndo : styles.rowActionPay,
												!action.secondary && styles.rowActionLast,
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
									{action.secondary ? (
										<Pressable
											onPress={() => runSecondary(row, action.secondary ?? 'skip')}
											disabled={busyId === row.bill.id}
											accessibilityRole="button"
											accessibilityLabel={
												action.secondary === 'skip'
													? t('bills.skip.action')
													: t('bills.payOnly.action', { month: shownName })
											}
											accessibilityHint={
												action.secondary === 'skip'
													? t('bills.skip.hint', { name: row.bill.name, month: shownName })
													: t('bills.payOnly.hint', {
															name: row.bill.name,
															month: shownName,
															older: monthNameOf(action.target ?? shownKey),
														})
											}
											style={({ pressed }) => [
												styles.rowAction,
												styles.rowActionUndo,
												styles.rowActionLast,
												pressed && styles.pressed,
											]}
										>
											<Ionicons
												name={
													action.secondary === 'skip'
														? 'close-circle-outline'
														: 'checkmark-done-outline'
												}
												size={18}
												color="#FFFFFF"
											/>
											<Text style={styles.rowActionText}>
												{action.secondary === 'skip'
													? t('bills.skip.action')
													: t('bills.payOnly.action', { month: shownName })}
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
	// A borda existe sempre, transparente; a atrasada só troca a cor. Sem `overflow: 'hidden'`:
	// com ele, o cartão que perdia um botão (atrasada → paga ou pulada) ficava em branco no
	// Android até a tela redesenhar (SPD-156). Os cantos de baixo vêm do último botão
	// (`rowActionLast`).
	row: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		borderWidth: 1,
		borderColor: 'transparent',
	},
	rowLate: {
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
	// O raio do cartão menos a borda de 1px: o fundo do botão acompanha o canto do cartão.
	rowActionLast: {
		borderBottomLeftRadius: 11,
		borderBottomRightRadius: 11,
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
