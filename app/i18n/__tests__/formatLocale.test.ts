import { formatDate } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import i18n, { applyFormatLocale } from '../index';

/**
 * O formato tem que seguir o idioma **do app**, inclusive quando ele muda depois de o app
 * carregar — é o que acontece quando o idioma vem de uma preferência salva ou da tela de
 * Ajustes. Já saiu errado duas vezes ("R$154.80" e "Sep 16" num app em português), então
 * fica testado.
 */
describe('formato segue o idioma do app', () => {
	afterAll(() => applyFormatLocale('en'));

	it('trocar para português muda dinheiro e datas', async () => {
		await i18n.changeLanguage('pt');
		// O símbolo vem da moeda escolhida (aqui o padrão); o que se testa é o formato.
		expect(formatCents(15_480)).toContain('154,80');
		expect(formatDate('2026-09-16')).toBe('16 set');
	});

	it('voltar para inglês muda de volta', async () => {
		await i18n.changeLanguage('en');
		expect(formatDate('2026-09-16')).toBe('Sep 16');
	});
});
