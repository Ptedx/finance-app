/**
 * Cartões e total de Contas a pagar (SPD-156).
 *
 * - Cartão em branco no Android: a conta que deixava de estar atrasada perdia um botão num
 *   cartão com `borderRadius` e `overflow: 'hidden'`, e o Android não redesenhava o conteúdo
 *   (conferido no aparelho: só a borda fixa não bastou; sem o recorte, o cartão aparece). O
 *   cartão não recorta mais; o último botão arredonda os cantos de baixo. A largura da borda
 *   também é a mesma em todo estado; só a cor muda.
 * - "Tudo pago" com mês pulado: quando não falta nada no mês e alguma conta do mês está pulada
 *   ("Não vou pagar este mês"), o total diz "Nada em aberto", não "Tudo pago".
 *
 * O contexto é dublê com as regras de verdade (`monthBills`); as chaves de tradução aparecem
 * cruas, com os valores entre chaves. Os nomes dos meses saem em inglês (o locale de datas
 * padrão dos testes).
 */

import type { Bill, BillPayment } from '../../database/schema';

const mockState: { bills: Bill[]; payments: BillPayment[]; today: string } = {
	bills: [],
	payments: [],
	today: '2026-11-11',
};

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
			payments: mockState.payments,
			month: monthBills(mockState.bills, mockState.today, mockState.payments),
			today: mockState.today,
			isLoading: false,
			planPayment: jest.fn(),
			markPaid: jest.fn(),
			skipMonth: jest.fn(),
			undoPaid: jest.fn(),
		}),
	};
});

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: [] }),
}));

import { StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import BillsScreen from '../BillsScreen';

jest.setTimeout(20_000);

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'academia',
	name: 'Academia teste',
	dueDay: 5,
	amountCents: 10_000,
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

const skipped = (billId: string, month: string): BillPayment => ({
	id: `pulado-${billId}-${month}`,
	billId,
	month,
	status: 'skipped',
	transactionId: null,
	amountCents: null,
	updatedAt: '',
});

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<BillsScreen />);
	});
};

