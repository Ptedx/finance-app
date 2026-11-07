/**
 * A folha "Acertar conta" com os números do teste no aparelho (E2E-01, SPD-087).
 *
 * Conta corrente nova, sem lançamentos: quem tem R$ 5.000 e já gastou R$ 1.200 em
 * novembro digita os dois. Antes, os dois campos se ligavam pelo dinheiro do mês — zero
 * numa conta nova — e digitar um zerava o outro. Aqui a folha roda de verdade, digitada
 * tecla a tecla como no aparelho; as chaves de tradução aparecem cruas, com os valores.
 */

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// Os valores entram no texto ("accounts.adjust.preview|{...}") para o teste ler o número.
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
	}),
}));

import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../../database/schema';
import { configureMoney, formatCents } from '../../../utils/money';
import AdjustAccountSheet from '../AdjustAccountSheet';

const account: Account = {
	id: 'corrente',
	name: 'Corrente Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	closingDaysBefore: null,
	dueDay: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
};

jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

// A primeira montagem carrega a folha inteira (3 s sozinha); com outras suítes rodando
// junto, passou dos 5 s padrão.
jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const onConfirm = jest.fn(async (_input: { spentCents: number; balanceCents: number }) => undefined);

/** O que o app sabia da conta quando a folha abriu. */
interface Known {
	spentCents: number;
	balanceCents: number;
	targetCents: number;
	isEnvelope?: boolean;
}

type FieldKey = 'accounts.adjust.spent' | 'accounts.adjust.balance';

const sheet = (known: Known, visible = true) => (
	<AdjustAccountSheet
		visible={visible}
		account={account}
		spentCents={known.spentCents}
		monthLabel="novembro"
		balanceCents={known.balanceCents}
		targetCents={known.targetCents}
		isEnvelope={known.isEnvelope ?? false}
		onClose={() => undefined}
		onConfirm={onConfirm}
	/>
);

const open = async (known: Known) => {
	await act(async () => {
		renderer = create(sheet(known));
	});
};

const input = (key: FieldKey): ReactTestInstance =>
	renderer.root.find(
		(node) => (node.type as unknown) === 'TextInput' && String(node.props.accessibilityLabel).split('|')[0] === key
	);

/** O que o campo mostra agora. */
const shown =(key: FieldKey): string => input(key).props.value;

/**
 * Toca no campo (`selectTextOnFocus` seleciona tudo, então a primeira tecla substitui o
 * que havia), digita tecla a tecla como o teclado manda, e sai do campo.
 */
const typeInto = async (key: FieldKey, keys: string) => {
	let typed = '';
	for (const letter of keys) {
		const field = input(key);
		await act(async () => {
			field.props.onChangeText(typed + letter);
		});
		typed = input(key).props.value;
	}
	const field = input(key);
	await act(async () => {
		field.props.onBlur?.();
	});
};

const texts = (): string[] =>
	renderer.root.findAll((node) => (node.type as unknown) === 'Text').map((node) => [node.props.children].flat().join(''));

/** Os valores de uma frase da folha, pela chave. */
const sentence = (key: string): Record<string, string> | undefined => {
	const found = texts().find((text) => text.startsWith(`${key}|`));
	return found ? JSON.parse(found.slice(key.length + 1)) : undefined;
};

const confirm = async () => {
	const label = renderer.root.find((node) => (node.type as unknown) === 'Text' && node.props.children === 'accounts.adjust.confirm');
	let target: ReactTestInstance | null = label;
	while (target && !target.props.onPress) target = target.parent;
	const onPress = target?.props.onPress as () => Promise<void>;
	await act(async () => {
		await onPress();
	});
};

const NEW_ACCOUNT: Known = { spentCents: 0, balanceCents: 0, targetCents: 0 };

