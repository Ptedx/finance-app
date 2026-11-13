/**
 * "Contas do mês" enxuto na tela inicial (SPD-142).
 *
 * Antes o card listava todas as contas do mês e ocupava muito espaço. Agora: só as atrasadas
 * e as que vencem nos próximos 7 dias, no máximo 3 (e "e mais N"), com "Falta pagar este mês"
 * embaixo; sem nada para os próximos 7 dias, uma linha só ("Nada vence nos próximos 7 dias ·
 * Falta pagar R$ 1.500,00"); sem nenhuma conta, uma linha com "Cadastrar". O card continua
 * sendo um botão para Contas a pagar.
 *
 * O contexto é dublê com as regras de verdade (`monthBills`); as chaves de tradução aparecem
 * cruas, com os valores entre chaves.
 */

import type { Bill, BillPayment } from '../../../database/schema';

const mockPush = jest.fn();
const mockState: { bills: Bill[]; payments: BillPayment[]; today: string } = {
	bills: [],
	payments: [],
	today: '2026-11-11',
};

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
	}),
}));

jest.mock('../BillStatusPill', () => () => null);

jest.mock('../../../contexts/BillsContext', () => {
	const { monthBills } = jest.requireActual('../../../utils/billRules');
	return {
		useBills: () => {
			const activeBills = mockState.bills.filter((bill) => bill.active);
			return {
				bills: mockState.bills,
				activeBills,
				payments: mockState.payments,
				month: monthBills(mockState.bills, mockState.today, mockState.payments),
				today: mockState.today,
				isLoading: false,
			};
		},
	};
});

import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { formatCents } from '../../../utils/money';
import BillsMonthCard from '../BillsMonthCard';

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
		renderer = create(<BillsMonthCard />);
	});
};

const texts = (): string[] =>
	renderer.root
		.findAll((node: ReactTestInstance) => (node.type as unknown) === Text)
		.map((node) => [node.props.children].flat().join(''));

/** O botão de fora: o card inteiro (ou a linha com "Cadastrar"). */
const pressables = () =>
	renderer.root.findAll(
		(node: ReactTestInstance) => typeof node.props.onPress === 'function' && node.props.accessibilityRole === 'button'
	);

beforeEach(() => {
	mockPush.mockClear();
	mockState.today = '2026-11-11';
	mockState.payments = [];
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
});

