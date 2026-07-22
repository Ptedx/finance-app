import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import type React from 'react';
import { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Category } from '../database/schema';

interface HorizontalCategoryPickerProps {
	categories: Category[];
	selectedCategoryId: string | null;
	onSelectCategory: (categoryId: string) => void;
	isIncome?: boolean;
}

const HorizontalCategoryPicker: React.FC<HorizontalCategoryPickerProps> = ({
	categories,
	selectedCategoryId,
	onSelectCategory,
	isIncome = false,
}) => {
	const handleEditCategories = useCallback(() => {
		router.push('/screens/CategoryManagementScreen');
	}, []);

	// Match the side of the ledger being recorded, as the full picker does.
	const visibleCategories = useMemo(() => {
		const wanted = isIncome ? 'income' : 'expense';
		return categories.filter((c) => c.id !== 'uncategorized' && c.type === wanted);
	}, [categories, isIncome]);

	return (
		<View style={styles.container}>
			<View style={styles.headerContainer}>
				<Text style={styles.title}>Category</Text>
				<TouchableOpacity style={styles.editButton} onPress={handleEditCategories}>
					<Text style={styles.editButtonText}>Edit Categories</Text>
				</TouchableOpacity>
			</View>
			{visibleCategories.length === 0 ? (
				<Text style={styles.emptyText}>No categories available</Text>
			) : (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.categoriesContainer}
				>
					{visibleCategories.map((category) => (
						<TouchableOpacity
							key={category.id}
							style={[
								styles.categoryItem,
								selectedCategoryId === category.id && {
									borderColor: category.color,
									borderWidth: 2,
								},
							]}
							onPress={() => onSelectCategory(category.id)}
						>
							<BlurView intensity={20} tint="dark" style={styles.blurContainer}>
								<View style={[styles.iconContainer, { backgroundColor: category.color }]}>
									{/* biome-ignore lint/suspicious/noExplicitAny: external API shape unknown */}
									<Ionicons name={category.icon as any} size={22} color="#000000" />
								</View>
								<Text style={styles.categoryName}>{category.name}</Text>
							</BlurView>
						</TouchableOpacity>
					))}
				</ScrollView>
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		marginVertical: 12,
	},
	title: {
		fontSize: 16,
		fontWeight: '600',
		color: '#ffffff',
		marginBottom: 10,
	},
	editButtonText: {
		color: '#15E8FE',
		fontSize: 12,
		fontWeight: '600',
	},
	editButton: {
		backgroundColor: 'rgba(21, 232, 254, 0.2)',
		paddingHorizontal: 12,
		paddingVertical: 6,
		borderRadius: 4,
	},
	headerContainer: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 12,
	},
	categoriesContainer: {
		paddingBottom: 10,
		paddingTop: 5,
	},
	categoryItem: {
		width: 100,
		height: 100,
		borderRadius: 12,
		overflow: 'hidden',
		borderColor: 'transparent',
		borderWidth: 2,
		marginRight: 12,
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
		width: 42,
		height: 42,
		borderRadius: 21,
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
	emptyText: {
		color: 'rgba(255, 255, 255, 0.6)',
		fontSize: 14,
		fontStyle: 'italic',
		textAlign: 'center',
		padding: 20,
	},
});

export default HorizontalCategoryPicker;
