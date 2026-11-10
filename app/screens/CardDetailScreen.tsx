import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CardFace from '../components/cards/CardFace';
import { ACCENT, Button, ChipGroup, type ChipOption, Field } from '../components/cards/formParts';
import RenameCardSheet from '../components/cards/RenameCardSheet';
import Sheet from '../components/cards/Sheet';
import HorizontalCategoryPicker from '../components/HorizontalCategoryPicker';
import TransactionItem from '../components/TransactionItem';
import HelpButton from '../components/tour/HelpButton';
import { TourTarget, useScreenTour, useTourScroll, useTourTarget } from '../components/tour/TourContext';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { getAccountTransfers } from '../database/database';
import type { Account, Transaction } from '../database/schema';
import { accountPairKey } from '../utils/accountBinding';
import { findCheckingForCard } from '../utils/accountResolver';
import { capitalizeFirst } from '../utils/capitalize';
import { dismissCardDuplicates, getDismissedCardDuplicates } from '../utils/cardDuplicateDismissals';
import { type CardDuplicateEntry, cardPaymentEntries, findCardDuplicates, summarizeCardDuplicates } from '../utils/cardDuplicates';
import {
	CARD_CHARGE_NOTE,
	type CardChargeKind,
	type CardChargeShown,
	cardChargeDate,
	cardChargeKindOf,
	cardChargeShown,
	chargeMonthOptions,
	cycleFor,
	cycleRuleOf,
	existingInstallmentDates,
	invoiceDueCents,
	invoiceMonthOf,
	invoiceStatusOf,
	type InvoiceView,
	isCardAdjustment,
	isCardCharge,
	isCardNonPurchase,
	openInvoiceInformed,
	splitCardCharges,
} from '../utils/cardMath';
import { usageByCard } from '../utils/cardNames';
import { findRefusedCardPayment } from '../utils/cardPaymentNotice';
import { addDays, formatDayMonth, formatMonthLong, formatMonthShort, todayISO } from '../utils/dateUtils';
import { centsToDisplayInput, formatCents, parseAmountToCents } from '../utils/money';

/**
 * Um cartão por inteiro.
 *
 * De cima para baixo: o cartão (o que já se vê na tela inicial), as quatro coisas que se
 * faz com ele (pagar a fatura, acertar o valor com o banco, cadastrar uma parcela antiga,
 * registrar um encargo), as faturas mês a mês com os lançamentos de cada uma e o que o app
 * não vê nelas (juros, IOF, anuidade), o limite explicado, as parcelas que ainda vão cair,
 * e as datas que decidem quando comprar.
 *
 * As faturas são abas horizontais, uma por mês, com o valor na própria aba: dá para
 * comparar meses sem abrir nenhum. A aba aberta vem selecionada.
 */

const ROW_GAP = 12;

/** A fatura leva o nome do mês em que vence, que é a chave dela. */
const invoiceMonth = (invoice: InvoiceView): string => `${invoice.cycle.key}-01`;

interface CardDetailScreenProps {
	cardId: string;
}

type SheetKind = 'pay' | 'adjust' | 'installments' | 'charge' | null;

/** Os tipos que a folha "Registrar encargo" oferece; `bank` é só do "Acertar valor". */
const CHARGE_KINDS: CardChargeKind[] = ['interest', 'iof', 'annualFee', 'fee', 'other'];

/** Quanto o aviso do "Pagar fatura" fica na tela: oito segundos, como a barra de desfazer da caixa de avisos. */
const PAY_NOTICE_MS = 8000;

