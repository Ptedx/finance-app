/**
 * Voltar de uma tela da raiz devolve a aba de onde se veio (E2E-46).
 *
 * Usa o expo-router de verdade (rotas de mentira, navegadores reais): com o `<Slot />` antigo
 * na raiz, o voltar caía em Início.
 */
import 'expo-router/build/testing-library/mocks';
import { router, Tabs } from 'expo-router';
import { ExpoRoot } from 'expo-router/build/ExpoRoot';
import { store } from 'expo-router/build/global-state/router-store';
import { getMockContext } from 'expo-router/build/testing-library/mock-config';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import RootStack from '../RootStack';

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

const path = () => store.getRouteInfo().pathname;

describe('RootStack', () => {
	it('editar uma transferência aberta de Lançamentos e voltar fica em Lançamentos', async () => {
		const context = getMockContext({
			_layout: () => <RootStack />,
			'(tabs)/_layout': () => <Tabs />,
			'(tabs)/index': () => <Text>início</Text>,
			'(tabs)/transactions': () => <Text>lançamentos</Text>,
			'transaction/edit/[id]': () => <Text>editar</Text>,
		});
		let tree: ReactTestRenderer | undefined;
		await act(async () => {
			tree = create(<ExpoRoot context={context} location="/" />);
		});
		await settle();

		await act(async () => router.navigate('/transactions'));
		await settle();
		expect(path()).toBe('/transactions');

		await act(async () => router.push({ pathname: '/transaction/edit/[id]', params: { id: '1', kind: 'transfer' } }));
		await settle();
		expect(path()).toBe('/transaction/edit/1');

		await act(async () => router.back());
		await settle();
		expect(path()).toBe('/transactions');

		tree?.unmount();
	});
});
