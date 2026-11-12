/**
 * Filtros e troca de mês em Contas a pagar (SPD-142).
 *
 * A página mostra todas as contas do mês, com "Todas / A vencer / Atrasadas / Pagas" em cima
 * ("Todas" de partida), e as setas ‹ › trocam o mês: o total "Falta pagar" e a lista seguem o
 * mês escolhido. "Já paguei" e "Desfazer" gravam sempre o mês atual (`markPaid`/`undoPaid`),
 * então só aparecem nele.
 *
 * O contexto é dublê com as regras de verdade (`monthBills`); as chaves de tradução aparecem
 * cruas, com os valores entre chaves. Os nomes dos meses saem em inglês (o locale de datas
 * padrão dos testes).
 */

import type { Bill } from '../../database/schema';

const mockState: { bills: Bill[]; today: string } = { bills: [], today: '2026-11-11' };

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
	}),
}));

jest.mock('../../components/bills/BillStatusPill', () => {
	const { Text } = require('react-native');
	return ({ status }: { status: string }) => <Text>{`pill:${status}`}</Text>;
});

jest.mock('../../contexts/BillsContext', () => {
	const { monthBills } = jest.requireActual('../../utils/billRules');
	return {
		markPaidTransactionId: (id: string, month: string) => `lancamento-${id}-${month}`,
		useBills: () => ({
			bills: mockState.bills,
			activeBills: mockState.bills.filter((bill) => bill.active),
			month: monthBills(mockState.bills, mockState.today),
			today: mockState.today,
			isLoading: false,
			planPayment: jest.fn(),
			markPaid: jest.fn(),
			undoPaid: jest.fn(),
		}),
	};
});

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: [] }),
}));

import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { formatCents } from '../../utils/money';
import BillsScreen from '../BillsScreen';

jest.setTimeout(20_000);

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'plano',
	name: 'Plano de saúde',
	dueDay: 10,
	amountCents: 50_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: '2026-10',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<BillsScreen />);
	});
};

const texts = (): string[] =>
	renderer.root
		.findAll((node: ReactTestInstance) => (node.type as unknown) === Text)
		.map((node) => [node.props.children].flat().join(''));

/** Toca no que tem este rótulo de acessibilidade. */
const pressLabel = async (label: string) => {
	const target = renderer.root.find(
		(node: ReactTestInstance) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
	);
	await act(async () => {
		target.props.onPress();
	});
};

const shownBills = () => {
	const names = ['Atrasada', 'Hoje', 'Depois', 'Paga'];
	return texts().filter((text) => names.includes(text));
};

beforeEach(() => {
	mockState.today = '2026-11-11';
	mockState.bills = [
		bill({ id: 'atrasada', name: 'Atrasada', dueDay: 5, amountCents: 10_000, paidThrough: '2026-10' }),
		bill({ id: 'hoje', name: 'Hoje', dueDay: 11, amountCents: 20_000, paidThrough: '2026-10' }),
		bill({ id: 'depois', name: 'Depois', dueDay: 20, amountCents: 30_000, paidThrough: '2026-10' }),
		bill({ id: 'paga', name: 'Paga', dueDay: 1, amountCents: 40_000, paidThrough: '2026-11' }),
	];
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
});

describe('filtros', () => {
	it('"Todas" é o padrão e mostra todas', async () => {
		await mount();
		const all = renderer.root.find(
			(node: ReactTestInstance) =>
				typeof node.props.onPress === 'function' &&
				node.props.accessibilityRole === 'radio' &&
				node.props.accessibilityLabel === 'bills.filter.all'
		);
		expect(all.props.accessibilityState).toEqual({ selected: true });
		expect(shownBills()).toEqual(['Paga', 'Atrasada', 'Hoje', 'Depois']);
	});

	it('A vencer: a de hoje e a de depois', async () => {
		await mount();
		await pressLabel('bills.filter.upcoming');
		expect(shownBills()).toEqual(['Hoje', 'Depois']);
	});

	it('Atrasadas', async () => {
		await mount();
		await pressLabel('bills.filter.late');
		expect(shownBills()).toEqual(['Atrasada']);
	});

	it('Pagas', async () => {
		await mount();
		await pressLabel('bills.filter.paid');
		expect(shownBills()).toEqual(['Paga']);
	});

	it('filtro sem nenhuma conta: diz que não há', async () => {
		mockState.bills = mockState.bills.filter((item) => item.id !== 'paga');
		await mount();
		await pressLabel('bills.filter.paid');
		expect(shownBills()).toEqual([]);
		expect(texts()).toContain('bills.filter.empty');
	});

	it('o total não muda com o filtro: é o do mês', async () => {
		await mount();
		await pressLabel('bills.filter.paid');
		expect(texts()).toContain(formatCents(10_000 + 20_000 + 30_000));
	});
});

