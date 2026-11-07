/**
 * "Cartão não encontrado" com saída (E2E-40).
 *
 * Depois de juntar dois cartões, o voltar do Android caiu na tela do cartão apagado: só o
 * texto, sem cabeçalho nem botão. A tela ganha o cabeçalho com o voltar das outras telas
 * do cartão; sem tela para onde voltar (aberta direto), o voltar leva à lista de cartões.
 * O resto da tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockRouter = {
	replace: jest.fn(),
	back: jest.fn(),
	push: jest.fn(),
	canGoBack: jest.fn(() => true),
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../components/cards/CardFace', () => () => null);
jest.mock('../../components/cards/RenameCardSheet', () => () => null);
jest.mock('../../components/cards/Sheet', () => () => null);
jest.mock('../../components/HorizontalCategoryPicker', () => () => null);
jest.mock('../../components/TransactionItem', () => () => null);
jest.mock('../../utils/accountResolver', () => ({ findCheckingForCard: () => null }));

jest.mock('../../contexts/AccountsContext', () => ({
	// O cartão "dup" já foi juntado: não está mais na lista.
	useAccounts: () => ({ accounts: [], bankAccounts: [], cardSummaries: new Map() }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [], categories: [] }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import CardDetailScreen from '../CardDetailScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<CardDetailScreen cardId="dup" />);
	});
};

const backButton = (): ReactTestInstance | undefined =>
	renderer.root.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'cards.back' && node.props.accessibilityRole === 'button'
	)[0];

beforeEach(() => {
	jest.clearAllMocks();
	mockRouter.canGoBack.mockReturnValue(true);
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('E2E-40 — cartão que não existe mais', () => {
	it('diz que não encontrou, como cabeçalho, e tem o botão de voltar', async () => {
		await mount();
		const header = renderer.root.findAll((node) => node.props.accessibilityRole === 'header' && node.props.children === 'cards.notFound');
		expect(header.length).toBeGreaterThan(0);
		expect(backButton()).toBeDefined();
	});

	it('voltar volta para a tela de antes', async () => {
		await mount();
		await act(async () => {
			backButton()?.props.onPress();
		});
		expect(mockRouter.back).toHaveBeenCalledTimes(1);
		expect(mockRouter.replace).not.toHaveBeenCalled();
	});

	it('sem tela antes (aberta direto), voltar leva à lista de cartões', async () => {
		mockRouter.canGoBack.mockReturnValue(false);
		await mount();
		await act(async () => {
			backButton()?.props.onPress();
		});
		expect(mockRouter.back).not.toHaveBeenCalled();
		expect(mockRouter.replace).toHaveBeenCalledWith('/cards');
	});
});