const CardDetailScreen: React.FC<CardDetailScreenProps> = ({ cardId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const {
		accounts,
		bankAccounts,
		cardSummaries,
		recordCardPayment,
		adjustCardInvoices,
		addCardCharge,
		addExistingInstallments,
		renameCard,
	} = useAccounts();
	const { transactions, categories } = useTransactions();

	const card: Account | undefined = accounts.find((account) => account.id === cardId && account.kind === 'credit_card');
	const summary = card ? cardSummaries.get(card.id) : undefined;

	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [sheet, setSheet] = useState<SheetKind>(null);
	// Filtro da lista da fatura por cartão: undefined = todos, null = sem cartão identificado.
	const [cardFilter, setCardFilter] = useState<string | null | undefined>(undefined);
	const [renaming, setRenaming] = useState<{ last4: string; name: string | null } | null>(null);
	// O "Como funciona?" dos encargos: fechado, para não empurrar as faturas para baixo.
	const [howOpen, setHowOpen] = useState(false);
	// O resultado do "Pagar fatura" (SPD-133): a folha fecha e a frase fica na tela por alguns
	// segundos. Cada resultado é um objeto novo: a mesma frase de novo recomeça a contagem.
	const [payNotice, setPayNotice] = useState<{ text: string } | null>(null);
	useEffect(() => {
		if (!payNotice) return undefined;
		const timer = setTimeout(() => setPayNotice(null), PAY_NOTICE_MS);
		return () => clearTimeout(timer);
	}, [payNotice]);
	// O guia da tela do cartão (SPD-129): abre com o cartão carregado e sem folha aberta.
	useScreenTour('card', { ready: Boolean(card && summary), blocked: sheet !== null || renaming !== null });
	const tourScroll = useTourScroll('card');

	// Abre na fatura atual, e volta para ela quando a escolhida some da lista (virou o
	// ciclo, ou uma fatura futura zerou) — senão o painel sumiria.
	useEffect(() => {
		if (!summary?.openCycle) return;
		if (!selectedKey || !summary.invoices.some((invoice) => invoice.cycle.key === selectedKey)) {
			setSelectedKey(summary.openCycle.key);
		}
	}, [selectedKey, summary]);

	const cardTransactions = useMemo(
		() => transactions.filter((tx) => tx.accountId === cardId),
		[transactions, cardId]
	);

	// Provável repetido (E2E-34): o mesmo valor com até um dia de diferença neste cartão. O app
	// só marca; quem apaga é o dono, pela tela do lançamento. "Não é repetido" vai com a conta e no backup.
	const [dismissedDuplicates, setDismissedDuplicates] = useState<ReadonlySet<string>>(() => new Set());
	const [onlyDuplicates, setOnlyDuplicates] = useState(false);
	useEffect(() => {
		let alive = true;
		getDismissedCardDuplicates().then((dismissed) => {
			if (alive) setDismissedDuplicates(dismissed);
		});
		return () => {
			alive = false;
		};
	}, []);
	// Os pagamentos da fatura entram na marcação (SPD-124): o "Pagar fatura" de um cartão e o
	// "Pagamento recebido" do extrato no outro ficam os dois aqui depois de juntar. São
	// transferências, lidas de novo a cada resumo novo do cartão (pagou, juntou, apagou).
	const [cardPayments, setCardPayments] = useState<CardDuplicateEntry[]>([]);
	useEffect(() => {
		let alive = true;
		const load = async () => {
			if (!summary) return;
			try {
				const payments = cardPaymentEntries(await getAccountTransfers(cardId), cardId);
				if (alive) setCardPayments(payments);
			} catch {
				// Sem ler as transferências, os pagamentos só não são marcados.
			}
		};
		load();
		return () => {
			alive = false;
		};
	}, [cardId, summary]);
	const duplicates = useMemo(
		() => findCardDuplicates<CardDuplicateEntry>([...cardTransactions, ...cardPayments], dismissedDuplicates),
		[cardTransactions, cardPayments, dismissedDuplicates]
	);

	// Cartão juntado ou excluído (E2E-40): o cabeçalho com voltar, como no resto da tela. Aberta
	// direto, sem tela antes, o voltar leva à lista de cartões.
	if (!card) {
		return (
			<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
				<Stack.Screen options={{ headerShown: false }} />
				<View style={styles.header}>
					<Pressable
						onPress={() => (router.canGoBack() ? router.back() : router.replace('/cards'))}
						accessibilityRole="button"
						accessibilityLabel={t('cards.back')}
						style={styles.iconButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
				</View>
				<Text style={styles.missing} accessibilityRole="header">
					{t('cards.notFound')}
				</Text>
			</SafeAreaView>
		);
	}

	const selected: InvoiceView | undefined = summary?.invoices.find((invoice) => invoice.cycle.key === selectedKey);
	const inSelected = (date: string) => Boolean(selected) && date >= (selected as InvoiceView).cycle.start && date <= (selected as InvoiceView).cycle.end;
	// A lista soma o valor da fatura. O que é de antes da âncora não soma — já está no valor
	// informado — e aparece à parte, embaixo de uma linha que diz isso: sumir com a compra
	// fazia o dono procurá-la, e somá-la faria achar que contou duas vezes.
	const selectedTransactions = cardTransactions
		.filter((tx) => inSelected(tx.date) && tx.date > card.openingBalanceDate)
		.sort((a, b) => b.date.localeCompare(a.date));
	const beforeAnchor = cardTransactions
		.filter((tx) => inSelected(tx.date) && tx.date <= card.openingBalanceDate)
		.sort((a, b) => b.date.localeCompare(a.date));
	const selectedPending = (summary?.pendingEntries ?? []).filter((entry) => inSelected(entry.date));
	// Os prováveis repetidos da fatura na tela: o grupo conta quando algum lançamento dele está
	// nela — o par pode cair um de cada lado do fechamento.
	// Os pagamentos da fatura na tela também (SPD-124); os marcados aparecem logo abaixo do
	// aviso, que eles não estão na lista de lançamentos.
	const selectedPayments = cardPayments.filter((payment) => inSelected(payment.date));
	const selectedDuplicates = summarizeCardDuplicates(
		duplicates.groups,
		new Set([...selectedTransactions, ...beforeAnchor, ...selectedPayments].map((entry) => entry.id))
	);
	const markedPayments = selectedPayments
		.filter((payment) => duplicates.partners.has(payment.id))
		.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
	const showOnlyDuplicates = onlyDuplicates && selectedDuplicates.count > 0;
	const matchesDuplicates = (id: string) => !showOnlyDuplicates || selectedDuplicates.ids.has(id);
	// Quem gastou nesta fatura: o físico e cada virtual. A fatura é uma só; isto é o "por cartão".
	// O ajuste com a fatura do banco e o encargo (juros, anuidade) não são compra de cartão
	// nenhum: ficam fora.
	const usage = usageByCard(
		[...selectedTransactions.filter((tx) => !isCardNonPurchase(tx)), ...selectedPending],
		card.cardNames,
		card.last4
	);
	const showUsage = usage.filter((item) => item.count > 0).length > 1 || usage.some((item) => item.last4 !== null && item.last4 !== card.last4);
	const matchesFilter = (last4: string | null | undefined) => cardFilter === undefined || (last4 ?? null) === cardFilter;
	const cardLabel = (last4: string | null, name: string | null) =>
		last4 === null ? t('cards.byCard.unknown') : (name ?? t('cards.finalLabel', { last4 }));
	const anchorDateInSelected = Boolean(selected) && inSelected(card.openingBalanceDate);
	const anchorInSelected = anchorDateInSelected && card.openingBalanceCents !== 0;
	// As compras de antes da âncora estão "no valor informado" quando houve valor: a âncora
	// dele, ou o ajuste do cadastro antigo (âncora zero e ajuste no dia seguinte). Sem nada
	// informado, o cartão começou do zero no cadastro e elas ficam fora da fatura — a tela
	// diz isso, em vez de afirmar que estão num valor que ninguém informou.
	// O pagamento de antes da âncora também já está no valor (E2E-38): não abate a fatura e não
	// é "pagamento antecipado" — aparece aqui, junto das compras de antes.
	const coveredPayments = selected?.coveredPayments ?? [];
	const coveredKeys = new Map<string, number>();
	const showBeforeAnchor = anchorDateInSelected && (beforeAnchor.length > 0 || coveredPayments.length > 0);
	const beforeAnchorInformed = anchorInSelected || selectedTransactions.some((tx) => isCardAdjustment(tx));
	const today = todayISO();
	// O que ainda falta pagar da fatura escolhida (SPD-108): o número do lembrete e da tela
	// inicial (`invoiceDueCents`; na fechada, o "a pagar" do resumo). Aparece embaixo das
	// linhas que mexem no valor — pagamento, valor informado, saldo anterior, crédito —, e só
	// quando há alguma: sem elas, repetiria o valor da fatura. As anteriores à fechada não têm:
	// o que ficou delas está no saldo anterior da fechada, e o status já diz.
	const dueCents = selected && summary ? invoiceDueCents(selected, summary) : 0;
	const dueExplained =
		selected !== undefined &&
		selected.offset >= -1 &&
		(selected.paidCents > 0 ||
			anchorInSelected ||
			selected.previousUnpaidCents > 0 ||
			selected.creditAppliedCents > 0 ||
			coveredPayments.length > 0);
	const showLeftToPay = dueExplained && dueCents > 0;
	// Quitada, a linha diz "Paga", como o status das fechadas, e não "Falta pagar R$ 0,00". Na
	// fechada o status já diz "Paga": a linha só aparece na aberta e nas futuras, cujo status
	// é "Aberta · fecha…" — o antecipado ou o crédito cobriu tudo, até entrar compra nova.
	const showSettled =
		dueExplained &&
		dueCents === 0 &&
		selected !== undefined &&
		selected.offset >= 0 &&
		selected.amountCents + selected.previousUnpaidCents > 0;

	// O encargo é gravado com a nota-marcador em português (é o que o reconhece); na lista da
	// fatura ele aparece com o tipo no idioma do app. Nota editada à mão fica como está.
	const shownNote = <T extends { note: string }>(tx: T): T => {
		if (!isCardCharge(tx)) return tx;
		const kind = cardChargeKindOf(tx.note);
		if (tx.note.trim() === CARD_CHARGE_NOTE) return { ...tx, note: t('cards.charges.listLabelOther') };
		if (kind === null || kind === 'other') return tx;
		return { ...tx, note: t('cards.charges.listLabel', { kind: t(`cards.charges.kinds.${kind}`) }) };
	};

	const dismissDuplicates = async (keys: string[]) => {
		try {
			setDismissedDuplicates(await dismissCardDuplicates(keys));
			AccessibilityInfo.announceForAccessibility(t('cards.duplicates.dismissed'));
		} catch {
			// Sem gravar, a marca fica: o dono pode tentar de novo, e nada se perdeu.
		}
	};

	/** A linha embaixo do marcado: com quem ele pode ser o mesmo, e o "Não é repetido". */
	const renderDuplicateRow = (id: string, partnerIds: string[], entries: string) => (
		<View style={styles.duplicateRow}>
			<Ionicons name="copy-outline" size={16} color="#FFD166" />
			<Text style={styles.duplicateText}>{t('cards.duplicates.pairWith', { entries })}</Text>
			<Pressable
				testID={`notDuplicate:${id}`}
				onPress={() => dismissDuplicates(partnerIds.map((partnerId) => accountPairKey(id, partnerId)))}
				accessibilityRole="button"
				accessibilityLabel={t('cards.duplicates.notDuplicate')}
				accessibilityHint={t('cards.duplicates.notDuplicateHint')}
				hitSlop={8}
				style={({ pressed }) => pressed && styles.pressed}
			>
				<Text style={styles.duplicateAction}>{t('cards.duplicates.notDuplicate')}</Text>
			</Pressable>
		</View>
	);

	/** Um lançamento da fatura e, quando ele tem provável par, a linha que diz com qual. */
	const renderTransaction = (transaction: Transaction, shown: Transaction = transaction) => {
		const partnerIds = duplicates.partners.get(transaction.id);
		const partners = (partnerIds ?? []).flatMap((id) => cardTransactions.filter((tx) => tx.id === id));
		const open = (tx: Transaction) => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } });
		if (!partnerIds || partners.length === 0) return <TransactionItem key={transaction.id} transaction={shown} onPress={open} />;
		const entries = partners
			.map((partner) => `${shownNote(partner).note || t('transactionsList.noDescription')}, ${formatDayMonth(partner.date)}`)
			.join('; ');
		return (
			<View key={transaction.id}>
				<TransactionItem transaction={shown} onPress={open} />
				{renderDuplicateRow(transaction.id, partnerIds, entries)}
			</View>
		);
	};

	/**
	 * Um pagamento de fatura marcado como provável repetido (SPD-124) e o par dele. Abre a
	 * edição da transferência, que também a exclui — pagamento não tem tela de detalhe.
	 */
	const renderPayment = (payment: CardDuplicateEntry) => {
		const partnerIds = duplicates.partners.get(payment.id) ?? [];
		const label = t('cards.duplicates.paymentLabel', { date: formatDayMonth(payment.date) });
		const entries = partnerIds
			.flatMap((id) => cardPayments.filter((other) => other.id === id))
			.map((partner) => t('cards.duplicates.paymentLabel', { date: formatDayMonth(partner.date) }))
			.join('; ');
		return (
			<View key={payment.id}>
				<Pressable
					onPress={() => router.push({ pathname: '/transaction/edit/[id]', params: { id: payment.id, kind: 'transfer' } })}
					accessibilityRole="button"
					accessibilityLabel={`${label}, ${formatCents(payment.amountCents)}`}
					accessibilityHint={t('cards.duplicates.paymentHint')}
					style={({ pressed }) => [styles.anchorRow, pressed && styles.pressed]}
				>
					<Ionicons name="checkmark-circle-outline" size={18} color="#81C784" />
					<Text style={styles.anchorText}>{label}</Text>
					<Text style={[styles.anchorAmount, styles.paidAmount]}>{formatCents(payment.amountCents)}</Text>
				</Pressable>
				{renderDuplicateRow(payment.id, partnerIds, entries)}
			</View>
		);
	};

	const invoiceStatus = (invoice: InvoiceView): string => {
		const due = formatDayMonth(invoice.cycle.dueDate);
		if (!summary) return t('cards.invoice.closed', { due });
		const status = invoiceStatusOf(invoice, summary, today);
		switch (status.kind) {
			case 'open':
				return t('cards.invoice.open', { closing: formatDayMonth(invoice.cycle.closingDate), due });
			case 'future':
				return t('cards.invoice.future', { due });
			case 'overdue':
				return t('cards.invoice.overdue', { due, amount: formatCents(status.amountCents) });
			case 'toPay':
				return t('cards.invoice.closedToPay', { due, amount: formatCents(status.amountCents) });
			case 'paid':
				return t('cards.invoice.paid');
			case 'closedUpcoming':
				return t('cards.invoice.closedUpcoming', { due });
			case 'leftOpen':
				return t('cards.invoice.leftOpen', { due, amount: formatCents(status.amountCents) });
			default:
				return t('cards.invoice.closed', { due });
		}
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('cards.back')} style={styles.iconButton}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
					{card.name}
				</Text>
				<HelpButton screen="card" />
				<Pressable
					onPress={() => router.push({ pathname: '/cards/edit/[id]', params: { id: card.id } })}
					accessibilityRole="button"
					accessibilityLabel={t('cards.editCard')}
					style={styles.iconButton}
				>
					<Ionicons name="create-outline" size={24} color="#FFFFFF" />
				</Pressable>
			</View>

			<ScrollView ref={tourScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<TourTarget id="card.face">
					<CardFace card={card} summary={summary} />
				</TourTarget>

				<View style={styles.actions}>
					<ActionTile tourId="card.pay" icon="cash-outline" label={t('cards.actions.pay')} onPress={() => setSheet('pay')} />
					<ActionTile tourId="card.adjust" icon="scale-outline" label={t('cards.actions.adjust')} onPress={() => setSheet('adjust')} />
					<ActionTile tourId="card.installments" icon="layers-outline" label={t('cards.actions.installments')} onPress={() => setSheet('installments')} />
					<ActionTile tourId="card.charge" icon="receipt-outline" label={t('cards.charges.action')} onPress={() => setSheet('charge')} />
				</View>

				{summary && !summary.configured ? (
					<Pressable
						onPress={() => router.push({ pathname: '/cards/edit/[id]', params: { id: card.id } })}
						accessibilityRole="button"
						accessibilityLabel={`${t('cards.setupTitle')}. ${t('cards.setupBody')}`}
						style={({ pressed }) => [styles.notice, pressed && styles.pressed]}
					>
						<Ionicons name="calendar-outline" size={22} color={ACCENT} />
						<View style={styles.flex}>
							<Text style={styles.noticeTitle}>{t('cards.setupTitle')}</Text>
							<Text style={styles.noticeBody}>{t('cards.setupBody')}</Text>
						</View>
						<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.6)" />
					</Pressable>
				) : null}

				{summary?.configured && summary.invoices.length > 0 ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.invoice.title')}
						</Text>
						<TourTarget id="card.invoices">
						<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
							{summary.invoices.map((invoice) => {
								const isSelected = invoice.cycle.key === selectedKey;
								// "Nov · atual": maiúscula só na primeira letra (E2E-46).
								const month = capitalizeFirst(formatMonthShort(invoiceMonth(invoice)));
								return (
									<Pressable
										key={invoice.cycle.key}
										onPress={() => setSelectedKey(invoice.cycle.key)}
										accessibilityRole="tab"
										accessibilityState={{ selected: isSelected }}
										accessibilityLabel={`${t('cards.invoice.of', { month: formatMonthLong(invoiceMonth(invoice)) })}, ${formatCents(invoice.amountCents)}. ${invoiceStatus(invoice)}`}
										style={({ pressed }) => [styles.tab, isSelected && styles.tabSelected, pressed && styles.pressed]}
									>
										<Text style={[styles.tabMonth, isSelected && styles.tabTextSelected]}>
											{month}
											{invoice.offset === 0 ? ` · ${t('cards.invoice.current')}` : ''}
										</Text>
										<Text style={[styles.tabAmount, isSelected && styles.tabTextSelected]}>{formatCents(invoice.amountCents)}</Text>
									</Pressable>
								);
							})}
						</ScrollView>
						</TourTarget>

						{selected ? (
							<View style={styles.panel}>
								<Text style={styles.panelTitle}>{t('cards.invoice.of', { month: formatMonthLong(invoiceMonth(selected)) })}</Text>
								<Text style={styles.panelAmount}>{formatCents(selected.amountCents)}</Text>
								<Text style={styles.panelStatus}>{invoiceStatus(selected)}</Text>
								<Text style={styles.panelMeta}>
									{t('cards.invoice.period', { start: formatDayMonth(selected.cycle.start), end: formatDayMonth(selected.cycle.end) })}
								</Text>

								{selectedDuplicates.count > 0 ? (
									<TourTarget id="card.duplicates">
									<DuplicatesNotice
										count={selectedDuplicates.count}
										extraCents={selectedDuplicates.extraCents}
										paymentExtraCents={selectedDuplicates.paymentExtraCents}
										onlyMarked={showOnlyDuplicates}
										onPress={() => setOnlyDuplicates((only) => !only)}
									/>
									</TourTarget>
								) : null}

								{/* Pagamento não tem final: com o filtro por cartão, fica de fora, como na lista. */}
								{cardFilter === undefined ? markedPayments.map(renderPayment) : null}

								{selected.previousUnpaidCents > 0 ? (
									<View
										style={styles.anchorRow}
										accessible
										accessibilityLabel={`${t('cards.invoice.previousUnpaid')}, ${formatCents(selected.previousUnpaidCents)}`}
									>
										<Ionicons name="alert-circle-outline" size={18} color="#FFD166" />
										<Text style={styles.anchorText}>{t('cards.invoice.previousUnpaid')}</Text>
										<Text style={styles.anchorAmount}>{formatCents(selected.previousUnpaidCents)}</Text>
									</View>
								) : null}

								{anchorInSelected ? (
									<View style={styles.anchorRow} accessible accessibilityLabel={`${t('cards.invoice.informed', { date: formatDayMonth(card.openingBalanceDate) })}, ${formatCents(-card.openingBalanceCents)}`}>
										<Ionicons name="scale-outline" size={18} color="rgba(255,255,255,0.8)" />
										<Text style={styles.anchorText}>{t('cards.invoice.informed', { date: formatDayMonth(card.openingBalanceDate) })}</Text>
										<Text style={styles.anchorAmount}>{formatCents(-card.openingBalanceCents)}</Text>
									</View>
								) : null}

								{selected.paidCents > 0 ? (
									<View
										style={styles.anchorRow}
										accessible
										accessibilityLabel={`${selected.offset === 0 ? t('cards.invoice.advance') : t('cards.invoice.paidRow')}, ${formatCents(selected.paidCents)}`}
									>
										<Ionicons name="checkmark-circle-outline" size={18} color="#81C784" />
										<Text style={styles.anchorText}>{selected.offset === 0 ? t('cards.invoice.advance') : t('cards.invoice.paidRow')}</Text>
										<Text style={[styles.anchorAmount, styles.paidAmount]}>{formatCents(selected.paidCents)}</Text>
									</View>
								) : null}

								{showLeftToPay ? (
									<View style={styles.anchorRow} accessible accessibilityLabel={`${t('cards.invoice.leftToPay')}, ${formatCents(dueCents)}`}>
										<Ionicons name="wallet-outline" size={18} color="#FFFFFF" />
										<Text style={styles.anchorText}>{t('cards.invoice.leftToPay')}</Text>
										<Text style={styles.anchorAmount}>{formatCents(dueCents)}</Text>
									</View>
								) : null}

								{showSettled ? (
									<View style={styles.anchorRow} accessible accessibilityLabel={t('cards.invoice.paid')}>
										<Ionicons name="checkmark-done-outline" size={18} color="#81C784" />
										<Text style={styles.anchorText}>{t('cards.invoice.paid')}</Text>
									</View>
								) : null}

								{showUsage ? (
									<View style={styles.usage}>
										<Text style={styles.usageTitle} accessibilityRole="header">
											{t('cards.byCard.title')}
										</Text>
										{usage.map((item) => {
											const selectedRow = cardFilter !== undefined && cardFilter === item.last4;
											const label = cardLabel(item.last4, item.name);
											return (
												<View key={item.last4 ?? 'none'} style={styles.usageRow}>
													<Pressable
														onPress={() => setCardFilter(selectedRow ? undefined : item.last4)}
														accessibilityRole="button"
														accessibilityState={{ selected: selectedRow }}
														accessibilityLabel={`${label}, ${formatCents(item.totalCents)}, ${t('cards.byCard.purchases', { count: item.count })}`}
														accessibilityHint={selectedRow ? t('cards.byCard.clearHint') : t('cards.byCard.filterHint')}
														style={({ pressed }) => [styles.usageMain, selectedRow && styles.usageSelected, pressed && styles.pressed]}
													>
														<View style={styles.flex}>
															<Text style={[styles.usageName, selectedRow && styles.usageNameSelected]} numberOfLines={1}>
																{label}
															</Text>
															<Text style={styles.usageMeta}>
																{item.last4 ? `•••• ${item.last4} · ` : ''}
																{t('cards.byCard.purchases', { count: item.count })}
															</Text>
														</View>
														<Text style={styles.usageAmount}>{formatCents(item.totalCents)}</Text>
													</Pressable>
													{item.last4 ? (
														<Pressable
															onPress={() => setRenaming({ last4: item.last4 as string, name: item.name })}
															accessibilityRole="button"
															accessibilityLabel={t('cards.rename.actionFor', { card: label })}
															style={styles.iconButton}
														>
															<Ionicons name="pencil-outline" size={20} color="rgba(255,255,255,0.85)" />
														</Pressable>
													) : null}
												</View>
											);
										})}
									</View>
								) : null}

								{selectedPending.filter((entry) => matchesFilter(entry.cardLast4) && !showOnlyDuplicates).map((entry) => (
									<Pressable
										key={entry.id}
										onPress={() => router.push('/inbox')}
										accessibilityRole="button"
										accessibilityLabel={`${entry.note}, ${formatCents(entry.amountCents)}. ${t('cards.invoice.pendingReview')}`}
										accessibilityHint={t('cards.invoice.pendingHint')}
										style={({ pressed }) => [styles.anchorRow, pressed && styles.pressed]}
									>
										<Ionicons name="time-outline" size={18} color="#FFD166" />
										<View style={styles.flex}>
											<Text style={styles.anchorText} numberOfLines={1}>
												{entry.note}
											</Text>
											<Text style={styles.pendingLabel}>{t('cards.invoice.pendingReview')}</Text>
										</View>
										<Text style={styles.anchorAmount}>{formatCents(entry.isIncome ? -entry.amountCents : entry.amountCents)}</Text>
									</Pressable>
								))}

								{selectedTransactions.length === 0 &&
								selectedPending.length === 0 &&
								!anchorInSelected &&
								!showBeforeAnchor &&
								selected.previousUnpaidCents === 0 ? (
									<Text style={styles.empty}>{t('cards.invoice.empty')}</Text>
								) : (
									selectedTransactions
										.filter((transaction) => matchesFilter(transaction.cardLast4) && matchesDuplicates(transaction.id))
										.map((transaction) => renderTransaction(transaction, shownNote(transaction)))
								)}

								{showBeforeAnchor ? (
									<>
										{beforeAnchor.length > 0 ? (
											<>
												<Text style={styles.covered}>
													{beforeAnchorInformed
														? t('cards.invoice.coveredByAnchor', { count: beforeAnchor.length })
														: t('cards.invoice.beforeStart', { count: beforeAnchor.length })}
												</Text>
												<View style={styles.coveredList}>
													{beforeAnchor
														.filter((transaction) => matchesFilter(transaction.cardLast4) && matchesDuplicates(transaction.id))
														.map((transaction) => renderTransaction(transaction))}
												</View>
											</>
										) : null}
										{coveredPayments.map((payment) => {
											const label = beforeAnchorInformed
												? t('cards.invoice.paymentCovered', { date: formatDayMonth(payment.date) })
												: t('cards.invoice.paymentBeforeStart', { date: formatDayMonth(payment.date) });
											// Pagamento não tem id aqui: dois iguais no mesmo dia levam o número da vez.
											const base = `${payment.date}:${payment.amountCents}`;
											const repeat = (coveredKeys.get(base) ?? 0) + 1;
											coveredKeys.set(base, repeat);
											return (
												<View
													key={`${base}:${repeat}`}
													style={styles.anchorRow}
													accessible
													accessibilityLabel={`${label}, ${formatCents(payment.amountCents)}`}
												>
													<Ionicons name="checkmark-circle-outline" size={18} color="rgba(255,255,255,0.6)" />
													<Text style={styles.anchorText}>{label}</Text>
													<Text style={styles.anchorAmount}>{formatCents(payment.amountCents)}</Text>
												</View>
											);
										})}
									</>
								) : null}
							</View>
						) : null}
					</View>
				) : null}

				{/* O que o app não vê na fatura: juros, IOF, anuidade, tarifas (E2E-20). */}
				<View style={styles.chargesNote}>
					<View style={styles.chargesRow}>
						<Ionicons name="information-circle-outline" size={20} color="rgba(255,255,255,0.8)" />
						<Text style={styles.chargesText}>{t('cards.charges.explain')}</Text>
					</View>
					<Pressable
						onPress={() => setHowOpen((open) => !open)}
						accessibilityRole="button"
						accessibilityState={{ expanded: howOpen }}
						accessibilityLabel={howOpen ? t('cards.charges.howHide') : t('cards.charges.howTitle')}
						style={({ pressed }) => [styles.howButton, pressed && styles.pressed]}
					>
						<Text style={styles.howLabel}>{t('cards.charges.howTitle')}</Text>
						<Ionicons name={howOpen ? 'chevron-up' : 'chevron-down'} size={18} color={ACCENT} />
					</Pressable>
					{howOpen ? <Text style={styles.chargesHow}>{t('cards.charges.how')}</Text> : null}
				</View>

				{summary ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.limit.title')}
						</Text>
						<View style={styles.panel}>
							{summary.limitCents !== null ? (
								<>
									<View
										style={styles.track}
										accessible
										accessibilityLabel={t('cards.limit.usage', { percent: summary.limitUsagePercent ?? 0 })}
									>
										<View
											style={[
												styles.fill,
												{ width: `${Math.min(100, summary.limitUsagePercent ?? 0)}%` },
												(summary.limitUsagePercent ?? 0) >= 90 && styles.fillDanger,
											]}
										/>
									</View>
									<View style={styles.limitNumbers}>
										<Stat label={t('cards.limit.used')} value={formatCents(summary.limitUsedCents)} />
										<Stat
											label={t('cards.limit.available')}
											value={formatCents(summary.limitAvailableCents ?? 0)}
											tone={(summary.limitAvailableCents ?? 0) < 0 ? 'danger' : 'default'}
										/>
										<Stat label={t('cards.limit.total')} value={formatCents(summary.limitCents)} />
									</View>
								</>
							) : (
								<Text style={styles.empty}>{t('cards.limit.noLimit')}</Text>
							)}
							<Line label={t('cards.limit.owed')} value={formatCents(summary.owedCents)} />
							<Line label={t('cards.limit.future')} value={formatCents(summary.futureCommittedCents)} />
							{summary.creditCents > 0 ? <Line label={t('cards.limit.credit')} value={formatCents(summary.creditCents)} /> : null}
						</View>
					</View>
				) : null}

				{summary && summary.installmentPlans.length > 0 ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.plans.title')}
						</Text>
						<View style={styles.panel}>
							{summary.installmentPlans.map((plan, index) => {
								const done = plan.totalCount - plan.remainingCount;
								const text = t('cards.plans.line', {
									parcel: formatCents(plan.parcelCents),
									remaining: plan.remainingCount,
									total: plan.totalCount,
									// O mês da fatura que cobra a última parcela, não o mês em que ela está datada.
									last: formatMonthShort(`${invoiceMonthOf(plan.lastDate, cycleRuleOf(card))}-01`),
								});
								return (
									<View
										key={plan.group}
										style={[styles.plan, index > 0 && styles.planBorder]}
										accessible
										accessibilityLabel={`${plan.note}. ${text}. ${t('cards.plans.remainingTotal', { amount: formatCents(plan.remainingCents) })}`}
									>
										<View style={styles.flex}>
											<Text style={styles.planName} numberOfLines={1}>
												{plan.note}
											</Text>
											<Text style={styles.planMeta}>{text}</Text>
											<View style={styles.planTrack}>
												<View style={[styles.planFill, { width: `${Math.round((done / Math.max(1, plan.totalCount)) * 100)}%` }]} />
											</View>
										</View>
										<Text style={styles.planAmount}>{formatCents(plan.remainingCents)}</Text>
									</View>
								);
							})}
						</View>
					</View>
				) : null}

				{summary?.configured && summary.openCycle && card.closingDay ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.dates.title')}
						</Text>
						<View style={styles.panel}>
							<Line label={t('cards.dates.best')} value={formatDayMonth(summary.openCycle.closingDate)} />
							<Line label={t('cards.dates.closing')} value={formatDayMonth(summary.openCycle.closingDate)} />
							<Line label={t('cards.dates.due')} value={formatDayMonth(summary.openCycle.dueDate)} />
							<Text style={styles.explain}>
								{t(...datesExplain(card, card.closingDay, formatDayMonth(summary.openCycle.closingDate)))}
							</Text>
						</View>
					</View>
				) : null}
			</ScrollView>

			{summary ? (
				<>
					<PaySheet
						visible={sheet === 'pay'}
						onClose={() => setSheet(null)}
						suggestedCents={summary.toPayCents > 0 ? summary.toPayCents : summary.owedCents}
						accounts={bankAccounts}
						card={card}
						onConfirm={async (fromId, cents, date) => {
							// Recusado, o pagamento não cria outro (SPD-133): só o leitor de tela ouvia, e para
							// quem vê parecia que nada tinha acontecido. A tela diz qual pagamento já estava —
							// as transferências do cartão de antes e de depois do toque dizem qual foi.
							const before = await getAccountTransfers(card.id).catch(() => null);
							const created = await recordCardPayment(card.id, fromId, cents, date);
							setSheet(null);
							let text = t('cards.pay.done', { amount: formatCents(cents) });
							if (!created) {
								const after = before ? await getAccountTransfers(card.id).catch(() => null) : null;
								const refused =
									before && after ? findRefusedCardPayment(card.id, before, after, { fromAccountId: fromId, amountCents: cents, date }) : null;
								const from = refused?.fromAccountId ? accounts.find((account) => account.id === refused.fromAccountId) : undefined;
								const params = { amount: formatCents(refused?.amountCents ?? cents), date: refused ? formatDayMonth(refused.date) : '' };
								if (!refused) text = t('cards.pay.already', { amount: formatCents(cents) });
								else if (refused.kind === 'completed') text = t('cards.pay.completed', { ...params, account: from?.name ?? t('cards.pay.outside') });
								else if (from) text = t('cards.pay.alreadyFrom', { ...params, account: from.name });
								else text = t('cards.pay.alreadyOutside', params);
							}
							setPayNotice({ text });
							AccessibilityInfo.announceForAccessibility(text);
						}}
					/>
					{/* Sem fechamento não há fatura fechada para separar: o devido inteiro vai no campo da aberta, e repeti-lo no da fechada dobraria o valor do cartão. */}
					<AdjustSheet
						visible={sheet === 'adjust'}
						onClose={() => setSheet(null)}
						openNowCents={summary.configured ? summary.openInvoiceCents : summary.owedCents}
						closedToPayCents={summary.configured ? summary.toPayCents : 0}
						chargeShown={cardChargeShown(card, summary)}
						onConfirm={async (openCents, closedCents, asCharge) => {
							const charged = await adjustCardInvoices(card.id, openCents, closedCents, { asCharge });
							setSheet(null);
							AccessibilityInfo.announceForAccessibility(
								charged > 0
									? t('cards.charges.adjustedAsCharge', { amount: formatCents(charged) })
									: t('cards.adjust.done', { amount: formatCents((openCents ?? 0) + (closedCents ?? 0)) })
							);
						}}
					/>
					<ChargeSheet
						visible={sheet === 'charge'}
						onClose={() => setSheet(null)}
						card={card}
						onConfirm={async (kind, cents, date) => {
							await addCardCharge(card.id, kind, cents, date);
							setSheet(null);
							AccessibilityInfo.announceForAccessibility(t('cards.charges.done', { amount: formatCents(cents) }));
						}}
					/>
					<RenameCardSheet
						visible={renaming !== null}
						last4={renaming?.last4 ?? ''}
						currentName={renaming?.name ?? null}
						onClose={() => setRenaming(null)}
						onSave={async (name) => {
							if (renaming) await renameCard(card.id, renaming.last4, name);
							setRenaming(null);
						}}
					/>
					<InstallmentsSheet
						visible={sheet === 'installments'}
						onClose={() => setSheet(null)}
						card={card}
						currentCovered={openInvoiceInformed(card, cardTransactions, today)}
						categories={categories}
						onConfirm={async (input) => {
							const created = await addExistingInstallments({ ...input, cardId: card.id });
							setSheet(null);
							AccessibilityInfo.announceForAccessibility(t('cards.installments.done', { count: created }));
						}}
					/>
				</>
			) : null}

			{payNotice ? (
				<View style={styles.payNotice}>
					<Ionicons name="information-circle-outline" size={20} color={ACCENT} />
					<Text style={styles.payNoticeText}>{payNotice.text}</Text>
					<Pressable
						onPress={() => setPayNotice(null)}
						accessibilityRole="button"
						accessibilityLabel={t('cards.pay.noticeClose')}
						hitSlop={8}
						style={({ pressed }) => [styles.payNoticeClose, pressed && styles.pressed]}
					>
						<Ionicons name="close" size={20} color="#FFFFFF" />
					</Pressable>
				</View>
			) : null}
		</SafeAreaView>
	);
};

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