describe('troca de mês', () => {
	it('mostra o mês atual de partida, com "Já paguei"', async () => {
		await mount();
		expect(texts()).toContain('November 2026');
		expect(texts()).toContain('bills.toPay');
		expect(texts()).toContain('bills.markPaid');
	});

	it('‹ volta para outubro: status e total de outubro; "Desfazer" só onde outubro é o último mês pago', async () => {
		await mount();
		await pressLabel('bills.monthNav.previous');
		const shown = texts();
		expect(shown).toContain('October 2026');
		expect(shown).toContain('bills.toPayIn{"month":"October"}');
		// Todas estão pagas até outubro, pelo menos.
		expect(shown.filter((text) => text.startsWith('pill:'))).toEqual(['pill:paid', 'pill:paid', 'pill:paid', 'pill:paid']);
		expect(shown).toContain('bills.allPaidIn{"month":"October"}');
		expect(shown).not.toContain('bills.markPaid');
		// SPD-145: as três pagas só até outubro podem reabrir outubro; a paga até novembro, não.
		expect(shown.filter((text) => text === 'bills.undoPaid')).toHaveLength(3);
		expect(shown).toContain('bills.otherMonthNote');
	});

	it('mês anterior com conta em aberto: aparece atrasada e entra no total', async () => {
		mockState.bills = [bill({ id: 'velha', name: 'Atrasada', dueDay: 5, amountCents: 10_000, paidThrough: '2026-09' })];
		await mount();
		await pressLabel('bills.monthNav.previous');
		const shown = texts();
		expect(shown).toContain('pill:late');
		expect(shown).toContain(formatCents(10_000));
	});

	it('SPD-145: em outubro, "Já paguei" só na conta cujo mês mais antigo em aberto é outubro', async () => {
		mockState.bills = [
			bill({ id: 'velha', name: 'Atrasada', dueDay: 5, amountCents: 10_000, paidThrough: '2026-09' }),
			bill({ id: 'antiga', name: 'Depois', dueDay: 20, amountCents: 30_000, paidThrough: '2026-08' }),
		];
		await mount();
		await pressLabel('bills.monthNav.previous');
		const shown = texts();
		expect(shown.filter((text) => text === 'bills.markPaid')).toHaveLength(1);
		// A de setembro em aberto não tem ação em outubro: diz para quitar setembro antes.
		expect(shown).toContain('bills.payOlderFirst{"month":"September"}');
	});

	it('SPD-145: no mês atual, o atraso de meses anteriores aparece à parte e leva ao mês mais antigo', async () => {
		mockState.bills = [
			bill({ id: 'velha', name: 'Atrasada', dueDay: 5, amountCents: 10_000, paidThrough: '2026-09' }),
			bill({ id: 'depois', name: 'Depois', dueDay: 20, amountCents: 30_000, paidThrough: '2026-10' }),
		];
		await mount();
		const shown = texts();
		// "Falta pagar este mês" é só novembro.
		expect(shown).toContain(formatCents(10_000 + 30_000));
		const overdue = shown.find((text) => text.startsWith('bills.overdueNote'));
		expect(overdue).toContain(formatCents(10_000));
		const target = renderer.root.find(
			(node: ReactTestInstance) =>
				typeof node.props.onPress === 'function' && node.props.accessibilityHint === 'bills.overdueOpen'
		);
		await act(async () => {
			target.props.onPress();
		});
		expect(texts()).toContain('October 2026');
	});

	it('SPD-145: volta no máximo 3 meses', async () => {
		await mount();
		await pressLabel('bills.monthNav.previous');
		await pressLabel('bills.monthNav.previous');
		await pressLabel('bills.monthNav.previous');
		expect(texts()).toContain('August 2026');
		const previous = renderer.root.find(
			(node: ReactTestInstance) =>
				typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'bills.monthNav.previous'
		);
		expect(previous.props.disabled).toBe(true);
		await pressLabel('bills.monthNav.previous');
		expect(texts()).toContain('August 2026');
	});

	it('› vai para dezembro: tudo a vencer, total de dezembro', async () => {
		await mount();
		await pressLabel('bills.monthNav.next');
		const shown = texts();
		expect(shown).toContain('December 2026');
		expect(shown.filter((text) => text.startsWith('pill:'))).toEqual([
			'pill:upcoming',
			'pill:upcoming',
			'pill:upcoming',
			'pill:upcoming',
		]);
		expect(shown).toContain(formatCents(10_000 + 20_000 + 30_000 + 40_000));
		expect(shown).not.toContain('bills.markPaid');
	});

	it('o filtro vale no mês escolhido', async () => {
		await mount();
		await pressLabel('bills.monthNav.next');
		await pressLabel('bills.filter.late');
		expect(shownBills()).toEqual([]);
		await pressLabel('bills.filter.upcoming');
		expect(shownBills()).toEqual(['Paga', 'Atrasada', 'Hoje', 'Depois']);
	});

	it('de outro mês, tocar no nome do mês volta ao atual', async () => {
		await mount();
		await pressLabel('bills.monthNav.next');
		await pressLabel('bills.monthNav.next');
		expect(texts()).toContain('January 2027');
		await pressLabel('bills.monthNav.current');
		expect(texts()).toContain('November 2026');
		expect(texts()).toContain('bills.markPaid');
	});
});
