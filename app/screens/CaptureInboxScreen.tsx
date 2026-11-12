import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { accountSelectOptions } from '../components/AccountPicker';
import { categoryChoices, mostUsedSection } from '../components/CategoryPicker';
import { SelectSheet } from '../components/SelectField';
import HelpButton from '../components/tour/HelpButton';
import { TourTarget, useScreenTour, useTourScroll, useTourTarget } from '../components/tour/TourContext';
import { useAccounts } from '../contexts/AccountsContext';
import { useCaptures } from '../contexts/CapturesContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { getStatementClaimedCaptureIds } from '../database/captures';
import { getBillPayments, getBills } from '../database/database';
import type {
	Account,
	Bill,
	BillPayment,
	Capture,
	Category,
	Transaction,
} from '../database/schema';
import { ambiguityOfReason } from '../utils/ambiguityReasons';
import { onBillsChanged } from '../utils/billEvents';
import { billSettledBy } from '../utils/billMatcher';
import { resolveCategoryId } from '../utils/captureActions';
import { isStatementPackage, STATEMENT_LEDGER_SUSPECT_REASON } from '../utils/captureMatcher';
import type { CaptureDirection } from '../utils/captureParser';
import { formatDate, getISODate, monthKeyName } from '../utils/dateUtils';
import { splitInstallments } from '../utils/installments';
import { formatCents } from '../utils/money';

/**
 * A caixa de entrada: cada notificação capturada vira um cartão para confirmar com
 * um toque, e as dúvidas que o app não resolve sozinho — "é a mesma compra?", "é
 * transferência entre suas contas?" — viram uma pergunta de dois botões dentro do
 * cartão. Nada acontece sem o usuário ver, e tudo que acontece dá para desfazer.
 *
 * Acessibilidade: todo controle tem ao menos 48 pontos de altura, rótulo e dica para
 * leitor de tela; valores são anunciados por extenso pelo `formatCents`; mudanças de
 * estado são anunciadas; nada depende só de cor.
 */

const UNDO_WINDOW_MS = 8000;
const AUTO_APPROVED_DAYS = 7;

const ACCENT = '#15E8FE';

const whenLabel = (iso: string): string => {
	const date = new Date(iso);
	const today = new Date();
	const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	if (date.toDateString() === today.toDateString()) return time;
	return `${formatDate(getISODate(date))} ${time}`;
};

/** Linhas de extrato só têm o dia; mostrar "12:00" seria inventar um horário. */
const whenLabelFor = (capture: Pick<Capture, 'packageName' | 'postedAt'>): string =>
	isStatementPackage(capture.packageName)
		? formatDate(getISODate(new Date(capture.postedAt)))
		: whenLabel(capture.postedAt);

/**
 * Onde a captura vai cair, e em quantas vezes — as duas coisas que a revisão não mostrava.
 *
 * A conta é a decisão mais arriscada do fluxo (dinheiro no lugar errado não aparece em
 * lugar nenhum) e "Sem conta" agora acontece de propósito: desde a 1.2.6, quando o app
 * não sabe de onde saiu o dinheiro ele não chuta. As parcelas são o que mais muda o caixa
 * futuro: uma compra em 3x aparecia como "− R$ 300,00" e ao confirmar virava três
 * parcelas de R$ 100 em três faturas, sem nada disso estar escrito (achado 7.7).
 */
export const destinationLabel = (
	capture: Pick<Capture, 'accountId'>,
	accounts: Account[],
	t: (key: string, options?: Record<string, unknown>) => string
): string => {
	if (!capture.accountId) return t('captures.noAccount');
	const account = accounts.find((item) => item.id === capture.accountId);
	return account ? account.name : t('captures.noAccount');
};

/** "3x de R$ 100,00": a divisão exata que a confirmação vai lançar. */
export const installmentsLabel = (
	capture: Pick<Capture, 'amountCents' | 'installments'>,
	t: (key: string, options?: Record<string, unknown>) => string
): string | null => {
	const count = capture.installments ?? 1;
	if (count <= 1) return null;
	const parts = splitInstallments(capture.amountCents, count);
	// `times`, não `count`: `count` liga a pluralização do i18next, e aqui o número é
	// parte da frase ("3x"), não a contagem de uma coisa no plural.
	return t('captures.installmentsSplit', { times: count, amount: formatCents(parts[0]) });
};

/**
 * O aviso da compra em moeda estrangeira (SPD-037), ou `null`.
 *
 * A notificação trazia só o valor da outra moeda: o número no cartão é ele (US$ 15,99
 * aparece como R$ 15,99), e por isso a captura não foi confirmada sozinha nem com a regra
 * aprendida. O valor em reais só aparece na fatura; o aviso pede para conferir antes.
 */
export const currencyWarning = (
	capture: Pick<Capture, 'reason'>,
	t: (key: string, options?: Record<string, unknown>) => string
): string | null =>
	capture.reason === 'foreign_currency'
		? t('captures.reason.foreign_currency', {
				defaultValue: 'Valor em moeda estrangeira: confira o valor em reais antes de confirmar',
			})
		: null;

/**
 * "Valor confirmado pelo extrato" (SPD-117), ou `null`: a pendente que uma linha de extrato
 * importado casou. O extrato provou o valor e a conta; a categoria era só palpite, então ela
 * continua na revisão. Sem coluna nova: a marca é a linha do extrato que aponta para ela.
 */
export const statementConfirmedLabel = (
	capture: Pick<Capture, 'id' | 'status'>,
	claimedByStatement: ReadonlySet<string>,
	t: (key: string, options?: Record<string, unknown>) => string
): string | null =>
	capture.status === 'pending' && claimedByStatement.has(capture.id) ? t('captures.statementConfirmed') : null;

/**
 * "Avisos do WhatsApp estão sendo ignorados": o app que não é banco e que o usuário
 * descartou três vezes (SPD-022). Aparece na caixa de entrada com "desfazer".
 */
export const ignoredAppLabel = (
	app: string,
	t: (key: string, options?: Record<string, unknown>) => string
): string => t('captures.ignoredApp', { app, defaultValue: 'Avisos do {{app}} estão sendo ignorados' });

/**
 * O botão que mostra o texto cru: "Linha do extrato" no item que veio de OFX — ele não
 * veio de notificação nenhuma (E2E-34) —, "Notificação original" no resto.
 */
