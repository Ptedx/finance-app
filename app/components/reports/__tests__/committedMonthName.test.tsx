/**
 * O nome do mês em "Já comprometido" (E2E-46): "novembro 2026" com `textTransform:
 * 'capitalize'` saía certo por sorte (a segunda palavra é o ano), mas o estilo põe
 * maiúscula em toda palavra. A maiúscula agora é só a da primeira letra, feita no código.
 */

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { StyleSheet, type TextStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { configureDateLocale } from '../../../utils/dateUtils';
import CommittedSection from '../CommittedSection';

let renderer: ReactTestRenderer | null = null;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

const month = {
	month: '2026-11',
	cards: [{ accountId: 'nubank', name: 'Nubank', cents: 123_456 }],
	cardCents: 123_456,
	debts: [],
	debtCents: 0,
	fixedCents: 0,
	totalCents: 123_456,
};

beforeAll(() => configureDateLocale('pt-BR'));

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

it('o nome do mês tem a maiúscula no texto, não no estilo', async () => {
	await act(async () => {
		renderer = create(<CommittedSection months={[month]} />);
	});
	const node = (renderer as ReactTestRenderer).root
		.findAll(isHostText)
		.find((text) => [text.props.children].flat().join('') === 'Novembro 2026');
	expect(node).toBeDefined();
	const style = StyleSheet.flatten(node?.props.style) as TextStyle | undefined;
	expect(style?.textTransform).toBeUndefined();
});
