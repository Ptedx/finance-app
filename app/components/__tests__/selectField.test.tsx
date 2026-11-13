/**
 * O campo que abre a lista (SPD-130): "olha o tanto de espaço que isso ocupa" — 11 bancos em
 * botões no cadastro do cartão. Agora o campo mostra só a escolha e a lista abre numa folha.
 *
 * Aqui: a lista só aparece ao tocar, escolher fecha e o campo mostra a escolhida, a linha
 * "Nenhuma" do campo opcional limpa, a seção do topo (`featured`), a busca da lista longa e a
 * acessibilidade (botão com o valor no rótulo, linhas `radio` com `selected`).
 */

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key}|${JSON.stringify(params)}` : key),
	}),
}));

import { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { filterSelectOptions, SEARCH_FROM, SelectField, type SelectOption } from '../SelectField';

jest.setTimeout(20_000);

const BANKS: SelectOption<string>[] = [
	{ value: 'nubank', label: 'Nubank', color: '#8A05BE' },
	{ value: 'inter', label: 'Inter', color: '#FF7A00' },
	{ value: 'c6', label: 'C6 Bank', color: '#242424' },
];

let renderer: ReactTestRenderer;
const root = () => renderer.root;

const textOf = (node: ReactTestInstance): string => {
	const children = node.props.children;
	const flat = Array.isArray(children) ? children : [children];
	return flat.filter((child) => typeof child === 'string').join('');
};
const texts = (): string[] => root().findAll((node) => (node.type as unknown) === Text).map(textOf);

const field = (): ReactTestInstance => {
	const [found] = root().findAll((node) => node.props.accessibilityRole === 'button' && node.props.testID === 'campo' && typeof node.props.onPress === 'function');
	if (!found) throw new Error('sem o campo');
	return found;
};

const rows = (): ReactTestInstance[] =>
	root().findAll((node) => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function');

const row = (label: string): ReactTestInstance => {
	const found = rows().find((node) => node.props.accessibilityLabel === label);
	if (!found) throw new Error(`sem a linha ${label}`);
	return found;
};

const tap = async (node: ReactTestInstance) => {
	await act(async () => {
		node.props.onPress();
	});
};

/** O campo com estado de verdade, como numa tela. */
interface HarnessProps {
	initial?: string | null;
	optional?: boolean;
	options?: SelectOption<string>[];
	featured?: string[];
	onChange?: (value: string | null) => void;
}

const Harness: React.FC<HarnessProps> = ({ initial = null, optional = false, options = BANKS, featured, onChange }) => {
	const [value, setValue] = useState<string | null>(initial);
	const set = (next: string | null) => {
		setValue(next);
		onChange?.(next);
	};
	return (
		<SelectField
			testID="campo"
			label="Banco"
			hint="Onde está o cartão"
			options={options}
			selected={value}
			onSelect={set}
			clearLabel={optional ? 'Nenhuma' : undefined}
			onClear={optional ? () => set(null) : undefined}
			featured={featured ? { title: 'Mais usadas', values: featured, restTitle: 'Todas' } : undefined}
		/>
	);
};

const mount = async (props: HarnessProps = {}) => {
	await act(async () => {
		renderer = create(<Harness {...props} />);
	});
};

afterEach(() => {
	act(() => renderer.unmount());
});

describe('SelectField', () => {
	it('fechado, mostra o rótulo e o convite; nenhuma opção na tela', async () => {
		await mount();
		expect(texts()).toContain('Banco');
		expect(texts()).toContain('select.placeholder');
		expect(rows()).toHaveLength(0);
		expect(texts()).not.toContain('Inter');
	});

	it('tocar abre a lista com todas as opções e o título do campo', async () => {
		await mount();
		await tap(field());
		expect(rows().map((node) => node.props.accessibilityLabel)).toEqual(['Nubank', 'Inter', 'C6 Bank']);
		const [group] = root().findAll((node) => node.props.accessibilityRole === 'radiogroup');
		expect(group.props.accessibilityLabel).toBe('Banco');
		expect(field().props.accessibilityState).toMatchObject({ expanded: true });
	});

	it('escolher fecha a lista e o campo mostra a escolhida', async () => {
		const onChange = jest.fn();
		await mount({ onChange });
		await tap(field());
		await tap(row('Inter'));
		expect(onChange).toHaveBeenCalledWith('inter');
		expect(rows()).toHaveLength(0);
		expect(texts()).toContain('Inter');
		expect(field().props.accessibilityLabel).toBe('Banco, Inter');
	});

	it('a escolhida aparece marcada ao abrir de novo', async () => {
		await mount({ initial: 'c6' });
		await tap(field());
		expect(rows().map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected])).toEqual([
			['Nubank', false],
			['Inter', false],
			['C6 Bank', true],
		]);
	});

	it('acessibilidade: o campo é botão com o nome e o valor, e a dica', async () => {
		await mount();
		expect(field().props.accessibilityLabel).toBe('Banco, select.placeholder');
		expect(field().props.accessibilityHint).toBe('Onde está o cartão');
	});

	it('campo opcional: a linha "Nenhuma" vem primeiro, escolhida quando nada está, e limpa', async () => {
		const onChange = jest.fn();
		await mount({ optional: true, initial: 'inter', onChange });
		await tap(field());
		expect(rows().map((node) => node.props.accessibilityLabel)).toEqual(['Nenhuma', 'Nubank', 'Inter', 'C6 Bank']);
		expect(row('Nenhuma').props.accessibilityState).toEqual({ selected: false });

		await tap(row('Nenhuma'));
		expect(onChange).toHaveBeenCalledWith(null);
		expect(rows()).toHaveLength(0);
		expect(field().props.accessibilityLabel).toBe('Banco, Nenhuma');

		await tap(field());
		expect(row('Nenhuma').props.accessibilityState).toEqual({ selected: true });
	});

	it('campo obrigatório não tem a linha de limpar', async () => {
		await mount();
		await tap(field());
		expect(rows().map((node) => node.props.accessibilityLabel)).not.toContain('Nenhuma');
	});

	it('seção do topo: as do topo primeiro, depois todas', async () => {
		await mount({ featured: ['c6', 'nubank'] });
		await tap(field());
		expect(rows().map((node) => node.props.accessibilityLabel)).toEqual(['C6 Bank', 'Nubank', 'Nubank', 'Inter', 'C6 Bank']);
		const headers = root()
			.findAll((node) => (node.type as unknown) === Text && node.props.accessibilityRole === 'header')
			.map(textOf);
		expect(headers).toEqual(expect.arrayContaining(['Mais usadas', 'Todas']));
	});

	it('lista curta não tem busca; lista longa tem, e filtra sem acento', async () => {
		await mount();
		await tap(field());
		expect(root().findAll((node) => (node.type as unknown) === TextInput)).toHaveLength(0);
		act(() => renderer.unmount());

		const many: SelectOption<string>[] = Array.from({ length: SEARCH_FROM + 1 }, (_, index) => ({
			value: `c${index}`,
			label: index === 3 ? 'Saúde' : `Categoria ${index}`,
		}));
		await mount({ options: many, featured: ['c0'] });
		await tap(field());
		const [search] = root().findAll((node) => (node.type as unknown) === TextInput);
		expect(search).toBeDefined();
		await act(async () => {
			search.props.onChangeText('saude');
		});
		// Buscando, a seção do topo some: só o que bate.
		expect(rows().map((node) => node.props.accessibilityLabel)).toEqual(['Saúde']);
		await act(async () => {
			search.props.onChangeText('xyz');
		});
		expect(rows()).toHaveLength(0);
		expect(texts()).toContain('select.noResults');
	});
});

describe('filterSelectOptions', () => {
	it('acha pelo nome e pela segunda linha, sem acento e sem maiúscula', () => {
		const options: SelectOption<string>[] = [
			{ value: 'a', label: 'Conta Corrente', description: 'Itaú' },
			{ value: 'b', label: 'Poupança' },
		];
		expect(filterSelectOptions(options, 'itau').map((option) => option.value)).toEqual(['a']);
		expect(filterSelectOptions(options, 'POUPANCA').map((option) => option.value)).toEqual(['b']);
		expect(filterSelectOptions(options, '  ').map((option) => option.value)).toEqual(['a', 'b']);
	});
});
