import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
import { useAccounts } from '../contexts/AccountsContext';
import { useCurrency } from '../contexts/CurrencyContext';
import type { Account, Transfer } from '../database/schema';
import { formatFullDate, getISODate, parseISODate } from '../utils/dateUtils';
import {
	centsToDisplayInput,
	finaliseAmountInput,
	formatAmountInput,
	formatCents,
	isValidAmountInput,
	parseAmountToCents,
} from '../utils/money';
import { accountSelectOptions } from './AccountPicker';
import DatePickerModal from './DatePickerModal';
import { SelectField, type SelectOption } from './SelectField';
import { TourTarget } from './tour/TourContext';

/** Cor da transferência: nem o vermelho da despesa, nem o verde da receita. */
const ACCENT = '#15E8FE';

type Side = Pick<Transfer, 'fromAccountId' | 'toAccountId'>;

/** A ponta "fora do app" na lista: o `null` da transferência que já era assim. */
const OUTSIDE = 'outside';

/**
 * As contas que cada ponta oferece. Arquivadas e apagadas ficam fora; cartão de crédito
 * só é destino (pagar a fatura), nunca origem. Na edição, as contas que a transferência já
 * usa continuam na lista mesmo arquivadas — senão a ponta apareceria vazia.
 */
export const transferChoices = (active: Account[], all: Account[], initial?: Side | null): { from: Account[]; to: Account[] } => {
	const used = (id: string) => initial?.fromAccountId === id || initial?.toAccountId === id;
	const pool = [...active, ...all.filter((account) => account.archived && used(account.id) && !active.some((a) => a.id === account.id))];
	return {
		from: pool.filter((account) => account.kind !== 'credit_card' || initial?.fromAccountId === account.id),
		to: pool,
	};
};

export type TransferErrorCode = 'amountRequired' | 'fromRequired' | 'toRequired' | 'sameAccount';
export type TransferErrors = { amount?: TransferErrorCode; from?: TransferErrorCode; to?: TransferErrorCode };

/**
 * O que impede salvar: valor maior que zero, as duas pontas escolhidas e diferentes. Uma
 * ponta "fora do app" (nula) só vale na edição de uma transferência que já era assim.
 */
export const validateTransfer = (input: {
	amountText: string;
	fromAccountId: string | null;
	toAccountId: string | null;
	outsideFrom?: boolean;
	outsideTo?: boolean;
}): TransferErrors => {
	const errors: TransferErrors = {};
	if (!isValidAmountInput(input.amountText)) errors.amount = 'amountRequired';
	if (input.fromAccountId === null && !input.outsideFrom) errors.from = 'fromRequired';
	if (input.toAccountId === null && !input.outsideTo) errors.to = 'toRequired';
	else if (input.toAccountId !== null && input.toAccountId === input.fromAccountId) errors.to = 'sameAccount';
	return errors;
};

/** Ordem dos campos na tela, para a mensagem junto do botão. */
const FIELD_ORDER: (keyof TransferErrors)[] = ['from', 'to', 'amount'];

interface TransferFormProps {
	/** A transferência sendo editada; sem ela, é uma nova. */
	initialTransfer?: Transfer;
	onSubmit: () => void;
	onCancel: () => void;
	/** O que vem antes dos campos (no "+", a escolha entre Despesa, Receita e Transferência). */
	header?: React.ReactNode;
}

/**
 * Transferência entre contas suas (E2E-28): De, Para, Valor, Data e Descrição. Não é
 * receita nem despesa — o mês não muda, os saldos das duas contas sim; para uma conta de
 * reserva, entra no "Guardado". Para um cartão de crédito é o pagamento da fatura, pelo
 * mesmo caminho do "Pagar fatura" (`saveTransfer` decide).
 */
