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

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../../database/schema';
import { configureMoney, formatCents } from '../../../utils/money';
import { TourContext, type TourContextValue } from '../../tour/TourContext';
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
const onClose = jest.fn();

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
		onClose={onClose}
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

describe('E2E-05 — fechar a folha com um valor digitado pergunta antes', () => {
	const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

	/** O voltar do Android, já com o teclado fechado: o Modal chama `onRequestClose`. */
	const back = async () => {
		const modal = renderer.root.find((node) => typeof node.props.onRequestClose === 'function');
		await act(async () => {
			modal.props.onRequestClose();
		});
	};

	it('digitado o gasto, o voltar pergunta se descarta e a folha fica aberta', async () => {
		await open(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await back();

		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0][0]).toBe('cards.discard.title');
		expect(onClose).not.toHaveBeenCalled();
		expect(shown('accounts.adjust.spent')).toBe('1.200,00');
	});

	it('sem nada digitado, o voltar fecha direto', async () => {
		await open(NEW_ACCOUNT);
		await back();

		expect(alert).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe('SPD-135 — o "?" mostra uma dica rápida e não perde o digitado sem perguntar', () => {
	const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
	const openTopic = jest.fn();
	const tour: TourContextValue = {
		report: jest.fn(),
		startTour: jest.fn(),
		openTopic,
		noticeVisible: false,
		answerNotice: jest.fn(),
	};

	/** A folha com o guia por perto, como no app (o `TourProvider` do `_layout` raiz). */
	const openWithTour = async (known: Known, balanceOnly = false) => {
		await act(async () => {
			renderer = create(
				<TourContext.Provider value={tour}>
					<AdjustAccountSheet
						visible
						account={account}
						spentCents={known.spentCents}
						monthLabel="novembro"
						balanceCents={known.balanceCents}
						targetCents={known.targetCents}
						isEnvelope={false}
						balanceOnly={balanceOnly}
						onClose={onClose}
						onConfirm={onConfirm}
					/>
				</TourContext.Provider>
			);
		});
	};

	const pressWhere = async (predicate: (node: ReactTestInstance) => boolean) => {
		const target = renderer.root.findAll((node) => typeof node.props.onPress === 'function' && predicate(node))[0];
		if (!target) throw new Error('botão não encontrado');
		await act(async () => {
			target.props.onPress();
		});
	};

	const pressHelp = () => pressWhere((node) => node.props.accessibilityLabel === 'tutorial.help');
	const pressFullGuide = () => pressWhere((node) => node.props.accessibilityLabel === 'tutorial.tip.fullGuide');
	const tipShown = () => texts().includes('accounts.adjust.helpTip');

	/** Os botões da última pergunta feita. */
	const lastButtons = (): AlertButton[] => alert.mock.calls[alert.mock.calls.length - 1][2] ?? [];

	it('tocar no "?" mostra a dica dentro da folha, sem fechar nada; tocar de novo esconde', async () => {
		await openWithTour(NEW_ACCOUNT);
		expect(tipShown()).toBe(false);

		await pressHelp();

		expect(tipShown()).toBe(true);
		expect(texts()).toContain('tutorial.tip.fullGuide');
		expect(onClose).not.toHaveBeenCalled();
		expect(openTopic).not.toHaveBeenCalled();
		// O leitor de tela lê a dica quando ela abre.
		expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('accounts.adjust.helpTip');

		await pressHelp();
		expect(tipShown()).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('tocar fora da dica a fecha: no fundo escurecido ou sobre os campos, sem fechar a folha', async () => {
		await openWithTour(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await pressHelp();

		await pressWhere((node) => node.props.importantForAccessibility === 'no-hide-descendants');
		expect(tipShown()).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();

		await pressHelp();
		await pressWhere((node) => node.props.testID === 'sheet-tip-dismiss');
		expect(tipShown()).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
		expect(shown('accounts.adjust.spent')).toBe('1.200,00');
	});

	it('o voltar do Android com a dica aberta fecha só a dica', async () => {
		await openWithTour(NEW_ACCOUNT);
		await pressHelp();

		const modal = renderer.root.find((node) => typeof node.props.onRequestClose === 'function');
		await act(async () => {
			modal.props.onRequestClose();
		});

		expect(tipShown()).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('numa reserva, a dica fala do saldo de hoje, não do gasto do mês', async () => {
		await openWithTour(NEW_ACCOUNT, true);
		await pressHelp();

		expect(texts()).toContain('accounts.adjust.helpTipBalanceOnly');
		expect(tipShown()).toBe(false);
	});

	it('"Ver o guia completo" sem nada digitado fecha a folha e abre o tópico direto', async () => {
		await openWithTour(NEW_ACCOUNT);
		await pressHelp();
		await pressFullGuide();

		expect(alert).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(openTopic).toHaveBeenCalledWith('accounts');
	});

	it('"Ver o guia completo" com algo digitado pergunta antes; "Continuar editando" mantém os valores', async () => {
		await openWithTour(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await typeInto('accounts.adjust.balance', '5000');
		await pressHelp();
		await pressFullGuide();

		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0][0]).toBe('tutorial.tip.leaveTitle');
		expect(onClose).not.toHaveBeenCalled();
		expect(openTopic).not.toHaveBeenCalled();

		const stay = lastButtons().find((button) => button.style === 'cancel');
		expect(stay?.text).toBe('tutorial.tip.stay');
		await act(async () => {
			stay?.onPress?.();
		});

		expect(onClose).not.toHaveBeenCalled();
		expect(openTopic).not.toHaveBeenCalled();
		expect(shown('accounts.adjust.spent')).toBe('1.200,00');
		expect(shown('accounts.adjust.balance')).toBe('5.000,00');
	});

	it('com algo digitado, "Sair" fecha a folha e abre o tópico', async () => {
		await openWithTour(NEW_ACCOUNT);
		await typeInto('accounts.adjust.spent', '1200');
		await pressHelp();
		await pressFullGuide();

		const leave = lastButtons().find((button) => button.style === 'destructive');
		expect(leave?.text).toBe('tutorial.tip.leave');
		await act(async () => {
			leave?.onPress?.();
		});

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(openTopic).toHaveBeenCalledWith('accounts');
	});
});