beforeEach(() => {
	jest.clearAllMocks();
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

afterEach(() => {
	act(() => renderer.unmount());
	configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
});

describe('E2E-01 — conta nova: "já gastei" e "ainda tenho" valem os dois', () => {
	it('gastei R$ 1.200 e depois tenho R$ 5.000: o gasto não volta a zero', async () => {
		await open(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await typeInto('accounts.adjust.balance', '5000');

		expect(shown('accounts.adjust.spent')).toBe('1.200,00');
		expect(shown('accounts.adjust.balance')).toBe('5.000,00');
		expect(sentence('accounts.adjust.preview')).toEqual({ spent: formatCents(120_000), balance: formatCents(500_000) });

		await confirm();
		expect(onConfirm).toHaveBeenCalledWith({ spentCents: 120_000, balanceCents: 500_000 });
	});

	it('na ordem inversa, tenho R$ 5.000 e depois gastei R$ 1.200: o saldo não volta a zero', async () => {
		await open(NEW_ACCOUNT);
		await typeInto('accounts.adjust.balance', '5000');
		await typeInto('accounts.adjust.spent', '1200');

		expect(shown('accounts.adjust.spent')).toBe('1.200,00');
		expect(shown('accounts.adjust.balance')).toBe('5.000,00');
		expect(sentence('accounts.adjust.preview')).toEqual({ spent: formatCents(120_000), balance: formatCents(500_000) });

		await confirm();
		expect(onConfirm).toHaveBeenCalledWith({ spentCents: 120_000, balanceCents: 500_000 });
	});

	it('a prévia diz que a diferença é dinheiro de antes, não receita do mês', async () => {
		await open(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await typeInto('accounts.adjust.balance', '5000');

		// R$ 5.000 hoje depois de R$ 1.200 de gasto: R$ 6.200 já estavam na conta.
		expect(sentence('accounts.adjust.previewBefore')).toEqual({ amount: formatCents(620_000) });
		expect(sentence('accounts.adjust.previewBeforeLess')).toBeUndefined();
	});

	it('reabrir a folha volta a ligar os dois campos', async () => {
		await open(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await typeInto('accounts.adjust.balance', '5000');
		await act(async () => {
			renderer.update(sheet(NEW_ACCOUNT, false));
		});
		await act(async () => {
			renderer.update(sheet({ spentCents: 0, balanceCents: 0, targetCents: 100_000 }));
		});

		await typeInto('accounts.adjust.spent', '300');
		expect(shown('accounts.adjust.balance')).toBe('700,00');
	});
});

describe('o par continua ligado enquanto só um campo foi digitado', () => {
	it('com R$ 1.000 no mês, digitar 845,20 deixa 154,80; corrigir o gasto recalcula o saldo', async () => {
		await open({ spentCents: 0, balanceCents: 100_000, targetCents: 0 });
		await typeInto('accounts.adjust.spent', '845,20');
		expect(shown('accounts.adjust.balance')).toBe('154,80');

		await typeInto('accounts.adjust.spent', '900');
		expect(shown('accounts.adjust.balance')).toBe('100,00');
		// O que fecha com o mês não é dinheiro de antes.
		expect(sentence('accounts.adjust.previewBefore')).toBeUndefined();
		expect(sentence('accounts.adjust.previewBeforeLess')).toBeUndefined();
	});

	it('digitar o saldo calcula o gasto de volta, e corrigir o gasto depois mantém o saldo', async () => {
		await open({ spentCents: 0, balanceCents: 100_000, targetCents: 0 });
		await typeInto('accounts.adjust.balance', '154,80');
		expect(shown('accounts.adjust.spent')).toBe('845,20');

		await typeInto('accounts.adjust.spent', '800');
		expect(shown('accounts.adjust.balance')).toBe('154,80');
		// R$ 45,20 a menos do que o app sabia: sai do ponto de partida, não vira gasto.
		expect(sentence('accounts.adjust.previewBeforeLess')).toEqual({ amount: formatCents(4_520) });
	});

	it('envelope: o teto liga os campos e a barra mostra o gasto de gasto + saldo', async () => {
		await open({ spentCents: 30_000, balanceCents: 70_000, targetCents: 100_000, isEnvelope: true });
		await typeInto('accounts.adjust.spent', '400');
		expect(shown('accounts.adjust.balance')).toBe('600,00');
		expect(sentence('accounts.adjust.previewEnvelope')).toEqual({ spent: formatCents(40_000), target: formatCents(100_000) });
		expect(sentence('accounts.adjust.previewBefore')).toBeUndefined();
	});
});
