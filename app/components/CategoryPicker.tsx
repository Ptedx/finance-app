import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import type React from 'react';
import { memo, useCallback, useMemo } from 'react';
import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Category } from '../database/schema';

interface CategoryPickerProps {
	categories: Category[];
	selectedCategoryId: string | null;
	onSelectCategory: (categoryId: string) => void;
	isIncome?: boolean;
}

const { width } = Dimensions.get('window');
const ITEM_WIDTH = (width - 48) / 2; // 2 columns with 16px padding on each side and 16px between

const CategoryPicker: React.FC<CategoryPickerProps> = ({
	categories,
	selectedCategoryId,
	onSelectCategory,
}) => {
	const router = useRouter();

	// Memoize filtered categories to prevent recalculation on every render
	const filteredCategories = useMemo(() => {
		return categories.filter((category) => category.id !== 'uncategorized');
	}, [categories]);

	// Handle category selection with useCallback
	const handleSelectCategory = useCallback(
		(categoryId: string) => {
			onSelectCategory(categoryId);
		},
		[onSelectCategory]
	);

	// Memoize the navigation handler
	const handleEditCategories = useCallback(() => {
		router.push('/screens/CategoryManagementScreen');
	}, [router]);

	// Create rows of categories (2 per row) - memoized to prevent recalculation
	const categoryRows = useMemo(() => {
		const rows = [];
		for (let i = 0; i < filteredCategories.length; i += 2) {
			const row = (
				<View key={`row-${i}`} style={styles.columnWrapper}>
					{renderCategoryItem(filteredCategories[i], selectedCategoryId, handleSelectCategory)}
					{i + 1 < filteredCategories.length ? (
						renderCategoryItem(filteredCategories[i + 1], selectedCategoryId, handleSelectCategory)
					) : (
						<View style={{ width: ITEM_WIDTH }} />
					)}
				</View>
			);
			rows.push(row);
		}
		return rows;
	}, [filteredCategories, selectedCategoryId, handleSelectCategory]);

	return (
		<View style={styles.container}>
			<View style={styles.headerContainer}>
				<Text style={styles.title}>Category</Text>
				<TouchableOpacity style={styles.editButton} onPress={handleEditCategories}>
					<Text style={styles.editButtonText}>Edit Categories</Text>
				</TouchableOpacity>
			</View>
			<View style={styles.categoriesContainer}>{categoryRows}</View>
		</View>
	);
};

// Extracted to a separate function to improve readability
const renderCategoryItem = (
	item: Category,
	selectedCategoryId: string | null,
	onSelectCategory: (categoryId: string) => void
) => {
	const isSelected = selectedCategoryId === item.id;
	return (
		<TouchableOpacity
			key={item.id}
			style={[styles.categoryItem, isSelected && { borderColor: item.color, borderWidth: 2 }]}
			onPress={() => onSelectCategory(item.id)}
		>
			<BlurView intensity={20} tint="dark" style={styles.blurContainer}>
				<View style={[styles.iconContainer, { backgroundColor: item.color }]}>
					{/* biome-ignore lint/suspicious/noExplicitAny: external API shape unknown */}
					<Ionicons name={item.icon as any} size={24} color="#000000" />
				</View>
				<Text style={styles.categoryName}>{item.name}</Text>
			</BlurView>
		</TouchableOpacity>
	);
};

const styles = StyleSheet.create({
	container: {
		marginVertical: 16,
	},
	headerContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 12,
	},
	title: {
		fontSize: 16,
		fontWeight: '600',
		color: '#ffffff',
	},
	editButton: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		paddingHorizontal: 12,
		paddingVertical: 6,
		borderRadius: 4,
	},
	editButtonText: {
		color: '#15E8FE',
		fontSize: 12,
		fontWeight: '600',
	},
	categoriesContainer: {
		width: '100%',
	},
	columnWrapper: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginBottom: 16,
	},
	categoryItem: {
		width: ITEM_WIDTH,
		height: 100,
		borderRadius: 12,
		overflow: 'hidden',
		borderColor: 'transparent',
		borderWidth: 2,
	},
	blurContainer: {
		flex: 1,
		padding: 12,
		alignItems: 'center',
		justifyContent: 'center',
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.1)',
		borderRadius: 10,
	},
	iconContainer: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 8,
	},
	categoryName: {
		fontSize: 14,
		fontWeight: '500',
		color: '#ffffff',
		textAlign: 'center',
	},
});

// Memoize the entire component to prevent unnecessary re-renders
export default memo(CategoryPicker, (prevProps, nextProps) => {
	// Only re-render if these props change
	if (prevProps.selectedCategoryId !== nextProps.selectedCategoryId) {
		return false;
	}

	// Check if categories array has changed
	if (prevProps.categories.length !== nextProps.categories.length) {
		return false;
	}

	// Check category ids (deep comparison)
	const prevIds = prevProps.categories
		.map((c) => c.id)
		.sort()
		.join(',');
	const nextIds = nextProps.categories
		.map((c) => c.id)
		.sort()
		.join(',');

	return prevIds === nextIds;
});
