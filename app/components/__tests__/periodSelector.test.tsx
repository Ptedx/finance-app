/**
 * O seletor de mês da tela inicial (E2E-32): textos traduzidos, a lista abre com o mês
 * escolhido à vista e os anos vão até o seguinte (faturas e parcelas de janeiro). As
 * chaves de tradução aparecem cruas.
 */

const mockSetSelectedPeriod = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedMonth: 11, selectedYear: 2026, setSelectedPeriod: mockSetSelectedPeriod }),
}));

import { ScrollView } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { configureDateLocale } from '../../utils/dateUtils';
import PeriodSelector, { centeredOffset, yearOptions } from '../PeriodSelector';

jest.setTimeout(20_000);

describe('yearOptions', () => {
	it('vai do ano seguinte a cinco anos atrás, do mais novo para o mais velho', () => {
		expect(yearOptions(2026, 2026)).toEqual([2027, 2026, 2025, 2024, 2023, 2022, 2021]);
	});

	it('o ano escolhido entra mesmo fora da faixa', () => {
		expect(yearOptions(2026, 2028)[0]).toBe(2028);
		expect(yearOptions(2026, 2019).at(-1)).toBe(2019);
	});
});

describe('centeredOffset', () => {
	it('põe o item no meio da lista, sem rolar para antes do começo', () => {
		expect(centeredOffset(440, 44, 200)).toBe(362);
		expect(centeredOffset(0, 44, 200)).toBe(0);
	});
});

describe('PeriodSelector', () => {
	let renderer: ReactTestRenderer;

	const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
	const texts = (): string[] =>
		renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));
	const upTo = (label: string, prop: string): ReactTestInstance => {
		let target: ReactTestInstance | null = renderer.root.find((node) => isHostText(node) && [node.props.children].flat().join('') === label);
		while (target && !target.props[prop]) target = target.parent;
		if (!target) throw new Error(`nada com ${prop} em ${label}`);
		return target;
	};

	beforeEach(async () => {
		configureDateLocale('pt-BR');
		jest.clearAllMocks();
		await act(async () => {
			renderer = create(<PeriodSelector />);
		});
		await act(async () => {
			upTo('NOVEMBRO 2026', 'onPress').props.onPress();
		});
	});

	afterEach(() => {
		act(() => renderer.unmount());
		configureDateLocale('en-US');
	});

	it('não tem texto fixo em inglês', () => {
		for (const key of ['periodSelector.title', 'periodSelector.year', 'periodSelector.month', 'periodSelector.cancel', 'periodSelector.confirm']) {
			expect(texts()).toContain(key);
		}
		for (const english of ['Select Month', 'Year', 'Month', 'Cancel', 'Confirm']) {
			expect(texts()).not.toContain(english);
		}
	});

	it('lista o ano seguinte', () => {
		expect(texts()).toContain(String(new Date().getFullYear() + 1));
	});

	it('abre a lista de meses rolada até o mês escolhido', async () => {
		const item = upTo('novembro', 'onLayout');
		await act(async () => {
			item.props.onLayout({ nativeEvent: { layout: { x: 0, y: 440, width: 100, height: 44 } } });
		});
		const monthList = renderer.root.findAll((node) => node.type === (ScrollView as unknown))[1];
		expect(monthList.instance.scrollTo).toHaveBeenCalledWith({ y: 362, animated: false });
	});

	it('confirmar troca o período', async () => {
		await act(async () => {
			upTo('dezembro', 'onPress').props.onPress();
		});
		await act(async () => {
			upTo('periodSelector.confirm', 'onPress').props.onPress();
		});
		expect(mockSetSelectedPeriod).toHaveBeenCalledWith(12, 2026);
	});
});