describe('com contas para os próximos 7 dias', () => {
	beforeEach(() => {
		mockState.bills = [
			bill({ id: 'longe', name: 'Longe', dueDay: 25, amountCents: 100_000 }),
			bill({ id: 'paga', name: 'Paga', dueDay: 12, paidThrough: '2026-11' }),
			bill({ id: 'a', name: 'Internet', dueDay: 12, amountCents: 10_000 }),
			bill({ id: 'b', name: 'Luz', dueDay: 13, amountCents: 20_000 }),
			bill({ id: 'c', name: 'Celular', dueDay: 14, amountCents: null }),
			bill({ id: 'd', name: 'Financiamento', dueDay: 5, amountCents: 30_000, debtId: 'fin' }),
			bill({ id: 'e', name: 'Escola', dueDay: 15, amountCents: 40_000 }),
		];
	});

	it('mostra só 3, atrasada primeiro, e "e mais N"', async () => {
		await mount();
		const shown = texts();
		expect(shown).toContain('Financiamento');
		expect(shown).toContain('Internet');
		expect(shown).toContain('Luz');
		expect(shown).not.toContain('Celular');
		expect(shown).not.toContain('Escola');
		expect(shown).not.toContain('Longe');
		expect(shown).not.toContain('Paga');
		expect(shown).toContain('bills.home.more{"count":2}');
		expect(shown.indexOf('Financiamento')).toBeLessThan(shown.indexOf('Internet'));
	});

	it('a conta de dívida diz "Dívida"', async () => {
		await mount();
		expect(texts().some((text) => text.includes('bills.fromDebt'))).toBe(true);
	});

	it('embaixo, "Falta pagar este mês" com o total do mês inteiro', async () => {
		await mount();
		const shown = texts();
		expect(shown).toContain('bills.toPay');
		expect(shown).toContain(formatCents(100_000 + 10_000 + 20_000 + 30_000 + 40_000));
	});

	it('o card é um botão para Contas a pagar, com rótulo que resume o que está nele', async () => {
		await mount();
		const [card] = pressables();
		const label = card.props.accessibilityLabel as string;
		expect(label).toContain('Financiamento');
		expect(label).toContain('Luz');
		expect(label).toContain('bills.home.more{"count":2}');
		expect(label).toContain(formatCents(200_000));
		await act(async () => {
			card.props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith('/bills');
	});

	it('virada do mês: hoje 28/11, a do dia 3 já paga em novembro aparece com 03/12', async () => {
		mockState.today = '2026-11-28';
		mockState.bills = [bill({ id: 'dia3', name: 'Aluguel', dueDay: 3, paidThrough: '2026-11' })];
		await mount();
		const shown = texts();
		expect(shown).toContain('Aluguel');
		expect(shown.some((text) => text.includes('03/12') || text.includes('12/03'))).toBe(true);
	});
});

/**
 * SPD-145: outubro em aberto e hoje 11/11. Antes a tela inicial só olhava novembro: o atraso
 * de outubro não aparecia em lugar nenhum.
 */
describe('conta de mês passado em aberto', () => {
	beforeEach(() => {
		mockState.bills = [
			bill({ id: 'plano', name: 'Plano', dueDay: 10, amountCents: 50_000, paidThrough: '2026-09' }),
			bill({ id: 'longe', name: 'Longe', dueDay: 25, amountCents: 100_000 }),
		];
	});

	it('"Em atraso" numa linha à parte, com o valor e quantas contas', async () => {
		await mount();
		const shown = texts();
		expect(shown).toContain('bills.home.overdue');
		expect(shown).toContain('bills.home.overdueBills{"count":1}');
		const overdueAt = shown.indexOf('bills.home.overdue');
		expect(shown[overdueAt + 1]).toBe(formatCents(50_000));
	});

	it('"Falta pagar este mês" não soma o atraso: é só novembro', async () => {
		await mount();
		const shown = texts();
		expect(shown).toContain('bills.toPay');
		expect(shown).toContain(formatCents(50_000 + 100_000));
		expect(shown).not.toContain(formatCents(100_000 + 100_000));
	});

	it('a de outubro entra na lista como atrasada, com a data de outubro', async () => {
		await mount();
		const shown = texts();
		expect(shown).toContain('Plano');
		expect(shown.some((text) => text.includes('10/10'))).toBe(true);
	});

	it('o rótulo do card diz o atraso, e tocar abre Contas a pagar', async () => {
		await mount();
		const [card] = pressables();
		expect(card.props.accessibilityLabel).toContain('bills.home.overdue');
		expect(card.props.accessibilityLabel).toContain(formatCents(50_000));
		await act(async () => {
			card.props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith('/bills');
	});

	it('valor que varia em atraso: a linha aparece sem somar', async () => {
		mockState.bills = [bill({ id: 'celular', name: 'Celular', dueDay: 15, amountCents: null, paidThrough: '2026-09' })];
		await mount();
		const shown = texts();
		const overdueAt = shown.indexOf('bills.home.overdue');
		expect(overdueAt).toBeGreaterThanOrEqual(0);
		expect(shown[overdueAt + 1]).toBe('bills.variable');
	});

	it('sem atraso, sem a linha', async () => {
		mockState.bills = [bill({ id: 'plano', name: 'Plano', dueDay: 12, paidThrough: '2026-10' })];
		await mount();
		expect(texts()).not.toContain('bills.home.overdue');
	});
});

describe('nada vencendo em 7 dias e nada atrasado', () => {
	it('vira uma linha: "Nada vence nos próximos 7 dias · Falta pagar R$ 1.500,00"', async () => {
		mockState.bills = [
			bill({ id: 'longe', name: 'Longe', dueDay: 25, amountCents: 150_000 }),
			bill({ id: 'paga', name: 'Paga', dueDay: 5, paidThrough: '2026-11' }),
		];
		await mount();
		const shown = texts();
		expect(shown).not.toContain('Longe');
		expect(shown).not.toContain('Paga');
		const line = shown.find((text) => text.includes('bills.home.nothingSoon'));
		expect(line).toBeDefined();
		expect(line).toContain(formatCents(150_000));
		expect(shown).not.toContain('bills.toPay');

		const [card] = pressables();
		expect(card.props.accessibilityLabel).toContain('bills.home.nothingSoon');
		await act(async () => {
			card.props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith('/bills');
	});

	it('sem nada a pagar no mês: diz que está tudo pago', async () => {
		mockState.bills = [bill({ id: 'paga', name: 'Paga', dueDay: 5, paidThrough: '2026-11' })];
		await mount();
		const line = texts().find((text) => text.includes('bills.home.nothingSoon'));
		expect(line).toContain('bills.allPaid');
		expect(line).not.toContain('bills.nothingOpen');
	});

	it('o que zerou o mês foi um mês pulado: "Nada em aberto este mês", não "Tudo pago" (SPD-156)', async () => {
		mockState.bills = [bill({ id: 'academia', name: 'Academia teste', dueDay: 5 })];
		mockState.payments = [
			{
				id: 'pulado',
				billId: 'academia',
				month: '2026-11',
				status: 'skipped',
				transactionId: null,
				amountCents: null,
				updatedAt: '',
			},
		];
		await mount();
		const line = texts().find((text) => text.includes('bills.home.nothingSoon'));
		expect(line).toContain('bills.nothingOpen');
		expect(line).not.toContain('bills.allPaid');
	});
});

describe('sem nenhuma conta cadastrada', () => {
	it('uma linha com "Cadastrar", sem o convite grande', async () => {
		mockState.bills = [];
		await mount();
		const shown = texts();
		expect(shown).toContain('bills.home.none');
		expect(shown).toContain('bills.home.inviteAction');
		expect(shown).not.toContain('bills.home.invite');

		const add = pressables().find((node) => node.props.accessibilityLabel === 'bills.home.inviteAction');
		expect(add).toBeDefined();
		await act(async () => {
			add?.props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith('/bills/new');
	});
});
