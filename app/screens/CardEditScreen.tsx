import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { accountSelectOptions } from '../components/AccountPicker';
import CardFace from '../components/cards/CardFace';
import { Button, ChipGroup, type ChipOption, Field } from '../components/cards/formParts';
import MergeTargetSheet from '../components/MergeTargetSheet';
import { SelectField } from '../components/SelectField';
import HelpButton from '../components/tour/HelpButton';
import { TourTarget, useScreenTour, useTourScroll } from '../components/tour/TourContext';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Account, AccountDraft } from '../database/schema';
import {
	BANK_BRANDS,
	brandFor,
	CARD_NETWORKS,
	type CardNetwork,
	NETWORK_LABELS,
	NEUTRAL_CARD_COLOR,
} from '../utils/bankBrands';
import { getDismissedCardDuplicates } from '../utils/cardDuplicateDismissals';
import { findCardDuplicates, summarizeCardDuplicates } from '../utils/cardDuplicates';
import { cycleFor, cycleRuleOf, daysBetween, invoicesToInform, isCardAdjustment } from '../utils/cardMath';
import { addDays, buildClampedDate, formatDayMonth, formatMonthLong, todayISO } from '../utils/dateUtils';
import { centsToDisplayInput, parseAmountToCents } from '../utils/money';

/**
 * Criar ou editar um cartão. Nada aqui fala de saldo.
 *
 * O cartão aparece no topo e muda enquanto se preenche — escolher o banco já pinta o
 * cartão com a cor dele, e o final e a bandeira aparecem onde estariam no plástico.
 * Isso confirma a escolha sem precisar ler.
 *
 * Campos na ordem em que se acha a informação no app do banco: banco, final, bandeira,
 * limite, dia de fechamento e dia de vencimento — os dois como a fatura mostra, em qualquer
 * banco. Nada vem suposto: o cartão novo começa sem banco e sem vencimento (SPD-109; antes
 * vinha o Nubank escolhido e 7 dias de prazo). Cada fatura vence no dia digitado, já
 * empurrado para dia útil (SPD-119); o prazo entre os dois (`closingDaysBefore`), contado na
 * fatura aberta de hoje (`dueGapFor`), continua gravado para o aparelho com versão antiga,
 * que só lê o prazo. A tela mostra as datas da fatura atual para conferir com o banco. Só o
 * banco é obrigatório; sem fechamento o cartão funciona, mas não monta faturas — e a tela
 * diz isso.
 *
 * A fatura que o banco mostra hoje vai com o nome do mês no rótulo, para não haver dúvida
 * de qual é. Entre o fechamento e o vencimento o banco mostra duas — a fechada a pagar e a
 * aberta —, e a tela pede as duas (`invoicesToInform`): um campo só levava a fechada para a
 * fatura aberta e deixava o vencimento dela sem aviso.
 *
 * Débito fica de fora: não tem fatura nem limite, a compra sai da conta na hora. Quem
 * cadastrou um débito aqui por engano leva os lançamentos para a conta com um toque.
 */

const POPULAR_BANKS = ['nubank', 'inter', 'mercadopago', 'itau', 'bradesco', 'santander', 'bb', 'caixa', 'c6', 'picpay'];
const OTHER = 'other';
/** O maior prazo entre fechamento e vencimento que o formulário aceita. */
const MAX_DUE_GAP = 20;
/** Prazo fora de 1 a 20 dias: a mesma regra no salvar e no aviso enquanto se digita. */
const dueGapInvalid = (gap: number | null): boolean => gap !== null && (gap < 1 || gap > MAX_DUE_GAP);

type CardType = 'credit' | 'debit';

/**
 * Dias entre o fechamento e o vencimento, contados na fatura aberta de hoje: o fechamento
 * dela e o primeiro dia `dueDay` depois dele (no mês seguinte quando o dia já passou).
 * Fecha 28 e vence 5 dá 8 dias em outubro (28/10 → 05/11), 7 em novembro e 5 em fevereiro —
 * conta-se na fatura que o dono tem aberta no app do banco enquanto preenche. Dia que o mês
 * não tem vai para o último (vence 31 em novembro é 30/11).
 */
