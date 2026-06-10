import type React from 'react';
import { useEffect, useState } from 'react';
import {
	Alert,
	Modal,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
import { useCurrency } from '../contexts/CurrencyContext';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { RecurringTransaction } from '../database/schema';
import { parseAmount } from '../utils/currencyUtils';
import HorizontalCategoryPicker from './HorizontalCategoryPicker';

// Transaction recurrence types
type RecurrenceType = 'monthly' | 'yearly' | 'weekly';

interface TransactionEditorProps {
	isVisible: boolean;
	onClose: () => void;
	isIncome?: boolean;
	initialTransaction?: RecurringTransaction | null;
}

const TransactionEditor: React.FC<TransactionEditorProps> = ({
	isVisible,
	onClose,
	isIncome = true,
	initialTransaction = null,
}) => {
	const { addTransaction, updateTransaction } = useRecurringTransactions();
	const { categories } = useTransactions();
	const { currentCurrency } = useCurrency();

	const [amount, setAmount] = useState<string>('');
	const [note, setNote] = useState<string>('');
	const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>('monthly');
	const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// For monthly recurrence
	const [selectedDay, setSelectedDay] = useState<number>(1);

	// For yearly recurrence
	const [selectedMonth, setSelectedMonth] = useState<number>(1);
	const [selectedYearlyDay, setSelectedYearlyDay] = useState<number>(1);

	// For weekly recurrence
	const [selectedWeekday, setSelectedWeekday] = useState<number>(1); // 1 = Monday, 7 = Sunday

	// Set initial values if editing an existing transaction
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		if (initialTransaction) {
			setAmount(initialTransaction.amount.toString());
			setNote(initialTransaction.note || '');
			setRecurrenceType(initialTransaction.recurrenceType || 'monthly');
			setSelectedCategory(initialTransaction.category || null);

			if (initialTransaction.day) {
				setSelectedDay(initialTransaction.day);
				setSelectedYearlyDay(initialTransaction.day);
			}

			if (initialTransaction.month) {
				setSelectedMonth(initialTransaction.month);
			}

			if (initialTransaction.weekday) {
				setSelectedWeekday(initialTransaction.weekday);
			}
		} else {
			// Reset form for new transactions
			setAmount('');
			setNote('');
			setRecurrenceType('monthly');
			setSelectedDay(1);
			setSelectedMonth(1);
			setSelectedYearlyDay(1);
			setSelectedWeekday(1);
			setSelectedCategory(null);
		}
	}, [initialTransaction, isVisible]);

	const validateForm = (): boolean => {
		if (!amount || parseAmount(amount) <= 0) {
			Alert.alert('Invalid Amount', 'Please enter a valid amount greater than zero.');
			return false;
		}

		if (!selectedCategory) {
			Alert.alert('Category Required', 'Please select a category for this transaction.');
			return false;
		}

		return true;
	};

	const handleSave = async () => {
		if (!validateForm()) return;

		try {
			setIsSubmitting(true);

			// Prepare transaction data based on recurrence type
			const parsedAmount = parseAmount(amount);

			const transactionData: Omit<RecurringTransaction, 'id' | 'lastProcessed' | 'nextDue'> = {
				amount: parsedAmount,
				note,
				recurrenceType,
				isIncome,
				category: selectedCategory || '',
				active: true,
			};

			// Add specific properties based on recurrence type
			if (recurrenceType === 'monthly') {
				transactionData.day = selectedDay;
			} else if (recurrenceType === 'yearly') {
				transactionData.month = selectedMonth;
				transactionData.day = selectedYearlyDay;
			} else if (recurrenceType === 'weekly') {
				transactionData.weekday = selectedWeekday;
			}

			if (initialTransaction) {
				// Update existing transaction
				await updateTransaction({
					...transactionData,
					id: initialTransaction.id,
					lastProcessed: initialTransaction.lastProcessed,
					nextDue: initialTransaction.nextDue,
				});
			} else {
				// Create new transaction
				await addTransaction(transactionData);
			}

			// Reset form and close
			setIsSubmitting(false);
			onClose();
		} catch (error) {
			console.error('Failed to save transaction:', error);
			setIsSubmitting(false);
			Alert.alert('Error', 'Failed to save transaction. Please try again.');
		}
	};

	const handleCancel = () => {
		onClose();
	};

	const handleSelectCategory = (categoryId: string) => {
		setSelectedCategory(categoryId);
	};

	// Generate options for day selection (1-31)
	const renderDayOptions = () => {
		const days = Array.from({ length: 31 }, (_, i) => i + 1);
		return (
			<View style={styles.selectorContainer}>
				<Text style={styles.sectionLabel}>Day of month</Text>
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.daysContainer}
				>
					{days.map((day) => (
						<TouchableOpacity
							key={`day-${day}`}
							style={[styles.dayOption, selectedDay === day && styles.selectedDayOption]}
							onPress={() => setSelectedDay(day)}
						>
							<Text
								style={[styles.dayOptionText, selectedDay === day && styles.selectedDayOptionText]}
							>
								{day}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>
			</View>
		);
	};

	// Generate options for month selection (Jan-Dec)
	const renderMonthOptions = () => {
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

		return (
			<View style={styles.selectorContainer}>
				<Text style={styles.sectionLabel}>Month</Text>
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.monthsContainer}
				>
					{months.map((month, index) => (
						<TouchableOpacity
							// biome-ignore lint/suspicious/noArrayIndexKey: index is stable for static month/weekday arrays
							key={`month-${index}`}
							style={[
								styles.monthOption,
								selectedMonth === index + 1 && styles.selectedMonthOption,
							]}
							onPress={() => setSelectedMonth(index + 1)}
						>
							<Text
								style={[
									styles.monthOptionText,
									selectedMonth === index + 1 && styles.selectedMonthOptionText,
								]}
							>
								{month.substring(0, 3)}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>
			</View>
		);
	};

	// Generate options for yearly day selection (1-31)
	const renderYearlyDayOptions = () => {
		const days = Array.from({ length: 31 }, (_, i) => i + 1);
		return (
			<View style={styles.selectorContainer}>
				<Text style={styles.sectionLabel}>Day of month</Text>
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.daysContainer}
				>
					{days.map((day) => (
						<TouchableOpacity
							key={`yearly-day-${day}`}
							style={[styles.dayOption, selectedYearlyDay === day && styles.selectedDayOption]}
							onPress={() => setSelectedYearlyDay(day)}
						>
							<Text
								style={[
									styles.dayOptionText,
									selectedYearlyDay === day && styles.selectedDayOptionText,
								]}
							>
								{day}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>
			</View>
		);
	};

	// Generate options for weekday selection (Mon-Sun)
	const renderWeekdayOptions = () => {
		const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

		return (
			<View style={styles.selectorContainer}>
				<Text style={styles.sectionLabel}>Day of week</Text>
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.weekdaysContainer}
				>
					{weekdays.map((weekday, index) => (
						<TouchableOpacity
							// biome-ignore lint/suspicious/noArrayIndexKey: index is stable for static month/weekday arrays
							key={`weekday-${index}`}
							style={[
								styles.weekdayOption,
								selectedWeekday === index + 1 && styles.selectedWeekdayOption,
							]}
							onPress={() => setSelectedWeekday(index + 1)}
						>
							<Text
								style={[
									styles.weekdayOptionText,
									selectedWeekday === index + 1 && styles.selectedWeekdayOptionText,
								]}
							>
								{weekday.substring(0, 3)}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>
			</View>
		);
	};

	return (
		<Modal visible={isVisible} transparent={true} animationType="slide">
			<View style={styles.modalOverlay}>
				<View style={styles.modalCenteredContainer}>
					<View style={styles.modalContent}>
						<Text style={styles.modalTitle}>
							{initialTransaction
								? `Edit ${isIncome ? 'Income' : 'Expense'}`
								: `Add Recurring ${isIncome ? 'Income' : 'Expense'}`}
						</Text>

						<ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
							<View style={styles.inputContainer}>
								<Text style={styles.currencySymbol}>{currentCurrency.symbol}</Text>
								<TextInput
									style={styles.input}
									value={amount}
									onChangeText={setAmount}
									placeholder="Enter amount"
									placeholderTextColor="rgba(255, 255, 255, 0.3)"
									keyboardType="decimal-pad"
									autoFocus
								/>
							</View>

							<View style={styles.noteContainer}>
								<Text style={styles.sectionLabel}>Description (Optional)</Text>
								<TextInput
									style={styles.noteInput}
									value={note}
									onChangeText={setNote}
									placeholder="Add a note"
									placeholderTextColor="rgba(255, 255, 255, 0.3)"
									multiline
								/>
							</View>

							{/* Category Picker - Show for both income and expense */}
							<View style={styles.categoryContainer}>
								<HorizontalCategoryPicker
									categories={categories}
									selectedCategoryId={selectedCategory}
									onSelectCategory={handleSelectCategory}
								/>
							</View>

							<View style={styles.recurrenceContainer}>
								<Text style={styles.sectionLabel}>Recurrence</Text>
								<View style={styles.recurrenceOptions}>
									<TouchableOpacity
										style={[
											styles.recurrenceOption,
											recurrenceType === 'monthly' && styles.selectedRecurrenceOption,
										]}
										onPress={() => {
											setRecurrenceType('monthly');
										}}
									>
										<Text
											style={[
												styles.recurrenceOptionText,
												recurrenceType === 'monthly' && styles.selectedRecurrenceOptionText,
											]}
										>
											Monthly
										</Text>
									</TouchableOpacity>

									<TouchableOpacity
										style={[
											styles.recurrenceOption,
											recurrenceType === 'yearly' && styles.selectedRecurrenceOption,
										]}
										onPress={() => {
											setRecurrenceType('yearly');
										}}
									>
										<Text
											style={[
												styles.recurrenceOptionText,
												recurrenceType === 'yearly' && styles.selectedRecurrenceOptionText,
											]}
										>
											Yearly
										</Text>
									</TouchableOpacity>

									<TouchableOpacity
										style={[
											styles.recurrenceOption,
											recurrenceType === 'weekly' && styles.selectedRecurrenceOption,
										]}
										onPress={() => {
											setRecurrenceType('weekly');
										}}
									>
										<Text
											style={[
												styles.recurrenceOptionText,
												recurrenceType === 'weekly' && styles.selectedRecurrenceOptionText,
											]}
										>
											Weekly
										</Text>
									</TouchableOpacity>
								</View>
							</View>

							{/* Render specific options based on recurrence type */}
							{recurrenceType === 'monthly' && renderDayOptions()}

							{recurrenceType === 'yearly' && (
								<>
									{renderMonthOptions()}
									{renderYearlyDayOptions()}
								</>
							)}

							{recurrenceType === 'weekly' && renderWeekdayOptions()}

							<View style={styles.buttonRow}>
								<TouchableOpacity
									style={styles.cancelButton}
									onPress={handleCancel}
									disabled={isSubmitting}
								>
									<Text style={styles.cancelButtonText}>Cancel</Text>
								</TouchableOpacity>

								<TouchableOpacity
									style={[styles.saveButton, isSubmitting && styles.disabledButton]}
									onPress={handleSave}
									disabled={isSubmitting}
								>
									<Text style={styles.saveButtonText}>{isSubmitting ? 'Saving...' : 'Save'}</Text>
								</TouchableOpacity>
							</View>
						</ScrollView>
					</View>
				</View>
			</View>
		</Modal>
	);
};

const styles = StyleSheet.create({
	modalOverlay: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
		justifyContent: 'center',
		alignItems: 'center',
	},
	modalCenteredContainer: {
		width: '90%',
		maxHeight: '80%',
		justifyContent: 'center',
	},
	modalContent: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 22,
	},
	scrollContent: {
		maxHeight: '100%',
	},
	modalTitle: {
		fontSize: 22,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 22,
	},
	inputContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 10,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginBottom: 18,
		height: 64,
	},
	currencySymbol: {
		fontSize: 22,
		fontWeight: '600',
		color: '#FFFFFF',
		marginRight: 10,
		marginLeft: 4,
	},
	input: {
		flex: 1,
		fontSize: 20,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	sectionLabel: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 10,
	},
	noteContainer: {
		marginBottom: 18,
	},
	noteInput: {
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		color: '#FFFFFF',
		height: 70, // Slightly larger height
		textAlignVertical: 'top',
	},
	categoryContainer: {
		marginBottom: 18,
	},
	recurrenceContainer: {
		marginBottom: 18,
	},
	recurrenceOptions: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	recurrenceOption: {
		flex: 1,
		paddingVertical: 12,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginHorizontal: 4,
		borderRadius: 8,
	},
	selectedRecurrenceOption: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		borderColor: '#15E8FE',
		borderWidth: 1,
	},
	recurrenceOptionText: {
		color: '#FFFFFF',
		fontWeight: '500',
		fontSize: 15,
	},
	selectedRecurrenceOptionText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	// Day selector styles
	selectorContainer: {
		marginBottom: 18,
	},
	daysContainer: {
		flexDirection: 'row',
		paddingVertical: 10,
	},
	dayOption: {
		width: 40, // Slightly larger
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 10,
	},
	selectedDayOption: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		borderColor: '#15E8FE',
		borderWidth: 1,
	},
	dayOptionText: {
		color: '#FFFFFF',
		fontWeight: '500',
		fontSize: 15, // Slightly larger font
	},
	selectedDayOptionText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	// Month selector styles
	monthsContainer: {
		flexDirection: 'row',
		paddingVertical: 10,
	},
	monthOption: {
		minWidth: 60, // Slightly larger
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 10,
		paddingHorizontal: 10,
	},
	selectedMonthOption: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		borderColor: '#15E8FE',
		borderWidth: 1,
	},
	monthOptionText: {
		color: '#FFFFFF',
		fontWeight: '500',
		fontSize: 15, // Slightly larger font
	},
	selectedMonthOptionText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	// Weekday selector styles
	weekdaysContainer: {
		flexDirection: 'row',
		paddingVertical: 10,
	},
	weekdayOption: {
		minWidth: 60, // Slightly larger
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 10,
		paddingHorizontal: 10,
	},
	selectedWeekdayOption: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		borderColor: '#15E8FE',
		borderWidth: 1,
	},
	weekdayOptionText: {
		color: '#FFFFFF',
		fontWeight: '500',
		fontSize: 15, // Slightly larger font
	},
	selectedWeekdayOptionText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	buttonRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: 12,
		marginBottom: 8,
	},
	cancelButton: {
		flex: 1,
		padding: 14,
		borderRadius: 8,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 8,
		alignItems: 'center',
	},
	cancelButtonText: {
		color: '#FFFFFF',
		fontWeight: '600',
		fontSize: 16,
	},
	saveButton: {
		flex: 1,
		padding: 14,
		borderRadius: 8,
		backgroundColor: '#15E8FE',
		alignItems: 'center',
	},
	saveButtonText: {
		color: '#000000',
		fontWeight: '600',
		fontSize: 16,
	},
	disabledButton: {
		opacity: 0.6,
	},
});

export default TransactionEditor;