export const rawSourceLabel = (
	capture: Pick<Capture, 'packageName'>,
	t: (key: string, options?: Record<string, unknown>) => string
): string => (isStatementPackage(capture.packageName) ? t('captures.statementLine') : t('captures.originalNotification'));

/** A linha do extrato pergunta se é um lançamento que o usuário digitou (`findLedgerSuspect`). */
const isLedgerSuspect = (capture: Pick<Capture, 'question' | 'reason'>): boolean =>
	capture.question === 'duplicate' && capture.reason === STATEMENT_LEDGER_SUSPECT_REASON;

/**
 * "Parece repetido: Padaria de R$ 50,00 em 1 nov, já lançado." O lançamento é o do
 * `relatedId`; a descrição é a nota dele ou, sem nota, a categoria. Lançamento que a tela
 * não tem mais (apagado depois do import) não impede a pergunta, só tira os detalhes.
 */
export const ledgerSuspectLabel = (
	capture: Pick<Capture, 'relatedId'>,
	transactions: Pick<Transaction, 'id' | 'amountCents' | 'date' | 'note' | 'category'>[],
	categories: Pick<Category, 'id' | 'name'>[],
	t: (key: string, options?: Record<string, unknown>) => string
): string => {
	const found = capture.relatedId ? transactions.find((transaction) => transaction.id === capture.relatedId) : undefined;
	if (!found) return t('captures.ledgerSuspectUnknown');
	const description =
		found.note.trim() || categories.find((category) => category.id === found.category)?.name || t('captures.ledgerSuspectEntry');
	return t('captures.ledgerSuspectBody', {
		description,
		amount: formatCents(found.amountCents),
		date: formatDate(found.date),
	});
};

/** O porquê de um item do histórico, ou vazio quando não há um para dizer. */
export const resolvedReasonLabel = (
	capture: Pick<Capture, 'reason' | 'appLabel'>,
	t: (key: string, options?: Record<string, unknown>) => string
): string => {
	if (!capture.reason) return '';
	// O item que a regra do app ignorou diz qual regra foi: é por ele que o usuário chega
	// ao "desfazer" se o app calou um aviso que importava.
	if (capture.reason === 'app_rule') {
		return t('captures.reason.app_rule', {
			app: capture.appLabel,
			defaultValue: 'Avisos do {{app}} estão sendo ignorados',
		});
	}
	return t(`captures.reason.${capture.reason}`, { defaultValue: '', app: capture.appLabel });
};

/**
 * A linha que explica por que o aviso ambíguo está na revisão (SPD-123) — sem o final do
 * cartão, final desconhecido, débito ou crédito, entrou ou saiu, de qual conta saiu o
 * pagamento da fatura — ou que a escolha anterior do usuário decidiu por ele. Vazio quando o
 * item não é um aviso ambíguo. `remember`: só na pergunta, o aviso de que a resposta fica
 * guardada.
 */
export const ambiguityLine = (
	capture: Pick<Capture, 'reason' | 'cardLast4'>,
	t: (key: string, options?: Record<string, unknown>) => string
): { text: string; remember: string } => {
	const ambiguity = ambiguityOfReason(capture.reason);
	if (!ambiguity) return { text: '', remember: '' };
	if (ambiguity.learned) return { text: t('captures.ambiguity.learned'), remember: '' };
	return {
		text: t(`captures.ambiguity.${ambiguity.case}`, { last4: capture.cardLast4 ?? '' }),
		remember: t('captures.ambiguity.remember'),
	};
};

/**
 * Se o cartão do aviso traz uma pergunta (repetido, transferência, entrou ou saiu, de qual
 * conta saiu a fatura): a trilha da revisão (SPD-131) aponta a primeira que aparece.
 */
export const asksQuestion = (capture: Pick<Capture, 'question' | 'reason'>): boolean => {
	if (capture.question === 'duplicate' || capture.question === 'transfer') return true;
	const ambiguity = ambiguityOfReason(capture.reason);
	return Boolean(ambiguity && !ambiguity.learned && (ambiguity.case === 'pix_direction' || ambiguity.case === 'invoice_payment'));
};

/**
 * O detalhe de um item do histórico: a categoria do confirmado, o porquê do resto. O que a
 * regra aprendida num aviso ambíguo lançou diz as duas coisas (SPD-123): é por esse porquê
 * que o usuário acha o lançamento a corrigir.
 */
export const resolvedDetail = (
	capture: Pick<Capture, 'status' | 'reason'>,
	categoryName: string | null,
	reason: string
): string => {
	if (capture.status !== 'confirmed' || !categoryName) return reason;
	return reason && ambiguityOfReason(capture.reason)?.learned ? `${categoryName} · ${reason}` : categoryName;
};

/** A categoria mostrada quando a sugerida não existe: o nome vem da tradução, não fixo em inglês. */
export const fallbackCategory = (
	t: (key: string, options?: Record<string, unknown>) => string
): Pick<Category, 'id' | 'name' | 'color' | 'icon'> => ({
	id: 'uncategorized',
	name: t('transactionsList.uncategorized'),
	color: '#9CA3AF',
	icon: 'help-circle',
});

interface ActionButtonProps {
	label: string;
	hint: string;
	icon: React.ComponentProps<typeof Ionicons>['name'];
	onPress: () => void;
	primary?: boolean;
	danger?: boolean;
	/** A resposta que vale agora, numa pergunta de escolha (SPD-123). */
	selected?: boolean;
}

const ActionButton: React.FC<ActionButtonProps> = ({ label, hint, icon, onPress, primary, danger, selected }) => (
	<Pressable
		onPress={onPress}
		accessibilityRole="button"
		accessibilityLabel={label}
		accessibilityHint={hint}
		accessibilityState={selected === undefined ? undefined : { selected }}
		style={({ pressed }) => [
			styles.button,
			primary && styles.buttonPrimary,
			danger && styles.buttonDanger,
			pressed && styles.buttonPressed,
		]}
	>
		<Ionicons name={icon} size={20} color={primary ? '#000000' : '#FFFFFF'} />
		<Text style={[styles.buttonLabel, primary && styles.buttonLabelPrimary]}>{label}</Text>
	</Pressable>
);