const TransferForm: React.FC<TransferFormProps> = ({ initialTransfer, onSubmit, onCancel, header }) => {
	const { t } = useTranslation();
	const { currentCurrency } = useCurrency();
	const { accounts, activeAccounts, saveTransfer, removeTransfer } = useAccounts();
	const isEditing = !!initialTransfer;
	// Uma ponta nula na transferência original (a captura não sabia a outra conta).
	const outsideFrom = isEditing && initialTransfer.fromAccountId === null;
	const outsideTo = isEditing && initialTransfer.toAccountId === null;

	const [fromAccountId, setFromAccountId] = useState<string | null>(initialTransfer?.fromAccountId ?? null);
	const [toAccountId, setToAccountId] = useState<string | null>(initialTransfer?.toAccountId ?? null);
	const [amount, setAmount] = useState(initialTransfer ? centsToDisplayInput(initialTransfer.amountCents) : '');
	// `parseISODate`, nunca `new Date('YYYY-MM-DD')`: o construtor lê meia-noite UTC.
	const [date, setDate] = useState(initialTransfer ? parseISODate(initialTransfer.date) : new Date());
	const [note, setNote] = useState(initialTransfer?.note ?? '');
	const [errors, setErrors] = useState<TransferErrors>({});
	const [saveFailed, setSaveFailed] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [showDateModal, setShowDateModal] = useState(false);

	const choices = transferChoices(activeAccounts, accounts ?? [], initialTransfer);
	// A conta escolhida em De não aparece em Para, na criação e na edição (E2E-42).
	const toOptions = choices.to.filter((account) => fromAccountId === null || account.id !== fromAccountId);
	const destination = choices.to.find((account) => account.id === toAccountId) ?? null;
	// Pagamento de fatura novo: vai por `recordCardPayment`, que não guarda descrição.
	const isCardPayment = !isEditing && destination?.kind === 'credit_card';

	const messageOf = (code: TransferErrorCode) =>
		code === 'amountRequired' ? t('transactionForm.amountRequired') : t(`transactionForm.transfer.${code}`);

	const clearError = (field: keyof TransferErrors) =>
		setErrors((previous) => (previous[field] ? { ...previous, [field]: undefined } : previous));

	const pick = (side: 'from' | 'to', id: string | null) => {
		if (side === 'from') {
			setFromAccountId(id);
			// A origem sai da lista de Para: se era o destino escolhido, o destino fica por escolher.
			if (id !== null && id === toAccountId) setToAccountId(null);
		} else setToAccountId(id);
		setNotice(null);
		// Trocar qualquer ponta pode desfazer o "De e Para iguais".
		setErrors((previous) => (previous.from || previous.to ? { ...previous, from: undefined, to: undefined } : previous));
	};

	const handleSubmit = async () => {
		const found = validateTransfer({ amountText: amount, fromAccountId, toAccountId, outsideFrom, outsideTo });
		if (Object.keys(found).length > 0) {
			setErrors(found);
			AccessibilityInfo.announceForAccessibility(
				FIELD_ORDER.map((field) => found[field])
					.filter((code): code is TransferErrorCode => Boolean(code))
					.map(messageOf)
					.join('. ')
			);
			return;
		}
		setErrors({});
		setSaveFailed(false);
		setNotice(null);
		// biome-ignore lint/style/noNonNullAssertion: validateTransfer garante um valor positivo
		const amountCents = parseAmountToCents(amount)!;
		try {
			setIsSubmitting(true);
			const created = await saveTransfer({
				id: initialTransfer?.id,
				fromAccountId,
				toAccountId,
				amountCents,
				date: getISODate(date),
				note: isCardPayment ? '' : note,
			});
			setIsSubmitting(false);
			if (!created) {
				// O aviso do banco já tinha registrado este pagamento: nada foi lançado de novo.
				const message = t('transactionForm.transfer.cardPaymentAlready', { amount: formatCents(amountCents) });
				setNotice(message);
				AccessibilityInfo.announceForAccessibility(message);
				return;
			}
			onSubmit();
			if (!isEditing) {
				// O "+" é uma aba: a tela continua montada para o próximo lançamento.
				setFromAccountId(null);
				setToAccountId(null);
				setAmount('');
				setDate(new Date());
				setNote('');
			}
		} catch (error) {
			console.error('Failed to save transfer:', error);
			setIsSubmitting(false);
			setSaveFailed(true);
			AccessibilityInfo.announceForAccessibility(t('transactionForm.saveFailed'));
		}
	};

	const handleDelete = () => {
		if (!initialTransfer) return;
		Alert.alert(t('transactionForm.transfer.deleteTitle'), t('transactionForm.transfer.deleteBody'), [
			{ text: t('transactionForm.transfer.deleteCancel'), style: 'cancel' },
			{
				text: t('transactionForm.transfer.deleteConfirm'),
				style: 'destructive',
				onPress: async () => {
					try {
						await removeTransfer(initialTransfer.id);
						onSubmit();
					} catch (error) {
						console.error('Failed to delete transfer:', error);
						setSaveFailed(true);
						AccessibilityInfo.announceForAccessibility(t('transactionForm.saveFailed'));
					}
				},
			},
		]);
	};

	/**
	 * De ou Para: um campo que abre a lista das contas (SPD-130; antes, uma linha de fichas).
	 * "Fora do app" só aparece na edição de uma transferência que já tinha essa ponta.
	 */
	const sideGroup = (side: 'from' | 'to', options: Account[], outside: boolean) => {
		const label = t(side === 'from' ? 'transactionForm.transfer.from' : 'transactionForm.transfer.to');
		const error = errors[side];
		const selectedId = side === 'from' ? fromAccountId : toAccountId;
		const choices: SelectOption<string>[] = [
			...(outside ? [{ value: OUTSIDE, label: t('transactionForm.transfer.outside'), icon: 'globe-outline' as const }] : []),
			...accountSelectOptions(options),
		];
		return (
			<TourTarget id={`add.${side}`} style={styles.formGroup}>
				<SelectField
					testID={`transfer-form-${side}`}
					optionTestID={`transfer-${side}-`}
					label={label}
					options={choices}
					selected={selectedId ?? (outside ? OUTSIDE : null)}
					onSelect={(value) => pick(side, value === OUTSIDE ? null : value)}
					error={error ? messageOf(error) : undefined}
				/>
			</TourTarget>
		);
	};

	const errorSummary = [
		...FIELD_ORDER.map((field) => errors[field]).filter((code): code is TransferErrorCode => Boolean(code)).map(messageOf),
		saveFailed ? t('transactionForm.saveFailed') : undefined,
	]
		.filter(Boolean)
		.join('. ');
	// Sem duas contas não há entre o que transferir.
	const tooFewAccounts = !isEditing && choices.to.length < 2;

	return (
		<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container} testID="transfer-form">
			<ScrollView keyboardShouldPersistTaps="handled">
				{header}

				<Text style={styles.hint}>{t('transactionForm.transfer.hint')}</Text>
				{tooFewAccounts ? <Text style={styles.notice}>{t('transactionForm.transfer.noAccounts')}</Text> : null}

				{sideGroup('from', choices.from, outsideFrom)}
				{sideGroup('to', toOptions, outsideTo)}

				{isCardPayment ? (
					<Text style={styles.notice} testID="transfer-form-card-payment">
						{t('transactionForm.transfer.cardPaymentHint')}
					</Text>
				) : null}

				<View style={styles.formGroup}>
					<Text style={styles.label}>{t('transactionForm.amount')}</Text>
					<View style={styles.amountInputContainer}>
						<Text style={styles.currencySymbol}>{currentCurrency.symbol}</Text>
						<TextInput
							testID="transfer-form-amount"
							style={styles.amountInput}
							value={amount}
							onChangeText={(text) => {
								setAmount(formatAmountInput(text));
								setNotice(null);
								clearError('amount');
							}}
							onBlur={() => setAmount(finaliseAmountInput(amount))}
							placeholder={centsToDisplayInput(0)}
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
							keyboardType="decimal-pad"
							accessibilityLabel={t('transactionForm.amount')}
						/>
					</View>
					{errors.amount ? <Text style={styles.errorText}>{messageOf(errors.amount)}</Text> : null}
				</View>

				<View style={styles.formGroup}>
					<Text style={styles.label}>{t('transactionForm.date')}</Text>
					<TouchableOpacity style={styles.dateButton} onPress={() => setShowDateModal(true)} accessibilityRole="button">
						<Text style={styles.dateButtonText}>{formatFullDate(getISODate(date))}</Text>
						<Ionicons name="calendar-outline" size={20} color="white" />
					</TouchableOpacity>
				</View>

				{isCardPayment ? null : (
					<View style={styles.formGroup}>
						<Text style={styles.label}>{t('transactionForm.note')}</Text>
						<TextInput
							testID="transfer-form-note"
							style={styles.noteInput}
							value={note}
							onChangeText={setNote}
							placeholder={t('transactionForm.notePlaceholder')}
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
							accessibilityLabel={t('transactionForm.note')}
							multiline
						/>
					</View>
				)}

				{notice ? (
					<Text style={styles.notice} accessibilityLiveRegion="polite" testID="transfer-form-notice">
						{notice}
					</Text>
				) : null}
				{/* O erro também junto do botão: é onde o dedo está ao tocar Salvar. */}
				{errorSummary ? (
					<Text style={styles.errorSummary} accessibilityLiveRegion="polite" testID="transfer-form-error-summary">
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
						testID="transfer-form-save"
						style={[styles.button, styles.saveButton, isSubmitting && styles.disabledButton]}
						onPress={handleSubmit}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Text style={styles.submitButtonText}>{isEditing ? t('transactionForm.update') : t('transactionForm.save')}</Text>
					</TouchableOpacity>
				</View>

				{isEditing ? (
					<TouchableOpacity
						testID="transfer-form-delete"
						style={styles.deleteButton}
						onPress={handleDelete}
						disabled={isSubmitting}
						accessibilityRole="button"
					>
						<Ionicons name="trash-outline" size={18} color="#FF6B6B" />
						<Text style={styles.deleteButtonText}>{t('transactionForm.transfer.delete')}</Text>
					</TouchableOpacity>
				) : null}
			</ScrollView>

			<DatePickerModal
				visible={showDateModal}
				value={date}
				onConfirm={(picked) => {
					setDate(picked);
					setShowDateModal(false);
				}}
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
		marginBottom: 16,
	},
	notice: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.85)',
		backgroundColor: 'rgba(255, 255, 255, 0.08)',
		borderRadius: 8,
		padding: 12,
		marginBottom: 16,
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
	errorText: {
		color: '#FF6B6B',
		fontSize: 14,
		marginTop: 4,
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
		marginBottom: 16,
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
	saveButton: {
		backgroundColor: ACCENT,
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
	deleteButton: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		marginBottom: 32,
	},
	deleteButtonText: {
		color: '#FF6B6B',
		fontSize: 16,
		fontWeight: '600',
	},
});

export default TransferForm;