/** `tourId`: o passo do guia da tela que aponta este botão (SPD-129). */
const ActionTile: React.FC<{ icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; tourId?: string }> = ({
	icon,
	label,
	onPress,
	tourId,
}) => {
	const target = useTourTarget(tourId);
	return (
		<Pressable {...target} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
			<View style={styles.actionIcon}>
				<Ionicons name={icon} size={22} color={ACCENT} />
			</View>
			<Text style={styles.actionLabel}>{label}</Text>
		</Pressable>
	);
};

const Stat: React.FC<{ label: string; value: string; tone?: 'default' | 'danger' }> = ({ label, value, tone = 'default' }) => (
	<View style={styles.stat} accessible accessibilityLabel={`${label}, ${value}`}>
		<Text style={styles.statLabel}>{label}</Text>
		<Text style={[styles.statValue, tone === 'danger' && styles.danger]}>{value}</Text>
	</View>
);

/**
 * "2 lançamentos podem estar repetidos" (E2E-34). O número é quantos sobram se forem: em cada
 * grupo de iguais, todos menos um. O toque deixa na lista só os marcados, e de novo mostra todos.
 */
const DuplicatesNotice: React.FC<{
	count: number;
	extraCents: number;
	paymentExtraCents: number;
	onlyMarked: boolean;
	onPress: () => void;
}> = ({ count, extraCents, paymentExtraCents, onlyMarked, onPress }) => {
	const { t } = useTranslation();
	const title = t('cards.duplicates.notice', { count });
	const body =
		extraCents > 0 ? t('cards.duplicates.noticeBody', { amount: formatCents(extraCents) }) : t('cards.duplicates.noticeBodyPlain');
	// Pagamento repetido não muda a fatura: muda o quanto dela foi pago (SPD-124).
	const payments = paymentExtraCents > 0 ? t('cards.duplicates.noticePayments', { amount: formatCents(paymentExtraCents) }) : null;
	const toggle = onlyMarked ? t('cards.duplicates.showAll') : t('cards.duplicates.showOnly');
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected: onlyMarked }}
			accessibilityLabel={payments ? `${title}. ${body} ${payments}` : `${title}. ${body}`}
			accessibilityHint={onlyMarked ? t('cards.duplicates.showAllHint') : t('cards.duplicates.showOnlyHint')}
			style={({ pressed }) => [styles.notice, styles.duplicateNotice, pressed && styles.pressed]}
		>
			<Ionicons name="copy-outline" size={22} color="#FFD166" />
			<View style={styles.flex}>
				<Text style={styles.noticeTitle}>{title}</Text>
				<Text style={styles.noticeBody}>{body}</Text>
				{payments ? <Text style={styles.noticeBody}>{payments}</Text> : null}
				<Text style={styles.duplicateToggle}>{toggle}</Text>
			</View>
		</Pressable>
	);
};

