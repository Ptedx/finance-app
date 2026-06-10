import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Transaction } from '../database/schema';
import { parseAmount, validateAmount } from '../utils/currencyUtils';
import { formatFullDate, getISODate } from '../utils/dateUtils';
import CategoryPicker from './CategoryPicker';

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
	const { categories, addNewTransaction, updateExistingTransaction } = useTransactions();
	const { currentCurrency } = useCurrency();

	const [amount, setAmount] = useState(
		initialTransaction ? initialTransaction.amount.toString() : ''
	);
	const [category, setCategory] = useState<string | null>(
		initialTransaction ? initialTransaction.category : null
	);
	const [date, setDate] = useState(
		initialTransaction ? new Date(initialTransaction.date) : new Date()
	);
	const [note, setNote] = useState(initialTransaction ? initialTransaction.note : '');
	const [isIncome, setIsIncome] = useState(
		initialTransaction
			? initialTransaction.isIncome
			: defaultIsIncome !== undefined
				? defaultIsIncome
				: false
	);
	const [_isDatePickerVisible, _setDatePickerVisible] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errors, setErrors] = useState<{ amount?: string; category?: string }>({});

	// Custom date picker state
	const [tempDate, setTempDate] = useState(date);
	const [showDateModal, setShowDateModal] = useState(false);

	const isEditing = !!initialTransaction;

	// Reset form state when the component is unmounted
	useEffect(() => {
		return () => {
			setIsSubmitting(false);
		};
	}, []);

	const validateForm = (): boolean => {
		const newErrors: { amount?: string; category?: string } = {};

		if (!validateAmount(amount)) {
			newErrors.amount = 'Please enter a valid amount greater than 0';
		}

		if (!category) {
			newErrors.category = 'Please select a category';
		}

		setErrors(newErrors);
		return Object.keys(newErrors).length === 0;
	};

	const handleSubmit = async () => {
		if (!validateForm()) {
			return;
		}

		try {
			setIsSubmitting(true);

			const transactionData = {
				amount: parseAmount(amount),
				// biome-ignore lint/style/noNonNullAssertion: category is guaranteed non-null here because submit is only called after validation
				category: category!,
				date: getISODate(date),
				note: note.trim(),
				isIncome,
			};

			if (isEditing && initialTransaction) {
				await updateExistingTransaction({
					...transactionData,
					id: initialTransaction.id,
				});
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
			}
			setIsSubmitting(false);
		} catch (error) {
			console.error('Failed to save transaction:', error);
			setIsSubmitting(false);
		}
	};

	const handleSelectCategory = (categoryId: string) => {
		setCategory(categoryId);
		if (errors.category) {
			setErrors({ ...errors, category: undefined });
		}
	};

	const handleShowDatePicker = () => {
		setTempDate(date);
		setShowDateModal(true);
	};

	const handleConfirmDate = () => {
		setDate(tempDate);
		setShowDateModal(false);
	};

	const toggleTransactionType = () => {
		// Reset category when switching transaction types
		if (category) {
			const currentCat = categories.find((c) => c.id === category);
			if (currentCat) {
				const incomeCategories = [
					'salary',
					'freelance',
					'investment',
					'gift',
					'refund',
					'other_income',
				];
				const isCategoryIncome = incomeCategories.includes(currentCat.id);

				// The new isIncome value will be the opposite of current isIncome
				const newIsIncome = !isIncome;

				// If category type doesn't match the NEW transaction type, reset it
				if (isCategoryIncome !== newIsIncome) {
					setCategory(null);
				}
			}
		}

		setIsIncome(!isIncome);
	};

	// Simple date picker UI
	const renderDatePicker = () => {
		const months = [
			'January',
			'February',
			'March',
			'April',
			'May',
			'June',
			'July',
			'August',
			'September',
			'October',
			'November',
			'December',
		];

		const currentYear = new Date().getFullYear();
		const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

		const days = Array.from({ length: 31 }, (_, i) => i + 1);

		const yearOptions = years.map((year) => (
			<TouchableOpacity
				key={`year-${year}`}
				style={[
					styles.pickerOption,
					tempDate.getFullYear() === year && styles.selectedPickerOption,
				]}
				onPress={() => {
					const newDate = new Date(tempDate);
					newDate.setFullYear(year);
					setTempDate(newDate);
				}}
			>
				<Text
					style={[
						styles.pickerOptionText,
						tempDate.getFullYear() === year && styles.selectedPickerOptionText,
					]}
				>
					{year}
				</Text>
			</TouchableOpacity>
		));

		const monthOptions = months.map((month, index) => (
			<TouchableOpacity
				// biome-ignore lint/suspicious/noArrayIndexKey: Required for list rendering with dynamic data
				key={`month-${index}`}
				style={[styles.pickerOption, tempDate.getMonth() === index && styles.selectedPickerOption]}
				onPress={() => {
					const newDate = new Date(tempDate);
					newDate.setMonth(index);
					setTempDate(newDate);
				}}
			>
				<Text
					style={[
						styles.pickerOptionText,
						tempDate.getMonth() === index && styles.selectedPickerOptionText,
					]}
				>
					{month}
				</Text>
			</TouchableOpacity>
		));

		const dayOptions = days.map((day) => (
			<TouchableOpacity
				key={`day-${day}`}
				style={[styles.pickerOption, tempDate.getDate() === day && styles.selectedPickerOption]}
				onPress={() => {
					const newDate = new Date(tempDate);
					newDate.setDate(day);
					setTempDate(newDate);
				}}
			>
				<Text
					style={[
						styles.pickerOptionText,
						tempDate.getDate() === day && styles.selectedPickerOptionText,
					]}
				>
					{day}
				</Text>
			</TouchableOpacity>
		));

		return (
			<Modal visible={showDateModal} transparent={true} animationType="slide">
				<View style={styles.modalContainer}>
					<View style={styles.datePickerContainer}>
						<Text style={styles.datePickerTitle}>Select Date</Text>

						<View style={styles.datePickerContent}>
							<View style={styles.pickerSection}>
								<Text style={styles.pickerLabel}>Year</Text>
								<ScrollView style={styles.pickerScrollView}>{yearOptions}</ScrollView>
							</View>

							<View style={styles.pickerSection}>
								<Text style={styles.pickerLabel}>Month</Text>
								<ScrollView style={styles.pickerScrollView}>{monthOptions}</ScrollView>
							</View>

							<View style={styles.pickerSection}>
								<Text style={styles.pickerLabel}>Day</Text>
								<ScrollView style={styles.pickerScrollView}>{dayOptions}</ScrollView>
							</View>
						</View>

						<View style={styles.datePickerButtons}>
							<TouchableOpacity
								style={[styles.datePickerButton, styles.cancelDateButton]}
								onPress={() => setShowDateModal(false)}
							>
								<Text style={styles.cancelDateButtonText}>Cancel</Text>
							</TouchableOpacity>

							<TouchableOpacity
								style={[styles.datePickerButton, styles.confirmDateButton]}
								onPress={handleConfirmDate}
							>
								<Text style={styles.confirmDateButtonText}>Confirm</Text>
							</TouchableOpacity>
						</View>
					</View>
				</View>
			</Modal>
		);
	};

	return (
		<KeyboardAvoidingView
			behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
			style={styles.container}
		>
			<ScrollView>
				{/* Transaction Type Toggle */}
				<View style={styles.typeToggleContainer}>
					<Text style={styles.label}>Transaction Type</Text>
					<View style={styles.toggleRow}>
						<Text style={styles.toggleLabel}>Expense</Text>
						<Switch
							value={isIncome}
							onValueChange={toggleTransactionType}
							trackColor={{
								false: 'rgba(255, 107, 107, 0.3)',
								true: 'rgba(76, 175, 80, 0.3)',
							}}
							thumbColor={isIncome ? '#4CAF50' : '#FF6B6B'}
							ios_backgroundColor="rgba(255, 107, 107, 0.3)"
							style={styles.switch}
						/>
						<Text style={styles.toggleLabel}>Income</Text>
					</View>
				</View>

				<View style={styles.formGroup}>
					<Text style={styles.label}>Amount</Text>
					<View style={styles.amountInputContainer}>
						<Text style={styles.currencySymbol}>{currentCurrency.symbol}</Text>
						<TextInput
							style={styles.amountInput}
							value={amount}
							onChangeText={(text) => {
								setAmount(text);
								if (errors.amount) {
									setErrors({ ...errors, amount: undefined });
								}
							}}
							placeholder="0.00"
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
							keyboardType="decimal-pad"
							autoFocus
						/>
					</View>
					{errors.amount ? <Text style={styles.errorText}>{errors.amount}</Text> : null}
				</View>

				<CategoryPicker
					categories={categories}
					selectedCategoryId={category}
					onSelectCategory={handleSelectCategory}
				/>
				{errors.category ? <Text style={styles.errorText}>{errors.category}</Text> : null}

				<View style={styles.formGroup}>
					<Text style={styles.label}>Date</Text>
					<TouchableOpacity style={styles.dateButton} onPress={handleShowDatePicker}>
						<Text style={styles.dateButtonText}>{formatFullDate(date.toISOString())}</Text>
						<Ionicons name="calendar-outline" size={20} color="white" />
					</TouchableOpacity>
				</View>

				<View style={styles.formGroup}>
					<Text style={styles.label}>Note (Optional)</Text>
					<TextInput
						style={styles.noteInput}
						value={note}
						onChangeText={setNote}
						placeholder="Add a note"
						placeholderTextColor="rgba(255, 255, 255, 0.3)"
						multiline
					/>
				</View>

				<View style={styles.buttonsRow}>
					<TouchableOpacity
						style={[styles.button, styles.cancelButton]}
						onPress={onCancel}
						disabled={isSubmitting}
					>
						<Text style={styles.cancelButtonText}>Cancel</Text>
					</TouchableOpacity>

					<TouchableOpacity
						style={[
							styles.button,
							isIncome ? styles.saveIncomeButton : styles.saveExpenseButton,
							isSubmitting && styles.disabledButton,
						]}
						onPress={handleSubmit}
						disabled={isSubmitting}
					>
						<Text style={styles.submitButtonText}>{isEditing ? 'Update' : 'Save'}</Text>
						{isSubmitting ? (
							<Ionicons name="sync" size={18} color="black" style={styles.spinnerIcon} />
						) : null}
					</TouchableOpacity>
				</View>
			</ScrollView>

			{renderDatePicker()}
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
	buttonsRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: 32,
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
	// Date picker modal styles
	modalContainer: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
		justifyContent: 'center',
		alignItems: 'center',
	},
	datePickerContainer: {
		width: '90%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		maxHeight: '80%',
	},
	datePickerTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 16,
	},
	datePickerContent: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginBottom: 16,
	},
	pickerSection: {
		flex: 1,
		marginHorizontal: 4,
	},
	pickerLabel: {
		fontSize: 14,
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 8,
	},
	pickerScrollView: {
		height: 200,
	},
	pickerOption: {
		padding: 12,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: 8,
	},
	selectedPickerOption: {
		backgroundColor: 'rgba(80, 227, 194, 0.2)',
	},
	pickerOptionText: {
		fontSize: 16,
		color: '#FFFFFF',
	},
	selectedPickerOptionText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	datePickerButtons: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	datePickerButton: {
		flex: 1,
		padding: 12,
		borderRadius: 8,
		alignItems: 'center',
		justifyContent: 'center',
	},
	cancelDateButton: {
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 8,
	},
	confirmDateButton: {
		backgroundColor: '#50E3C2',
		marginLeft: 8,
	},
	cancelDateButtonText: {
		color: '#FFFFFF',
		fontSize: 16,
		fontWeight: '500',
	},
	confirmDateButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '500',
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
		padding: 12,
	},
	toggleLabel: {
		fontSize: 16,
		color: '#ffffff',
		fontWeight: '500',
	},
	switch: {
		marginHorizontal: 20,
	},
});

export default TransactionForm;
