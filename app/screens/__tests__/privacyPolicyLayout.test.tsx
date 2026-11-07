/**
 * A política de privacidade (SPD-121): a pilha da raiz não desenha cabeçalho, e a tela abria
 * direto no texto, sem título nem voltar. Agora desenha o seu, como o detalhe do lançamento
 * (SPD-110). O texto da política não muda (SPD-118). As chaves de tradução aparecem cruas.
 */

const mockBack = jest.fn();

jest.mock('expo-router', () => ({
	useRouter: () => ({ back: mockBack }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt' } }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import PrivacyPolicyScreen from '../PrivacyPolicyScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

beforeEach(async () => {
	mockBack.mockClear();
	await act(async () => {
		renderer = create(<PrivacyPolicyScreen />);
	});
});

afterEach(() => {
	act(() => renderer.unmount());
});

it('tem cabeçalho com o título e a seta de voltar, que volta para Configurações', async () => {
	const titles = renderer.root
		.findAll((node) => isHostText(node) && node.props.accessibilityRole === 'header')
		.map((node) => [node.props.children].flat().join(''));
	expect(titles).toEqual(['settings.privacyPolicy']);

	const [back] = renderer.root.findAll(
		(node) => node.props.accessibilityLabel === 'settings.privacyPolicyBack' && typeof node.props.onPress === 'function'
	);
	expect(back?.props.accessibilityRole).toBe('button');
	await act(async () => {
		back?.props.onPress();
	});
	expect(mockBack).toHaveBeenCalledTimes(1);
});

it('o texto da política continua na tela', () => {
	const shown = renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));
	expect(shown.some((text) => text.includes('Seus dados são seus.'))).toBe(true);
});
