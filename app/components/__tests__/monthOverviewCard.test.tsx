/**
 * O título do quadro do mês (E2E-43): com DEZEMBRO 2026 no seletor e hoje em novembro, o
 * card dizia "Este mês". "Este mês" só vale para o mês corrente; nos outros o título não
 * repete o nome do mês, que já está no seletor ao lado. As chaves de tradução aparecem cruas.
 */

const mockPeriod = { selectedMonth: 11, selectedYear: 2026 };

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => mockPeriod,
}));

// Valores de dezembro do achado: Nubank R$ 500 + Inter R$ 80 = R$ 580; orçamento R$ 5.000.
jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		month: {
			incomeCents: 0,
			totalSpendCents: 58_000,
			mainSpendCents: 0,
			cards: [],
			envelopes: [],
			savedCents: 0,
			yieldCents: 0,
			leftoverCents: -58_000,
			savingsRateBp: null,
		},
		provisionalMonth: null,
	}),
}));

jest.mock('../../contexts/BudgetContext', () => ({
	useBudget: () => ({ currentBudgetCents: 500_000 }),
}));

jest.mock('../PeriodSelector', () => () => null);
jest.mock('../BudgetEditor', () => () => null);

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import MonthOverviewCard from '../MonthOverviewCard';

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

/** O texto do cabeçalho do card. */
const title = (): string => {
	const header = renderer.root.find((node) => isHostText(node) && node.props.accessibilityRole === 'header');
	return [header.props.children].flat().join('');
};

const show = (month: number, year: number) => {
	mockPeriod.selectedMonth = month;
	mockPeriod.selectedYear = year;
	act(() => {
		renderer = create(<MonthOverviewCard />);
	});
};

beforeEach(() => {
	// Hoje: 7 de novembro de 2026, meio-dia no fuso local.
	jest.useFakeTimers({ now: new Date(2026, 10, 7, 12) });
});

afterEach(() => {
	act(() => renderer.unmount());
	jest.useRealTimers();
});

describe('E2E-43 — título do quadro do mês', () => {
	it('no mês corrente, "Este mês"', () => {
		show(11, 2026);
		expect(title()).toBe('month.title');
	});

	it('com DEZEMBRO 2026 no seletor, não diz "Este mês"', () => {
		show(12, 2026);
		expect(title()).toBe('month.otherTitle');
	});

	it('mês passado também não', () => {
		show(10, 2026);
		expect(title()).toBe('month.otherTitle');
	});

	it('o mesmo mês de outro ano não é o mês corrente', () => {
		show(11, 2025);
		expect(title()).toBe('month.otherTitle');
	});
});
