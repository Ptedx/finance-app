/**
 * O painel da tela de Contas (SPD-149/150): o aviso da conta que voltou e a lista "Encerradas
 * com saldo". Aqui só a tela: o efeito de cada decisão em R$ está em `closedReview.test.ts` e
 * a gravação, com o banco de verdade, em `closedReviewSql.test.tsx`.
 *
 * O que se confere: a confirmação mostra o "Patrimônio: R$ X → R$ Y" antes de qualquer coisa;
 * nada é gravado sem o toque em "Confirmar"; o cartão devendo paga pela conta escolhida na
 * folha; o aviso sai no "Entendi" ou ao deixar a tela. As chaves de tradução aparecem cruas.
 *
 * Números de hoje: Em caixa R$ 24.150,00, guardado R$ 300,00, cartões R$ 700,00 (R$ 500,00 do
 * cartão encerrado), Depois das faturas R$ 23.650,00 — Patrimônio R$ 23.750,00.
 */

const mockSettle = jest.fn(async () => undefined);
const mockPlanClose = jest.fn(async (): Promise<unknown> => ({ kind: 'direct' }));
const mockDismiss = jest.fn();
const mockMarkShown = jest.fn();
const mockState: { closedReview: unknown[]; revivalNotices: unknown[]; unseen: boolean } = {
	closedReview: [],
	revivalNotices: [],
	unseen: false,
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../MergeTargetSheet', () => ({ __esModule: true, default: () => null }));

const mockAccount = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
	id,
	name,
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#FF7A00',
	icon: null,
	openingBalanceCents: 0,
	openingBalanceDate: null,
	archived: 0,
	isPrimary: 0,
	closingDay: null,
	dueDay: null,
	limitCents: null,
	sortOrder: 0,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	deletedAt: null,
	...overrides,
});

const mockCorrente = mockAccount('corrente', 'Corrente');
const mockCarteira = mockAccount('carteira', 'Carteira', { kind: 'cash', archived: 1 });
const mockCartao = mockAccount('cartao', 'Cartão', { kind: 'credit_card', role: 'main', archived: 1 });

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: [mockCorrente, mockCarteira, mockCartao],
		overview: { cashCents: 2_415_000, savedCents: 30_000, netCents: 2_365_000 },
		cardSummaries: new Map([
			['cartao', { owedCents: 50_000, futureCommittedCents: 0 }],
			['outro', { owedCents: 20_000, futureCommittedCents: 0 }],
		]),
		planClose: mockPlanClose,
		settleClosedAccount: mockSettle,
		closedReview: mockState.closedReview,
		closedReviewUnseen: mockState.unseen,
		markClosedReviewShown: mockMarkShown,
		revivalNotices: mockState.revivalNotices,
		dismissRevivalNotices: mockDismiss,
	}),
}));

jest.mock('../../../contexts/DebtsContext', () => ({ useDebts: () => ({ summary: { balanceCents: 0 } }) }));
jest.mock('../../../hooks/useRetirementGoal', () => ({ useRetirementGoal: () => ({ goal: null }) }));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { formatMonthYear } from '../../../utils/dateUtils';
import { formatCents } from '../../../utils/money';
import ClosedReviewPanel from '../ClosedReviewPanel';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer | null = null;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const carteiraItem = { account: mockCarteira, balanceCents: 45_000, owedCents: 0 };
const cartaoItem = { account: mockCartao, balanceCents: -50_000, owedCents: 50_000 };

const mount = async () => {
	await act(async () => {
		renderer = create(<ClosedReviewPanel />);
	});
};

const button = (label: string, index = 0): ReactTestInstance => {
	const found =
		renderer?.root.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label) ?? [];
	// O Pressable aparece mais de uma vez na árvore (host e composto): fica um por rótulo e item.
	const unique = found.filter((node, i) => found.findIndex((other) => other.props.onPress === node.props.onPress) === i);
	return unique[index];
};

const press = async (node: ReactTestInstance) => {
	await act(async () => {
		await node.props.onPress();
	});
};

const texts = (): string[] =>
	renderer?.root.findAll((node) => (node.type as unknown) === 'Text').map((node) => [node.props.children].flat().join('')) ?? [];

/** A última confirmação: título, texto e o botão de confirmar. */
const lastAlert = () => {
	const [title, message, buttons] = alertSpy.mock.calls[alertSpy.mock.calls.length - 1] as [string, string, AlertButton[]];
	return { title, message, confirm: buttons?.find((b) => b.text === 'accounts.closedReview.confirmAction') };
};

