/**
 * O título do quadro do mês (E2E-43): com DEZEMBRO 2026 no seletor e hoje em novembro, o
 * card dizia "Este mês". "Este mês" só vale para o mês corrente; nos outros o título não
 * repete o nome do mês, que já está no seletor ao lado. As chaves de tradução aparecem cruas.
 */

const mockPeriod = { selectedMonth: 11, selectedYear: 2026 };
const mockLeftover = { cents: -58_000 };

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
			leftoverCents: mockLeftover.cents,
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
import { formatCents } from '../../utils/money';
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
	mockLeftover.cents = -58_000;
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

describe('SPD-161 — a cor do "Sobrou"', () => {
	/** A cor final do valor do "Sobrou" (o último estilo que define cor vale). */
	const leftoverColor = (cents: number): string | undefined => {
		mockLeftover.cents = cents;
		show(11, 2026);
		const box = renderer.root.find(
			(node) => (node.type as unknown) === 'View' && String(node.props.accessibilityLabel ?? '').startsWith('month.leftover,')
		);
		const value = box.find((node) => isHostText(node) && node.props.children === formatCents(cents));
		const styles = [value.props.style].flat(Number.POSITIVE_INFINITY).filter(Boolean) as Array<{ color?: string }>;
		return styles.reduce<string | undefined>((color, style) => style.color ?? color, undefined);
	};

	it('sobrou dinheiro: verde, como as receitas', () => {
		expect(leftoverColor(745_801)).toBe('#4CAF50');
	});

	it('R$ 0,00: branco', () => {
		expect(leftoverColor(0)).toBe('#FFFFFF');
	});

	it('gastou mais do que entrou: vermelho, como antes', () => {
		expect(leftoverColor(-58_000)).toBe('#FF6B6B');
	});
});
