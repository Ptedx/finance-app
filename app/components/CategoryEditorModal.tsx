import { Ionicons } from '@expo/vector-icons';
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
import type { Category } from '../database/schema';

interface CategoryEditorModalProps {
	isVisible: boolean;
	initialCategory?: Category | null;
	onSave: (category: Omit<Category, 'id'> & { id?: string }) => void;
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
	const [name, setName] = useState('');
	const [color, setColor] = useState(COLOR_OPTIONS[0]);
	const [icon, setIcon] = useState(ICON_OPTIONS[0]);

	// Reset form when modal opens or closes
	useEffect(() => {
		if (isVisible && initialCategory) {
			setName(initialCategory.name);
			setColor(initialCategory.color);
			setIcon(initialCategory.icon);
		} else if (isVisible && !initialCategory) {
			// Reset to defaults when adding a new category
			setName('');
			setColor(COLOR_OPTIONS[0]);
			setIcon(ICON_OPTIONS[0]);
		}
	}, [isVisible, initialCategory]);

	const handleSave = () => {
		// Validate name
		const trimmedName = name.trim();
		if (!trimmedName) {
			Alert.alert('Invalid Name', 'Please enter a category name');
			return;
		}

		// Prepare category data
		const categoryData = {
			name: trimmedName,
			color,
			icon,
			...(initialCategory && { id: initialCategory.id }), // Include ID if editing
		};

		onSave(categoryData);
	};

	return (
		<Modal visible={isVisible} transparent={true} animationType="slide">
			<View style={styles.modalContainer}>
				<View style={styles.modalContent}>
					<Text style={styles.modalTitle}>
						{initialCategory ? 'Edit Category' : 'Add New Category'}
					</Text>

					{/* Name Input */}
					<View style={styles.inputContainer}>
						<Text style={styles.label}>Category Name</Text>
						<TextInput
							style={styles.input}
							value={name}
							onChangeText={setName}
							placeholder="Enter category name"
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
						/>
					</View>

					{/* Color Selection */}
					<View style={styles.sectionContainer}>
						<Text style={styles.label}>Select Color</Text>
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
						<Text style={styles.label}>Select Icon</Text>
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
							<Text style={styles.cancelButtonText}>Cancel</Text>
						</TouchableOpacity>

						<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
							<Text style={styles.saveButtonText}>{initialCategory ? 'Update' : 'Save'}</Text>
						</TouchableOpacity>
					</View>
				</View>
			</View>
		</Modal>
	);
};

const styles = StyleSheet.create({
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
