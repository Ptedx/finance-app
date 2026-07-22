import type { Category } from '../../database/schema';
import { categoryPickerPropsAreEqual } from '../CategoryPicker';

const category = (overrides: Partial<Category> = {}): Category => ({
	id: 'food',
	name: 'Food',
	color: '#50E3C2',
	icon: 'fast-food',
	type: 'expense',
	...overrides,
});

const props = (overrides: Partial<Parameters<typeof categoryPickerPropsAreEqual>[0]> = {}) => ({
	categories: [category()],
	selectedCategoryId: null,
	onSelectCategory: () => {},
	isIncome: false,
	...overrides,
});

describe('categoryPickerPropsAreEqual', () => {
	it('allows skipping a render when nothing visible changed', () => {
		expect(categoryPickerPropsAreEqual(props(), props())).toBe(true);
	});

	// Regression: the comparator ignored `isIncome`, so toggling a transaction from
	// expense to income reported "no change" and the expense categories stayed listed.
	it('forces a render when the transaction type flips', () => {
		expect(categoryPickerPropsAreEqual(props({ isIncome: false }), props({ isIncome: true }))).toBe(
			false
		);
	});

	it('forces a render when the selection changes', () => {
		expect(
			categoryPickerPropsAreEqual(
				props({ selectedCategoryId: null }),
				props({ selectedCategoryId: 'food' })
			)
		).toBe(false);
	});

	it('forces a render when a category is added or removed', () => {
		expect(
			categoryPickerPropsAreEqual(
				props({ categories: [category()] }),
				props({ categories: [category(), category({ id: 'transport', name: 'Transport' })] })
			)
		).toBe(false);
	});

	// The old comparator only hashed ids, so editing a category's name, colour or icon
	// left the picker showing the previous values.
	it.each([
		['name', { name: 'Groceries' }],
		['color', { color: '#FF0000' }],
		['icon', { icon: 'cart' }],
		['type', { type: 'income' as const }],
	])('forces a render when a category %s changes', (_field, change) => {
		expect(
			categoryPickerPropsAreEqual(
				props({ categories: [category()] }),
				props({ categories: [category(change)] })
			)
		).toBe(false);
	});

	it('ignores the callback identity, which is a new closure every render', () => {
		expect(
			categoryPickerPropsAreEqual(
				props({ onSelectCategory: () => {} }),
				props({ onSelectCategory: () => {} })
			)
		).toBe(true);
	});
});