export const dueGapFor = (closingDay: number, dueDay: number, today: string): number => {
	const { closingDate } = cycleFor(today, { closingDay, dueDaysAfter: 1 });
	const [year, month] = closingDate.split('-').map(Number);
	const sameMonth = buildClampedDate(year, month, dueDay);
	const due = sameMonth > closingDate ? sameMonth : buildClampedDate(month === 12 ? year + 1 : year, (month % 12) + 1, dueDay);
	return daysBetween(closingDate, due);
};

/**
 * O dia de vencimento que o campo mostra ao abrir um cartão: o que foi digitado e gravado
 * (`dueDay`), ou, em cartão de versão antiga sem ele, o dia que sai do fechamento e do prazo
 * na fatura aberta de hoje. Sem fechamento, em branco: o vencimento sozinho não monta fatura,
 * e o salvar de um cartão em que ninguém mexeu não pode pedir o fechamento.
 */
export const dueDayShown = (card: Pick<Account, 'closingDay' | 'closingDaysBefore' | 'dueDay'>, today: string): string => {
	const rule = cycleRuleOf(card);
	if (!rule) return '';
	if (card.dueDay) return String(card.dueDay);
	return String(Number(addDays(cycleFor(today, rule).closingDate, rule.dueDaysAfter).slice(8, 10)));
};

interface CardEditScreenProps {
	cardId?: string;
}

