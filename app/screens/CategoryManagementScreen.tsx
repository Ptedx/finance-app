import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useState } from 'react';
import {
	Alert,
	FlatList,
	SafeAreaView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import CategoryEditorModal from '../components/CategoryEditorModal';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Category } from '../database/schema';

const CategoryManagementScreen = () => {
	const { categories, addCategory, updateCategory, deleteCategory } = useTransactions();
	const [isEditorVisible, setIsEditorVisible] = useState(false);
	const [editingCategory, setEditingCategory] = useState<Category | null>(null);

	const handleAddCategory = () => {
		setEditingCategory(null);
		setIsEditorVisible(true);
	};

	const handleEditCategory = (category: Category) => {
		setEditingCategory(category);
		setIsEditorVisible(true);
	};

	const handleDeleteCategory = (category: Category) => {
		Alert.alert(
			'Delete Category',
			`Are you sure you want to delete the category "${category.name}"?`,
			[
				{
					text: 'Cancel',
					style: 'cancel',
				},
				{
					text: 'Delete',
					style: 'destructive',
					onPress: async () => {
						try {
							await deleteCategory(category.id);
						} catch (_error) {
							Alert.alert(
								'Cannot Delete Category',
								'This category is associated with existing transactions and cannot be deleted.'
							);
						}
					},
				},
			]
		);
	};

	const handleSaveCategory = async (categoryData: Omit<Category, 'id'> & { id?: string }) => {
		try {
			if (categoryData.id) {
				// Editing existing category
				await updateCategory({
					id: categoryData.id,
					name: categoryData.name,
					color: categoryData.color,
					icon: categoryData.icon,
				});
			} else {
				// Adding new category
				await addCategory(categoryData);
			}
			setIsEditorVisible(false);
		} catch (_error) {
			Alert.alert('Error', 'Failed to save category. Please try again.');
		}
	};

	const renderCategoryItem = ({ item }: { item: Category }) => (
		<View style={styles.categoryItem}>
			<View style={[styles.categoryIcon, { backgroundColor: item.color }]}>
				<Ionicons
					// biome-ignore lint/suspicious/noExplicitAny: external API shape unknown
					name={item.icon as any}
					size={22}
					color="#000000"
				/>
			</View>
			<View style={styles.categoryDetails}>
				<Text style={styles.categoryName}>{item.name}</Text>
			</View>
			<View style={styles.categoryActions}>
				<TouchableOpacity style={styles.actionButton} onPress={() => handleEditCategory(item)}>
					<Ionicons name="pencil" size={20} color="#15E8FE" />
				</TouchableOpacity>
				<TouchableOpacity style={styles.actionButton} onPress={() => handleDeleteCategory(item)}>
					<Ionicons name="trash-outline" size={20} color="#FF6B6B" />
				</TouchableOpacity>
			</View>
		</View>
	);

	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen
				options={{
					title: 'Manage Categories',
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<View style={styles.headerContainer}>
				<Text style={styles.headerTitle}>Category Management</Text>
				<Text style={styles.headerSubtitle}>
					Add, edit, or remove categories for your transactions
				</Text>
			</View>

			<FlatList
				data={categories}
				renderItem={renderCategoryItem}
				keyExtractor={(item) => item.id}
				contentContainerStyle={styles.categoryList}
				ListEmptyComponent={
					<View style={styles.emptyContainer}>
						<Text style={styles.emptyText}>No categories found</Text>
					</View>
				}
			/>

			<View style={styles.addButtonContainer}>
				<TouchableOpacity style={styles.addButton} onPress={handleAddCategory}>
					<Ionicons name="add" size={24} color="#000000" />
					<Text style={styles.addButtonText}>Add Category</Text>
				</TouchableOpacity>
			</View>

			<CategoryEditorModal
				isVisible={isEditorVisible}
				initialCategory={editingCategory}
				onSave={handleSaveCategory}
				onCancel={() => setIsEditorVisible(false)}
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
		paddingTop: 60,
	},
	headerContainer: {
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	headerTitle: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	headerSubtitle: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.7)',
	},
	categoryList: {
		padding: 16,
		paddingBottom: 80,
	},
	categoryItem: {
		flexDirection: 'row',
		alignItems: 'center',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 12,
	},
	categoryIcon: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: 12,
	},
	categoryDetails: {
		flex: 1,
	},
	categoryName: {
		fontSize: 16,
		color: '#FFFFFF',
		fontWeight: '500',
	},
	categoryActions: {
		flexDirection: 'row',
	},
	actionButton: {
		marginLeft: 12,
		padding: 8,
	},
	emptyContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
		marginTop: 60,
	},
	emptyText: {
		color: 'rgba(255, 255, 255, 0.6)',
		fontSize: 16,
	},
	addButtonContainer: {
		position: 'absolute',
		bottom: 0,
		left: 0,
		right: 0,
		padding: 16,
		backgroundColor: '#121212',
	},
	addButton: {
		backgroundColor: '#15E8FE',
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		paddingVertical: 16,
		borderRadius: 10,
	},
	addButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
		marginLeft: 8,
	},
});

export default CategoryManagementScreen;
