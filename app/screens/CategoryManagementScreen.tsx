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
import type { Category, CategoryDraft } from '../database/schema';

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

	/**
	 * Vira a natureza direto na lista, sem abrir o editor.
	 *
	 * Classificar dez categorias é o que habilita a visão 50/30/20, e obrigar a abrir,
	 * trocar e salvar dez vezes seria o suficiente para ninguém classificar nada.
	 */
	const handleToggleNature = async (category: Category) => {
		try {
			await updateCategory({
				id: category.id,
				name: category.name,
				color: category.color,
				icon: category.icon,
				type: category.type,
				nature: category.nature === 'essential' ? 'discretionary' : 'essential',
			});
		} catch (_error) {
			Alert.alert('Error', 'Failed to update category. Please try again.');
		}
	};

	const handleSaveCategory = async (categoryData: CategoryDraft & { id?: string }) => {
		try {
			if (categoryData.id) {
				// Editing existing category
				const { id, ...fields } = categoryData;
				await updateCategory({ id, ...fields });
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
				<View style={styles.badgeRow}>
					{/* Two categories can share a name across sides of the ledger, so the type
					    has to be visible here to tell them apart. */}
					<Text style={item.type === 'income' ? styles.incomeBadge : styles.expenseBadge}>
						{item.type === 'income' ? 'Income' : 'Expense'}
					</Text>

					{/* Income is neither a need nor a want, so the chip only exists on the
					    expense side. */}
					{item.type === 'expense' && (
						<TouchableOpacity
							style={[
								styles.natureChip,
								item.nature === 'essential' ? styles.essentialChip : styles.discretionaryChip,
							]}
							onPress={() => handleToggleNature(item)}
						>
							<Text
								style={[
									styles.natureChipText,
									item.nature === 'essential'
										? styles.essentialChipText
										: styles.discretionaryChipText,
								]}
							>
								{item.nature === 'essential' ? 'Essential' : 'Discretionary'}
							</Text>
						</TouchableOpacity>
					)}
				</View>
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
					Add, edit, or remove categories for your transactions. Tap an expense's
					essential/discretionary chip to split your spending into needs and wants.
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
	badgeRow: {
		flexDirection: 'row',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: 8,
	},
	incomeBadge: {
		fontSize: 11,
		color: '#4CAF50',
		marginTop: 2,
	},
	expenseBadge: {
		fontSize: 11,
		color: '#FF6B6B',
		marginTop: 2,
	},
	natureChip: {
		marginTop: 2,
		paddingHorizontal: 8,
		paddingVertical: 2,
		borderRadius: 10,
		borderWidth: 1,
	},
	// Essencial é o estado afirmado pelo usuário, então ele é o que ganha cor; supérfluo
	// é o padrão e fica discreto, para a lista não parecer um mar de alertas.
	essentialChip: {
		backgroundColor: 'rgba(21, 232, 254, 0.15)',
		borderColor: 'rgba(21, 232, 254, 0.5)',
	},
	discretionaryChip: {
		backgroundColor: 'transparent',
		borderColor: 'rgba(255, 255, 255, 0.2)',
	},
	natureChipText: {
		fontSize: 10,
		fontWeight: '600',
	},
	essentialChipText: {
		color: '#15E8FE',
	},
	discretionaryChipText: {
		color: 'rgba(255, 255, 255, 0.5)',
	},
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
