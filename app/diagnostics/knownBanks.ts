/**
 * Apps de banco conhecidos, pelo nome do pacote Android, e o banco de cada um.
 *
 * É a fronteira da DEC-11 (b): texto cru de notificação só entra no diário quando vem de um
 * destes apps. Mensageiro, e-mail, carteira digital e qualquer outro app ficam só com
 * metadados — o texto deles é conversa pessoal, não aviso de banco.
 *
 * O serviço nativo tem a mesma lista (`KnownBanks.kt`), porque é ele quem decide o que
 * guardar antes de o JS existir; `knownBanks.test.ts` confere que as duas são iguais.
 * Banco que falta aqui não perde captura nenhuma: só o diário fica sem o texto dele.
 *
 * O banco de cada pacote é o que o resolvedor usa quando o nome do app na tela não é um que
 * o app reconheça (`asBankApp`, SPD-112): o PicPay que aparece como "Carteira digital"
 * continua sendo o PicPay. O nome é um que `brandFor` reconhece (o teste confere).
 */
export const KNOWN_BANK_APPS: ReadonlyMap<string, string> = new Map([
	['com.nu.production', 'Nubank'],
	['br.com.intermedium', 'Inter'],
	['br.com.inter.pj', 'Inter'],
	['com.itau', 'Itaú'],
	['br.com.itau.personnalite', 'Itaú'],
	['com.bradesco', 'Bradesco'],
	['br.com.bradesco.next', 'Next'],
	['com.santander.app', 'Santander'],
	['br.com.bb.android', 'Banco do Brasil'],
	['br.com.gabba.Caixa', 'Caixa'],
	['com.c6bank.app', 'C6 Bank'],
	['com.picpay', 'PicPay'],
	['com.mercadopago.wallet', 'Mercado Pago'],
	['br.com.neon', 'Neon'],
	['br.com.uol.ps.myaccount', 'PagBank'],
]);

export const KNOWN_BANK_PACKAGES: ReadonlySet<string> = new Set(KNOWN_BANK_APPS.keys());

export const isKnownBankPackage = (packageName: string | null | undefined): boolean =>
	typeof packageName === 'string' && KNOWN_BANK_PACKAGES.has(packageName);

/** O banco do app conhecido pelo pacote, ou nulo. */
export const bankOfPackage = (packageName: string | null | undefined): string | null =>
	typeof packageName === 'string' ? (KNOWN_BANK_APPS.get(packageName) ?? null) : null;
