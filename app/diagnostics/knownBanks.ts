/**
 * Apps de banco conhecidos, pelo nome do pacote Android.
 *
 * É a fronteira da DEC-11 (b): texto cru de notificação só entra no diário quando vem de um
 * destes apps. Mensageiro, e-mail, carteira digital e qualquer outro app ficam só com
 * metadados — o texto deles é conversa pessoal, não aviso de banco.
 *
 * O serviço nativo tem a mesma lista (`KnownBanks.kt`), porque é ele quem decide o que
 * guardar antes de o JS existir; `knownBanks.test.ts` confere que as duas são iguais.
 * Banco que falta aqui não perde captura nenhuma: só o diário fica sem o texto dele.
 */
export const KNOWN_BANK_PACKAGES: ReadonlySet<string> = new Set([
	'com.nu.production',
	'br.com.intermedium',
	'br.com.inter.pj',
	'com.itau',
	'br.com.itau.personnalite',
	'com.bradesco',
	'br.com.bradesco.next',
	'com.santander.app',
	'br.com.bb.android',
	'br.com.gabba.Caixa',
	'com.c6bank.app',
	'com.picpay',
	'com.mercadopago.wallet',
	'br.com.neon',
	'br.com.uol.ps.myaccount',
]);

export const isKnownBankPackage = (packageName: string | null | undefined): boolean =>
	typeof packageName === 'string' && KNOWN_BANK_PACKAGES.has(packageName);