/**
 * O texto do painel "Datas" com a regra que o ciclo usa (`cycleRuleOf`): com o dia de
 * vencimento gravado, "vence todo dia X" — o prazo gravado é o de uma fatura só e mudaria de
 * mês a mês; sem o dia, o prazo gravado; sem nenhum dos dois, o texto não diz prazo (antes
 * dizia 7, suposto).
 */
const datesExplain = (
	card: Pick<Account, 'dueDay' | 'closingDaysBefore'>,
	day: number,
	best: string
): [key: string, params: Record<string, unknown>] => {
	if (card.dueDay) return ['cards.dates.explainDueDay', { day, dueDay: card.dueDay, best }];
	if (card.closingDaysBefore) return ['cards.dates.explain', { count: card.closingDaysBefore, day, best }];
	return ['cards.dates.explainClosingOnly', { day, best }];
};

const Line: React.FC<{ label: string; value: string }> = ({ label, value }) => (
	<View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
		<Text style={styles.lineLabel}>{label}</Text>
		<Text style={styles.lineValue}>{value}</Text>
	</View>
);

const PaySheet: React.FC<{
	visible: boolean;
	onClose: () => void;
	suggestedCents: number;
	accounts: Account[];
	card: Account;
	onConfirm: (fromAccountId: string | null, cents: number, date: string) => Promise<void>;
}> = ({ visible, onClose, suggestedCents, accounts, card, onConfirm }) => {
	const { t } = useTranslation();
	const [amount, setAmount] = useState('');
	const [from, setFrom] = useState<string | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [fromError, setFromError] = useState<string | undefined>();
	// A data decide qual fatura o pagamento quita: registrar hoje um pagamento de semanas
	// atrás o jogaria na fatura errada.
	const [day, setDay] = useState<'0' | '1' | '2'>('0');
	const today = todayISO();
	// O cartão troca de identidade a cada recarga das contas, e a folha depende só do id:
	// uma recarga no meio do preenchimento não pode apagar o que já foi digitado.
	const cardRef = useRef(card);
	cardRef.current = card;

	useEffect(() => {
		if (!visible) return;
		setAmount(suggestedCents > 0 ? centsToDisplayInput(suggestedCents) : '');
		setFrom(null);
		setDay('0');
		setError(undefined);
		setFromError(undefined);

		// Quem paga a fatura é a conta **corrente** do banco do cartão: `findCheckingForCard`
		// é quem sabe — ignora poupança e investimento e, com mais de uma, vence a principal.
		// Marcar "a primeira conta do banco" punha a folha na caixinha do Nubank e debitava a
		// fatura da reserva de emergência. Quando nem ele sabe, nada vem marcado: o dono
		// escolhe, em vez de o app debitar a conta errada em silêncio.
		let current = true;
		void findCheckingForCard(cardRef.current).then((checking) => {
			if (current) setFrom(checking?.id ?? null);
		});
		return () => {
			current = false;
		};
	}, [visible, suggestedCents, card.id]);

	const options: ChipOption<string>[] = [
		...accounts.map((account) => ({ value: account.id, label: account.name, color: account.color })),
		{ value: 'outside', label: t('cards.pay.outside') },
	];

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.pay.title')} subtitle={t('cards.pay.subtitle')}>
			<Field label={t('cards.pay.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={error} />
			<ChipGroup
				label={t('cards.pay.from')}
				options={options}
				selected={from}
				onSelect={setFrom}
				hint={t('cards.pay.fromHint')}
				error={fromError}
			/>
			<ChipGroup
				label={t('cards.pay.when')}
				options={[
					{ value: '0', label: t('cards.pay.today') },
					{ value: '1', label: t('cards.pay.yesterday') },
					{ value: '2', label: formatDayMonth(addDays(today, -2)) },
				]}
				selected={day}
				onSelect={setDay}
			/>
			<Button
				label={t('cards.pay.confirm')}
				icon="checkmark"
				onPress={async () => {
					const cents = parseAmountToCents(amount);
					const amountError = cents === null || cents <= 0 ? t('cards.edit.invalidAmount') : undefined;
					const accountError = from === null ? t('cards.pay.fromRequired') : undefined;
					setError(amountError);
					setFromError(accountError);
					const messages = [amountError, accountError].filter(Boolean);
					if (messages.length > 0 || cents === null || from === null) {
						AccessibilityInfo.announceForAccessibility(messages.join('. '));
						return;
					}
					await onConfirm(from === 'outside' ? null : from, cents, addDays(today, -Number(day)));
				}}
			/>
		</Sheet>
	);
};

/**
 * "Acertar valor": o que o app do banco mostra agora em cada fatura.
 *
 * A folha chega **pré-preenchida com o que o app acha hoje** — é o que dá ao dono a
 * chance de perceber que um dos números está errado, em vez de digitar no escuro. Um
 * campo apagado é "não informei" (`null`), nunca "o banco mostra zero": só a fatura
 * preenchida é acertada, e a outra fica exatamente como está.
 *
 * Quando o banco mostra **mais** do que o app, a folha pergunta antes de gravar se a
 * diferença é juros, IOF, anuidade ou tarifa (`splitCardCharges`): sim lança encargo, não
 * lança o ajuste de sempre. Banco menor ou igual não pergunta nada.
 */
const AdjustSheet: React.FC<{
	visible: boolean;
	onClose: () => void;
	/** O que o app acha da fatura aberta e do que falta pagar da fechada, para pré-preencher. */
	openNowCents: number;
	closedToPayCents: number;
	/** O mesmo, do jeito que a pergunta do encargo compara (`cardChargeShown`). */
	chargeShown: CardChargeShown;
	onConfirm: (openCents: number | null, closedCents: number | null, asCharge: boolean) => Promise<void>;
}> = ({ visible, onClose, openNowCents, closedToPayCents, chargeShown, onConfirm }) => {
	const { t } = useTranslation();
	const [open, setOpenText] = useState('');
	const [closed, setClosedText] = useState('');
	const [error, setError] = useState<string | undefined>();
	// A diferença a mais que espera a resposta "é encargo?"; nula enquanto não perguntou.
	const [askCharge, setAskCharge] = useState<number | null>(null);
	// Mudar um número depois da pergunta muda a diferença: pergunta de novo.
	const setOpen = (text: string) => {
		setOpenText(text);
		setAskCharge(null);
	};
	const setClosed = (text: string) => {
		setClosedText(text);
		setAskCharge(null);
	};

	useEffect(() => {
		if (!visible) return;
		// Fatura sem valor fica em branco: "não informei" é a resposta certa para uma fatura
		// fechada que o app não vê — e preencher "0,00" faria o dono confirmar um zero.
		setOpenText(openNowCents > 0 ? centsToDisplayInput(openNowCents) : '');
		setClosedText(closedToPayCents > 0 ? centsToDisplayInput(closedToPayCents) : '');
		setError(undefined);
		setAskCharge(null);
	}, [visible, openNowCents, closedToPayCents]);

	const openCents = open.trim() ? parseAmountToCents(open) : null;
	const closedCents = closed.trim() ? parseAmountToCents(closed) : null;
	const invalid =
		(open.trim() !== '' && (openCents === null || openCents < 0)) ||
		(closed.trim() !== '' && (closedCents === null || closedCents < 0));
	const informed = [openCents, closedCents].filter((value): value is number => value !== null);
	const total = invalid || informed.length === 0 ? null : informed.reduce((sum, value) => sum + value, 0);

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.adjust.title')} subtitle={t('cards.adjust.subtitle')}>
			<Field label={t('cards.adjust.open')} value={open} onChangeText={setOpen} keyboardType="decimal-pad" hint={t('cards.adjust.openHint')} />
			<Field
				label={t('cards.adjust.closed')}
				optionalLabel={t('cards.edit.optional')}
				value={closed}
				onChangeText={setClosed}
				keyboardType="decimal-pad"
				hint={t('cards.adjust.closedHint')}
				error={error}
			/>
			{total !== null ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{informed.length === 2
						? t('cards.adjust.preview', { amount: formatCents(total) })
						: t('cards.adjust.previewPartial', { amount: formatCents(total) })}
				</Text>
			) : null}
			{askCharge !== null ? (
				<View style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('cards.charges.question', { amount: formatCents(askCharge) })}</Text>
					<Text style={styles.questionBody}>{t('cards.charges.questionBody')}</Text>
					<Button label={t('cards.charges.yes')} icon="receipt-outline" onPress={() => onConfirm(openCents, closedCents, true)} />
					<Button label={t('cards.charges.no')} variant="secondary" onPress={() => onConfirm(openCents, closedCents, false)} />
				</View>
			) : (
				<Button
					label={t('cards.adjust.confirm')}
					icon="checkmark"
					onPress={async () => {
						if (total === null) {
							setError(t('cards.edit.invalidAmount'));
							AccessibilityInfo.announceForAccessibility(t('cards.edit.invalidAmount'));
							return;
						}
						const { totalCents } = splitCardCharges(chargeShown, todayISO(), openCents, closedCents);
						if (totalCents > 0) {
							setAskCharge(totalCents);
							AccessibilityInfo.announceForAccessibility(t('cards.charges.question', { amount: formatCents(totalCents) }));
							return;
						}
						await onConfirm(openCents, closedCents, false);
					}}
				/>
			)}
		</Sheet>
	);
};

