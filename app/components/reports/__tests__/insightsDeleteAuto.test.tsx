/**
 * A cobrança dupla (recorrência antiga × cobrança de verdade) ganha um botão "Apagar o
 * [Auto]" no insight (SPD-113). O par sai de `findRecurringDoubleCharges` e vira frase em
 * `buildGoalInsights`, como na tela; o botão pede confirmação e apaga, pela exclusão de
 * sempre (`removeTransaction`), o lançamento `[Auto]` do par — nunca a cobrança de verdade,
 * mesmo quando ela vem primeiro na data. Apagado, o insight some.
 *
 * O `t` daqui resolve no português de verdade, então o teste também falha se a chave não
 * existir.
 */

import pt from '../../../i18n/locales/pt';

const mockT = (key: string, options: Record<string, unknown> = {}): string => {
	const found = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pt as unknown);
	if (typeof found !== 'string') {
		if (typeof options.defaultValue === 'string') return options.defaultValue;
		throw new Error(`chave de tradução ausente: ${key}`);
	}
	return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
};

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: mockT }),
}));

const mockRemoveTransaction = jest.fn(async (_id: string) => undefined);
jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ removeTransaction: mockRemoveTransaction }),
}));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { buildGoalInsights, type Insight } from '../../../utils/insights';
import { findRecurringDoubleCharges } from '../../../utils/reportSeries';
import InsightsList from '../InsightsList';

let renderer: ReactTestRenderer | null = null;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

// A cobrança de verdade chega antes do dia combinado da recorrência: o `[Auto]` é o segundo.
const transactions = [
	{ id: 'cobranca-real', amountCents: 5_500, isIncome: false, date: '2026-10-03', note: 'NETFLIX.COM' },
	{ id: 'lancamento-auto', amountCents: 5_500, isIncome: false, date: '2026-10-05', note: '[Auto] Netflix' },
];

const insightsOf = (): Insight[] => buildGoalInsights(null, [], [], findRecurringDoubleCharges(transactions));

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textsOf = (): string[] =>
	(renderer as ReactTestRenderer).root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

const deleteButtons = (): ReactTestInstance[] =>
	(renderer as ReactTestRenderer).root.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === pt.reports.insights.doubleCharge.deleteAuto
	);

const render = async (insights: Insight[]) => {
	await act(async () => {
		renderer = create(<InsightsList insights={insights} onPress={jest.fn()} />);
	});
};

const lastAlertButtons = (): AlertButton[] => alertSpy.mock.calls[alertSpy.mock.calls.length - 1][2] ?? [];

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	alertSpy.mockClear();
	mockRemoveTransaction.mockClear();
});

it('o par aponta o [Auto] mesmo quando ele vem depois da cobrança de verdade', () => {
	const [charge] = findRecurringDoubleCharges(transactions);
	expect(charge.autoId).toBe('lancamento-auto');
	const insight = insightsOf().find((item) => item.id === 'expense-possibly-duplicated');
	expect(insight?.transactionId).toBe('lancamento-auto');
});

it('o insight da cobrança dupla mostra o botão "Apagar o [Auto]"', async () => {
	await render(insightsOf());

	expect(deleteButtons()).toHaveLength(1);
	expect(textsOf()).toContain(pt.reports.insights.doubleCharge.deleteAuto);
});

it('confirmando, apaga o [Auto] e não a cobrança de verdade; o insight some', async () => {
	await render(insightsOf());

	await act(async () => {
		deleteButtons()[0].props.onPress();
	});
	expect(alertSpy).toHaveBeenCalledTimes(1);
	expect(mockRemoveTransaction).not.toHaveBeenCalled();

	const confirm = lastAlertButtons().find((button) => button.style === 'destructive');
	await act(async () => {
		await confirm?.onPress?.();
	});

	expect(mockRemoveTransaction).toHaveBeenCalledTimes(1);
	expect(mockRemoveTransaction).toHaveBeenCalledWith('lancamento-auto');
	expect(deleteButtons()).toHaveLength(0);
	expect(textsOf().some((text) => text.includes('Netflix'))).toBe(false);
});

it('cancelando, nada é apagado e o insight continua', async () => {
	await render(insightsOf());

	await act(async () => {
		deleteButtons()[0].props.onPress();
	});
	const cancel = lastAlertButtons().find((button) => button.style === 'cancel');
	await act(async () => {
		await cancel?.onPress?.();
	});

	expect(mockRemoveTransaction).not.toHaveBeenCalled();
	expect(deleteButtons()).toHaveLength(1);
});

it('os outros insights não ganham o botão', async () => {
	await render(buildGoalInsights(null, [], [{ amountCents: 15_000, accountId: null, ids: ['a', 'b'], dates: ['2026-10-01', '2026-10-02'] }]));

	expect(deleteButtons()).toHaveLength(0);
});
