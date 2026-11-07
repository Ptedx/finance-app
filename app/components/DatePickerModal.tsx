import type React from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getMonthName, lastDayOfMonth } from '../utils/dateUtils';

/**
 * Seletor de data do lançamento: três colunas (ano, mês, dia) num modal.
 *
 * Abre com a data escolhida **no meio de cada coluna** (E2E-14): antes abria rolado para o
 * topo, em janeiro e dia 1, com o mês e o dia escolhidos fora da vista. Para isso cada
 * opção tem altura fixa (`PICKER_ITEM_HEIGHT`) e a coluna nasce já rolada até ela.
 * Os meses saem no idioma do app (`getMonthName`), não numa lista em inglês.
 */

export const PICKER_ITEM_HEIGHT = 44;
export const PICKER_VIEWPORT_HEIGHT = 200;

/** Quanto rolar a coluna para a opção `index` ficar no meio, sem passar do topo. */
export const pickerOffset = (index: number): number =>
	Math.max(0, index * PICKER_ITEM_HEIGHT - (PICKER_VIEWPORT_HEIGHT - PICKER_ITEM_HEIGHT) / 2);

/**
 * Os anos da coluna, do mais novo ao mais antigo: o atual e os cinco anteriores, e o ano
 * escolhido se estiver fora disso — a parcela 3/3 de uma compra de novembro é de janeiro
 * do ano que vem, e editá-la abria o seletor sem o ano dela na lista.
 */
export const pickerYears = (selectedYear: number, currentYear: number): number[] => {
	const newest = Math.max(currentYear, selectedYear);
	const oldest = Math.min(currentYear - 5, selectedYear);
	return Array.from({ length: newest - oldest + 1 }, (_, index) => newest - index);
};

/**
 * Monta a data escolhida no seletor, com o dia preso ao tamanho do mês.
 *
 * `setMonth`/`setDate` transbordam: 31 de janeiro com o mês trocado para fevereiro
 * virava 3 de março, e dia 31 escolhido em abril virava 1º de maio — silenciosamente,
 * no mês errado. `monthIndex` é 0-11, como o `Date` do JS.
 */
export const buildPickedDate = (year: number, monthIndex: number, day: number): Date =>
	new Date(year, monthIndex, Math.min(day, lastDayOfMonth(year, monthIndex + 1)));

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface DatePickerModalProps {
	visible: boolean;
	value: Date;
	onConfirm: (date: Date) => void;
	onCancel: () => void;
}

interface ColumnProps {
	testID: string;
	label: string;
	options: { key: string; label: string; selected: boolean; onPress: () => void }[];
}

/**
 * Uma coluna rolável. Nasce rolada até a opção escolhida (`contentOffset`) e, na primeira
 * medida, rola de novo até ela: o `contentOffset` inicial não vale em todo Android, e o
 * `scrollTo` depois do layout garante. Só na primeira — depois quem rola é o usuário.
 */
const Column: React.FC<ColumnProps> = ({ testID, label, options }) => {
	const scrollRef = useRef<ScrollView>(null);
	const placed = useRef(false);
	const selectedIndex = Math.max(0, options.findIndex((option) => option.selected));
	const offset = pickerOffset(selectedIndex);

	return (
		<View style={styles.pickerSection}>
			<Text style={styles.pickerLabel}>{label}</Text>
			<ScrollView
				ref={scrollRef}
				testID={testID}
				style={styles.pickerScrollView}
				contentOffset={{ x: 0, y: offset }}
				onLayout={() => {
					if (placed.current) return;
					placed.current = true;
					scrollRef.current?.scrollTo({ x: 0, y: offset, animated: false });
				}}
				accessibilityLabel={label}
			>
				{options.map((option) => (
					<TouchableOpacity
						key={option.key}
						style={[styles.pickerOption, option.selected && styles.selectedPickerOption]}
						onPress={option.onPress}
						accessibilityRole="button"
						accessibilityState={{ selected: option.selected }}
					>
						<Text style={[styles.pickerOptionText, option.selected && styles.selectedPickerOptionText]}>{option.label}</Text>
					</TouchableOpacity>
				))}
			</ScrollView>
		</View>
	);
};

/**
 * O miolo do modal. Nasce a cada abertura (o `Modal` só monta o conteúdo visível), então
 * a data provisória começa sempre da data do formulário — e já na primeira pintura, que é
 * quando as colunas leem onde nascer roladas.
 */
const PickerBody: React.FC<Omit<DatePickerModalProps, 'visible'>> = ({ value, onConfirm, onCancel }) => {
	const { t } = useTranslation();
	const [tempDate, setTempDate] = useState(value);

	const year = tempDate.getFullYear();
	const monthIndex = tempDate.getMonth();
	const day = tempDate.getDate();

	const years = pickerYears(year, new Date().getFullYear());
	const days = Array.from({ length: lastDayOfMonth(year, monthIndex + 1) }, (_, index) => index + 1);

	return (
		<View style={styles.modalContainer}>
			<View style={styles.datePickerContainer}>
				<Text style={styles.datePickerTitle} accessibilityRole="header">
					{t('transactionForm.datePickerTitle')}
				</Text>

				<View style={styles.datePickerContent}>
					<Column
						testID="date-picker-year"
						label={t('transactionForm.datePickerYear')}
						options={years.map((option) => ({
							key: `year-${option}`,
							label: String(option),
							selected: option === year,
							onPress: () => setTempDate(buildPickedDate(option, monthIndex, day)),
						}))}
					/>
					<Column
						testID="date-picker-month"
						label={t('transactionForm.datePickerMonth')}
						options={Array.from({ length: 12 }, (_, index) => ({
							key: `month-${index}`,
							label: capitalize(getMonthName(index + 1)),
							selected: index === monthIndex,
							onPress: () => setTempDate(buildPickedDate(year, index, day)),
						}))}
					/>
					<Column
						testID="date-picker-day"
						label={t('transactionForm.datePickerDay')}
						options={days.map((option) => ({
							key: `day-${option}`,
							label: String(option),
							selected: option === day,
							onPress: () => setTempDate(buildPickedDate(year, monthIndex, option)),
						}))}
					/>
				</View>

				<View style={styles.datePickerButtons}>
					<TouchableOpacity style={[styles.datePickerButton, styles.cancelDateButton]} onPress={onCancel} accessibilityRole="button">
						<Text style={styles.cancelDateButtonText}>{t('transactionForm.datePickerCancel')}</Text>
					</TouchableOpacity>

					<TouchableOpacity
						style={[styles.datePickerButton, styles.confirmDateButton]}
						onPress={() => onConfirm(tempDate)}
						accessibilityRole="button"
					>
						<Text style={styles.confirmDateButtonText}>{t('transactionForm.datePickerConfirm')}</Text>
					</TouchableOpacity>
				</View>
			</View>
		</View>
	);
};

const DatePickerModal: React.FC<DatePickerModalProps> = ({ visible, value, onConfirm, onCancel }) => (
	<Modal visible={visible} transparent={true} animationType="slide" onRequestClose={onCancel}>
		{visible ? <PickerBody value={value} onConfirm={onConfirm} onCancel={onCancel} /> : null}
	</Modal>
);

const styles = StyleSheet.create({
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
		height: PICKER_VIEWPORT_HEIGHT,
	},
	// Altura fixa: é ela que diz onde cada opção está para abrir rolado até a escolhida.
	pickerOption: {
		height: PICKER_ITEM_HEIGHT,
		paddingHorizontal: 4,
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
});

export default DatePickerModal;