const CardEditScreen: React.FC<CardEditScreenProps> = ({ cardId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, bankAccounts, createAccount, saveAccount, removeAccount, adjustCardInvoices, convertCardToDebit, mergeCards } =
		useAccounts();
	const { transactions } = useTransactions();

	const existing: Account | undefined = useMemo(
		() => accounts.find((account) => account.id === cardId && account.kind === 'credit_card'),
		[accounts, cardId]
	);

	// Sem banco escolhido até o dono escolher: cartão novo, ou um antigo que ficou sem banco.
	// O salvar pede o banco (`bankRequired`).
	const initialBrand = brandFor(existing?.bankName);
	const [bankId, setBankId] = useState<string | null>(initialBrand?.id ?? (existing?.bankName ? OTHER : null));
	const [otherBank, setOtherBank] = useState(initialBrand ? '' : (existing?.bankName ?? ''));
	const [name, setName] = useState(existing?.name ?? '');
	const [last4, setLast4] = useState(existing?.last4 ?? '');
	const [network, setNetwork] = useState<CardNetwork | null>((existing?.network as CardNetwork | null) ?? null);
	const [limit, setLimit] = useState(existing?.creditLimitCents ? centsToDisplayInput(existing.creditLimitCents) : '');
	const [cardType, setCardType] = useState<CardType>('credit');
	const [debitAccountId, setDebitAccountId] = useState<string | null>(null);
	// Como o cartão está gravado: com os dois dias sem mexer, o salvar mantém o prazo dele.
	const savedClosing = existing?.closingDay ? String(existing.closingDay) : '';
	const savedDue = existing ? dueDayShown(existing, todayISO()) : '';
	const [closingDay, setClosingDay] = useState(savedClosing);
	const [dueDay, setDueDay] = useState(savedDue);
	const [currentInvoice, setCurrentInvoice] = useState('');
	const [closedInvoice, setClosedInvoice] = useState('');
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});
	const [saving, setSaving] = useState(false);
	// A folha de "Juntar com outro cartão" aberta.
	const [merging, setMerging] = useState(false);
	// O guia do cadastro do cartão (SPD-129): o final e os dias da fatura.
	useScreenTour('cardEdit', { blocked: merging });
	const tourScroll = useTourScroll('cardEdit');

	useEffect(() => {
		if (!existing) return;
		const brand = brandFor(existing.bankName);
		setBankId(brand?.id ?? (existing.bankName ? OTHER : null));
		setOtherBank(brand ? '' : (existing.bankName ?? ''));
		setName(existing.name);
		setLast4(existing.last4 ?? '');
		setNetwork((existing.network as CardNetwork | null) ?? null);
		setLimit(existing.creditLimitCents ? centsToDisplayInput(existing.creditLimitCents) : '');
		setClosingDay(existing.closingDay ? String(existing.closingDay) : '');
		setDueDay(dueDayShown(existing, todayISO()));
	}, [existing]);

	const brand = BANK_BRANDS.find((b) => b.id === bankId) ?? null;
	const bankName = bankId === OTHER ? otherBank.trim() : (brand?.name ?? '');
	const color = brand?.color ?? (existing && bankId === OTHER ? existing.color : NEUTRAL_CARD_COLOR);

	const bankOptions: ChipOption<string>[] = [
		...POPULAR_BANKS.map((id) => BANK_BRANDS.find((b) => b.id === id))
			.filter((b): b is (typeof BANK_BRANDS)[number] => Boolean(b))
			.map((b) => ({ value: b.id, label: b.name, color: b.color })),
		{ value: OTHER, label: t('cards.edit.otherBank') },
	];
	const networkOptions: ChipOption<CardNetwork>[] = CARD_NETWORKS.map((n) => ({ value: n, label: NETWORK_LABELS[n] }));

	const parseDay = (value: string): number | null | false => {
		if (value.trim() === '') return null;
		const day = Number(value);
		return Number.isInteger(day) && day >= 1 && day <= 31 ? day : false;
	};

	const preview: Account = {
		...(existing ?? {
			id: 'preview',
			kind: 'credit_card',
			role: 'card',
			envelopeMonthlyCents: null,
			cardNames: null,
			packageName: null,
			accountKey: null,
			openingBalanceCents: 0,
			openingBalanceDate: todayISO(),
			sortOrder: 0,
			archived: false,
			updatedAt: '',
		}),
		name: name.trim() || bankName || t('cards.edit.newTitle'),
		bankName: bankName || null,
		color,
		last4: last4 || null,
		network,
		closingDay: null,
		dueDay: null,
		closingDaysBefore: null,
		creditLimitCents: null,
	};

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	/**
	 * O prazo que o ciclo vai usar com os dois dias digitados. Com os dois como estão gravados,
	 * o do cartão: recontar na fatura de outro mês trocaria o prazo (8 dias em outubro, 7 em
	 * novembro) sem o dono ter mexido em nada. Nulo sem os dois dias válidos.
	 */
	const gapOf = (closing: number | null | false, due: number | null | false): number | null => {
		if (!closing || !due) return null;
		if (existing?.closingDaysBefore && closingDay === savedClosing && dueDay === savedDue) return existing.closingDaysBefore;
		return dueGapFor(closing, due, todayISO());
	};

	// As datas da fatura atual com o que está digitado, para conferir com o app do banco. A
	// regra é a que o salvar grava: com o dia de vencimento, que dá o vencimento de cada fatura.
	const typedClosing = parseDay(closingDay);
	const typedDue = parseDay(dueDay);
	const typedGap = gapOf(typedClosing, typedDue);
	const typedRule =
		typedClosing && typedDue && typedGap !== null && !dueGapInvalid(typedGap)
			? cycleRuleOf({ closingDay: typedClosing, closingDaysBefore: typedGap, dueDay: typedDue })
			: null;
	const cyclePreview = typedRule ? cycleFor(todayISO(), typedRule) : null;
	// As faturas que o banco mostra hoje: a aberta e, até o vencimento, a fechada.
	const asked = typedRule ? invoicesToInform(typedRule, todayISO()) : null;

	const parseInvoice = (value: string): number | null | false => {
		if (!value.trim()) return null;
		const cents = parseAmountToCents(value);
		return cents === null || cents < 0 ? false : cents;
	};

	const handleSave = async () => {
		const next: Record<string, string | undefined> = {};
		if (!bankName) next.bank = t('cards.edit.bankRequired');
		const closing = parseDay(closingDay);
		const due = parseDay(dueDay);
		const gap = gapOf(closing, due);
		if (closing === false) next.closing = t('cards.edit.invalidDay');
		else if (closing === null && due) next.closing = t('cards.edit.closingNeeded');
		if (due === false) next.due = t('cards.edit.invalidDay');
		else if (closing && due === null) next.due = t('cards.edit.dueNeeded');
		else if (dueGapInvalid(gap)) next.due = t('cards.edit.invalidDueGap');
		if (last4 && !/^\d{4}$/.test(last4)) next.last4 = t('cards.edit.invalidLast4');

		let limitCents: number | null = null;
		if (limit.trim()) {
			limitCents = parseAmountToCents(limit);
			if (limitCents === null || limitCents <= 0) next.limit = t('cards.edit.invalidAmount');
		}
		const openCents = existing ? null : parseInvoice(currentInvoice);
		// A fechada só conta enquanto a tela a pede: com o fechamento trocado depois de digitar,
		// o campo some e o valor não vai para uma fatura que não foi perguntada.
		const closedCents = existing || !asked?.closed ? null : parseInvoice(closedInvoice);
		if (openCents === false) next.invoice = t('cards.edit.invalidAmount');
		if (closedCents === false) next.closedInvoice = t('cards.edit.invalidAmount');

		setErrors(next);
		const messages = Object.values(next).filter(Boolean);
		if (messages.length > 0) {
			announce(messages.join('. '));
			return;
		}

		const draft: AccountDraft = {
			name: name.trim() || (last4 ? `${bankName} · ${last4}` : bankName),
			kind: 'credit_card',
			role: 'card',
			envelopeMonthlyCents: null,
			network,
			bankName,
			color,
			last4: last4 || null,
			closingDay: closing || null,
			// O dia de vencimento que a fatura mostra, como o dono digitou: é ele que dá o
			// vencimento de cada fatura. O prazo fica para o aparelho com versão antiga.
			dueDay: closing && due ? due : null,
			closingDaysBefore: closing ? gap : null,
			creditLimitCents: limitCents,
			cardNames: existing?.cardNames ?? null,
			packageName: existing?.packageName ?? null,
			accountKey: existing?.accountKey ?? null,
			openingBalanceCents: existing?.openingBalanceCents ?? 0,
			// Véspera de hoje: uma compra lançada hoje, depois de criar o cartão, precisa contar.
			openingBalanceDate: existing?.openingBalanceDate ?? addDays(todayISO(), -1),
			sortOrder: existing?.sortOrder ?? accounts.length,
			archived: existing?.archived ?? false,
		};

		try {
			setSaving(true);
			if (existing) {
				await saveAccount({ ...draft, id: existing.id });
				announce(t('cards.edit.saved'));
				router.back();
			} else {
				const id = await createAccount(draft);
				// Campo em branco vai como `null` ("não informei"), e não como zero — o cartão novo
				// pode ter uma fechada em aberto que ninguém declarou aqui, e zerá-la lançaria um
				// estorno falso datado hoje. A aberta vira a âncora (`planCardOpening`): a fatura
				// informada não é compra do mês nem saída em Lançamentos.
				const open = openCents === false ? null : openCents;
				const closed = closedCents === false ? null : closedCents;
				if ((open ?? 0) > 0 || (closed ?? 0) > 0) await adjustCardInvoices(id, open, closed, { opening: true });
				router.replace({ pathname: '/cards/[id]', params: { id } });
			}
		} finally {
			setSaving(false);
		}
	};

	const sameBankAccount = bankAccounts.find((account) => brandFor(account.bankName)?.id === bankId) ?? null;
	const chosenDebitAccount = bankAccounts.find((account) => account.id === (debitAccountId ?? sameBankAccount?.id)) ?? null;

	/**
	 * Sai de um cartão que deixou de existir (excluído, juntado, levado para o débito) sem
	 * deixar a tela dele na pilha (E2E-40): o voltar caía em "Cartão não encontrado". Esta
	 * edição se abre por cima da tela do cartão; `dismissTo` volta até ela (sem ela embaixo,
	 * com a edição aberta direto, troca esta por ela). Depois, ao juntar, ela é trocada pela
	 * do cartão que fica — tela nova, sem o filtro nem a fatura escolhida no que saiu; ao
	 * excluir, fecha, e o voltar seguinte é o de quem abriu o cartão (lista ou tela inicial).
	 */
	const leaveRemovedCard = (removedId: string, into?: string) => {
		router.dismissTo({ pathname: '/cards/[id]', params: { id: removedId } });
		if (into) router.replace({ pathname: '/cards/[id]', params: { id: into } });
		else router.dismiss();
	};

	const handleConvertToDebit = () => {
		if (!existing || !chosenDebitAccount) return;
		Alert.alert(t('cards.edit.debitConvert'), t('cards.edit.debitConfirm', { account: chosenDebitAccount.name }), [
			{ text: t('cards.cancel'), style: 'cancel' },
			{
				text: t('cards.edit.debitConvert'),
				onPress: async () => {
					await convertCardToDebit(existing.id, chosenDebitAccount.id);
					announce(t('cards.edit.debitDone', { account: chosenDebitAccount.name }));
					leaveRemovedCard(existing.id);
				},
			},
		]);
	};

	const handleArchive = async () => {
		if (!existing) return;
		await saveAccount({ ...existing, archived: !existing.archived });
		announce(existing.archived ? t('cards.edit.unarchived') : t('cards.edit.archived'));
		router.back();
	};

	const handleDelete = () => {
		if (!existing) return;
		Alert.alert(t('cards.edit.delete'), t('cards.edit.deleteConfirm'), [
			{ text: t('cards.cancel'), style: 'cancel' },
			{
				text: t('cards.edit.delete'),
				style: 'destructive',
				onPress: async () => {
					await removeAccount(existing.id);
					leaveRemovedCard(existing.id);
				},
			},
		]);
	};

	/**
	 * O mesmo cartão do banco com duas fichas no app: a cadastrada à mão e a que o extrato
	 * OFX criou, por exemplo (E2E-34). Como "Juntar com outra conta": este sai e o escolhido
	 * fica, com o fechamento, o limite e a fatura informada dele (`mergeCards`).
	 */
	const mergeCandidates = existing
		? accounts.filter(
				(account) => account.kind === 'credit_card' && account.id !== existing.id && !account.deletedAt && !account.archived
			)
		: [];

	/**
	 * Quantos lançamentos do cartão que fica podem estar repetidos depois de juntar (E2E-34): a
	 * padaria digitada no Nubank Teste e a mesma padaria que o extrato pôs no duplicado. Conta
	 * sobre a lista de antes de juntar, do jeito que `mergeCardInto` a deixa — a lista da tela
	 * só se atualiza depois deste toque: o ajuste do que sai não vem, e o lançamento sem final
	 * ganha o do cartão que sai.
	 */
	const keptDuplicateCount = (from: Account, intoId: string, dismissed: ReadonlySet<string>): number => {
		const kept = transactions.flatMap((tx) => {
			if (tx.accountId === intoId) return [tx];
			if (tx.accountId !== from.id || isCardAdjustment(tx)) return [];
			return [{ ...tx, cardLast4: tx.cardLast4 ?? from.last4 }];
		});
		return summarizeCardDuplicates(findCardDuplicates(kept, dismissed).groups).count;
	};

	// O destino se escolhe numa folha com todos os cartões (E2E-39): o Alert do Android mostra no
	// máximo três botões. A confirmação, com dois, continua no Alert.
	const handleMerge = () => {
		if (!existing || mergeCandidates.length === 0) return;
		setMerging(true);
	};

	const confirmMerge = (card: Account) => {
		setMerging(false);
		if (!existing) return;
		Alert.alert(t('cards.edit.merge'), t('cards.edit.mergeConfirm', { from: existing.name, into: card.name }), [
			{ text: t('cards.cancel'), style: 'cancel' },
			{
				text: t('cards.edit.mergeAction'),
				onPress: async () => {
					const dismissed = await getDismissedCardDuplicates();
					const repeated = keptDuplicateCount(existing, card.id, dismissed);
					await mergeCards(existing.id, card.id);
					announce(t('cards.edit.merged', { into: card.name }));
					// Juntar não apaga a cópia da compra que estava nos dois (SPD-098): o dono precisa saber.
					if (repeated > 0) {
						Alert.alert(t('cards.edit.merged', { into: card.name }), t('cards.duplicates.afterMerge', { count: repeated, into: card.name }));
					}
					leaveRemovedCard(existing.id, card.id);
				},
			},
		]);
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			{/* No Android, sem `behavior` nada encolhia e o teclado cobria o salvar no fim da rolagem (SPD-121): o `height` encolhe a área, como na `Sheet`. */}
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
				<View style={styles.header}>
					<Pressable
						onPress={() => router.back()}
						accessibilityRole="button"
						accessibilityLabel={t('cards.back')}
						style={styles.iconButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
						{existing ? t('cards.edit.title') : t('cards.edit.newTitle')}
					</Text>
					<HelpButton screen="cardEdit" />
				</View>

				<ScrollView ref={tourScroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
						<CardFace card={preview} summary={undefined} />
					</View>

					<ChipGroup
						label={t('cards.edit.type')}
						options={[
							{ value: 'credit', label: t('cards.edit.credit') },
							{ value: 'debit', label: t('cards.edit.debit') },
						]}
						selected={cardType}
						onSelect={(value) => setCardType(value)}
					/>

					{cardType === 'debit' ? (
						<View style={styles.debit} accessibilityLiveRegion="polite">
							<Text style={styles.debitBody}>{t('cards.edit.debitBody')}</Text>
							{existing ? (
								bankAccounts.length > 0 ? (
									<>
										<SelectField
											label={t('cards.edit.debitAccount')}
											options={accountSelectOptions(bankAccounts)}
											selected={chosenDebitAccount?.id ?? null}
											onSelect={(value) => setDebitAccountId(value)}
										/>
										<Button
											label={t('cards.edit.debitConvert')}
											icon="swap-horizontal"
											onPress={handleConvertToDebit}
											disabled={!chosenDebitAccount}
										/>
									</>
								) : (
									<Text style={styles.debitBody}>{t('cards.edit.debitNoAccount')}</Text>
								)
							) : (
								<Button label={t('cards.back')} icon="arrow-back" variant="secondary" onPress={() => router.back()} />
							)}
						</View>
					) : null}

					{cardType === 'credit' ? (
					<>
					{/* Lista que abre de baixo (SPD-130): 11 bancos em botões ocupavam meia tela. */}
					<SelectField
						label={t('cards.edit.bank')}
						options={bankOptions}
						selected={bankId}
						onSelect={(value) => setBankId(value)}
						error={bankId !== OTHER ? errors.bank : undefined}
					/>
					{bankId === OTHER ? (
						<Field
							label={t('cards.edit.bankName')}
							value={otherBank}
							onChangeText={setOtherBank}
							placeholder={t('cards.edit.bankNamePlaceholder')}
							error={errors.bank}
						/>
					) : null}

					<Field
						label={t('cards.edit.nickname')}
						optionalLabel={t('cards.edit.optional')}
						value={name}
						onChangeText={setName}
						placeholder={t('cards.edit.nicknamePlaceholder')}
						hint={t('cards.edit.nicknameHint')}
					/>

					<TourTarget id="cardEdit.last4">
					<Field
						label={t('cards.edit.last4')}
						optionalLabel={t('cards.edit.optional')}
						value={last4}
						onChangeText={(text) => setLast4(text.replace(/\D/g, '').slice(0, 4))}
						keyboardType="number-pad"
						maxLength={4}
						hint={t('cards.edit.last4Hint')}
						error={errors.last4}
					/>
					</TourTarget>

					<ChipGroup
						label={t('cards.edit.network')}
						options={networkOptions}
						selected={network}
						onSelect={(value) => setNetwork(value === network ? null : value)}
					/>

					<Field
						label={t('cards.edit.limit')}
						optionalLabel={t('cards.edit.optional')}
						value={limit}
						onChangeText={setLimit}
						keyboardType="decimal-pad"
						hint={t('cards.edit.limitHint')}
						error={errors.limit}
					/>

					<TourTarget id="cardEdit.days" style={styles.twoColumns}>
						<View style={styles.column}>
							<Field
								label={t('cards.edit.closingDay')}
								value={closingDay}
								onChangeText={(text) => setClosingDay(text.replace(/\D/g, '').slice(0, 2))}
								keyboardType="number-pad"
								maxLength={2}
								error={errors.closing}
							/>
						</View>
						<View style={styles.column}>
							<Field
								label={t('cards.edit.dueDay')}
								value={dueDay}
								onChangeText={(text) => setDueDay(text.replace(/\D/g, '').slice(0, 2))}
								keyboardType="number-pad"
								maxLength={2}
								error={errors.due}
							/>
						</View>
					</TourTarget>
					<Text style={styles.explain}>{t('cards.edit.cycleHint')}</Text>
					{cyclePreview ? (
						<Text style={styles.cyclePreview} accessibilityLiveRegion="polite">
							{t('cards.edit.cyclePreview', {
								month: formatMonthLong(`${cyclePreview.key}-01`),
								closing: formatDayMonth(cyclePreview.closingDate),
								due: formatDayMonth(cyclePreview.dueDate),
							})}
						</Text>
					) : dueGapInvalid(typedGap) && !errors.due ? (
						// Os dois dias digitados dão um prazo fora de 1 a 20: no lugar da linha das datas,
						// o porquê, já enquanto se digita — antes ela sumia calada e o aviso só vinha no
						// salvar (E2E-50). Depois do salvar, o aviso fica no campo, uma vez só.
						<Text style={styles.cycleInvalid} accessibilityLiveRegion="polite">
							{t('cards.edit.invalidDueGap')}
						</Text>
					) : null}

					{!existing && asked?.closed ? (
						<Field
							label={t('cards.edit.closedInvoice', {
								month: formatMonthLong(`${asked.closed.key}-01`),
								due: formatDayMonth(asked.closed.dueDate),
							})}
							optionalLabel={t('cards.edit.optional')}
							value={closedInvoice}
							onChangeText={setClosedInvoice}
							keyboardType="decimal-pad"
							hint={t('cards.edit.closedInvoiceHint')}
							error={errors.closedInvoice}
						/>
					) : null}
					{!existing ? (
						<Field
							label={
								asked
									? t('cards.edit.openInvoice', {
											month: formatMonthLong(`${asked.open.key}-01`),
											closing: formatDayMonth(asked.open.closingDate),
										})
									: t('cards.edit.currentInvoice')
							}
							optionalLabel={t('cards.edit.optional')}
							value={currentInvoice}
							onChangeText={setCurrentInvoice}
							keyboardType="decimal-pad"
							hint={asked ? t('cards.edit.openInvoiceHint') : t('cards.edit.currentInvoiceHint')}
							error={errors.invoice}
						/>
					) : null}

					<Button label={t('cards.edit.save')} onPress={handleSave} disabled={saving} icon="checkmark" />

					{existing ? (
						<View style={styles.secondary}>
							<Button
								label={existing.archived ? t('cards.edit.unarchive') : t('cards.edit.archive')}
								hint={t('cards.edit.archiveHint')}
								onPress={handleArchive}
								variant="secondary"
								icon={existing.archived ? 'arrow-undo-outline' : 'archive-outline'}
							/>
							{mergeCandidates.length > 0 ? (
								<Button
									label={t('cards.edit.merge')}
									hint={t('cards.edit.mergeHint')}
									onPress={handleMerge}
									variant="secondary"
									icon="git-merge-outline"
								/>
							) : null}
							<Button label={t('cards.edit.delete')} onPress={handleDelete} variant="danger" icon="trash-outline" />
						</View>
					) : null}
					</>
					) : null}
				</ScrollView>
			</KeyboardAvoidingView>

			{existing ? (
				<MergeTargetSheet
					visible={merging}
					title={t('cards.edit.merge')}
					subtitle={t('cards.edit.mergePick', { name: existing.name })}
					targets={mergeCandidates}
					onPick={confirmMerge}
					onClose={() => setMerging(false)}
				/>
			) : null}
		</SafeAreaView>
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
		gap: 18,
	},
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	column: {
		flex: 1,
	},
	explain: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: -8,
	},
	secondary: {
		gap: 10,
	},
	cyclePreview: {
		fontSize: 15,
		lineHeight: 22,
		color: '#FFFFFF',
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		padding: 12,
	},
	cycleInvalid: {
		fontSize: 15,
		lineHeight: 22,
		color: '#FF8A80',
		backgroundColor: 'rgba(255,138,128,0.1)',
		borderRadius: 12,
		padding: 12,
	},
	debit: {
		gap: 14,
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
	},
	debitBody: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.85)',
	},
});

export default CardEditScreen;
