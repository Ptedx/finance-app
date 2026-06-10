import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { usePeriod } from '../contexts/PeriodContext';
import { getMonthName } from '../utils/dateUtils';

interface PeriodSelectorProps {
	style?: object;
	textStyle?: object;
}

const PeriodSelector: React.FC<PeriodSelectorProps> = ({ style, textStyle }) => {
	const { selectedMonth, selectedYear, setSelectedPeriod } = usePeriod();
	const [showModal, setShowModal] = useState(false);
	const [tempMonth, setTempMonth] = useState(selectedMonth);
	const [tempYear, setTempYear] = useState(selectedYear);

	const handleOpenSelector = () => {
		setTempMonth(selectedMonth);
		setTempYear(selectedYear);
		setShowModal(true);
	};

	const handleConfirm = () => {
		setSelectedPeriod(tempMonth, tempYear);
		setShowModal(false);
	};

	const handleCancel = () => {
		setShowModal(false);
	};

	const currentMonthText = `${getMonthName(selectedMonth).toUpperCase()} ${selectedYear}`;

	// Create year options (current year to 5 years back)
	const currentYear = new Date().getFullYear();
	const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

	// Create month options
	const months = Array.from({ length: 12 }, (_, i) => i + 1);

	return (
		<>
			<TouchableOpacity onPress={handleOpenSelector} style={[styles.monthSelector, style]}>
				<Text style={[styles.monthText, textStyle]}>{currentMonthText}</Text>
				<Ionicons name="chevron-down" size={14} color="#888888" style={styles.icon} />
			</TouchableOpacity>

			<Modal visible={showModal} transparent={true} animationType="slide">
				<View style={styles.modalContainer}>
					<View style={styles.pickerContainer}>
						<Text style={styles.pickerTitle}>Select Month</Text>

						<View style={styles.pickerContent}>
							<View style={styles.pickerSection}>
								<Text style={styles.pickerLabel}>Year</Text>
								<ScrollView style={styles.pickerScrollView}>
									{years.map((year) => (
										<TouchableOpacity
											key={`year-${year}`}
											style={[
												styles.pickerOption,
												tempYear === year && styles.selectedPickerOption,
											]}
											onPress={() => setTempYear(year)}
										>
											<Text
												style={[
													styles.pickerOptionText,
													tempYear === year && styles.selectedPickerOptionText,
												]}
											>
												{year}
											</Text>
										</TouchableOpacity>
									))}
								</ScrollView>
							</View>

							<View style={styles.pickerSection}>
								<Text style={styles.pickerLabel}>Month</Text>
								<ScrollView style={styles.pickerScrollView}>
									{months.map((month) => (
										<TouchableOpacity
											key={`month-${month}`}
											style={[
												styles.pickerOption,
												tempMonth === month && styles.selectedPickerOption,
											]}
											onPress={() => setTempMonth(month)}
										>
											<Text
												style={[
													styles.pickerOptionText,
													tempMonth === month && styles.selectedPickerOptionText,
												]}
											>
												{getMonthName(month)}
											</Text>
										</TouchableOpacity>
									))}
								</ScrollView>
							</View>
						</View>

						<View style={styles.pickerButtons}>
							<TouchableOpacity
								style={[styles.pickerButton, styles.cancelButton]}
								onPress={handleCancel}
							>
								<Text style={styles.cancelButtonText}>Cancel</Text>
							</TouchableOpacity>

							<TouchableOpacity
								style={[styles.pickerButton, styles.confirmButton]}
								onPress={handleConfirm}
							>
								<Text style={styles.confirmButtonText}>Confirm</Text>
							</TouchableOpacity>
						</View>
					</View>
				</View>
			</Modal>
		</>
	);
};

const styles = StyleSheet.create({
	monthSelector: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	monthText: {
		fontSize: 14,
		color: '#888888',
		fontWeight: '600',
		letterSpacing: 0.5,
	},
	icon: {
		marginLeft: 4,
	},
	// Modal styles
	modalContainer: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
		justifyContent: 'center',
		alignItems: 'center',
	},
	pickerContainer: {
		width: '90%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		maxHeight: '80%',
	},
	pickerTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 16,
	},
	pickerContent: {
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
	pickerButtons: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	pickerButton: {
		flex: 1,
		padding: 12,
		borderRadius: 8,
		alignItems: 'center',
		justifyContent: 'center',
	},
	cancelButton: {
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 8,
	},
	confirmButton: {
		backgroundColor: '#15E8FE',
		marginLeft: 8,
	},
	cancelButtonText: {
		color: '#FFFFFF',
		fontSize: 16,
		fontWeight: '500',
	},
	confirmButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '500',
	},
});

export default PeriodSelector;
