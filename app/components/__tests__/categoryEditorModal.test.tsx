/**
 * O editor de categoria em português (E2E-33): título, campos, tipo, natureza, cor, ícone
 * e botões vinham fixos em inglês. O `t` daqui resolve no português de verdade, então o
 * teste também falha se a chave não existir.
 */

import pt from '../../i18n/locales/pt';

/** `t` mínimo: busca a chave no português e interpola `{{assim}}`, como o i18next. */
const mockT = (key: string, options: Record<string, unknown> = {}): string => {
	const found = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pt as unknown);
	if (typeof found !== 'string') throw new Error(`chave de tradução ausente: ${key}`);
	return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
};

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: mockT }),
}));

import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Category } from '../../database/schema';
import CategoryEditorModal from '../CategoryEditorModal';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
const onSave = jest.fn();

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const texts = (): string[] =>
	renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

const SHOPPING: Category = {
	id: 'shopping',
	name: 'Compras',
	color: '#50E3C2',
	icon: 'cart',
	type: 'expense',
	nature: 'discretionary',
	updatedAt: '2026-11-07T12:00:00.000Z',
};

const render = async (initialCategory: Category | null) => {
	await act(async () => {
		renderer = create(
			<CategoryEditorModal isVisible initialCategory={initialCategory} onSave={onSave} onCancel={jest.fn()} />
		);
	});
};

beforeEach(() => {
	jest.clearAllMocks();
});

afterEach(() => {
	act(() => renderer.unmount());
});

it('editar: tudo em português, sem o texto fixo em inglês', async () => {
	await render(SHOPPING);
	const shown = texts();
	for (const text of ['Editar categoria', 'Nome da categoria', 'Tipo', 'Despesa', 'Receita', 'Natureza', 'Essencial', 'Supérfluo', 'Repasse', 'Cor', 'Ícone', 'Cancelar', 'Atualizar']) {
		expect(shown).toContain(text);
	}
	expect(shown).toContain(pt.categoryManagement.editor.natureHelp);
	for (const english of ['Edit Category', 'Category Name', 'Type', 'Expense', 'Income', 'Nature', 'Essential', 'Discretionary', 'Pass-through', 'Select Color', 'Select Icon', 'Cancel', 'Update']) {
		expect(shown).not.toContain(english);
	}
	const input = renderer.root.find((node) => (node.type as unknown) === 'TextInput');
	expect(input.props.placeholder).toBe('Digite o nome da categoria');
	expect(input.props.accessibilityLabel).toBe('Nome da categoria');
});

it('nova categoria: título e botão de salvar em português', async () => {
	await render(null);
	expect(texts()).toContain('Nova categoria');
	expect(texts()).toContain('Salvar');
	expect(texts()).not.toContain('Add New Category');
	expect(texts()).not.toContain('Save');
});

it('nome vazio: o alerta é em português', async () => {
	await render(null);
	const save = renderer.root.find((node) => isHostText(node) && node.props.children === 'Salvar');
	let target: ReactTestInstance | null = save;
	while (target && !target.props.onPress) target = target.parent;
	await act(async () => {
		target?.props.onPress();
	});
	expect(alertSpy).toHaveBeenCalledWith('Nome inválido', 'Digite um nome para a categoria.');
	expect(onSave).not.toHaveBeenCalled();
});
