/**
 * O filtro "tem valor" do serviço nativo (`CaptureListenerService.kt`), lido do próprio
 * Kotlin para o teste e o serviço não divergirem (NOTIF-19, SPD-045).
 *
 * "R$  35,90" (dois espaços), "R$ 35,90" com espaço não separável (U+00A0, o que o
 * `Intl.NumberFormat` pt-BR produz) ou com espaço fino (U+202F) eram jogados fora antes de
 * chegar ao app. O `\s` do regex Java não garante esses espaços, então o filtro os lista um
 * a um; o `RegExp` do JS lê o mesmo texto do mesmo jeito.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCapture } from '../../../app/utils/captureParser';

const NATIVE_SERVICE = path.join(
	__dirname,
	'../android/src/main/java/expo/modules/spendrcaptures/CaptureListenerService.kt'
);

const nativeFilter = (): RegExp => {
	const match = /val AMOUNT\s*=\s*Regex\("""(.+?)"""\)/.exec(fs.readFileSync(NATIVE_SERVICE, 'utf8'));
	if (!match) throw new Error('filtro do serviço nativo não encontrado');
	return new RegExp(match[1]);
};

/**
 * O mesmo filtro com o `\s` do Java sem `UNICODE_CHARACTER_CLASS`: só espaço, tab e quebras.
 * O `\s` do JS já aceita o U+00A0 e o U+202F, e o teste passaria sem o filtro listá-los.
 * A troca supõe o `\s` dentro de uma classe (`[\s...]`), como está no Kotlin.
 */
const javaFilter = (): RegExp => new RegExp(nativeFilter().source.replace(/\\s/g, ' \\t\\n\\x0B\\f\\r'));

const notice = (amount: string) => `Compra de ${amount} APROVADA em IFOOD para o cartão com final 1534.`;

describe('filtro de valor do serviço nativo (SPD-045)', () => {
	it.each([
		['um espaço', 'R$ 35,90'],
		['sem espaço', 'R$35,90'],
		['dois espaços', 'R$  35,90'],
		['espaço não separável', 'R$\u00a035,90'],
		['espaço fino não separável', 'R$\u202f35,90'],
		['espaço de figura', 'R$\u200735,90'],
		['espaços misturados', 'R$ \u00a0 35,90'],
		['tabulação', 'R$\t35,90'],
	])('%s entre "R$" e o número passa, e o parser lê R$ 35,90', (_label, amount) => {
		const text = notice(amount);
		expect(nativeFilter().test(text)).toBe(true);
		expect(javaFilter().test(text)).toBe(true);
		expect(parseCapture({ packageName: 'com.nu.production', appLabel: 'Nubank', title: 'Compra aprovada', text, postedAt: '2026-10-24T10:00:00.000Z' })?.amountCents).toBe(3590);
	});

	it('a saída do Intl.NumberFormat pt-BR passa', () => {
		const formatted = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(35.9);
		expect(nativeFilter().test(notice(formatted))).toBe(true);
		expect(javaFilter().test(notice(formatted))).toBe(true);
	});

	it.each([['US$\u00a015,99'], ['USD  15,99'], ['€\u202f20,00'], ['£  8,50']])('outra moeda com espaços: "%s" passa', (amount) => {
		expect(nativeFilter().test(notice(amount))).toBe(true);
		expect(javaFilter().test(notice(amount))).toBe(true);
	});

	it.each([['Seu código é 123456'], ['R$ mil de cashback'], ['Pague com R$ e ganhe']])('sem valor continua de fora: "%s"', (text) => {
		expect(nativeFilter().test(text)).toBe(false);
		expect(javaFilter().test(text)).toBe(false);
	});
});
