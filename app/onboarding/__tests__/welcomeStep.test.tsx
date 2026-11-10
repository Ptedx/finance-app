/**
 * As boas-vindas da primeira abertura (SPD-129): as quatro telas aprovadas, "Pular" em todas
 * menos a última, e depois o onboarding segue como era. Revistas por Ajustes › Como usar
 * (`?review=1`), "Pular" e "Começar" só voltam. As chaves de tradução aparecem cruas.
 */

const mockRouter = { push: jest.fn(), back: jest.fn() };
const mockParams: { review?: string } = {};

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	useLocalSearchParams: () => mockParams,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import WelcomeScreen from '../index';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const texts = (): string[] =>
	renderer.root
		.findAll((node) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''));

const press = async (match: (node: ReactTestInstance) => boolean) => {
	const node = renderer.root.findAll(
		(candidate) => typeof candidate.props.onPress === 'function' && match(candidate)
	)[0];
	await act(async () => {
		node.props.onPress();
	});
};

const pressNext = () =>
	press(
		(node) =>
			node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === undefined
	);
const pressSkip = () => press((node) => node.props.accessibilityLabel === 'welcome.skip');

beforeEach(async () => {
	mockRouter.push.mockClear();
	mockRouter.back.mockClear();
	delete mockParams.review;
});

afterEach(() => {
	act(() => renderer.unmount());
});

const mount = async () => {
	await act(async () => {
		renderer = create(<WelcomeScreen />);
	});
};

it('as quatro telas aprovadas, uma de cada vez, e "Começar" na última segue o onboarding', async () => {
	await mount();

	const seen: string[] = [];
	for (const slide of ['money', 'capture', 'cards', 'plan']) {
		expect(texts()).toContain(`welcome.slides.${slide}.title`);
		expect(texts()).toContain(`welcome.slides.${slide}.body`);
		seen.push(slide);
		if (slide !== 'plan') await pressNext();
	}

	expect(seen).toHaveLength(4);
	expect(texts()).toContain('welcome.start');
	expect(texts()).not.toContain('welcome.skip');
	expect(mockRouter.push).not.toHaveBeenCalled();

	await pressNext();
	expect(mockRouter.push).toHaveBeenCalledWith('/onboarding/info');
});

it('"Pular" passa as boas-vindas e segue o onboarding', async () => {
	await mount();

	expect(texts()).toContain('welcome.skip');
	await pressSkip();

	expect(mockRouter.push).toHaveBeenCalledWith('/onboarding/info');
});

it('revistas pelos Ajustes, "Pular" volta sem refazer o onboarding', async () => {
	mockParams.review = '1';
	await mount();

	await pressSkip();

	expect(mockRouter.back).toHaveBeenCalledTimes(1);
	expect(mockRouter.push).not.toHaveBeenCalled();
});
