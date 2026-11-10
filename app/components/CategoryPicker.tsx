import type { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Category, Transaction } from '../database/schema';
import { mostUsedCategoryIds } from '../utils/categoryUsage';
import { type SelectFeatured, SelectField, type SelectOption } from './SelectField';

/**
 * A categoria do lançamento: um campo que abre a lista (`SelectField`, SPD-130). Era uma
 * grade de duas colunas com ícone que ocupava a tela inteira com as categorias padrão.
 *
 * A lista começa pelas 4 mais usadas do lado do lançamento (despesa ou receita), na seção
 * "Mais usadas", e segue com todas na ordem de sempre. Sem histórico, só a lista. O
 * "Editar categorias" continua ao lado do rótulo.
 */

interface CategoryPickerProps {
	categories: Category[];
	selectedCategoryId: string | null;
	onSelectCategory: (categoryId: string) => void;
	isIncome?: boolean;
	/** Os lançamentos, para as "Mais usadas". Sem eles, a lista vem sem o topo. */
	transactions?: Transaction[];
	error?: string;
}

/**
 * As categorias do lado do lançamento como opções de lista, e as mais usadas delas. Só as do
 * lado que se lança (uma despesa não vai para "Salário"), sem "Sem categoria".
 */
export const categoryChoices = (
	categories: Category[],
	isIncome: boolean,
	transactions: readonly Transaction[] = []
): { options: SelectOption<string>[]; mostUsed: string[] } => {
	const wanted = isIncome ? 'income' : 'expense';
	const offered = categories.filter((category) => category.id !== 'uncategorized' && category.type === wanted);
	return {
		options: offered.map((category) => ({
			value: category.id,
			label: category.name,
			color: category.color,
			icon: category.icon as React.ComponentProps<typeof Ionicons>['name'],
		})),
		mostUsed: mostUsedCategoryIds(transactions, offered, isIncome),
	};
};

/** A seção "Mais usadas", ou nada quando não há histórico. */
export const mostUsedSection = (mostUsed: string[], t: (key: string) => string): SelectFeatured<string> | undefined =>
	mostUsed.length > 0
		? { title: t('transactionForm.categoryMostUsed'), values: mostUsed, restTitle: t('transactionForm.categoryAll') }
		: undefined;

const CategoryPicker: React.FC<CategoryPickerProps> = ({
	categories,
	selectedCategoryId,
	onSelectCategory,
	isIncome = false,
	transactions,
	error,
}) => {
	const { t } = useTranslation();
	const router = useRouter();

	const { options, mostUsed } = useMemo(
		() => categoryChoices(categories, isIncome, transactions),
		[categories, isIncome, transactions]
	);

	const handleEditCategories = useCallback(() => {
		router.push('/screens/CategoryManagementScreen');
	}, [router]);

	return (
		<View style={styles.container}>
			<SelectField
				label={t('transactionForm.category')}
				placeholder={t('transactionForm.categoryPlaceholder')}
				options={options}
				selected={selectedCategoryId}
				onSelect={onSelectCategory}
				featured={mostUsedSection(mostUsed, t)}
				error={error}
				labelAccessory={
					<TouchableOpacity
						style={styles.editButton}
						onPress={handleEditCategories}
						accessibilityRole="button"
						accessibilityLabel={t('transactionForm.editCategories')}
					>
						<Text style={styles.editButtonText}>{t('transactionForm.editCategories')}</Text>
					</TouchableOpacity>
				}
			/>
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		marginVertical: 16,
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
});

/**
 * Decides when the picker may skip a re-render.
 *
 * Every prop that affects what is drawn has to be compared here. `isIncome` was missing:
 * flipping the transaction type changed which categories should be listed, the
 * comparator reported "no change", and the previous type's categories stayed on screen.
 * Category fields are compared too, so renaming or recolouring one is reflected.
 *
 * `onSelectCategory` is deliberately not compared — it is a fresh closure on every
 * render of the parent, which would defeat the memo entirely. That is only safe because
 * the callback is wrapped in `useCallback` with no captured state; if it ever closes
 * over changing values again, this comparator will serve it stale.
 */
export const categoryPickerPropsAreEqual = (
	prevProps: CategoryPickerProps,
	nextProps: CategoryPickerProps
): boolean => {
	if (prevProps.selectedCategoryId !== nextProps.selectedCategoryId) return false;
	if (prevProps.isIncome !== nextProps.isIncome) return false;
	if (prevProps.error !== nextProps.error) return false;
	// A lista de lançamentos troca de identidade só quando muda: as "Mais usadas" seguem.
	if (prevProps.transactions !== nextProps.transactions) return false;
	if (prevProps.categories.length !== nextProps.categories.length) return false;

	return prevProps.categories.every((category, index) => {
		const other = nextProps.categories[index];
		return (
			category.id === other.id &&
			category.name === other.name &&
			category.color === other.color &&
			category.icon === other.icon &&
			category.type === other.type
		);
	});
};

export default memo(CategoryPicker, categoryPickerPropsAreEqual);