interface CaptureCardProps {
	capture: Capture;
	related: Capture | null;
	categories: Category[];
	/** Os lançamentos, para o "Parece repetido" da linha de extrato dizer qual. */
	transactions: Transaction[];
	/** As capturas que uma linha de extrato casou: a marca "valor confirmado pelo extrato". */
	claimedByStatement: ReadonlySet<string>;
	/** `accountId`: a conta escolhida no cartão; `undefined` quando o usuário não mexeu nela. */
	onConfirm: (capture: Capture, categoryId: string, accountId?: string | null) => void;
	onDismiss: (capture: Capture) => void;
	onTransfer: (capture: Capture) => void;
	onAnswerDuplicate: (capture: Capture, same: boolean) => void;
	onAnswerTransfer: (capture: Capture, isTransfer: boolean) => void;
	/** Entrou ou saiu, no aviso que fala das duas coisas (SPD-123). */
	onAnswerDirection: (capture: Capture, direction: CaptureDirection) => void;
	/** De qual conta saiu o pagamento da fatura, ou `null` para não lançar (SPD-123). */
	onResolveInvoice: (capture: Capture, fromAccountId: string | null) => void;
	/**
	 * Os alvos da trilha da revisão (SPD-131): `main` no primeiro cartão (conta, categoria,
	 * botões, texto original), `question` no primeiro com pergunta, `ambiguity` no primeiro com
	 * a linha do porquê. Só marcam: não mudam nada do cartão.
	 */
	tour?: { main?: boolean; question?: boolean; ambiguity?: boolean };
}

