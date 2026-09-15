import type { CategoryNature, CategoryType } from '@prisma/client';

export interface DefaultCategory {
	id: string;
	name: string;
	color: string;
	icon: string;
	type: CategoryType;
	/** Necessidade ou desejo. Só lida nas categorias de despesa. */
	nature: CategoryNature;
}

/**
 * Cópia fiel de `DEFAULT_CATEGORIES` em `app/database/schema.ts`.
 *
 * Os ids são fixos ('food', 'salary', ...) e precisam bater exatamente com os do app:
 * é isso que faz um lançamento criado offline em 'food' continuar válido depois que o
 * aparelho entra numa conta — sem remapear id nenhum. Cada usuário recebe sua própria
 * cópia dessas linhas no registro, então renomear ou apagar a sua não afeta ninguém.
 *
 * Ao mudar esta lista, mude a do app na mesma leva.
 */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
	// Despesas. `nature` espelha ESSENTIAL_DEFAULT_CATEGORY_IDS do app.
	{
		id: 'food',
		name: 'Food',
		color: '#50E3C2',
		icon: 'fast-food',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'transport',
		name: 'Transportation',
		color: '#5E5CE6',
		icon: 'car',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'entertainment',
		name: 'Entertainment',
		color: '#FF6B6B',
		icon: 'film',
		type: 'expense',
		nature: 'discretionary',
	},
	{
		id: 'shopping',
		name: 'Shopping',
		color: '#FFCC5C',
		icon: 'cart',
		type: 'expense',
		nature: 'discretionary',
	},
	{
		id: 'utilities',
		name: 'Utilities',
		color: '#4DACF7',
		icon: 'flash',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'health',
		name: 'Health',
		color: '#FF9FB1',
		icon: 'medical',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'education',
		name: 'Education',
		color: '#A78BFA',
		icon: 'school',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'other_expense',
		name: 'Other Expense',
		color: '#9CA3AF',
		icon: 'ellipsis-horizontal',
		type: 'expense',
		nature: 'discretionary',
	},

	// Receitas. `nature` vai junto por uniformidade e nunca é lida deste lado.
	{
		id: 'salary',
		name: 'Salary',
		color: '#4CAF50',
		icon: 'wallet',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'freelance',
		name: 'Freelance',
		color: '#15E8FE',
		icon: 'briefcase',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'investment',
		name: 'Investment',
		color: '#FFD166',
		icon: 'trending-up',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'gift',
		name: 'Gift',
		color: '#F78FB3',
		icon: 'gift',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'refund',
		name: 'Refund',
		color: '#7BDFF2',
		icon: 'return-down-back',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'other_income',
		name: 'Other Income',
		color: '#A0E7A0',
		icon: 'ellipsis-horizontal',
		type: 'income',
		nature: 'discretionary',
	},

	// Destino dos lançamentos cuja categoria foi apagada. Supérfluo porque uma despesa
	// sem classificação não pode virar necessidade em silêncio.
	{
		id: 'uncategorized',
		name: 'Uncategorized',
		color: '#9CA3AF',
		icon: 'help-circle',
		type: 'expense',
		nature: 'discretionary',
	},
];

/** Onde um lançamento cai quando sua categoria não existe (mais) no perfil. */
export const FALLBACK_CATEGORY_ID = 'uncategorized';
