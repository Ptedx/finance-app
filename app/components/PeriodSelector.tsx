import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	type LayoutChangeEvent,
	Modal,
	ScrollView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';

import { usePeriod } from '../contexts/PeriodContext';
import { getMonthName } from '../utils/dateUtils';

interface PeriodSelectorProps {
	style?: object;
	textStyle?: object;
}

/** Altura das duas listas (`pickerScrollView`), para centralizar o item escolhido. */
const PICKER_HEIGHT = 200;

/**
 * Os anos da lista, do mais novo para o mais velho: do ano seguinte a cinco anos atrás.
 *
 * O ano seguinte entra porque fatura e parcela de janeiro já existem em novembro — sem ele
 * não dava para ver a fatura de janeiro pela tela inicial. O ano escolhido entra mesmo fora
 * da faixa, para a lista nunca abrir sem nada marcado.
 */
export const yearOptions = (currentYear: number, selectedYear: number): number[] => {
	const newest = Math.max(currentYear + 1, selectedYear);
	const oldest = Math.min(currentYear - 5, selectedYear);
	return Array.from({ length: newest - oldest + 1 }, (_, i) => newest - i);
};

/** Quanto rolar para o item (topo `itemY`, altura `itemHeight`) ficar no meio da lista. */
export const centeredOffset = (itemY: number, itemHeight: number, viewportHeight: number): number =>
	Math.max(0, Math.round(itemY - (viewportHeight - itemHeight) / 2));

type PickerList = 'year' | 'month';

const PeriodSelector: React.FC<PeriodSelectorProps> = ({ style, textStyle }) => {
	const { t } = useTranslation();
	const { selectedMonth, selectedYear, setSelectedPeriod } = usePeriod();
	const [showModal, setShowModal] = useState(false);
	const [tempMonth, setTempMonth] = useState(selectedMonth);
	const [tempYear, setTempYear] = useState(selectedYear);
	const yearListRef = useRef<ScrollView>(null);
	const monthListRef = useRef<ScrollView>(null);
	// Cada lista rola até o item escolhido uma vez por abertura, quando ele é medido. A
	// lista abria em janeiro e o mês atual (novembro) ficava fora da vista.
	const scrolled = useRef<Record<PickerList, boolean>>({ year: false, month: false });

	const scrollToSelected = (list: PickerList, event: LayoutChangeEvent) => {
		if (scrolled.current[list]) return;
		scrolled.current[list] = true;
		const { y, height } = event.nativeEvent.layout;
		const ref = list === 'year' ? yearListRef : monthListRef;
		ref.current?.scrollTo({ y: centeredOffset(y, height, PICKER_HEIGHT), animated: false });
	};

	const handleOpenSelector = () => {
		setTempMonth(selectedMonth);
		setTempYear(selectedYear);
		scrolled.current = { year: false, month: false };
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

	const years = yearOptions(new Date().getFullYear(), selectedYear);

	// Create month options
	const months = Array.from({ length: 12 }, (_, i) => i + 1);

	return (
		<>
			<TouchableOpacity onPress={handleOpenSelector} style={[styles.monthSelector, style]}>
				<Text style={[styles.monthText, textStyle]}>{currentMonthText}</Text>
				<Ionicons name="chevron-down" size={14} color="#888888" style={styles.icon} />
			</TouchableOpacity>

			<Modal visible={showModal} transparent={true} animationType="slide" onRequestClose={handleCancel}>
				<View style={styles.modalContainer}>
					<View style={styles.pickerContainer}>
						<Text style={styles.pickerTitle} accessibilityRole="header">
							{t('periodSelector.title')}
						</Text>

						<View style={styles.pickerContent}>
							<View style={styles.pickerSection}>
								<Text style={styles.pickerLabel}>{t('periodSelector.year')}</Text>
								<ScrollView ref={yearListRef} style={styles.pickerScrollView}>
									{years.map((year) => (
										<TouchableOpacity
											key={`year-${year}`}
											style={[
												styles.pickerOption,
												tempYear === year && styles.selectedPickerOption,
											]}
											onPress={() => setTempYear(year)}
											onLayout={tempYear === year ? (event) => scrollToSelected('year', event) : undefined}
											accessibilityRole="radio"
											accessibilityState={{ selected: tempYear === year }}
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
								<Text style={styles.pickerLabel}>{t('periodSelector.month')}</Text>
								<ScrollView ref={monthListRef} style={styles.pickerScrollView}>
									{months.map((month) => (
										<TouchableOpacity
											key={`month-${month}`}
											style={[
												styles.pickerOption,
												tempMonth === month && styles.selectedPickerOption,
											]}
											onPress={() => setTempMonth(month)}
											onLayout={tempMonth === month ? (event) => scrollToSelected('month', event) : undefined}
											accessibilityRole="radio"
											accessibilityState={{ selected: tempMonth === month }}
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
								<Text style={styles.cancelButtonText}>{t('periodSelector.cancel')}</Text>
							</TouchableOpacity>

							<TouchableOpacity
								style={[styles.pickerButton, styles.confirmButton]}
								onPress={handleConfirm}
							>
								<Text style={styles.confirmButtonText}>{t('periodSelector.confirm')}</Text>
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
		height: PICKER_HEIGHT,
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