const CaptureCard: React.FC<CaptureCardProps> = ({
	capture,
	related,
	categories,
	transactions,
	claimedByStatement,
	onConfirm,
	onDismiss,
	onTransfer,
	onAnswerDuplicate,
	onAnswerTransfer,
	onAnswerDirection,
	onResolveInvoice,
	tour,
}) => {
	const { t } = useTranslation();
	const accountTarget = useTourTarget(tour?.main ? 'inbox.account' : undefined);
	const categoryTarget = useTourTarget(tour?.main ? 'inbox.category' : undefined);
	const buttonsTarget = useTourTarget(tour?.main ? 'inbox.buttons' : undefined);
	const rawTarget = useTourTarget(tour?.main ? 'inbox.raw' : undefined);
	const questionTarget = useTourTarget(tour?.question ? 'inbox.question' : undefined);
	const ambiguityTarget = useTourTarget(tour?.ambiguity ? 'inbox.ambiguity' : undefined);
	const ledgerSuspect = isLedgerSuspect(capture);
	const { accounts, activeAccounts } = useAccounts();
	const isIncome = capture.direction === 'in';
	const [categoryId, setCategoryId] = useState(() =>
		resolveCategoryId(capture.suggestedCategory, capture.direction, categories)
	);
	// A resposta "entrou/saiu" troca a direção do item: a categoria sugerida passa a ser a do
	// outro lado (receita × despesa), senão a confirmação levaria uma categoria de despesa.
	const [shownDirection, setShownDirection] = useState(capture.direction);
	if (shownDirection !== capture.direction) {
		setShownDirection(capture.direction);
		setCategoryId(resolveCategoryId(capture.suggestedCategory, capture.direction, categories));
	}
	const ambiguity = ambiguityOfReason(capture.reason);
	const askedCase = ambiguity && !ambiguity.learned ? ambiguity.case : null;
	const explained = ambiguityLine(capture, t);
	// As listas de categoria e de conta, que abrem de baixo (SPD-130).
	const [pickerOpen, setPickerOpen] = useState(false);
	const [rawOpen, setRawOpen] = useState(false);
	// A conta escolhida aqui (SPD-111). `undefined` enquanto o usuário não mexe: vale a do
	// aviso, inclusive se ela mudar por fora (o pull trouxe a decisão de outro aparelho).
	const [chosenAccountId, setChosenAccountId] = useState<string | null | undefined>(undefined);
	const accountId = chosenAccountId === undefined ? capture.accountId : chosenAccountId;
	// A linha da conta abre a lista das contas; "Sem conta" vem destacada na linha (SPD-111).
	const [accountPickerOpen, setAccountPickerOpen] = useState(false);
	const canPickAccount = activeAccounts.length > 0;
	const categoryList = useMemo(() => categoryChoices(categories, isIncome, transactions), [categories, isIncome, transactions]);

	const category = categories.find((c) => c.id === categoryId) ?? fallbackCategory(t);
	const amount = formatCents(capture.amountCents);
	const kindLabel = t(`captures.kind.${capture.kind}`, { defaultValue: t('captures.kind.unknown') });
	const destination = destinationLabel({ accountId }, accounts, t);
	const installments = installmentsLabel(capture, t);
	const warning = currencyWarning(capture, t);
	const confirmedByStatement = statementConfirmedLabel(capture, claimedByStatement, t);
	const summary = `${isIncome ? t('captures.income') : t('captures.expense')}, ${amount}, ${
		capture.counterparty ?? kindLabel
	}, ${t('captures.inAccount', { account: destination })}${installments ? `, ${installments}` : ''}, ${t(
		'captures.from',
		{ app: capture.appLabel, time: whenLabelFor(capture) }
	)}${warning ? `. ${warning}` : ''}${confirmedByStatement ? `. ${confirmedByStatement}` : ''}${
		explained.text ? `. ${explained.text}` : ''
	}`;
	const isInvoiceQuestion = askedCase === 'invoice_payment';

	const payInvoice = () => {
		// Sem conta escolhida, o botão abre o seletor: é a pergunta que falta responder.
		if (!accountId) {
			setAccountPickerOpen(true);
			return;
		}
		onResolveInvoice(capture, accountId);
	};

	return (
		<View style={styles.card}>
			<View accessible accessibilityLabel={summary}>
				<View style={styles.cardHeader}>
					<Text style={[styles.amount, isIncome ? styles.income : styles.expense]}>
						{isIncome ? '+' : '−'} {amount}
					</Text>
					<Text style={styles.meta}>
						{t('captures.from', { app: capture.appLabel, time: whenLabelFor(capture) })}
					</Text>
				</View>
				<Text style={styles.counterparty}>{capture.counterparty ?? kindLabel}</Text>
				<Text style={styles.kind}>
					{kindLabel}
					{capture.cardLast4 ? ` · ${t('captures.cardEnding', { last4: capture.cardLast4 })}` : ''}
				</Text>
				{/* Junto do valor, dentro do resumo que o leitor de tela lê: é o valor que está
				    em dúvida. Ícone e texto, não só cor. */}
				{warning && (
					<View style={styles.currencyWarning}>
						<Ionicons name="alert-circle-outline" size={18} color="#FFD166" />
						<Text style={styles.currencyWarningText}>{warning}</Text>
					</View>
				)}
				{/* Junto do valor, que é o que o extrato confirmou. Ícone e texto, não só cor. */}
				{confirmedByStatement && (
					<View style={styles.statementConfirmed}>
						<Ionicons name="checkmark-circle-outline" size={16} color={ACCENT} />
						<Text style={styles.statementConfirmedText}>{confirmedByStatement}</Text>
					</View>
				)}
				{/* Por que o aviso ambíguo está aqui, ou que a escolha anterior decidiu (SPD-123).
				    Ícone e texto, dentro do resumo que o leitor de tela lê. */}
				{explained.text !== '' && (
					<View {...ambiguityTarget} style={styles.ambiguity}>
						<Ionicons
							name={ambiguity?.learned ? 'school-outline' : 'help-circle-outline'}
							size={16}
							color={ACCENT}
						/>
						<Text style={styles.ambiguityText}>{explained.text}</Text>
					</View>
				)}
			</View>

			{/* Nada depende só de cor: o ícone acompanha o texto, e o texto diz "Sem conta"
			    com todas as letras quando o app não soube de onde saiu o dinheiro. Fora do
			    resumo (que já diz a conta) porque é um controle: abre o seletor (SPD-111). */}
			<Pressable
				{...accountTarget}
				onPress={() => setAccountPickerOpen(true)}
				disabled={!canPickAccount}
				accessibilityRole="button"
				accessibilityLabel={t('captures.inAccount', { account: destination })}
				accessibilityHint={canPickAccount ? t('captures.changeAccountHint') : undefined}
				accessibilityState={{ expanded: accountPickerOpen && canPickAccount, disabled: !canPickAccount }}
				style={({ pressed }) => [styles.destinationRow, pressed && styles.buttonPressed]}
			>
				<Ionicons name={accountId ? 'wallet-outline' : 'help-circle-outline'} size={15} color="rgba(255,255,255,0.7)" />
				<Text style={[styles.destination, !accountId && styles.destinationMissing]}>
					{t('captures.inAccount', { account: destination })}
				</Text>
				{installments && <Text style={styles.installments}>{installments}</Text>}
				{canPickAccount && <Ionicons name="chevron-down" size={18} color="rgba(255,255,255,0.7)" />}
			</Pressable>

			{/* A mesma lista de contas do formulário de lançamento. Num cartão, a confirmação segue
			    as regras do cartão (parcelas no ciclo dele); o final do cartão é o que o aviso disse. */}
			{canPickAccount && (
				<SelectSheet
					visible={accountPickerOpen}
					title={t('accounts.picker.label')}
					options={accountSelectOptions(activeAccounts)}
					selected={accountId}
					onSelect={(id) => setChosenAccountId(id)}
					clearLabel={t('accounts.picker.none')}
					onClear={() => setChosenAccountId(null)}
					onClose={() => setAccountPickerOpen(false)}
				/>
			)}

			{capture.question === 'duplicate' && (
				<View {...questionTarget} style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('captures.questionDuplicateTitle')}</Text>
					<Text style={styles.questionBody}>
						{ledgerSuspect
							? ledgerSuspectLabel(capture, transactions, categories, t)
							: t('captures.questionDuplicateBody', {
									app: related?.appLabel ?? '?',
									time: related ? whenLabelFor(related) : '?',
								})}
					</Text>
					<View style={styles.questionActions}>
						<ActionButton
							label={t('captures.sameEntry')}
							hint={ledgerSuspect ? t('captures.ledgerSameHint') : t('captures.sameEntryHint')}
							icon="copy-outline"
							onPress={() => onAnswerDuplicate(capture, true)}
							primary
						/>
						<ActionButton
							label={t('captures.differentEntries')}
							hint={t('captures.differentEntriesHint')}
							icon="git-branch-outline"
							onPress={() => onAnswerDuplicate(capture, false)}
						/>
					</View>
				</View>
			)}

			{capture.question === 'transfer' && (
				<View {...questionTarget} style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('captures.questionTransferTitle')}</Text>
					<Text style={styles.questionBody}>
						{t('captures.questionTransferBody', {
							app: related?.appLabel ?? '?',
							time: related ? whenLabelFor(related) : '?',
						})}
					</Text>
					<View style={styles.questionActions}>
						<ActionButton
							label={t('captures.yesTransfer')}
							hint={t('captures.yesTransferHint')}
							icon="swap-horizontal"
							onPress={() => onAnswerTransfer(capture, true)}
							primary
						/>
						<ActionButton
							label={t('captures.noTransfer')}
							hint={t('captures.noTransferHint')}
							icon="git-branch-outline"
							onPress={() => onAnswerTransfer(capture, false)}
						/>
					</View>
				</View>
			)}

			{askedCase === 'pix_direction' && (
				<View {...questionTarget} style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('captures.directionQuestionTitle')}</Text>
					<Text style={styles.questionBody}>{explained.remember}</Text>
					<View style={styles.questionActions}>
						<ActionButton
							label={t('captures.directionIn')}
							hint={t('captures.directionInHint')}
							icon="arrow-down"
							onPress={() => onAnswerDirection(capture, 'in')}
							primary={isIncome}
							selected={isIncome}
						/>
						<ActionButton
							label={t('captures.directionOut')}
							hint={t('captures.directionOutHint')}
							icon="arrow-up"
							onPress={() => onAnswerDirection(capture, 'out')}
							primary={!isIncome}
							selected={!isIncome}
						/>
					</View>
				</View>
			)}

			{/* "Recebemos o pagamento da fatura" sem dizer de onde (X-2): de qual conta saiu,
			    escolhida no seletor acima, ou não lançar. Categoria e "confirmar" não cabem. */}
			{isInvoiceQuestion && (
				<View {...questionTarget} style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('captures.invoiceQuestionTitle')}</Text>
					<Text style={styles.questionBody}>
						{accountId ? explained.remember : t('captures.invoiceChooseAccount')}
					</Text>
					<View style={styles.questionActions}>
						<ActionButton
							label={t('captures.invoicePay')}
							hint={accountId ? t('captures.invoicePayHint') : t('captures.invoiceChooseAccount')}
							icon="swap-horizontal"
							onPress={payInvoice}
							primary
						/>
						<ActionButton
							label={t('captures.invoiceSkip')}
							hint={t('captures.invoiceSkipHint')}
							icon="close"
							onPress={() => onResolveInvoice(capture, null)}
						/>
					</View>
				</View>
			)}

			{!isInvoiceQuestion && (
				<>
					<Pressable
						{...categoryTarget}
						onPress={() => setPickerOpen(true)}
						accessibilityRole="button"
						accessibilityLabel={t('captures.categoryLabel', { category: category.name })}
						accessibilityHint={t('captures.changeCategoryHint')}
						accessibilityState={{ expanded: pickerOpen }}
						style={({ pressed }) => [styles.categoryChip, pressed && styles.buttonPressed]}
					>
						<View style={[styles.categoryDot, { backgroundColor: category.color }]}>
							{/* biome-ignore lint/suspicious/noExplicitAny: external API shape unknown */}
							<Ionicons name={category.icon as any} size={14} color="#000000" />
						</View>
						<Text style={styles.categoryName}>{category.name}</Text>
						<Ionicons name="chevron-down" size={18} color="rgba(255,255,255,0.7)" />
					</Pressable>

					{/* Corrigir a categoria não confirma: o "Confirmar" continua sendo o passo seguinte. */}
					<SelectSheet
						visible={pickerOpen}
						title={t('transactionForm.category')}
						options={categoryList.options}
						featured={mostUsedSection(categoryList.mostUsed, t)}
						selected={categoryId}
						onSelect={setCategoryId}
						onClose={() => setPickerOpen(false)}
					/>

					<View {...buttonsTarget} style={styles.actions}>
						<ActionButton
							label={t('captures.confirm')}
							hint={t('captures.confirmHint', { category: category.name })}
							icon="checkmark"
							onPress={() => onConfirm(capture, categoryId, chosenAccountId)}
							primary
						/>
						<ActionButton
							label={t('captures.transfer')}
							hint={t('captures.transferHint')}
							icon="swap-horizontal"
							onPress={() => onTransfer(capture)}
						/>
						<ActionButton
							label={t('captures.dismiss')}
							hint={t('captures.dismissHint')}
							icon="close"
							onPress={() => onDismiss(capture)}
						/>
					</View>
				</>
			)}

			<Pressable
				{...rawTarget}
				onPress={() => setRawOpen((open) => !open)}
				accessibilityRole="button"
				accessibilityLabel={rawSourceLabel(capture, t)}
				accessibilityState={{ expanded: rawOpen }}
				style={styles.rawToggle}
			>
				<Text style={styles.rawToggleText}>{rawSourceLabel(capture, t)}</Text>
			</Pressable>
			{rawOpen && (
				<Text style={styles.raw} selectable>
					{capture.title ? `${capture.title}\n` : ''}
					{capture.text}
				</Text>
			)}
		</View>
	);
};

