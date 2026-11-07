import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Alert,
	FlatList,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
// O `SafeAreaView` do react-native é só do iOS: no Android a tela ia para baixo da barra de
// status e o "Adicionar categoria", para baixo da barra de gestos.
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import CategoryEditorModal from '../components/CategoryEditorModal';
import { Button, ChipGroup } from '../components/cards/formParts';
import Sheet from '../components/cards/Sheet';
import ScreenTopBar from '../components/ScreenTopBar';
import { useTransactions } from '../contexts/TransactionsContext';
import { CATEGORY_NATURES, type Category, type CategoryDraft } from '../database/schema';

/** A categoria que recebe o que sobra quando outra é apagada; o banco recusa apagá-la. */
const UNCATEGORIZED_ID = 'uncategorized';

const CategoryManagementScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { categories, transactions, addCategory, updateCategory, deleteCategory } = useTransactions();
	const [isEditorVisible, setIsEditorVisible] = useState(false);
	const [editingCategory, setEditingCategory] = useState<Category | null>(null);
	// Categoria em uso sendo apagada: a folha pergunta para onde vão os lançamentos dela.
	const [deleting, setDeleting] = useState<{ category: Category; count: number } | null>(null);
	const [moveTarget, setMoveTarget] = useState<string | null>(null);

	const handleAddCategory = () => {
		setEditingCategory(null);
		setIsEditorVisible(true);
	};

	const handleEditCategory = (category: Category) => {
		setEditingCategory(category);
		setIsEditorVisible(true);
	};

	const runDelete = async (category: Category, moveTo?: string) => {
		try {
			await deleteCategory(category.id, moveTo);
			setDeleting(null);
		} catch (_error) {
			Alert.alert(t('categoryManagement.error'), t('categoryManagement.deleteFailed'));
		}
	};

	/**
	 * Apagar uma categoria sem lançamentos é só confirmar. Em uso, a tela diz quantos
	 * lançamentos a usam e pede para onde eles vão: antes, o alerta só perguntava "tem
	 * certeza" e a compra virava "Sem descrição · Uncategorized", perdendo o nome que vinha
	 * da categoria.
	 *
	 * Conta só os lançamentos (`transactions` do contexto são todos, não só os do mês).
	 */
	const handleDeleteCategory = (category: Category) => {
		const count = transactions.filter((tx) => tx.category === category.id).length;
		if (count > 0) {
			setMoveTarget(null);
			setDeleting({ category, count });
			return;
		}
		Alert.alert(
			t('categoryManagement.deleteTitle'),
			t('categoryManagement.deleteMessage', { name: category.name }),
			[
				{ text: t('categoryManagement.cancel'), style: 'cancel' },
				{
					text: t('categoryManagement.delete'),
					style: 'destructive',
					onPress: () => runDelete(category),
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
				nature: CATEGORY_NATURES[(CATEGORY_NATURES.indexOf(category.nature) + 1) % CATEGORY_NATURES.length],
			});
		} catch (_error) {
			Alert.alert(t('categoryManagement.error'), t('categoryManagement.updateFailed'));
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
			Alert.alert(t('categoryManagement.error'), t('categoryManagement.saveFailed'));
		}
	};

	// Para onde os lançamentos podem ir: outra categoria do mesmo tipo, nunca a própria.
	const moveOptions = deleting
		? categories
				.filter((c) => c.type === deleting.category.type && c.id !== deleting.category.id)
				.map((c) => ({ value: c.id, label: c.name, color: c.color }))
		: [];

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
						{item.type === 'income' ? t('categoryManagement.income') : t('categoryManagement.expense')}
					</Text>

					{/* Income is neither a need nor a want, so the chip only exists on the
					    expense side. */}
					{item.type === 'expense' && (
						<TouchableOpacity
							style={[
								styles.natureChip,
								item.nature === 'essential'
									? styles.essentialChip
									: item.nature === 'passthrough'
										? styles.passThroughChip
										: styles.discretionaryChip,
							]}
							onPress={() => handleToggleNature(item)}
							accessibilityRole="button"
							accessibilityLabel={t('categoryManagement.natureLabel', {
								name: item.name,
								nature: t(`categoryManagement.nature.${item.nature}`),
							})}
							accessibilityHint={t('categoryManagement.natureHint')}
						>
							<Text
								style={[
									styles.natureChipText,
									item.nature === 'essential'
										? styles.essentialChipText
										: item.nature === 'passthrough'
											? styles.passThroughChipText
											: styles.discretionaryChipText,
								]}
							>
								{t(`categoryManagement.nature.${item.nature}`)}
							</Text>
						</TouchableOpacity>
					)}
				</View>
			</View>
			<View style={styles.categoryActions}>
				<TouchableOpacity
					style={styles.actionButton}
					onPress={() => handleEditCategory(item)}
					accessibilityRole="button"
					accessibilityLabel={t('categoryManagement.editLabel', { name: item.name })}
				>
					<Ionicons name="pencil" size={20} color="#15E8FE" />
				</TouchableOpacity>
				{item.id !== UNCATEGORIZED_ID && (
					<TouchableOpacity
						style={styles.actionButton}
						onPress={() => handleDeleteCategory(item)}
						accessibilityRole="button"
						accessibilityLabel={t('categoryManagement.deleteLabel', { name: item.name })}
					>
						<Ionicons name="trash-outline" size={20} color="#FF6B6B" />
					</TouchableOpacity>
				)}
			</View>
		</View>
	);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen
				options={{
					title: t('categoryManagement.screenTitle'),
					headerStyle: {
						backgroundColor: '#1A1A1A',
					},
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			{/* A pilha da raiz não desenha cabeçalho: sem este, a tela não tinha voltar. */}
			<ScreenTopBar
				title={t('categoryManagement.title')}
				backLabel={t('categoryManagement.back')}
				onBack={() => router.back()}
			/>
			<View style={styles.headerContainer}>
				<Text style={styles.headerSubtitle}>{t('categoryManagement.subtitle')}</Text>
			</View>

			{/* O botão fica preso no pé, acima da barra de gestos; a lista rola até passar dele. */}
			<FlatList
				data={categories}
				renderItem={renderCategoryItem}
				keyExtractor={(item) => item.id}
				contentContainerStyle={[styles.categoryList, { paddingBottom: insets.bottom + 80 }]}
				ListEmptyComponent={
					<View style={styles.emptyContainer}>
						<Text style={styles.emptyText}>{t('categoryManagement.empty')}</Text>
					</View>
				}
			/>

			<View style={[styles.addButtonContainer, { paddingBottom: insets.bottom + 16 }]}>
				<TouchableOpacity style={styles.addButton} onPress={handleAddCategory} accessibilityRole="button">
					<Ionicons name="add" size={24} color="#000000" />
					<Text style={styles.addButtonText}>{t('categoryManagement.add')}</Text>
				</TouchableOpacity>
			</View>

			<CategoryEditorModal
				isVisible={isEditorVisible}
				initialCategory={editingCategory}
				onSave={handleSaveCategory}
				onCancel={() => setIsEditorVisible(false)}
			/>

			<Sheet
				visible={deleting !== null}
				onClose={() => setDeleting(null)}
				title={t('categoryManagement.deleteTitle')}
				subtitle={
					deleting
						? t('categoryManagement.deleteInUse', { count: deleting.count, name: deleting.category.name })
						: undefined
				}
			>
				{deleting && moveOptions.length > 0 ? (
					<>
						<ChipGroup
							label={t('categoryManagement.moveTo')}
							options={moveOptions}
							selected={moveTarget}
							onSelect={setMoveTarget}
						/>
						<Button
							label={t('categoryManagement.moveAndDelete')}
							icon="swap-horizontal"
							variant="danger"
							disabled={moveTarget === null}
							onPress={() => {
								if (moveTarget) runDelete(deleting.category, moveTarget);
							}}
						/>
					</>
				) : null}
				{deleting && moveOptions.length === 0 ? (
					<>
						{/* Sem outra categoria do mesmo tipo, o banco põe os lançamentos em "Sem
						    categoria", como antes; a tela diz isso em vez de travar o apagar. */}
						<Text style={styles.noTarget}>{t('categoryManagement.noTarget')}</Text>
						<Button
							label={t('categoryManagement.deleteAnyway')}
							icon="trash-outline"
							variant="danger"
							onPress={() => runDelete(deleting.category)}
						/>
					</>
				) : null}
				<Button label={t('categoryManagement.cancel')} variant="secondary" onPress={() => setDeleting(null)} />
			</Sheet>
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
	passThroughChip: {
		backgroundColor: 'rgba(255, 204, 92, 0.12)',
		borderColor: 'rgba(255, 204, 92, 0.5)',
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
	passThroughChipText: {
		color: '#FFCC5C',
	},
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	headerContainer: {
		paddingHorizontal: 16,
		paddingBottom: 12,
	},
	headerSubtitle: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.7)',
	},
	categoryList: {
		padding: 16,
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
	noTarget: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255, 255, 255, 0.85)',
	},
});

export default CategoryManagementScreen;
