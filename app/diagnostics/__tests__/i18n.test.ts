import en from '../../i18n/locales/en';
import itLocale from '../../i18n/locales/it';
import pt from '../../i18n/locales/pt';

/** Os textos de "Exportar diagnóstico" existem nos três idiomas, e não vazios. */
describe('textos do diagnóstico', () => {
	const KEYS = [
		'exportItem',
		'confirmTitle',
		'confirmMsg',
		'confirmAction',
		'emptyTitle',
		'emptyMsg',
		'unavailableMsg',
		'failedTitle',
		'failedMsg',
	] as const;

	it.each([
		['pt', pt],
		['en', en],
		['it', itLocale],
	])('%s', (_name, locale) => {
		const section = (locale as unknown as { diagnostics?: Record<string, unknown> }).diagnostics;
		for (const key of KEYS) {
			expect(typeof section?.[key]).toBe('string');
			expect(String(section?.[key]).trim().length).toBeGreaterThan(0);
		}
	});

	it('a confirmação avisa que pode haver texto de notificação do banco', () => {
		expect(pt.diagnostics?.confirmMsg).toMatch(/notifica/i);
		expect(en.diagnostics?.confirmMsg).toMatch(/notification/i);
		expect(itLocale.diagnostics?.confirmMsg).toMatch(/notific/i);
	});
});
