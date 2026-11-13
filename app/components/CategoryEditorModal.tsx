import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { CATEGORY_NATURES, type Category, type CategoryDraft, type CategoryNature, type CategoryType } from '../database/schema';

interface CategoryEditorModalProps {
	isVisible: boolean;
	initialCategory?: Category | null;
	onSave: (category: CategoryDraft & { id?: string }) => void;
	onCancel: () => void;
}

// Predefined color and icon options
const COLOR_OPTIONS = [
	'#50E3C2', // Teal
	'#FF6B6B', // Red
	'#4DACF7', // Blue
	'#A78BFA', // Purple
	'#FFCC5C', // Yellow
	'#4CAF50', // Green
	'#FF9FB1', // Pink
	'#5E5CE6', // Indigo
	'#9CA3AF', // Gray
];

const ICON_OPTIONS = [
	'cash',
	'cart',
	'car',
	'fast-food',
	'medical',
	'school',
	'home',
	'book',
	'airplane',
	'fitness',
	'shirt',
	'gift',
	'film',
	'bicycle',
	'beer',
	'cafe',
	'card',
	'clipboard',
	'lock-closed',
	'chatbubble',
	'document',
	'basket',
	'heart',
];

const CategoryEditorModal: React.FC<CategoryEditorModalProps> = ({
	isVisible,
	initialCategory,
	onSave,
	onCancel,
}) => {
	const { t } = useTranslation();
	const [name, setName] = useState('');
	const [color, setColor] = useState(COLOR_OPTIONS[0]);
	const [icon, setIcon] = useState(ICON_OPTIONS[0]);
	const [type, setType] = useState<CategoryType>('expense');
	const [nature, setNature] = useState<CategoryNature>('discretionary');

	// Reset form when modal opens or closes
	useEffect(() => {
		if (isVisible && initialCategory) {
			setName(initialCategory.name);
			setColor(initialCategory.color);
			setIcon(initialCategory.icon);
			setType(initialCategory.type);
			setNature(initialCategory.nature);
		} else if (isVisible && !initialCategory) {
			// Reset to defaults when adding a new category
			setName('');
			setColor(COLOR_OPTIONS[0]);
			setIcon(ICON_OPTIONS[0]);
			setType('expense');
			// A new category is a want until its owner says otherwise: guessing "need" on
			// their behalf would quietly inflate the needs share of the 50/30/20 view.
			setNature('discretionary');
		}
	}, [isVisible, initialCategory]);

	const handleSave = () => {
		// Validate name
		const trimmedName = name.trim();
		if (!trimmedName) {
			Alert.alert(t('categoryManagement.editor.invalidName'), t('categoryManagement.editor.invalidNameMsg'));
			return;
		}

		// Prepare category data
		const categoryData = {
			name: trimmedName,
			color,
			icon,
			type,
			nature,
			...(initialCategory && { id: initialCategory.id }), // Include ID if editing
		};

		onSave(categoryData);
	};

	return (
		<Modal visible={isVisible} transparent={true} animationType="slide">
			<View style={styles.modalContainer}>
				<View style={styles.modalContent}>
					<Text style={styles.modalTitle}>
						{initialCategory ? t('categoryManagement.editor.editTitle') : t('categoryManagement.editor.addTitle')}
					</Text>

					{/* Name Input */}
					<View style={styles.inputContainer}>
						<Text style={styles.label}>{t('categoryManagement.editor.name')}</Text>
						<TextInput
							style={styles.input}
							value={name}
							onChangeText={setName}
							placeholder={t('categoryManagement.editor.namePlaceholder')}
							accessibilityLabel={t('categoryManagement.editor.name')}
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
						/>
					</View>

					{/* Type selection. Decides which picker the category appears in; without it
					    every user-created category was silently treated as an expense. */}
					<View style={styles.sectionContainer}>
						<Text style={styles.label}>{t('categoryManagement.editor.type')}</Text>
						<View style={styles.typeRow}>
							{(['expense', 'income'] as CategoryType[]).map((option) => (
								<TouchableOpacity
									key={option}
									style={[styles.typeOption, type === option && styles.selectedTypeOption]}
									onPress={() => setType(option)}
								>
									<Text
										style={[
											styles.typeOptionText,
											type === option && styles.selectedTypeOptionText,
										]}
									>
										{option === 'expense' ? t('categoryManagement.expense') : t('categoryManagement.income')}
									</Text>
								</TouchableOpacity>
							))}
						</View>
					</View>

					{/* Needs vs wants. Only meaningful on the expense side — income is neither a
					    need nor a want — so the control is hidden rather than shown disabled. */}
					{type === 'expense' && (
						<View style={styles.sectionContainer}>
							<Text style={styles.label}>{t('categoryManagement.editor.nature')}</Text>
							<View style={styles.typeRow}>
								{CATEGORY_NATURES.map((option) => (
									<TouchableOpacity
										key={option}
										style={[styles.typeOption, nature === option && styles.selectedTypeOption]}
										onPress={() => setNature(option)}
									>
										<Text
											style={[
												styles.typeOptionText,
												nature === option && styles.selectedTypeOptionText,
											]}
										>
											{t(`categoryManagement.nature.${option}`)}
										</Text>
									</TouchableOpacity>
								))}
							</View>
							<Text style={styles.helperText}>
								{t('categoryManagement.editor.natureHelp')}
							</Text>
						</View>
					)}

					{/* Color Selection */}
					<View style={styles.sectionContainer}>
						<Text style={styles.label}>{t('categoryManagement.editor.color')}</Text>
						<ScrollView
							horizontal
							showsHorizontalScrollIndicator={false}
							contentContainerStyle={styles.colorPickerContainer}
						>
							{COLOR_OPTIONS.map((colorOption) => (
								<TouchableOpacity
									key={colorOption}
									style={[
										styles.colorOption,
										{ backgroundColor: colorOption },
										color === colorOption && styles.selectedColorOption,
									]}
									onPress={() => setColor(colorOption)}
								/>
							))}
						</ScrollView>
					</View>

					{/* Icon Selection */}
					<View style={styles.sectionContainer}>
						<Text style={styles.label}>{t('categoryManagement.editor.icon')}</Text>
						<ScrollView
							horizontal
							showsHorizontalScrollIndicator={false}
							contentContainerStyle={styles.iconPickerContainer}
						>
							{ICON_OPTIONS.map((iconOption) => (
								<TouchableOpacity
									key={iconOption}
									style={[styles.iconOption, icon === iconOption && styles.selectedIconOption]}
									onPress={() => setIcon(iconOption)}
								>
									<View style={[styles.iconBackground, { backgroundColor: color }]}>
										<Ionicons
											// biome-ignore lint/suspicious/noExplicitAny: external API shape unknown
											name={iconOption as any}
											size={24}
											color="#000000"
										/>
									</View>
								</TouchableOpacity>
							))}
						</ScrollView>
					</View>

					{/* Action Buttons */}
					<View style={styles.buttonContainer}>
						<TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
							<Text style={styles.cancelButtonText}>{t('categoryManagement.editor.cancel')}</Text>
						</TouchableOpacity>

						<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
							<Text style={styles.saveButtonText}>{initialCategory ? t('categoryManagement.editor.update') : t('categoryManagement.editor.save')}</Text>
						</TouchableOpacity>
					</View>
				</View>
			</View>
		</Modal>
	);
};

