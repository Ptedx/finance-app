import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	KeyboardAvoidingView,
	type LayoutChangeEvent,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
import { useAccounts } from '../contexts/AccountsContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { addTransaction } from '../database/database';
import type { Transaction, TransactionDraft } from '../database/schema';
import * as syncQueue from '../sync/queue';
import { type CycleRule, cardInstallmentDates, cycleRuleOf, invoiceMonthOf } from '../utils/cardMath';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { formatFullDate, formatMonthShort, formatMonthYear, getISODate, parseISODate } from '../utils/dateUtils';
import { MAX_INSTALLMENTS, splitInstallments } from '../utils/installments';
import {
	centsToDisplayInput,
	finaliseAmountInput,
	formatAmountInput,
	formatCents,
	isValidAmountInput,
	parseAmountToCents,
} from '../utils/money';
import AccountPicker from './AccountPicker';
import CategoryPicker from './CategoryPicker';
import DatePickerModal from './DatePickerModal';
import TransferForm from './TransferForm';
import { TourTarget, useTourScroll, useTourTarget } from './tour/TourContext';

/** O que o "+" lança: despesa, receita ou transferência entre contas suas (E2E-28). */
type EntryKind = 'expense' | 'income' | 'transfer';

/** A cor de cada tipo no seletor: a mesma dos botões Salvar de cada formulário. */
const KIND_COLORS: Record<EntryKind, string> = {
	expense: '#FF6B6B',
	income: '#4CAF50',
	transfer: '#15E8FE',
};

export interface InstallmentPlan {
	/** Valor de cada parcela, em centavos; somam o total. */
	parts: number[];
	/** Data de cada parcela, uma por fatura. */
	dates: string[];
	/** Fatura (`YYYY-MM`) da primeira e da última parcela, para a prévia. */
	firstMonth: string;
	lastMonth: string;
}

/**
 * Uma compra parcelada no cartão, como confirmar a captura parcelada a lança
 * (`postTransaction` em `captureActions`): o resto da divisão na primeira parcela
 * (`splitInstallments`) e uma parcela por fatura (`cardInstallmentDates`).
 */
export const installmentPlan = (totalCents: number, count: number, purchaseDate: string, rule: CycleRule | null): InstallmentPlan => {
	const parts = splitInstallments(totalCents, count);
	const dates = cardInstallmentDates(purchaseDate, count, rule);
	return {
		parts,
		dates,
		firstMonth: invoiceMonthOf(dates[0], rule),
		lastMonth: invoiceMonthOf(dates[dates.length - 1], rule),
	};
};

/**
 * As linhas que o formulário grava para uma compra em `count` parcelas: as mesmas colunas
 * de parcela da captura (`installmentGroup`/`Index`/`Count`) e a nota com "(1/N)". Uma
 * parcela só é o próprio lançamento, sem grupo.
 */
export const manualInstallmentDrafts = (
	purchase: TransactionDraft,
	count: number,
	rule: CycleRule | null,
	groupId: string
): TransactionDraft[] => {
	if (count <= 1) return [purchase];
	const { parts, dates } = installmentPlan(purchase.amountCents, count, purchase.date, rule);
	return dates.map((date, index) => {
		const marker = `(${index + 1}/${count})`;
		return {
			...purchase,
			amountCents: parts[index],
			date,
			note: purchase.note ? `${purchase.note} ${marker}` : marker,
			installmentGroup: groupId,
			installmentIndex: index + 1,
			installmentCount: count,
		};
	});
};

/** O número de parcelas digitado, ou nulo se não for um inteiro de 1 a 48. */
const parseInstallmentCount = (text: string): number | null => {
	const count = Number(text);
	return Number.isInteger(count) && count >= 1 && count <= MAX_INSTALLMENTS ? count : null;
};

type FormErrors = { amount?: string; category?: string; installments?: string };

/** Ordem em que os campos aparecem na tela: o primeiro com erro é para onde a tela rola. */
const FIELD_ORDER: (keyof FormErrors)[] = ['amount', 'category', 'installments'];

/** Folga acima do campo ao rolar até ele, para o rótulo não colar no topo. */
const SCROLL_MARGIN = 16;

interface TransactionFormProps {
	initialTransaction?: Transaction;
	onSubmit: () => void;
	onCancel: () => void;
	defaultIsIncome?: boolean;
}

