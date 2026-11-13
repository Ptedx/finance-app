/**
 * Sair do cadastro de conta a pagar sem salvar pergunta antes (SPD-142).
 *
 * Antes, voltar (a seta do topo ou o voltar do Android) com o formulário preenchido perdia
 * tudo sem aviso. Agora, com algo digitado ou alterado, pergunta como a dica do Acertar
 * (SPD-135): "Sair e perder o que você digitou?", com "Continuar editando" e "Sair". Sem nada
 * alterado sai direto, e depois de salvar não pergunta. O resto da tela é dublê; as chaves de
 * tradução aparecem cruas.
 */

import type { Bill } from '../../database/schema';

const mockBack = jest.fn();
const mockSaveBill = jest.fn(async () => undefined);
const mockCreateBill = jest.fn(async () => 'nova');
const mockState: { bills: Bill[] } = { bills: [] };

jest.mock('expo-router', () => {
	const { useEffect } = require('react');
	return {
		useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
		// A tela está sempre em foco no teste: o efeito roda como um efeito comum.
		useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
		Stack: { Screen: () => null },
	};
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: [], bankAccounts: [] }),
}));

jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({
		bills: mockState.bills,
		createBill: mockCreateBill,
		saveBill: mockSaveBill,
		setBillActive: jest.fn(),
		removeBill: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [], categories: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { AccessibilityInfo, Alert, type AlertButton, BackHandler, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import BillEditScreen from '../BillEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

/** Os ouvintes do voltar do Android que a tela registrou (o último registrado responde primeiro). */
let backHandlers: (() => boolean | null | undefined)[] = [];
jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
	backHandlers.push(handler);
	return {
		remove: () => {
			backHandlers = backHandlers.filter((item) => item !== handler);
		},
	};
});

const PLANO: Bill = {
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
};

let renderer: ReactTestRenderer;

const mount = async (billId?: string) => {
	await act(async () => {
		renderer = create(<BillEditScreen billId={billId} />);
	});
};

const typeInto = async (label: string, text: string) => {
	const field = renderer.root.find(
		(node: ReactTestInstance) => (node.type as unknown) === TextInput && node.props.accessibilityLabel === label
	);
	await act(async () => {
		field.props.onChangeText(text);
	});
};

const blur = async (label: string) => {
	const field = renderer.root.find(
		(node: ReactTestInstance) => (node.type as unknown) === TextInput && node.props.accessibilityLabel === label
	);
	await act(async () => {
		field.props.onBlur?.();
	});
};

const pressLabel = async (label: string) => {
	const target = renderer.root.find(
		(node: ReactTestInstance) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
	);
	await act(async () => {
		await target.props.onPress();
	});
};

/** O voltar do Android: devolve se a tela segurou o toque (`true`) ou deixou a navegação voltar. */
const hardwareBack = async (): Promise<boolean> => {
	let handled = false;
	await act(async () => {
		for (const handler of [...backHandlers].reverse()) {
			if (handler()) {
				handled = true;
				break;
			}
		}
	});
	return handled;
};

const lastAlert = () => alertSpy.mock.calls.at(-1);

const pressAlertButton = async (text: string) => {
	const buttons = lastAlert()?.[2] as AlertButton[];
	const button = buttons.find((candidate) => candidate.text === text);
	if (!button) throw new Error(`sem botão ${text}`);
	await act(async () => {
		button.onPress?.();
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockState.bills = [PLANO];
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
});

describe('conta nova', () => {
	it('sem nada digitado: a seta do topo sai direto', async () => {
		await mount();
		await pressLabel('bills.back');
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockBack).toHaveBeenCalledTimes(1);
	});

	it('sem nada digitado: o voltar do Android segue normal', async () => {
		await mount();
		expect(await hardwareBack()).toBe(false);
		expect(alertSpy).not.toHaveBeenCalled();
	});

	it('com algo digitado: a seta do topo pergunta antes, e "Continuar editando" fica', async () => {
		await mount();
		await typeInto('bills.edit.name', 'Internet');
		await pressLabel('bills.back');

		expect(mockBack).not.toHaveBeenCalled();
		const [title, body, buttons] = lastAlert() ?? [];
		expect(title).toBe('tutorial.tip.leaveTitle');
		expect(body).toBe('tutorial.tip.leaveBody');
		expect((buttons as AlertButton[]).map((button) => button.text)).toEqual(['tutorial.tip.stay', 'tutorial.tip.leave']);

		await pressAlertButton('tutorial.tip.stay');
		expect(mockBack).not.toHaveBeenCalled();
	});

	it('com algo digitado: "Sair" sai', async () => {
		await mount();
		await typeInto('bills.edit.dueDay', '15');
		await pressLabel('bills.back');
		await pressAlertButton('tutorial.tip.leave');
		expect(mockBack).toHaveBeenCalledTimes(1);
	});

	it('com algo digitado: o voltar do Android também pergunta', async () => {
		await mount();
		await typeInto('bills.edit.amount', '120');
		expect(await hardwareBack()).toBe(true);
		expect(lastAlert()?.[0]).toBe('tutorial.tip.leaveTitle');
		expect(mockBack).not.toHaveBeenCalled();
	});

	it('apagou o que digitou: sai direto', async () => {
		await mount();
		await typeInto('bills.edit.name', 'Internet');
		await typeInto('bills.edit.name', '');
		await pressLabel('bills.back');
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockBack).toHaveBeenCalledTimes(1);
	});

	it('depois de salvar, não pergunta', async () => {
		await mount();
		await typeInto('bills.edit.name', 'Internet');
		await typeInto('bills.edit.dueDay', '20');
		await pressLabel('bills.edit.save');
		expect(mockCreateBill).toHaveBeenCalledTimes(1);
		expect(mockBack).toHaveBeenCalledTimes(1);
		expect(alertSpy).not.toHaveBeenCalled();
		// Um voltar que chegue depois de salvar (a tela ainda fechando) também não pergunta.
		expect(await hardwareBack()).toBe(false);
		expect(alertSpy).not.toHaveBeenCalled();
	});
});

describe('conta gravada', () => {
	it('aberta e não mexida (nem tocar e sair do valor): sai direto', async () => {
		await mount('plano');
		await blur('bills.edit.amount');
		await pressLabel('bills.back');
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockBack).toHaveBeenCalledTimes(1);
		expect(await hardwareBack()).toBe(false);
	});

	it('valor alterado: pergunta antes', async () => {
		await mount('plano');
		await typeInto('bills.edit.amount', '600');
		await pressLabel('bills.back');
		expect(lastAlert()?.[0]).toBe('tutorial.tip.leaveTitle');
		expect(mockBack).not.toHaveBeenCalled();
	});

	it('alterada e salva: não pergunta', async () => {
		await mount('plano');
		await typeInto('bills.edit.matchHint', 'unimed');
		await pressLabel('bills.edit.save');
		expect(mockSaveBill).toHaveBeenCalledTimes(1);
		expect(mockBack).toHaveBeenCalledTimes(1);
		expect(alertSpy).not.toHaveBeenCalled();
	});
});