const worthLine = (before: number, after: number) =>
	`accounts.closedReview.effectWorth ${JSON.stringify({ before: formatCents(before), after: formatCents(after) })}`;
const netLine = (before: number, after: number) =>
	`accounts.closedReview.effectNet ${JSON.stringify({ before: formatCents(before), after: formatCents(after) })}`;

beforeEach(() => {
	mockState.closedReview = [];
	mockState.revivalNotices = [];
	mockState.unseen = false;
	mockSettle.mockClear();
	mockPlanClose.mockClear();
	mockPlanClose.mockImplementation(async () => ({ kind: 'direct' }));
	mockDismiss.mockClear();
	mockMarkShown.mockClear();
	alertSpy.mockClear();
});

afterEach(() => {
	act(() => {
		renderer?.unmount();
	});
	renderer = null;
});

describe('ClosedReviewPanel', () => {
	it('sem encerrada com saldo e sem aviso, não mostra nada', async () => {
		await mount();
		expect(renderer?.toJSON()).toBeNull();
		expect(mockMarkShown).not.toHaveBeenCalled();
	});

	it('o aviso da conta que voltou mostra a conta, os lançamentos e o R$ de cada mês, e sai no "Entendi"', async () => {
		mockState.revivalNotices = [
			{
				accounts: [{ id: 'vazia', name: 'Vazia', transactions: 1, transfers: 2 }],
				months: [{ month: '2026-11', incomeCents: 0, spendCents: 9_000, savedCents: 0 }],
			},
		];
		await mount();
		const all = texts();
		expect(all).toContain('accounts.closedReview.revivedTitle {"count":1}');
		expect(all.some((text) => text.startsWith('accounts.closedReview.revivedAccount') && text.includes('"name":"Vazia"'))).toBe(true);
		expect(
			all.some(
				// O valor do mês vem dentro do texto do mês: "+R$ 90,00" de gasto em novembro.
				(text) =>
					text.includes('accounts.closedReview.revivedMonth') &&
					text.includes(`"month":"${formatMonthYear('2026-11-01')}"`) &&
					text.includes(`accounts.closedReview.revivedSpend {\\"amount\\":\\"+${formatCents(9_000)}\\"}`)
			)
		).toBe(true);
		expect(mockDismiss).not.toHaveBeenCalled();

		await press(button('accounts.closedReview.revivedOk'));
		expect(mockDismiss).toHaveBeenCalledTimes(1);
	});

	it('cartão que voltou: o aviso mostra o Patrimônio de hoje, de R$ 24.290,00 para R$ 23.750,00', async () => {
		mockState.revivalNotices = [
			{
				accounts: [{ id: 'cartao', name: 'Cartão', transactions: 2, transfers: 1 }],
				months: [{ month: '2026-11', incomeCents: 0, spendCents: 4_000, savedCents: 0 }],
				worthDeltaCents: -54_000,
			},
		];
		await mount();
		expect(texts()).toContain(worthLine(2_429_000, 2_375_000));
		expect(texts()).toContain('accounts.closedReview.revivedWorthCard');
		expect(texts()).not.toContain('accounts.closedReview.revivedWorthSame');
	});

	it('conta que voltou sem mudar o Patrimônio: o aviso diz que ele não mudou, sem linha de antes e depois', async () => {
		mockState.revivalNotices = [
			{
				accounts: [{ id: 'vazia', name: 'Vazia', transactions: 1, transfers: 0 }],
				months: [{ month: '2026-11', incomeCents: 0, spendCents: 9_000, savedCents: 0 }],
				worthDeltaCents: 0,
			},
		];
		await mount();
		expect(texts().some((text) => text.startsWith('accounts.closedReview.effectWorth'))).toBe(false);
		expect(texts()).toContain('accounts.closedReview.revivedWorthSame');
	});

	it('sem o efeito calculado (a conta falhou), o aviso não afirma nada sobre o Patrimônio', async () => {
		mockState.revivalNotices = [
			{ accounts: [{ id: 'cartao', name: 'Cartão', transactions: 2, transfers: 1 }], months: null, worthDeltaCents: null },
		];
		await mount();
		const all = texts();
		expect(all).toContain('accounts.closedReview.revivedUnknown');
		expect(all.some((text) => text.includes('Worth'))).toBe(false);
	});

	it('o aviso também sai ao deixar a tela', async () => {
		mockState.revivalNotices = [{ accounts: [{ id: 'vazia', name: 'Vazia', transactions: 1, transfers: 0 }], months: null }];
		await mount();
		expect(texts()).toContain('accounts.closedReview.revivedUnknown');
		act(() => {
			renderer?.unmount();
		});
		renderer = null;
		expect(mockDismiss).toHaveBeenCalledTimes(1);
	});

	it('a lista aparece e conta como vista; o saldo de cada encerrada está na tela', async () => {
		mockState.closedReview = [cartaoItem, carteiraItem];
		mockState.unseen = true;
		await mount();
		expect(mockMarkShown).toHaveBeenCalledTimes(1);
		const all = texts();
		expect(all).toContain('accounts.closedReview.title');
		expect(all).toContain(`accounts.closedReview.owes ${JSON.stringify({ amount: formatCents(50_000) })}`);
		expect(all).toContain(`accounts.closedReview.balance ${JSON.stringify({ amount: formatCents(45_000) })}`);
	});

	it('zerar a Carteira mostra o Patrimônio igual (ela já estava fora) e só grava no "Confirmar"', async () => {
		mockState.closedReview = [carteiraItem];
		await mount();
		await press(button('accounts.closedReview.zero'));

		expect(mockPlanClose).toHaveBeenCalledWith('carteira');
		const { title, message, confirm } = lastAlert();
		expect(title).toBe('accounts.closedReview.zero');
		expect(message).toContain(worthLine(2_375_000, 2_375_000));
		expect(message).not.toContain('effectNet');
		expect(mockSettle).not.toHaveBeenCalled();

		await act(async () => {
			await confirm?.onPress?.();
		});
		expect(mockSettle).toHaveBeenCalledWith('carteira', { kind: 'zero' });
	});

	it('reabrir a Carteira mostra os R$ 450,00 entrando no Patrimônio e em "Depois das faturas"', async () => {
		mockState.closedReview = [carteiraItem];
		await mount();
		await press(button('accounts.closedReview.reopen'));

		const { message, confirm } = lastAlert();
		expect(message).toContain(worthLine(2_375_000, 2_420_000));
		expect(message).toContain(netLine(2_365_000, 2_410_000));
		expect(mockSettle).not.toHaveBeenCalled();
		await act(async () => {
			await confirm?.onPress?.();
		});
		expect(mockSettle).toHaveBeenCalledWith('carteira', { kind: 'reopen' });
	});

	it('pagar o cartão escolhe a conta na folha; o Patrimônio não muda e "Depois das faturas" cai R$ 500,00', async () => {
		mockState.closedReview = [cartaoItem];
		await mount();
		await press(button('accounts.closedReview.pay'));
		expect(alertSpy).not.toHaveBeenCalled();

		const sheet = renderer?.root.findAll((node) => typeof node.props.onPick === 'function')[0];
		expect(sheet?.props.targets.map((target: { id: string }) => target.id)).toEqual(['corrente']);
		await act(async () => {
			sheet?.props.onPick(mockCorrente);
		});

		const { title, message, confirm } = lastAlert();
		expect(title).toBe('accounts.closedReview.pay');
		expect(message).toContain('accounts.closedReview.confirmPay');
		expect(message).toContain(worthLine(2_375_000, 2_375_000));
		expect(message).toContain(netLine(2_365_000, 2_315_000));
		expect(mockSettle).not.toHaveBeenCalled();

		await act(async () => {
			await confirm?.onPress?.();
		});
		expect(mockSettle).toHaveBeenCalledWith('cartao', { kind: 'transfer', targetId: 'corrente' });
	});

	it('zerar o cartão devendo tira os R$ 500,00 do Patrimônio', async () => {
		mockState.closedReview = [cartaoItem];
		mockPlanClose.mockImplementation(async () => ({ kind: 'blocked', reason: 'cardOwes', amountCents: 50_000, count: 0 }));
		await mount();
		await press(button('accounts.closedReview.zero'));

		const { message } = lastAlert();
		expect(message).toContain('accounts.closedReview.confirmZeroCard');
		expect(message).toContain(worthLine(2_375_000, 2_425_000));
	});

	it('com compra a revisar na encerrada, a decisão espera: aviso do bloqueio e nada gravado', async () => {
		mockState.closedReview = [carteiraItem];
		mockPlanClose.mockImplementation(async () => ({ kind: 'blocked', reason: 'pendingCaptures', amountCents: 0, count: 2 }));
		await mount();
		await press(button('accounts.closedReview.zero'));

		const { title, confirm } = lastAlert();
		expect(title).toBe('Carteira');
		expect(confirm).toBeUndefined();
		expect(mockSettle).not.toHaveBeenCalled();
	});
});