const TransactionForm: React.FC<TransactionFormProps> = ({
	initialTransaction,
	onSubmit,
	onCancel,
	defaultIsIncome,
}) => {
	const { t } = useTranslation();
	const { categories, addNewTransaction, updateExistingTransaction, refreshData } = useTransactions();
	const { currentCurrency } = useCurrency();
	const { activeAccounts } = useAccounts();

	const [amount, setAmount] = useState(
		initialTransaction ? centsToDisplayInput(initialTransaction.amountCents) : ''
	);
	const [category, setCategory] = useState<string | null>(
		initialTransaction ? initialTransaction.category : null
	);
	// `parseISODate`, nunca `new Date('YYYY-MM-DD')`: o construtor lê a string como
	// meia-noite UTC, que em qualquer fuso a oeste de Greenwich ainda é o dia anterior.
	// Com o construtor, editar só a nota de um lançamento o movia um dia para trás.
	const [date, setDate] = useState(
		initialTransaction ? parseISODate(initialTransaction.date) : new Date()
	);
	const [note, setNote] = useState(initialTransaction ? initialTransaction.note : '');
	const [accountId, setAccountId] = useState<string | null>(initialTransaction?.accountId ?? null);
	const [cardLast4, setCardLast4] = useState<string | null>(initialTransaction?.cardLast4 ?? null);
	const [isIncome, setIsIncome] = useState(
		initialTransaction
			? initialTransaction.isIncome
			: defaultIsIncome !== undefined
				? defaultIsIncome
				: false
	);
	// Transferência só no lançamento novo: um lançamento gravado não vira transferência
	// (é outra tabela), e a transferência se edita pela linha dela em Lançamentos.
	const [isTransfer, setIsTransfer] = useState(false);
	// Texto, para o campo poder ficar vazio enquanto se digita; "1" é à vista.
	const [installments, setInstallments] = useState('1');
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errors, setErrors] = useState<FormErrors>({});
	const [saveFailed, setSaveFailed] = useState(false);
	const [showDateModal, setShowDateModal] = useState(false);

	const scrollRef = useRef<ScrollView>(null);
	// O guia do "+" (SPD-129): os alvos de cada passo e a rolagem até eles.
	const tourScroll = useTourScroll('add', scrollRef);
	const typeTarget = useTourTarget('add.type');
	const transferTarget = useTourTarget('add.transfer');
	const amountTarget = useTourTarget('add.amount');
	const installmentsTarget = useTourTarget('add.installments');
	// Onde cada campo começa dentro da rolagem, medido no layout.
	const fieldY = useRef<Partial<Record<keyof FormErrors, number>>>({});

	const isEditing = !!initialTransaction;

	// Parcelas só numa compra nova no cartão de crédito. Na edição, um lançamento é uma
	// linha: editar uma parcela muda só aquela parcela, e transformar um lançamento já
	// gravado em N parcelas mexeria em faturas que o usuário não está vendo.
	const selectedAccount = activeAccounts.find((account) => account.id === accountId) ?? null;
	const offersInstallments = !isEditing && !isIncome && selectedAccount?.kind === 'credit_card';
	const cycleRule = selectedAccount?.kind === 'credit_card' ? cycleRuleOf(selectedAccount) : null;
	const installmentCount = offersInstallments ? parseInstallmentCount(installments) : 1;

	// Reset form state when the component is unmounted
	useEffect(() => {
		return () => {
			setIsSubmitting(false);
		};
	}, []);

	const measure = (field: keyof FormErrors) => (event: LayoutChangeEvent) => {
		fieldY.current[field] = event.nativeEvent.layout.y;
	};

	const validateForm = (): FormErrors => {
		const newErrors: FormErrors = {};

		if (!isValidAmountInput(amount)) {
			newErrors.amount = t('transactionForm.amountRequired');
		}

		if (!category) {
			newErrors.category = t('transactionForm.categoryRequired');
		}

		if (offersInstallments) {
			const cents = parseAmountToCents(amount);
			if (installmentCount === null) {
				newErrors.installments = t('transactionForm.installmentsInvalid', { max: MAX_INSTALLMENTS });
			} else if (cents !== null && cents < installmentCount) {
				// Cada parcela precisa de pelo menos um centavo.
				newErrors.installments = t('transactionForm.installmentsTooSmall');
			}
		}

		return newErrors;
	};

	/**
	 * Salvar fica no fim da tela; o erro, junto do campo, pode estar lá em cima (E2E-13).
	 * A mensagem aparece também junto do botão, a tela rola até o primeiro campo com erro e
	 * o leitor de tela anuncia, como nas folhas de cartão e de conta.
	 */
	const showErrors = (found: FormErrors) => {
		setErrors(found);
		const messages = FIELD_ORDER.map((field) => found[field]).filter(Boolean);
		AccessibilityInfo.announceForAccessibility(messages.join('. '));
		const first = FIELD_ORDER.find((field) => found[field]);
		const y = first ? fieldY.current[first] : undefined;
		if (y !== undefined) {
			scrollRef.current?.scrollTo({ x: 0, y: Math.max(0, y - SCROLL_MARGIN), animated: true });
		}
	};

	const handleSubmit = async () => {
		const found = validateForm();
		if (Object.keys(found).length > 0) {
			showErrors(found);
			return;
		}
		setErrors({});
		setSaveFailed(false);

		try {
			setIsSubmitting(true);

			const transactionData = {
				// biome-ignore lint/style/noNonNullAssertion: validateForm guarantees a positive amount
				amountCents: parseAmountToCents(amount)!,
				// biome-ignore lint/style/noNonNullAssertion: category is guaranteed non-null here because submit is only called after validation
				category: category!,
				date: getISODate(date),
				note: note.trim(),
				isIncome,
				accountId,
				// Só um final completo vale; meio digitado não vira cartão.
				cardLast4: accountId && cardLast4?.length === 4 ? cardLast4 : null,
			};

			if (isEditing && initialTransaction) {
				await updateExistingTransaction({
					...transactionData,
					id: initialTransaction.id,
				});
			} else if (installmentCount !== null && installmentCount > 1) {
				// Parcelado: as linhas vão direto ao livro, como na captura parcelada, e a tela
				// recarrega uma vez no fim. Parcela não dá baixa em conta a pagar.
				const drafts = manualInstallmentDrafts(transactionData, installmentCount, cycleRule, generateUniqueId());
				for (const draft of drafts) {
					await addTransaction(draft);
				}
				syncQueue.schedule();
				await refreshData();
			} else {
				await addNewTransaction(transactionData);
			}

			onSubmit();

			// Reset form state
			if (!isEditing) {
				setAmount('');
				setCategory(null);
				setDate(new Date());
				setNote('');
				setInstallments('1');
			}
			setIsSubmitting(false);
		} catch (error) {
			console.error('Failed to save transaction:', error);
			setSaveFailed(true);
			AccessibilityInfo.announceForAccessibility(t('transactionForm.saveFailed'));
			setIsSubmitting(false);
		}
	};

	/**
	 * Stable across renders, and updates errors functionally rather than from a captured
	 * value. CategoryPicker is memoized and cannot compare this callback, so a closure
	 * over `errors` would go stale there: selecting a category after a failed submit
	 * would set the category but never clear the "select a category" message.
	 */
	const handleSelectCategory = useCallback((categoryId: string) => {
		setCategory(categoryId);
		setErrors((previous) => (previous.category ? { ...previous, category: undefined } : previous));
	}, []);

	const handleConfirmDate = (picked: Date) => {
		setDate(picked);
		setShowDateModal(false);
	};

	const chooseType = (kind: EntryKind) => {
		if (kind === 'transfer') {
			setIsTransfer(true);
			return;
		}
		setIsTransfer(false);
		const newIsIncome = kind === 'income';

		// Drop the selection if it belongs to the other side of the ledger. The category's
		// own `type` decides this now — it used to be a hardcoded list of ids, so every
		// category the user created counted as an expense and was cleared on every toggle.
		const selected = categories.find((c) => c.id === category);
		if (selected && (selected.type === 'income') !== newIsIncome) {
			setCategory(null);
		}

		setIsIncome(newIsIncome);
	};

	const changeInstallments = (text: string) => {
		setInstallments(text.replace(/\D/g, '').slice(0, 2));
		setErrors((previous) => (previous.installments ? { ...previous, installments: undefined } : previous));
	};

	const stepInstallments = (delta: number) => {
		const current = parseInstallmentCount(installments) ?? 1;
		changeInstallments(String(Math.min(MAX_INSTALLMENTS, Math.max(1, current + delta))));
	};

	/** "3 parcelas de R$ 100,00, de nov a jan": as faturas em que a compra vai cair. */
	const installmentsPreview = (): string | null => {
		const cents = parseAmountToCents(amount);
		if (!offersInstallments || installmentCount === null || installmentCount < 2 || cents === null || cents < installmentCount) {
			return null;
		}
		const plan = installmentPlan(cents, installmentCount, getISODate(date), cycleRule);
		// Mais de um ano de parcelas: o mês sozinho repetiria ("de nov a nov").
		const monthLabel = installmentCount > 12 ? formatMonthYear : formatMonthShort;
		const options = {
			count: installmentCount,
			amount: formatCents(plan.parts[plan.parts.length - 1]),
			first: monthLabel(`${plan.firstMonth}-01`),
			last: monthLabel(`${plan.lastMonth}-01`),
		};
		return plan.parts[0] === plan.parts[plan.parts.length - 1]
			? t('transactionForm.installmentsPreview', options)
			: t('transactionForm.installmentsPreviewUneven', { ...options, firstAmount: formatCents(plan.parts[0]) });
	};

	const preview = installmentsPreview();
	const errorSummary = [...FIELD_ORDER.map((field) => errors[field]), saveFailed ? t('transactionForm.saveFailed') : undefined]
		.filter(Boolean)
		.join('. ');
	const editingInstallment =
		initialTransaction?.installmentCount && initialTransaction.installmentCount > 1 && initialTransaction.installmentIndex
			? t('transactionForm.editingInstallment', {
					index: initialTransaction.installmentIndex,
					count: initialTransaction.installmentCount,
				})
			: null;

	const currentKind: EntryKind = isTransfer && !isEditing ? 'transfer' : isIncome ? 'income' : 'expense';
	const typeOption = (kind: EntryKind, label: string) => {
		const selected = currentKind === kind;
		const color = KIND_COLORS[kind];
		return (
			<Pressable
				key={kind}
				{...(kind === 'transfer' ? transferTarget : {})}
				testID={`transaction-form-type-${kind}`}
				onPress={() => chooseType(kind)}
				accessibilityRole="radio"
				accessibilityState={{ selected }}
				accessibilityLabel={label}
				style={({ pressed }) => [
					styles.typeOption,
					selected && { borderColor: color, backgroundColor: `${color}33` },
					pressed && styles.pressed,
				]}
			>
				{/* O selecionado não depende só da cor: ganha o check. */}
				{selected ? <Ionicons name="checkmark-circle" size={16} color={color} /> : null}
				<Text style={[styles.toggleLabel, selected && { color }]} numberOfLines={1}>
					{label}
				</Text>
			</Pressable>
		);
	};
	const typeSelector = (
		<View style={styles.typeToggleContainer}>
			<Text style={styles.label}>{t('transactionForm.type')}</Text>
			<View {...typeTarget} style={styles.toggleRow} accessibilityRole="radiogroup" accessibilityLabel={t('transactionForm.type')}>
				{typeOption('expense', t('transactionForm.expense'))}
				{typeOption('income', t('transactionForm.income'))}
				{isEditing ? null : typeOption('transfer', t('transactionForm.transfer.type'))}
			</View>
		</View>
	);

	if (currentKind === 'transfer') {
		return <TransferForm header={typeSelector} onSubmit={onSubmit} onCancel={onCancel} />;
	}

	return (
		<KeyboardAvoidingView
			behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
			style={styles.container}
		>
			<ScrollView ref={tourScroll} testID="transaction-form-scroll" keyboardShouldPersistTaps="handled">
				{editingInstallment ? (
					<Text style={styles.installmentNotice} testID="transaction-form-editing-installment">
						{editingInstallment}
					</Text>
				) : null}

				{typeSelector}

				<View {...amountTarget} style={styles.formGroup} onLayout={measure('amount')} testID="transaction-form-amount-group">
					<Text style={styles.label}>{t('transactionForm.amount')}</Text>
					<View style={styles.amountInputContainer}>
						<Text style={styles.currencySymbol}>{currentCurrency.symbol}</Text>
						<TextInput
							testID="transaction-form-amount"
							style={styles.amountInput}
							value={amount}
							onChangeText={(text) => {
								// Agrupa os milhares enquanto digita. É só aparência: o valor
								// gravado continua saindo de `parseAmountToCents` no submit.
								setAmount(formatAmountInput(text));
								if (errors.amount) {
									setErrors({ ...errors, amount: undefined });
								}
							}}
							// Ao sair do campo, completa os centavos: 15.006 vira 15.006,00.
							onBlur={() => setAmount(finaliseAmountInput(amount))}
							placeholder={centsToDisplayInput(0)}
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
							keyboardType="decimal-pad"
							accessibilityLabel={t('transactionForm.amount')}
							autoFocus
						/>
					</View>
					{errors.amount ? <Text style={styles.errorText}>{errors.amount}</Text> : null}
				</View>

				<View onLayout={measure('category')} testID="transaction-form-category-group">
					<CategoryPicker
						categories={categories}
						selectedCategoryId={category}
						onSelectCategory={handleSelectCategory}
						isIncome={isIncome}
					/>
					{errors.category ? <Text style={styles.errorText}>{errors.category}</Text> : null}
				</View>

				<TourTarget id="add.account">
					<AccountPicker selectedAccountId={accountId} onSelect={setAccountId} selectedLast4={cardLast4} onSelectLast4={setCardLast4} />
				</TourTarget>

				{offersInstallments ? (
					<View {...installmentsTarget} style={styles.formGroup} onLayout={measure('installments')}>
						<Text style={styles.label}>{t('transactionForm.installments')}</Text>
						<Text style={styles.hint}>{t('transactionForm.installmentsHint', { max: MAX_INSTALLMENTS })}</Text>
						<View style={styles.stepperRow}>
							<TouchableOpacity
								style={styles.stepperButton}
								onPress={() => stepInstallments(-1)}
								accessibilityRole="button"
								accessibilityLabel={t('transactionForm.installmentsFewer')}
							>
								<Ionicons name="remove" size={22} color="white" />
							</TouchableOpacity>
							<TextInput
								testID="transaction-form-installments"
								style={styles.stepperInput}
								value={installments}
								onChangeText={changeInstallments}
								onBlur={() => {
									if (installments === '') setInstallments('1');
								}}
								keyboardType="number-pad"
								maxLength={2}
								accessibilityLabel={t('transactionForm.installments')}
							/>
							<TouchableOpacity
								style={styles.stepperButton}
								onPress={() => stepInstallments(1)}
								accessibilityRole="button"
								accessibilityLabel={t('transactionForm.installmentsMore')}
							>
								<Ionicons name="add" size={22} color="white" />
							</TouchableOpacity>
						</View>
						{preview ? (
							<Text style={styles.preview} accessibilityLiveRegion="polite" testID="transaction-form-installments-preview">
								{preview}
							</Text>
						) : null}
						{errors.installments ? <Text style={styles.errorText}>{errors.installments}</Text> : null}
					</View>
				) : null}

				<View style={styles.formGroup}>
					<Text style={styles.label}>{t('transactionForm.date')}</Text>
					<TouchableOpacity style={styles.dateButton} onPress={() => setShowDateModal(true)} accessibilityRole="button">
						{/* `getISODate` e não `toISOString`: depois das 21h em UTC-3 o segundo já
						    mostra o dia seguinte, enquanto o que se grava é o dia local. */}
						<Text style={styles.dateButtonText}>{formatFullDate(getISODate(date))}</Text>
						<Ionicons name="calendar-outline" size={20} color="white" />
					</TouchableOpacity>
				</View>

				<View style={styles.formGroup}>
					<Text style={styles.label}>{t('transactionForm.note')}</Text>
					<TextInput
						testID="transaction-form-note"
						style={styles.noteInput}
						value={note}
						onChangeText={setNote}
						placeholder={t('transactionForm.notePlaceholder')}
						placeholderTextColor="rgba(255, 255, 255, 0.3)"
						accessibilityLabel={t('transactionForm.note')}
						multiline
					/>
				</View>

				{/* O erro também aqui, junto do botão: é onde o dedo está ao tocar Salvar. */}
				{errorSummary ? (
					<Text style={styles.errorSummary} accessibilityLiveRegion="polite" testID="transaction-form-error-summary">
						{errorSummary}
					</Text>
				) : null}

				<View style={styles.buttonsRow}>
					<TouchableOpacity
						style={[styles.button, styles.cancelButton]}
						onPress={onCancel}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Text style={styles.cancelButtonText}>{t('transactionForm.cancel')}</Text>
					</TouchableOpacity>

					<TouchableOpacity
						testID="transaction-form-save"
						style={[
							styles.button,
							isIncome ? styles.saveIncomeButton : styles.saveExpenseButton,
							isSubmitting && styles.disabledButton,
						]}
						onPress={handleSubmit}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Text style={styles.submitButtonText}>{isEditing ? t('transactionForm.update') : t('transactionForm.save')}</Text>
						{isSubmitting ? (
							<Ionicons name="sync" size={18} color="black" style={styles.spinnerIcon} />
						) : null}
					</TouchableOpacity>
				</View>
			</ScrollView>

			<DatePickerModal
				visible={showDateModal}
				value={date}
				onConfirm={handleConfirmDate}
				onCancel={() => setShowDateModal(false)}
			/>
		</KeyboardAvoidingView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		padding: 16,
	},
	formGroup: {
		marginBottom: 20,
	},
	label: {
		fontSize: 16,
		fontWeight: '600',
		color: '#ffffff',
		marginBottom: 8,
	},
	hint: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.6)',
		marginBottom: 8,
	},
	amountInputContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
	},
	currencySymbol: {
		fontSize: 24,
		fontWeight: '600',
		color: '#ffffff',
		marginRight: 8,
	},
	amountInput: {
		flex: 1,
		fontSize: 24,
		fontWeight: '600',
		color: '#ffffff',
	},
	noteInput: {
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		color: '#ffffff',
		height: 100,
		textAlignVertical: 'top',
	},
	stepperRow: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	stepperButton: {
		width: 48,
		height: 48,
		borderRadius: 8,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
	},
	stepperInput: {
		width: 72,
		height: 48,
		marginHorizontal: 8,
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		color: '#ffffff',
		fontSize: 18,
		fontWeight: '600',
		textAlign: 'center',
	},
	preview: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.85)',
		marginTop: 8,
	},
	installmentNotice: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.85)',
		backgroundColor: 'rgba(255, 255, 255, 0.08)',
		borderRadius: 8,
		padding: 12,
		marginBottom: 16,
	},
	dateButton: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
	},
	dateButtonText: {
		fontSize: 16,
		color: '#ffffff',
	},
	errorSummary: {
		color: '#FF6B6B',
		fontSize: 15,
		fontWeight: '600',
		marginTop: 12,
	},
	buttonsRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: 20,
		marginBottom: 32,
	},
	button: {
		flex: 1,
		padding: 16,
		borderRadius: 8,
		alignItems: 'center',
		justifyContent: 'center',
		flexDirection: 'row',
	},
	cancelButton: {
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 8,
	},
	saveExpenseButton: {
		backgroundColor: '#FF6B6B',
		marginLeft: 8,
	},
	saveIncomeButton: {
		backgroundColor: '#4CAF50',
		marginLeft: 8,
	},
	cancelButtonText: {
		color: '#ffffff',
		fontSize: 16,
		fontWeight: '600',
	},
	submitButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
	},
	disabledButton: {
		opacity: 0.6,
	},
	spinnerIcon: {
		marginLeft: 8,
	},
	errorText: {
		color: '#FF6B6B',
		fontSize: 14,
		marginTop: 4,
	},
	// Transaction type toggle styles
	typeToggleContainer: {
		marginBottom: 20,
	},
	toggleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		marginTop: 8,
		backgroundColor: '#1E1E1E',
		borderRadius: 8,
		padding: 6,
		gap: 6,
	},
	typeOption: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 4,
		minHeight: 48,
		paddingHorizontal: 6,
		borderRadius: 6,
		borderWidth: 1,
		borderColor: 'transparent',
	},
	pressed: {
		opacity: 0.7,
	},
	toggleLabel: {
		fontSize: 15,
		color: '#ffffff',
		fontWeight: '500',
		flexShrink: 1,
	},
});

export default TransactionForm;