const styles = StyleSheet.create({
	typeRow: {
		flexDirection: 'row',
	},
	typeOption: {
		flex: 1,
		paddingVertical: 10,
		alignItems: 'center',
		borderRadius: 8,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginRight: 8,
	},
	selectedTypeOption: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		borderColor: '#15E8FE',
		borderWidth: 1,
	},
	typeOptionText: {
		color: '#FFFFFF',
		fontWeight: '500',
	},
	selectedTypeOptionText: {
		color: '#15E8FE',
		fontWeight: '600',
	},
	modalContainer: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
		justifyContent: 'center',
		alignItems: 'center',
	},
	modalContent: {
		width: '90%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 20,
	},
	modalTitle: {
		fontSize: 20,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 20,
	},
	inputContainer: {
		marginBottom: 20,
	},
	input: {
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		color: '#FFFFFF',
	},
	label: {
		fontSize: 16,
		color: '#FFFFFF',
		marginBottom: 8,
	},
	helperText: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.5)',
		marginTop: 8,
		lineHeight: 16,
	},
	sectionContainer: {
		marginBottom: 20,
	},
	colorPickerContainer: {
		flexDirection: 'row',
		gap: 10,
	},
	colorOption: {
		width: 40,
		height: 40,
		borderRadius: 20,
		borderWidth: 2,
		borderColor: 'transparent',
	},
	selectedColorOption: {
		borderColor: '#15E8FE',
	},
	iconPickerContainer: {
		flexDirection: 'row',
		gap: 10,
	},
	iconOption: {
		alignItems: 'center',
		padding: 5,
		borderRadius: 8,
		borderWidth: 2,
		borderColor: 'transparent',
	},
	selectedIconOption: {
		borderColor: '#15E8FE',
	},
	iconBackground: {
		width: 50,
		height: 50,
		borderRadius: 25,
		alignItems: 'center',
		justifyContent: 'center',
	},
	buttonContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: 20,
	},
	cancelButton: {
		flex: 1,
		marginRight: 8,
		paddingVertical: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		borderRadius: 8,
		alignItems: 'center',
	},
	saveButton: {
		flex: 1,
		marginLeft: 8,
		paddingVertical: 12,
		backgroundColor: '#15E8FE',
		borderRadius: 8,
		alignItems: 'center',
	},
	cancelButtonText: {
		color: '#FFFFFF',
		fontSize: 16,
		fontWeight: '500',
	},
	saveButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '500',
	},
});

export default CategoryEditorModal;