const rerender = async () => {
	await act(async () => {
		renderer.update(<BillsScreen />);
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

/** O estilo achatado do cartão (o `View` com `borderRadius` 12) que tem este nome de conta. */
const cardStyleOf = (name: string) => {
	const label = renderer.root.find(
		(node: ReactTestInstance) => (node.type as unknown) === Text && node.props.children === name
	);
	let node: ReactTestInstance | null = label;
	while (node) {
		if ((node.type as unknown) === View) {
			const style = StyleSheet.flatten(node.props.style) ?? {};
			if (style.borderRadius === 12) return style;
		}
		node = node.parent;
	}
	throw new Error(`sem cartão para ${name}`);
};

beforeEach(() => {
	mockState.today = '2026-11-11';
	mockState.bills = [];
	mockState.payments = [];
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
});

describe('cartão da conta: a borda não aparece nem some (Android)', () => {
	it('atrasada e, depois, paga: a mesma largura de borda; só a cor muda', async () => {
		mockState.bills = [bill()];
		await mount();
		expect(texts()).toContain('pill:late');
		const late = cardStyleOf('Academia teste');

		mockState.bills = [bill({ paidThrough: '2026-11' })];
		await rerender();
		expect(texts()).toContain('pill:paid');
		const paid = cardStyleOf('Academia teste');

		expect(late.borderWidth).toBe(1);
		expect(paid.borderWidth).toBe(late.borderWidth);
		expect(paid.borderColor).not.toBe(late.borderColor);
	});

	it('atrasada e, depois, pulada: a mesma largura de borda', async () => {
		mockState.bills = [bill()];
		await mount();
		const late = cardStyleOf('Academia teste');

		mockState.payments = [skipped('academia', '2026-11')];
		await rerender();
		expect(texts()).toContain('pill:skipped');
		const skip = cardStyleOf('Academia teste');

		expect(skip.borderWidth).toBe(late.borderWidth);
	});

	it('a vencer e atrasada lado a lado: a mesma largura de borda', async () => {
		mockState.bills = [
			bill(),
			bill({ id: 'luz', name: 'Luz teste', dueDay: 20, sortOrder: 1 }),
		];
		await mount();
		expect(cardStyleOf('Luz teste').borderWidth).toBe(cardStyleOf('Academia teste').borderWidth);
	});
});

describe('cartão da conta: nada de recorte que apaga o conteúdo (Android)', () => {
	/** Os botões de ação do cartão desta conta (têm `onPress` e dica de acessibilidade), em ordem. */
	const actionStylesOf = (name: string) => {
		const label = renderer.root.find(
			(node: ReactTestInstance) => (node.type as unknown) === Text && node.props.children === name
		);
		let card: ReactTestInstance | null = label;
		while (card && !((card.type as unknown) === View && StyleSheet.flatten(card.props.style)?.borderRadius === 12)) {
			card = card.parent;
		}
		if (!card) throw new Error(`sem cartão para ${name}`);
		const seen = new Set<unknown>();
		return card
			.findAll((node: ReactTestInstance) => typeof node.props.onPress === 'function' && typeof node.props.accessibilityHint === 'string')
			.filter((node) => {
				if (seen.has(node.props.onPress)) return false;
				seen.add(node.props.onPress);
				return true;
			})
			.map((node) => {
				const style = node.props.style;
				return StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style) ?? {};
			});
	};

	it('o cartão não recorta os filhos: com `overflow: hidden`, perder um botão deixava o cartão em branco', async () => {
		mockState.bills = [bill()];
		await mount();
		expect(cardStyleOf('Academia teste').overflow).not.toBe('hidden');
		mockState.payments = [skipped('academia', '2026-11')];
		await rerender();
		expect(cardStyleOf('Academia teste').overflow).not.toBe('hidden');
	});

	it('sem o recorte, o último botão do cartão arredonda os cantos de baixo', async () => {
		mockState.bills = [bill()];
		await mount();
		const late = actionStylesOf('Academia teste');
		expect(late.length).toBe(2);
		expect(late[0].borderBottomLeftRadius ?? 0).toBe(0);
		expect(late[1].borderBottomLeftRadius).toBe(11);
		expect(late[1].borderBottomRightRadius).toBe(11);

		mockState.payments = [skipped('academia', '2026-11')];
		await rerender();
		const skip = actionStylesOf('Academia teste');
		expect(skip.length).toBe(1);
		expect(skip[0].borderBottomLeftRadius).toBe(11);
		expect(skip[0].borderBottomRightRadius).toBe(11);
	});
});

describe('nada a pagar no mês', () => {
	it('tudo pago de fato: "Tudo pago este mês"', async () => {
		mockState.bills = [bill({ paidThrough: '2026-11' })];
		await mount();
		const shown = texts();
		expect(shown).toContain('bills.allPaid');
		expect(shown).not.toContain('bills.nothingOpen');
	});

	it('com um mês pulado: "Nada em aberto este mês", não "Tudo pago"', async () => {
		mockState.bills = [
			bill(),
			bill({ id: 'luz', name: 'Luz teste', dueDay: 20, paidThrough: '2026-11', sortOrder: 1 }),
		];
		mockState.payments = [skipped('academia', '2026-11')];
		await mount();
		const shown = texts();
		expect(shown).toContain('bills.nothingOpen');
		expect(shown).not.toContain('bills.allPaid');
	});

	it('outubro com um mês pulado: "Nada em aberto em outubro"', async () => {
		mockState.bills = [bill({ paidThrough: '2026-09' })];
		mockState.payments = [skipped('academia', '2026-10'), skipped('academia', '2026-11')];
		await mount();
		await pressLabel('bills.monthNav.previous');
		const shown = texts();
		expect(shown).toContain('October 2026');
		expect(shown).toContain('bills.nothingOpenIn{"month":"October"}');
		expect(shown).not.toContain('bills.allPaidIn{"month":"October"}');
	});

	it('outubro todo pago: continua "Tudo pago em outubro"', async () => {
		mockState.bills = [bill({ paidThrough: '2026-11' })];
		await mount();
		await pressLabel('bills.monthNav.previous');
		const shown = texts();
		expect(shown).toContain('bills.allPaidIn{"month":"October"}');
		expect(shown).not.toContain('bills.nothingOpenIn{"month":"October"}');
	});
});