/**
 * "Registrar encargo": juros, IOF, anuidade, multa ou tarifa que o banco cobrou no cartão.
 *
 * A data é o dia e o mês (dois para trás, o atual e o seguinte, `chargeMonthOptions`), sem
 * seletor de data: é o que a fatura do banco mostra, e um campo de texto com dia/mês trocaria
 * a ordem conforme o idioma. A prévia diz em qual fatura o encargo cai (a do ciclo da data).
 */
const ChargeSheet: React.FC<{
	visible: boolean;
	onClose: () => void;
	card: Account;
	onConfirm: (kind: CardChargeKind, cents: number, date: string) => Promise<void>;
}> = ({ visible, onClose, card, onConfirm }) => {
	const { t } = useTranslation();
	const today = todayISO();
	const months = chargeMonthOptions(today);
	const [kind, setKind] = useState<CardChargeKind | null>(null);
	const [amount, setAmount] = useState('');
	const [day, setDay] = useState('');
	const [month, setMonth] = useState<string>(months[2]);
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});

	useEffect(() => {
		if (!visible) return;
		const now = todayISO();
		setKind(null);
		setAmount('');
		setDay(String(Number(now.slice(8, 10))));
		setMonth(now.slice(0, 7));
		setErrors({});
	}, [visible]);

	const cents = parseAmountToCents(amount);
	const date = day.trim() ? cardChargeDate(month, Number(day)) : null;
	const rule = cycleRuleOf(card);
	const cycle = date && rule ? cycleFor(date, rule) : null;

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.charges.title')} subtitle={t('cards.charges.subtitle')}>
			<ChipGroup
				label={t('cards.charges.kind')}
				options={CHARGE_KINDS.map((value) => ({ value, label: t(`cards.charges.kinds.${value}`) }))}
				selected={kind}
				onSelect={setKind}
				error={errors.kind}
			/>
			<Field label={t('cards.charges.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={errors.amount} />
			<Field
				label={t('cards.charges.day')}
				value={day}
				onChangeText={(text) => setDay(text.replace(/\D/g, '').slice(0, 2))}
				keyboardType="number-pad"
				hint={t('cards.charges.dayHint')}
				error={errors.date}
			/>
			<ChipGroup
				label={t('cards.charges.month')}
				options={months.map((value) => ({ value, label: formatMonthShort(`${value}-01`) }))}
				selected={month}
				onSelect={setMonth}
			/>
			{date ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{cycle
						? t('cards.charges.preview', { month: formatMonthLong(`${cycle.key}-01`), due: formatDayMonth(cycle.dueDate) })
						: t('cards.charges.previewNoCycle', { date: formatDayMonth(date) })}
				</Text>
			) : null}
			<Button
				label={t('cards.charges.confirm')}
				icon="checkmark"
				onPress={async () => {
					const next: Record<string, string | undefined> = {};
					if (!kind) next.kind = t('cards.charges.kindRequired');
					if (cents === null || cents <= 0) next.amount = t('cards.edit.invalidAmount');
					if (!date) next.date = t('cards.charges.invalidDay');
					setErrors(next);
					const messages = Object.values(next).filter(Boolean);
					if (messages.length > 0 || !kind || cents === null || !date) {
						AccessibilityInfo.announceForAccessibility(messages.join('. '));
						return;
					}
					await onConfirm(kind, cents, date);
				}}
			/>
		</Sheet>
	);
};

