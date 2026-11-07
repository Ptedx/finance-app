/**
 * O voltar do Android numa folha (E2E-05, SPD-096).
 *
 * Na folha "Acertar", com o teclado aberto e um valor digitado, o voltar fechou a folha
 * inteira e o que estava digitado se perdeu. No Android o primeiro voltar fecha só o
 * teclado. O voltar chega à folha pelo `onRequestClose` do Modal; o teclado, pelos eventos
 * do módulo `Keyboard` e pelo campo que está com o foco.
 */

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { Alert, type AlertButton, DeviceEventEmitter, Keyboard, Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Sheet from '../Sheet';

let renderer: ReactTestRenderer;
const onClose = jest.fn();
const dismiss = jest.spyOn(Keyboard, 'dismiss');
const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

// No jest o TextInput é um mock sem `State`; aqui ele ganha um, para dizer qual campo
// está com o foco, como o `TextInput.State` de verdade.
let focused: unknown = null;
(TextInput as unknown as { State: unknown }).State = { currentlyFocusedInput: () => focused };

const open = async (confirmDiscard?: boolean) => {
	await act(async () => {
		renderer = create(
			<Sheet visible title="Acertar" onClose={onClose} confirmDiscard={confirmDiscard}>
				<Text>campos</Text>
			</Sheet>
		);
	});
};

/** O voltar do Android: o Modal chama `onRequestClose`. */
const back = async () => {
	const modal = renderer.root.find((node) => typeof node.props.onRequestClose === 'function');
	await act(async () => {
		modal.props.onRequestClose();
	});
};

const keyboard = async (event: 'keyboardDidShow' | 'keyboardDidHide') => {
	await act(async () => {
		DeviceEventEmitter.emit(event, {
			endCoordinates: { screenX: 0, screenY: 500, width: 400, height: 300 },
			duration: 0,
			easing: 'keyboard',
		});
	});
};

const pressable = (predicate: (node: ReactTestInstance) => boolean): (() => void) => {
	const found = renderer.root.find((node) => typeof node.props.onPress === 'function' && predicate(node));
	return found.props.onPress;
};

/** O X do cabeçalho. */
const closeButton = () => pressable((node) => node.props.accessibilityLabel === 'cards.close');

/** O fundo escurecido atrás da folha. */
const backdrop = () => pressable((node) => node.props.importantForAccessibility === 'no-hide-descendants');

/** Os botões da última pergunta feita. */
const lastButtons = (): AlertButton[] => alert.mock.calls[alert.mock.calls.length - 1][2] ?? [];

beforeEach(() => {
	jest.clearAllMocks();
	focused = null;
});

afterEach(async () => {
	await keyboard('keyboardDidHide');
	act(() => renderer.unmount());
});

describe('E2E-05 — voltar com o teclado aberto fecha só o teclado', () => {
	it('com o teclado aberto, o voltar fecha o teclado e a folha fica', async () => {
		await open();
		await keyboard('keyboardDidShow');
		await back();

		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('o teclado já se fechou sozinho mas o campo segue com o foco: o voltar só tira o foco', async () => {
		// No Android o teclado pode tratar o voltar antes e se fechar; o campo continua focado.
		await open();
		focused = {};
		await back();

		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('com o teclado fechado, o voltar fecha a folha como antes', async () => {
		await open();
		await keyboard('keyboardDidShow');
		await keyboard('keyboardDidHide');
		await back();

		expect(dismiss).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('o segundo voltar, já sem teclado, fecha a folha', async () => {
		await open();
		await keyboard('keyboardDidShow');
		await back();
		await keyboard('keyboardDidHide');
		await back();

		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe('com algo digitado e não salvo, fechar pergunta antes', () => {
	it('o voltar com o teclado fechado pergunta; "descartar" fecha a folha', async () => {
		await open(true);
		await back();

		expect(onClose).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0][0]).toBe('cards.discard.title');
		const discard = lastButtons().find((button) => button.text === 'cards.discard.confirm');
		await act(async () => {
			discard?.onPress?.();
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('"continuar editando" deixa a folha aberta', async () => {
		await open(true);
		await back();

		const keep = lastButtons().find((button) => button.text === 'cards.discard.keep');
		expect(keep?.style).toBe('cancel');
		await act(async () => {
			keep?.onPress?.();
		});
		expect(onClose).not.toHaveBeenCalled();
	});

	it('com o teclado aberto, o voltar ainda fecha só o teclado, sem perguntar', async () => {
		await open(true);
		await keyboard('keyboardDidShow');
		await back();

		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(alert).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('o X e o toque fora também perguntam', async () => {
		await open(true);
		await act(async () => closeButton()());
		await act(async () => backdrop()());

		expect(alert).toHaveBeenCalledTimes(2);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('sem nada digitado, o X e o toque fora fecham direto', async () => {
		await open(false);
		await act(async () => closeButton()());
		await act(async () => backdrop()());

		expect(alert).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
