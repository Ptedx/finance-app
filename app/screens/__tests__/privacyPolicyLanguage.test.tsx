/**
 * A política de privacidade no idioma do app (SPD-118).
 *
 * O texto estava fixo em português dentro da tela: quem usa o app em inglês ou italiano lia
 * a política em português. A tela segue o idioma do i18next, como o resto do app, e cai no
 * português quando o idioma não tem versão da política.
 */

let mockLanguage = 'pt';

jest.mock('expo-router', () => ({
	Stack: { Screen: () => null },
}));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: mockLanguage },
	}),
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import PrivacyPolicyScreen from '../PrivacyPolicyScreen';

let renderer: ReactTestRenderer;

/** Todo o texto que a tela desenhou, numa string só. */
const screenText = async (language: string): Promise<string> => {
	mockLanguage = language;
	await act(async () => {
		renderer = create(<PrivacyPolicyScreen />);
	});
	const strings: string[] = [];
	const collect = (node: unknown): void => {
		if (typeof node === 'string') strings.push(node);
		else if (Array.isArray(node)) node.forEach(collect);
		else if (node && typeof node === 'object' && 'children' in node) collect((node as { children: unknown }).children);
	};
	collect(renderer.toJSON());
	return strings.join('');
};

afterEach(() => {
	act(() => renderer.unmount());
});

describe('SPD-118 — política de privacidade no idioma do app', () => {
	it('em inglês, a tela mostra a política em inglês', async () => {
		const text = await screenText('en');
		expect(text).toContain('Your data is yours.');
		expect(text).toContain('What stays on your device');
		expect(text).toContain('Updated October 27, 2026');
		expect(text).not.toContain('Seus dados são seus.');
	});

	it('em italiano, a tela mostra a política em italiano', async () => {
		const text = await screenText('it');
		expect(text).toContain('I tuoi dati sono tuoi.');
		expect(text).toContain('Cosa resta sul tuo dispositivo');
		expect(text).toContain('Aggiornata il 27 ottobre 2026');
		expect(text).not.toContain('Seus dados são seus.');
	});

	it('em português, continua em português', async () => {
		const text = await screenText('pt');
		expect(text).toContain('Seus dados são seus.');
		expect(text).toContain('O que fica no seu aparelho');
		expect(text).toContain('Atualizada em 27 de outubro de 2026');
	});

	it('num idioma sem versão da política, cai no português', async () => {
		const text = await screenText('de');
		expect(text).toContain('Seus dados são seus.');
	});

	it.each(['pt', 'en', 'it'])('em %s, o contato é o mesmo e-mail', async (language) => {
		expect(await screenText(language)).toContain('vinicosta37@gmail.com');
	});
});