const InstallmentsSheet: React.FC<{
	visible: boolean;
	onClose: () => void;
	card: Account;
	/** A fatura aberta já tem o valor do banco: a parcela atual já está nela (`openInvoiceInformed`). */
	currentCovered: boolean;
	categories: ReturnType<typeof useTransactions>['categories'];
	onConfirm: (input: { note: string; category: string; parcelCents: number; currentIndex: number; totalCount: number }) => Promise<void>;
}> = ({ visible, onClose, card, currentCovered, categories, onConfirm }) => {
	const { t } = useTranslation();
	const [note, setNote] = useState('');
	const [parcel, setParcel] = useState('');
	const [current, setCurrent] = useState('');
	const [total, setTotal] = useState('');
	const [category, setCategory] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});

	useEffect(() => {
		if (!visible) return;
		setNote('');
		setParcel('');
		setCurrent('');
		setTotal('');
		setCategory(null);
		setErrors({});
	}, [visible]);

	const parcelCents = parseAmountToCents(parcel);
	const currentIndex = Number(current);
	const totalCount = Number(total);
	const valid =
		Number.isInteger(currentIndex) && Number.isInteger(totalCount) && currentIndex >= 1 && totalCount >= 2 && totalCount <= 48 && currentIndex <= totalCount;
	// A âncora entra: a prévia mostra as mesmas faturas que serão gravadas, inclusive quando
	// o piso da âncora empurra a parcela atual para a fatura seguinte — e diz quando a parcela
	// atual fica de fora por já estar na fatura informada.
	const dates = valid
		? existingInstallmentDates(currentIndex, totalCount, cycleRuleOf(card), todayISO(), card.openingBalanceDate, currentCovered)
		: [];
	const currentLabel = `${currentIndex}/${totalCount}`;
	const range = (list: typeof dates) => ({
		count: list.length,
		amount: parcelCents ? formatCents(parcelCents) : '',
		first: list.length > 0 ? formatMonthShort(`${invoiceMonthOf(list[0].date, cycleRuleOf(card))}-01`) : '',
		last: list.length > 0 ? formatMonthShort(`${invoiceMonthOf(list[list.length - 1].date, cycleRuleOf(card))}-01`) : '',
	});
	const nothingToAdd = valid && currentCovered && dates.length === 0;

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.installments.title')} subtitle={t('cards.installments.subtitle')}>
			<Field label={t('cards.installments.note')} value={note} onChangeText={setNote} placeholder={t('cards.installments.notePlaceholder')} error={errors.note} />
			<Field label={t('cards.installments.parcel')} value={parcel} onChangeText={setParcel} keyboardType="decimal-pad" error={errors.parcel} />
			<View style={styles.twoColumns}>
				<View style={styles.flex}>
					<Field
						label={t('cards.installments.current')}
						value={current}
						onChangeText={(text) => setCurrent(text.replace(/\D/g, '').slice(0, 2))}
						keyboardType="number-pad"
						hint={t('cards.installments.currentHint')}
					/>
				</View>
				<View style={styles.flex}>
					<Field
						label={t('cards.installments.total')}
						value={total}
						onChangeText={(text) => setTotal(text.replace(/\D/g, '').slice(0, 2))}
						keyboardType="number-pad"
						error={errors.count}
					/>
				</View>
			</View>
			<View style={{ gap: 6 }}>
				<Text style={styles.fieldLabel}>{t('cards.installments.category')}</Text>
				<HorizontalCategoryPicker categories={categories} selectedCategoryId={category} onSelectCategory={setCategory} isIncome={false} />
				{errors.category ? (
					<Text style={styles.errorText} accessibilityLiveRegion="polite">
						{errors.category}
					</Text>
				) : null}
			</View>
			{dates.length > 0 && parcelCents ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{currentCovered
						? t('cards.installments.previewCovered', { ...range(dates), current: currentLabel })
						: t('cards.installments.preview', range(dates))}
				</Text>
			) : null}
			{nothingToAdd ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{t('cards.installments.allCovered', { current: currentLabel })}
				</Text>
			) : null}
			<Button
				label={t('cards.installments.confirm')}
				icon="checkmark"
				onPress={async () => {
					const next: Record<string, string | undefined> = {};
					if (!note.trim()) next.note = t('cards.installments.noteRequired');
					if (parcelCents === null || parcelCents <= 0) next.parcel = t('cards.edit.invalidAmount');
					if (!valid) next.count = t('cards.installments.invalidCount');
					if (!category) next.category = t('cards.installments.categoryRequired');
					setErrors(next);
					const messages = Object.values(next).filter(Boolean);
					if (messages.length > 0 || parcelCents === null || !category) {
						AccessibilityInfo.announceForAccessibility(messages.join('. '));
						return;
					}
					// A última parcela já estava na fatura informada: não há o que criar.
					if (nothingToAdd) {
						AccessibilityInfo.announceForAccessibility(t('cards.installments.allCovered', { current: currentLabel }));
						onClose();
						return;
					}
					await onConfirm({ note: note.trim(), category, parcelCents, currentIndex, totalCount });
				}}
			/>
		</Sheet>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	flex: {
		flex: 1,
	},
	missing: {
		color: '#FFFFFF',
		padding: 24,
		fontSize: 16,
	},
	payNotice: {
		position: 'absolute',
		left: 16,
		right: 16,
		bottom: 24,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		backgroundColor: '#2A2A2A',
		borderRadius: 12,
		paddingVertical: 8,
		paddingLeft: 14,
		paddingRight: 4,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	payNoticeText: {
		flex: 1,
		fontSize: 15,
		lineHeight: 21,
		color: '#FFFFFF',
	},
	payNoticeClose: {
		minWidth: 44,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
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
		paddingBottom: 60,
		gap: 20,
	},
	pressed: {
		opacity: 0.7,
	},
	actions: {
		flexDirection: 'row',
		gap: ROW_GAP,
	},
	action: {
		flex: 1,
		alignItems: 'center',
		gap: 6,
		minHeight: 84,
		paddingVertical: 12,
		paddingHorizontal: 4,
		borderRadius: 16,
		backgroundColor: '#1E1E1E',
	},
	actionIcon: {
		width: 40,
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	actionLabel: {
		fontSize: 13,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
	},
	notice: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		padding: 14,
		borderRadius: 14,
		backgroundColor: 'rgba(21,232,254,0.08)',
		borderWidth: 1,
		borderColor: 'rgba(21,232,254,0.4)',
	},
	noticeTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	noticeBody: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.8)',
		marginTop: 2,
	},
	section: {
		gap: 10,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	tabs: {
		gap: 8,
	},
	tab: {
		minHeight: 56,
		minWidth: 92,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 12,
		borderWidth: 1.5,
		borderColor: 'rgba(255,255,255,0.15)',
		justifyContent: 'center',
	},
	tabSelected: {
		borderColor: ACCENT,
		backgroundColor: 'rgba(21,232,254,0.1)',
	},
	tabMonth: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.8)',
	},
	tabAmount: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
		marginTop: 2,
	},
	tabTextSelected: {
		color: ACCENT,
	},
	panel: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
		gap: 4,
	},
	paidAmount: {
		color: '#81C784',
	},
	panelTitle: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.75)',
	},
	panelAmount: {
		fontSize: 28,
		fontWeight: '800',
		color: '#FFFFFF',
	},
	panelStatus: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	panelMeta: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
		marginBottom: 6,
	},
	anchorRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		paddingVertical: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
	},
	anchorText: {
		flex: 1,
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	anchorAmount: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	covered: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		paddingTop: 8,
		paddingBottom: 8,
	},
	// Fora da soma da fatura: mais apagadas que as que somam.
	coveredList: {
		opacity: 0.6,
	},
	usage: {
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
		paddingTop: 10,
		paddingBottom: 6,
		gap: 4,
	},
	usageTitle: {
		fontSize: 14,
		fontWeight: '700',
		color: 'rgba(255,255,255,0.85)',
		marginBottom: 2,
	},
	usageRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
	},
	usageMain: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 10,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: 'transparent',
	},
	usageSelected: {
		borderColor: ACCENT,
		backgroundColor: 'rgba(21,232,254,0.1)',
	},
	usageName: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	usageNameSelected: {
		color: ACCENT,
	},
	usageMeta: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.7)',
	},
	usageAmount: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	pendingLabel: {
		fontSize: 13,
		color: '#FFD166',
	},
	duplicateNotice: {
		marginTop: 10,
		backgroundColor: 'rgba(255,209,102,0.08)',
		borderColor: 'rgba(255,209,102,0.45)',
	},
	duplicateToggle: {
		fontSize: 13,
		fontWeight: '600',
		color: '#FFD166',
		marginTop: 6,
	},
	// Embaixo do lançamento marcado: com qual ele pode ser o mesmo.
	duplicateRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		paddingBottom: 8,
	},
	duplicateText: {
		flex: 1,
		fontSize: 13,
		color: '#FFD166',
	},
	duplicateAction: {
		fontSize: 13,
		fontWeight: '600',
		color: ACCENT,
		paddingVertical: 4,
	},
	empty: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.65)',
		paddingVertical: 8,
	},
	track: {
		height: 10,
		borderRadius: 5,
		backgroundColor: 'rgba(255,255,255,0.12)',
		overflow: 'hidden',
		marginBottom: 12,
	},
	fill: {
		height: 10,
		borderRadius: 5,
		backgroundColor: ACCENT,
	},
	fillDanger: {
		backgroundColor: '#FF8A80',
	},
	limitNumbers: {
		flexDirection: 'row',
		gap: 8,
		marginBottom: 8,
	},
	stat: {
		flex: 1,
	},
	statLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.7)',
	},
	statValue: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
		marginTop: 2,
	},
	danger: {
		color: '#FF8A80',
	},
	line: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		minHeight: 40,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
		gap: 12,
	},
	lineLabel: {
		flex: 1,
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	lineValue: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	plan: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		paddingVertical: 10,
	},
	planBorder: {
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
	},
	planName: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	planMeta: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	planTrack: {
		height: 4,
		borderRadius: 2,
		backgroundColor: 'rgba(255,255,255,0.12)',
		marginTop: 8,
		overflow: 'hidden',
	},
	planFill: {
		height: 4,
		borderRadius: 2,
		backgroundColor: ACCENT,
	},
	planAmount: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	explain: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 8,
	},
	preview: {
		fontSize: 14,
		lineHeight: 20,
		color: ACCENT,
	},
	chargesNote: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 14,
		gap: 6,
	},
	chargesRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 10,
	},
	chargesText: {
		flex: 1,
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.8)',
	},
	howButton: {
		flexDirection: 'row',
		alignItems: 'center',
		alignSelf: 'flex-start',
		gap: 4,
		minHeight: 44,
		paddingLeft: 30,
	},
	howLabel: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	chargesHow: {
		fontSize: 13,
		lineHeight: 19,
		color: 'rgba(255,255,255,0.75)',
		paddingLeft: 30,
	},
	question: {
		gap: 10,
		padding: 14,
		borderRadius: 14,
		backgroundColor: 'rgba(21,232,254,0.08)',
		borderWidth: 1,
		borderColor: 'rgba(21,232,254,0.4)',
	},
	questionTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	questionBody: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.8)',
	},
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	fieldLabel: {
		fontSize: 14,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
	},
	errorText: {
		fontSize: 13,
		color: '#FF8A80',
	},
});

export default CardDetailScreen;