interface ResolvedRowProps {
	capture: Capture;
	categories: Category[];
	onRevert: (capture: Capture) => void;
	revertLabel: string;
	/**
	 * A conta a pagar que o lançamento desta captura quitou (SPD-153), com o mês quando há o
	 * registro dele (SPD-146); sem registro, só o nome.
	 */
	settledBill?: { name: string; month: string | null } | null;
}

/** "quitou Plano de outubro", ou "quitou Plano" sem o registro do mês. */
const settledBillText = (
	settledBill: { name: string; month: string | null } | null | undefined,
	t: (key: string, options?: Record<string, unknown>) => string
): string => {
	if (!settledBill) return '';
	return settledBill.month
		? t('captures.settledBillMonth', {
				name: settledBill.name,
				month: monthKeyName(settledBill.month),
			})
		: t('captures.settledBill', { name: settledBill.name });
};

const ResolvedRow: React.FC<ResolvedRowProps> = ({
	capture,
	categories,
	onRevert,
	revertLabel,
	settledBill,
}) => {
	const { t } = useTranslation();
	const isIncome = capture.direction === 'in';
	const category = categories.find((c) => c.id === capture.suggestedCategory);
	const status = t(`captures.status.${capture.status}`, { defaultValue: capture.status });
	const reason = resolvedReasonLabel(capture, t);
	const settled = settledBillText(settledBill, t);
	const detail = [resolvedDetail(capture, category?.name ?? null, reason), settled].filter(Boolean).join(' · ');
	const summary = `${status}. ${isIncome ? '+' : '−'} ${formatCents(capture.amountCents)}, ${
		capture.counterparty ?? capture.appLabel
	}. ${detail}`;
	const [rawOpen, setRawOpen] = useState(false);

	return (
		<View style={styles.resolvedBlock}>
			<View style={styles.resolvedRow}>
				{/* Tocar no resumo mostra o texto original: é assim que se confere uma
				    decisão do app (por que ignorou? de onde veio?) sem sair do histórico. */}
				<Pressable
					style={styles.resolvedInfo}
					onPress={() => setRawOpen((open) => !open)}
					accessibilityRole="button"
					accessibilityLabel={summary}
					accessibilityHint={t('captures.originalNotificationHint')}
					accessibilityState={{ expanded: rawOpen }}
				>
					<Text style={styles.resolvedTitle}>
						<Text style={isIncome ? styles.income : styles.expense}>
							{isIncome ? '+' : '−'} {formatCents(capture.amountCents)}
						</Text>
						{'  '}
						{capture.counterparty ?? capture.appLabel}
					</Text>
					<Text style={styles.resolvedMeta}>
						{status}
						{detail ? ` · ${detail}` : ''} · {whenLabelFor(capture)}
					</Text>
					<Text style={styles.resolvedSource}>
						{capture.appLabel} · {rawOpen ? t('captures.hideOriginal') : rawSourceLabel(capture, t)}
					</Text>
				</Pressable>
				<Pressable
					onPress={() => onRevert(capture)}
					accessibilityRole="button"
					accessibilityLabel={`${revertLabel}: ${capture.counterparty ?? capture.appLabel}`}
					accessibilityHint={t('captures.revertHint')}
					style={({ pressed }) => [styles.revertButton, pressed && styles.buttonPressed]}
				>
					<Ionicons name="arrow-undo-outline" size={18} color={ACCENT} />
					<Text style={styles.revertLabel}>{revertLabel}</Text>
				</Pressable>
			</View>
			{rawOpen && (
				<Text style={styles.raw} selectable>
					{capture.title ? `${capture.title}\n` : ''}
					{capture.text}
				</Text>
			)}
		</View>
	);
};

const CaptureInboxScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { categories, transactions } = useTransactions();
	const {
		supported,
		enabled,
		pending,
		resolved,
		ignoredApps,
		isLoading,
		lastAction,
		refresh,
		openSettings,
		confirm,
		dismiss,
		markTransfer,
		answerDuplicate,
		answerTransfer,
		answerDirection,
		resolveInvoicePayment,
		revert,
		unignoreApp,
		undo,
		clearUndo,
	} = useCaptures();

	const [refreshing, setRefreshing] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	// O guia da revisão (SPD-129): o primeiro cartão e o "o app aprende".
	useScreenTour('inbox', { ready: !isLoading });
	const tourScroll = useTourScroll('inbox');
	// A trilha da revisão (SPD-131): o primeiro aviso com pergunta e o primeiro com a linha do porquê.
	const questionTourId = useMemo(() => pending.find(asksQuestion)?.id, [pending]);
	const ambiguityTourId = useMemo(() => pending.find((capture) => ambiguityLine(capture, t).text !== '')?.id, [pending, t]);
	const autoTarget = useTourTarget('inbox.auto');
	const ignoredTarget = useTourTarget('inbox.ignored');
	const historyTarget = useTourTarget('inbox.history');
	// As pendentes que um extrato importado casou (SPD-117), relidas quando a fila muda.
	const [claimedByStatement, setClaimedByStatement] = useState<ReadonlySet<string>>(() => new Set());
	const pendingIds = useMemo(() => pending.map((capture) => capture.id).join(','), [pending]);
	useEffect(() => {
		if (!pendingIds) return undefined;
		let active = true;
		getStatementClaimedCaptureIds()
			.then((ids) => {
				if (active) setClaimedByStatement(ids);
			})
			.catch((error) => console.error('Failed to load statement matches:', error));
		return () => {
			active = false;
		};
	}, [pendingIds]);
	const [undoVisible, setUndoVisible] = useState(false);

	// A barra de desfazer some sozinha, mas sem pressa: oito segundos dá tempo de ler.
	useEffect(() => {
		if (!lastAction) {
			setUndoVisible(false);
			return;
		}
		setUndoVisible(true);
		const timer = setTimeout(() => {
			setUndoVisible(false);
			clearUndo();
		}, UNDO_WINDOW_MS);
		return () => clearTimeout(timer);
	}, [lastAction, clearUndo]);

	const byId = useMemo(() => {
		const map = new Map<string, Capture>();
		for (const capture of [...pending, ...resolved]) map.set(capture.id, capture);
		return map;
	}, [pending, resolved]);

	const autoApproved = useMemo(() => {
		const cutoff = Date.now() - AUTO_APPROVED_DAYS * 24 * 60 * 60 * 1000;
		return resolved.filter(
			(c) => c.autoConfirmed && c.status === 'confirmed' && new Date(c.updatedAt).getTime() >= cutoff
		);
	}, [resolved]);

	// As contas a pagar, para dizer na linha do aprovado sozinho qual conta o lançamento quitou
	// (SPD-153) e, com o registro do mês (SPD-146), qual mês. Relidas quando os aprovados mudam e
	// quando as contas mudam (a baixa chega por `emitBillsChanged`), como as pendentes que o
	// extrato casou.
	const [bills, setBills] = useState<Bill[]>([]);
	const [billPayments, setBillPayments] = useState<BillPayment[]>([]);
	const autoApprovedRefs = useMemo(() => autoApproved.map((c) => c.transactionId ?? '').join(','), [autoApproved]);
	useEffect(() => {
		if (!autoApprovedRefs) return undefined;
		let active = true;
		const reload = () => {
			Promise.all([getBills(), getBillPayments()])
				.then(([rows, months]) => {
					if (!active) return;
					setBills(rows);
					setBillPayments(months);
				})
				.catch((error) => console.error('Failed to load bills:', error));
		};
		reload();
		const stop = onBillsChanged(reload);
		return () => {
			active = false;
			stop();
		};
	}, [autoApprovedRefs]);

	const announce = useCallback((message: string) => {
		AccessibilityInfo.announceForAccessibility(message);
	}, []);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refresh();
		} finally {
			setRefreshing(false);
		}
	}, [refresh]);

	const handleConfirm = useCallback(
		async (capture: Capture, categoryId: string, accountId?: string | null) => {
			await confirm(capture.id, categoryId, accountId);
			const category = categories.find((c) => c.id === categoryId);
			announce(
				t('captures.announceConfirmed', {
					amount: formatCents(capture.amountCents),
					category: category?.name ?? '',
				})
			);
		},
		[confirm, categories, announce, t]
	);

	const handleDismiss = useCallback(
		async (capture: Capture) => {
			await dismiss(capture.id);
			announce(t('captures.announceDismissed'));
		},
		[dismiss, announce, t]
	);

	const handleTransfer = useCallback(
		async (capture: Capture) => {
			await markTransfer(capture.id);
			announce(t('captures.announceTransfer'));
		},
		[markTransfer, announce, t]
	);

	const handleAnswerDuplicate = useCallback(
		async (capture: Capture, same: boolean) => {
			await answerDuplicate(capture.id, same);
			announce(same ? t('captures.announceDuplicate') : t('captures.announceKeptBoth'));
		},
		[answerDuplicate, announce, t]
	);

	const handleAnswerTransfer = useCallback(
		async (capture: Capture, isTransfer: boolean) => {
			await answerTransfer(capture.id, isTransfer);
			announce(isTransfer ? t('captures.announceTransfer') : t('captures.announceKeptBoth'));
		},
		[answerTransfer, announce, t]
	);

	const handleAnswerDirection = useCallback(
		async (capture: Capture, direction: CaptureDirection) => {
			await answerDirection(capture.id, direction);
			announce(direction === 'in' ? t('captures.announceDirectionIn') : t('captures.announceDirectionOut'));
		},
		[answerDirection, announce, t]
	);

	const handleResolveInvoice = useCallback(
		async (capture: Capture, fromAccountId: string | null) => {
			const done = await resolveInvoicePayment(capture.id, fromAccountId);
			// Recusado: a conta escolhida é um cartão (ou o item já saiu da fila).
			if (!done) announce(t('captures.invoiceChooseAccount'));
			else announce(fromAccountId ? t('captures.announceInvoicePaid') : t('captures.announceDismissed'));
		},
		[resolveInvoicePayment, announce, t]
	);

	const handleRevert = useCallback(
		async (capture: Capture) => {
			await revert(capture.id);
			announce(t('captures.announceReverted'));
		},
		[revert, announce, t]
	);

	const handleUnignore = useCallback(
		async (packageName: string, app: string) => {
			await unignoreApp(packageName);
			announce(
				t('captures.announceUnignored', { app, defaultValue: 'Os avisos do {{app}} voltam para a revisão' })
			);
		},
		[unignoreApp, announce, t]
	);

	const handleUndo = useCallback(async () => {
		await undo();
		announce(t('captures.announceReverted'));
	}, [undo, announce, t]);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('captures.back')}
					hitSlop={12}
					style={styles.backButton}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('captures.headerTitle')}
				</Text>
				<Text style={styles.headerCount} accessibilityLabel={t('captures.pendingCount', { count: pending.length })}>
					{pending.length > 0 ? pending.length : ''}
				</Text>
				<HelpButton trail="review" here={{ screen: 'inbox' }} />
			</View>

			<ScrollView
				ref={tourScroll}
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} colors={[ACCENT]} />
				}
			>
				{!supported && (
					<View style={styles.notice}>
						<Ionicons name="information-circle-outline" size={22} color={ACCENT} />
						<Text style={styles.noticeText}>{t('captures.notSupported')}</Text>
					</View>
				)}

				{supported && !enabled && (
					<View style={styles.setupCard}>
						<Text style={styles.setupTitle} accessibilityRole="header">
							{t('captures.setupTitle')}
						</Text>
						<Text style={styles.setupBody}>{t('captures.setupBody')}</Text>
						<ActionButton
							label={t('captures.setupButton')}
							hint={t('captures.setupHint')}
							icon="settings-outline"
							onPress={openSettings}
							primary
						/>
						<Text style={styles.setupHint}>{t('captures.setupHint')}</Text>
					</View>
				)}

				{pending.length === 0 && !isLoading && (supported ? enabled : false) && (
					<View style={styles.empty}>
						<Ionicons name="checkmark-done-circle-outline" size={40} color={ACCENT} />
						<Text style={styles.emptyText}>{t('captures.empty')}</Text>
					</View>
				)}

				{pending.map((capture, index) => (
					<TourTarget key={capture.id} id={index === 0 ? 'inbox.card' : undefined}>
					<CaptureCard
						key={capture.id}
						capture={capture}
						related={capture.relatedId ? (byId.get(capture.relatedId) ?? null) : null}
						categories={categories}
						transactions={transactions}
						claimedByStatement={claimedByStatement}
						onConfirm={handleConfirm}
						onDismiss={handleDismiss}
						onTransfer={handleTransfer}
						onAnswerDuplicate={handleAnswerDuplicate}
						onAnswerTransfer={handleAnswerTransfer}
						onAnswerDirection={handleAnswerDirection}
						onResolveInvoice={handleResolveInvoice}
						tour={{
							main: index === 0,
							question: capture.id === questionTourId,
							ambiguity: capture.id === ambiguityTourId,
						}}
					/>
					</TourTarget>
				))}

				{pending.length > 0 && (
					<TourTarget id="inbox.learned">
						<Text style={styles.learned}>{t('captures.learned')}</Text>
					</TourTarget>
				)}

				{autoApproved.length > 0 && (
					<View {...autoTarget} style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('captures.autoApprovedTitle')}
						</Text>
						<Text style={styles.sectionBody}>{t('captures.autoApprovedBody')}</Text>
						{autoApproved.map((capture) => (
							<ResolvedRow
								key={capture.id}
								capture={capture}
								categories={categories}
								onRevert={handleRevert}
								revertLabel={t('captures.undo')}
								settledBill={billSettledBy(bills, billPayments, capture.transactionId)}
							/>
						))}
					</View>
				)}

				{/* SPD-022: o app que o usuário descartou três vezes fica calado, mas à vista e com
				    "desfazer" — um aviso de banco repassado por ele não pode sumir sem rastro. */}
				{ignoredApps.length > 0 && (
					<View {...ignoredTarget} style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('captures.ignoredAppsTitle', { defaultValue: 'Avisos ignorados' })}
						</Text>
						{ignoredApps.map((app) => {
							const label = ignoredAppLabel(app.appLabel, t);
							return (
								<View key={app.packageName} style={styles.resolvedRow}>
									<Text style={[styles.resolvedInfo, styles.resolvedTitle]}>{label}</Text>
									<Pressable
										onPress={() => handleUnignore(app.packageName, app.appLabel)}
										accessibilityRole="button"
										accessibilityLabel={`${t('captures.undo')}: ${label}`}
										accessibilityHint={t('captures.unignoreHint', {
											defaultValue: 'Os avisos deste app voltam para a revisão',
										})}
										style={({ pressed }) => [styles.revertButton, pressed && styles.buttonPressed]}
									>
										<Ionicons name="arrow-undo-outline" size={18} color={ACCENT} />
										<Text style={styles.revertLabel}>{t('captures.undo')}</Text>
									</Pressable>
								</View>
							);
						})}
					</View>
				)}

				{resolved.length > 0 && (
					<View style={styles.section}>
						<Pressable
							{...historyTarget}
							onPress={() => setHistoryOpen((open) => !open)}
							accessibilityRole="button"
							accessibilityLabel={historyOpen ? t('captures.hideHistory') : t('captures.showHistory')}
							accessibilityState={{ expanded: historyOpen }}
							style={styles.historyToggle}
						>
							<Text style={styles.sectionTitle}>{t('captures.historyTitle')}</Text>
							<Ionicons name={historyOpen ? 'chevron-up' : 'chevron-down'} size={20} color="rgba(255,255,255,0.7)" />
						</Pressable>
						{historyOpen &&
							resolved.map((capture) => (
								<ResolvedRow
									key={capture.id}
									capture={capture}
									categories={categories}
									onRevert={handleRevert}
									revertLabel={t('captures.revert')}
								/>
							))}
					</View>
				)}
			</ScrollView>

			{undoVisible && lastAction && (
				<View style={styles.undoBar} accessibilityLiveRegion="polite">
					<Text style={styles.undoText}>
						{/* A baixa quita o mês mais antigo em aberto (SPD-145): o aviso diz qual (SPD-153). */}
						{lastAction.bill
							? t('captures.done.confirmBill', {
									name: lastAction.bill.name,
									month: monthKeyName(lastAction.bill.month),
								})
							: t(`captures.done.${lastAction.kind}`)}
					</Text>
					<Pressable
						onPress={handleUndo}
						accessibilityRole="button"
						accessibilityLabel={t('captures.undo')}
						style={({ pressed }) => [styles.undoButton, pressed && styles.buttonPressed]}
					>
						<Text style={styles.undoButtonText}>{t('captures.undo')}</Text>
					</Pressable>
				</View>
			)}
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
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 24,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	headerCount: {
		fontSize: 18,
		fontWeight: '600',
		color: ACCENT,
		minWidth: 32,
		textAlign: 'right',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	notice: {
		flexDirection: 'row',
		gap: 12,
		alignItems: 'center',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
	},
	noticeText: {
		flex: 1,
		color: 'rgba(255,255,255,0.85)',
		fontSize: 15,
		lineHeight: 21,
	},
	setupCard: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 12,
	},
	setupTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	setupBody: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.85)',
	},
	setupHint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
	},
	empty: {
		alignItems: 'center',
		gap: 12,
		paddingVertical: 40,
	},
	emptyText: {
		textAlign: 'center',
		color: 'rgba(255,255,255,0.75)',
		fontSize: 16,
		lineHeight: 22,
		paddingHorizontal: 16,
	},
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 12,
	},
	cardHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'flex-end',
		marginBottom: 6,
	},
	amount: {
		fontSize: 26,
		fontWeight: '700',
	},
	income: {
		color: '#4CAF50',
	},
	expense: {
		color: '#FF6B6B',
	},
	meta: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	counterparty: {
		fontSize: 17,
		fontWeight: '500',
		color: '#FFFFFF',
	},
	kind: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	destinationRow: {
		flexDirection: 'row',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: 6,
		minHeight: 48,
		marginTop: 2,
		marginBottom: 8,
	},
	destination: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	destinationMissing: {
		color: '#FFD166',
	},
	installments: {
		fontSize: 13,
		fontWeight: '600',
		color: '#000000',
		backgroundColor: ACCENT,
		borderRadius: 6,
		paddingHorizontal: 6,
		paddingVertical: 2,
		overflow: 'hidden',
	},
	currencyWarning: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 8,
		backgroundColor: 'rgba(255, 209, 102, 0.1)',
		borderColor: 'rgba(255, 209, 102, 0.5)',
		borderWidth: 1,
		borderRadius: 10,
		padding: 10,
		marginBottom: 12,
	},
	currencyWarningText: {
		flex: 1,
		fontSize: 14,
		lineHeight: 20,
		color: '#FFD166',
	},
	statementConfirmed: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		marginBottom: 12,
	},
	statementConfirmedText: {
		flex: 1,
		fontSize: 14,
		lineHeight: 20,
		color: ACCENT,
	},
	ambiguity: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 6,
		marginBottom: 12,
	},
	ambiguityText: {
		flex: 1,
		fontSize: 14,
		lineHeight: 20,
		color: '#FFFFFF',
	},
	question: {
		backgroundColor: 'rgba(21, 232, 254, 0.08)',
		borderColor: 'rgba(21, 232, 254, 0.5)',
		borderWidth: 1,
		borderRadius: 10,
		padding: 12,
		marginBottom: 12,
		gap: 8,
	},
	questionTitle: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	questionBody: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.85)',
	},
	questionActions: {
		gap: 8,
		marginTop: 4,
	},
	categoryChip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 12,
		borderRadius: 10,
		backgroundColor: 'rgba(255,255,255,0.06)',
		marginBottom: 12,
	},
	categoryDot: {
		width: 26,
		height: 26,
		borderRadius: 13,
		alignItems: 'center',
		justifyContent: 'center',
	},
	categoryName: {
		flex: 1,
		fontSize: 16,
		color: '#FFFFFF',
	},
	actions: {
		gap: 8,
	},
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 16,
		borderRadius: 10,
		backgroundColor: 'rgba(255,255,255,0.08)',
	},
	buttonPrimary: {
		backgroundColor: ACCENT,
	},
	buttonDanger: {
		backgroundColor: 'rgba(255,107,107,0.15)',
	},
	buttonPressed: {
		opacity: 0.7,
	},
	buttonLabel: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	buttonLabelPrimary: {
		color: '#000000',
	},
	rawToggle: {
		minHeight: 44,
		justifyContent: 'center',
		marginTop: 4,
	},
	rawToggleText: {
		fontSize: 14,
		color: ACCENT,
	},
	raw: {
		fontSize: 13,
		lineHeight: 19,
		color: 'rgba(255,255,255,0.75)',
		backgroundColor: 'rgba(0,0,0,0.3)',
		borderRadius: 8,
		padding: 10,
	},
	learned: {
		fontSize: 13,
		lineHeight: 19,
		color: 'rgba(255,255,255,0.6)',
		marginVertical: 8,
		paddingHorizontal: 4,
	},
	section: {
		marginTop: 20,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	sectionBody: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 4,
		marginBottom: 8,
	},
	historyToggle: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		minHeight: 48,
	},
	resolvedBlock: {
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.1)',
		paddingBottom: 6,
	},
	resolvedRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		paddingVertical: 10,
	},
	resolvedSource: {
		fontSize: 13,
		color: ACCENT,
		marginTop: 4,
	},
	resolvedInfo: {
		flex: 1,
	},
	resolvedTitle: {
		fontSize: 15,
		color: '#FFFFFF',
	},
	resolvedMeta: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	revertButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 48,
		paddingHorizontal: 10,
	},
	revertLabel: {
		fontSize: 14,
		color: ACCENT,
	},
	undoBar: {
		position: 'absolute',
		left: 16,
		right: 16,
		bottom: 24,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		backgroundColor: '#2A2A2A',
		borderRadius: 12,
		paddingVertical: 8,
		paddingLeft: 16,
		paddingRight: 8,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	undoText: {
		flex: 1,
		fontSize: 15,
		color: '#FFFFFF',
	},
	undoButton: {
		minHeight: 44,
		paddingHorizontal: 16,
		justifyContent: 'center',
	},
	undoButtonText: {
		fontSize: 16,
		fontWeight: '700',
		color: ACCENT,
	},
});

export default CaptureInboxScreen;
