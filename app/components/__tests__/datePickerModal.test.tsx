/**
 * O seletor de data do lançamento (E2E-14): abria rolado para o topo — janeiro, dia 1 —
 * com o mês e o dia escolhidos fora da vista, e todo em inglês ("Select Date", "Year",
 * "January"…). Agora abre com o ano, o mês e o dia escolhidos no meio de cada coluna, os
 * meses no idioma do app e os rótulos pelo i18n (chaves cruas aqui).
 */

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { ScrollView, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { configureDateLocale, getISODate } from '../../utils/dateUtils';
import DatePickerModal, { buildPickedDate, PICKER_ITEM_HEIGHT, PICKER_VIEWPORT_HEIGHT, pickerOffset, pickerYears } from '../DatePickerModal';

let renderer: ReactTestRenderer | null = null;

const render = async (value: Date, onConfirm = jest.fn(), onCancel = jest.fn()) => {
	await act(async () => {
		renderer = create(<DatePickerModal visible value={value} onConfirm={onConfirm} onCancel={onCancel} />);
	});
	// biome-ignore lint/style/noNonNullAssertion: acabou de ser criado
	return renderer!;
};

// `findAllByType` não aceita os componentes do React Native pelos tipos (duas cópias do
// `@types/react`); a comparação direta faz o mesmo.
const ofType = (scope: ReactTestInstance, type: unknown): ReactTestInstance[] =>
	scope.findAll((node) => (node.type as unknown) === type);

const textOf = (node: ReactTestInstance): string => {
	const children = node.props.children;
	const flat = Array.isArray(children) ? children : [children];
	return flat.filter((child) => typeof child === 'string' || typeof child === 'number').join('');
};

const column = (tree: ReactTestRenderer, testID: string): ReactTestInstance =>
	tree.root.find((node) => (node.type as unknown) === ScrollView && node.props.testID === testID);

const optionsIn = (scroll: ReactTestInstance): string[] => ofType(scroll, Text).map(textOf);

const pressText = async (scope: ReactTestInstance, text: string) => {
	const label = ofType(scope, Text).find((node) => textOf(node) === text);
	if (!label) throw new Error(`${text} não está na tela`);
	let node: ReactTestInstance | null = label;
	while (node && typeof node.props.onPress !== 'function') node = node.parent;
	if (!node) throw new Error(`${text} sem toque`);
	await act(async () => node.props.onPress());
};

beforeEach(() => {
	configureDateLocale('pt-BR');
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	configureDateLocale('en-US');
});

describe('pickerOffset', () => {
	it('põe a opção escolhida no meio da coluna, sem passar do topo', () => {
		expect(PICKER_ITEM_HEIGHT).toBe(44);
		expect(PICKER_VIEWPORT_HEIGHT).toBe(200);
		// Novembro é o índice 10: 10 × 44 − (200 − 44) / 2.
		expect(pickerOffset(10)).toBe(362);
		expect(pickerOffset(1)).toBe(0);
		expect(pickerOffset(0)).toBe(0);
	});
});

describe('pickerYears', () => {
	it('do ano atual até cinco anos antes', () => {
		expect(pickerYears(2026, 2026)).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
	});

	it('inclui o ano escolhido quando ele está fora da faixa (parcela do ano que vem)', () => {
		expect(pickerYears(2027, 2026)).toEqual([2027, 2026, 2025, 2024, 2023, 2022, 2021]);
		expect(pickerYears(2018, 2026)).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]);
	});
});

describe('buildPickedDate', () => {
	it('o dia fica preso ao tamanho do mês', () => {
		expect(getISODate(buildPickedDate(2026, 1, 31))).toBe('2026-02-28');
		expect(getISODate(buildPickedDate(2026, 3, 31))).toBe('2026-04-30');
	});
});

describe('DatePickerModal (E2E-14)', () => {
	it('abre com 7 de novembro de 2026 à vista', async () => {
		const tree = await render(new Date(2026, 10, 7));
		expect(column(tree, 'date-picker-month').props.contentOffset).toEqual({ x: 0, y: pickerOffset(10) });
		expect(column(tree, 'date-picker-day').props.contentOffset).toEqual({ x: 0, y: pickerOffset(6) });
		const years = optionsIn(column(tree, 'date-picker-year'));
		expect(column(tree, 'date-picker-year').props.contentOffset).toEqual({ x: 0, y: pickerOffset(years.indexOf('2026')) });
	});

	it('meses no idioma do app e rótulos traduzidos', async () => {
		const tree = await render(new Date(2026, 10, 7));
		const months = optionsIn(column(tree, 'date-picker-month'));
		expect(months).toEqual([
			'Janeiro',
			'Fevereiro',
			'Março',
			'Abril',
			'Maio',
			'Junho',
			'Julho',
			'Agosto',
			'Setembro',
			'Outubro',
			'Novembro',
			'Dezembro',
		]);
		const texts = ofType(tree.root, Text).map(textOf);
		for (const english of ['Select Date', 'Year', 'Month', 'Day', 'Cancel', 'Confirm', 'January', 'November']) {
			expect(texts).not.toContain(english);
		}
		for (const key of ['datePickerTitle', 'datePickerYear', 'datePickerMonth', 'datePickerDay', 'datePickerCancel', 'datePickerConfirm']) {
			expect(texts).toContain(`transactionForm.${key}`);
		}
	});

	it('em fevereiro só há os dias de fevereiro', async () => {
		const tree = await render(new Date(2026, 1, 10));
		const days = optionsIn(column(tree, 'date-picker-day'));
		expect(days).toHaveLength(28);
		expect(days[days.length - 1]).toBe('28');
	});

	it('confirmar devolve a data escolhida; cancelar não', async () => {
		const onConfirm = jest.fn();
		const onCancel = jest.fn();
		const tree = await render(new Date(2026, 10, 7), onConfirm, onCancel);

		await pressText(column(tree, 'date-picker-month'), 'Outubro');
		await pressText(column(tree, 'date-picker-day'), '31');
		await pressText(tree.root, 'transactionForm.datePickerConfirm');
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(getISODate(onConfirm.mock.calls[0][0])).toBe('2026-10-31');

		await pressText(tree.root, 'transactionForm.datePickerCancel');
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});
