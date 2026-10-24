jest.mock('../../database/database', () => ({
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
}));

import { addAccount, findAccountByKey, findAccountBySource, getAccounts, updateAccount } from '../../database/database';
import type { Account } from '../../database/schema';
import { isNoBankNotice, isNonBankApp, isSmsPackage, resolveAccountForNotification, SMS_PACKAGES } from '../accountResolver';
import type { ParsedCapture, RawCapture } from '../captureParser';

const INTER = 'br.com.intermedium';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

/** A compra no débito que o Inter avisa: sem final de cartão, então é a conta corrente. */
const debitPurchase: RawCapture = {
	packageName: INTER,
	appLabel: 'Inter',
	title: 'Inter',
	text: 'Olá Vinicius, você acaba de comprar no débito no ATACADAO DIA A DIA o valor de R$ 26,47.',
	postedAt: '2026-09-19T23:51:00.000Z',
};

const parsed: ParsedCapture = {
	amountCents: 2647,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'ATACADAO DIA A DIA',
	cardLast4: null,
	neutral: false,
	installments: null,
};

const mocked = {
	addAccount: addAccount as jest.Mock,
	updateAccount: updateAccount as jest.Mock,
	findAccountBySource: findAccountBySource as jest.Mock,
	findAccountByKey: findAccountByKey as jest.Mock,
	getAccounts: getAccounts as jest.Mock,
};

/** O resolvedor relê as contas depois de criar: o banco falso precisa devolver a nova. */
const withAccounts = (accounts: Account[]) => {
	let created = false;
	mocked.addAccount.mockImplementation(async () => {
		created = true;
		return 'nova';
	});
	mocked.getAccounts.mockImplementation(async () => (created ? [...accounts, account({ id: 'nova', name: 'Inter', bankName: 'Inter', packageName: INTER })] : accounts));
};

beforeEach(() => {
	jest.clearAllMocks();
	mocked.findAccountBySource.mockResolvedValue(null);
	mocked.findAccountByKey.mockResolvedValue(null);
});

describe('a conta de uma notificação', () => {
	it('adota a conta do mesmo banco cadastrada à mão, em vez de criar uma segunda', async () => {
		withAccounts([account({ id: 'inter-pf', name: 'Inter PF', role: 'envelope', bankName: 'Inter' })]);

		const resolved = await resolveAccountForNotification(debitPurchase, parsed);

		expect(resolved?.id).toBe('inter-pf');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		// A conta passa a conhecer o app: a próxima notificação cai nela direto.
		expect(mocked.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'inter-pf', packageName: INTER }));
	});

	it('adota também a conta que veio do extrato (OFX)', async () => {
		withAccounts([account({ id: 'inter-ofx', name: 'Inter', bankName: 'Inter', accountKey: 'inter:0001' })]);

		expect((await resolveAccountForNotification(debitPurchase, parsed))?.id).toBe('inter-ofx');
		expect(mocked.addAccount).not.toHaveBeenCalled();
	});

	it('com duas contas do mesmo banco não adivinha: cria a conta do app', async () => {
		withAccounts([account({ id: 'inter-pf', name: 'Inter PF', bankName: 'Inter' }), account({ id: 'inter-pj', name: 'Inter PJ', bankName: 'Inter' })]);

		await resolveAccountForNotification(debitPurchase, parsed);

		expect(mocked.addAccount).toHaveBeenCalledTimes(1);
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('não adota conta de outro banco, nem cartão de crédito do mesmo banco', async () => {
		withAccounts([
			account({ id: 'nu-pf', name: 'Nubank PF', bankName: 'Nubank' }),
			account({ id: 'inter-card', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter' }),
		]);

		await resolveAccountForNotification(debitPurchase, parsed);

		expect(mocked.addAccount).toHaveBeenCalledTimes(1);
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('conta apagada não adota', async () => {
		withAccounts([account({ id: 'inter-old', name: 'Inter', bankName: 'Inter', deletedAt: '2026-09-10T00:00:00.000Z' })]);

		await resolveAccountForNotification(debitPurchase, parsed);

		expect(mocked.addAccount).toHaveBeenCalledTimes(1);
	});

	it('app que não é banco não vira conta: a captura fica sem conta', async () => {
		withAccounts([account({ id: 'inter-pf', name: 'Inter PF', bankName: 'Inter' })]);

		const resolved = await resolveAccountForNotification(
			{
				packageName: 'com.whatsapp',
				appLabel: 'WhatsApp',
				title: 'Mãe',
				text: 'passa R$ 26,47 pra mim depois',
				postedAt: '2026-09-19T23:51:00.000Z',
			},
			parsed
		);

		expect(resolved).toBeNull();
		expect(mocked.addAccount).not.toHaveBeenCalled();
	});

	// Achado 7.6: a compra ia para a conta corrente, e R$ 480 saíam do saldo ficando fora
	// das duas faturas. "Não dá para responder" é resposta: sem conta, e o usuário atribui.
	it('compra "no crédito" com dois cartões do banco fica sem conta, nunca na conta corrente', async () => {
		const NUBANK = 'com.nu.production';
		const card = (id: string, last4: string): Account =>
			account({ id, name: `Cartão ${last4}`, kind: 'credit_card', role: 'card', bankName: 'Nubank', packageName: NUBANK, last4 });
		withAccounts([
			card('nu-1', '1534'),
			card('nu-2', '9999'),
			account({ id: 'nu-cc', name: 'Nubank', bankName: 'Nubank', packageName: NUBANK }),
		]);

		const resolved = await resolveAccountForNotification(
			{
				packageName: NUBANK,
				appLabel: 'Nubank',
				title: 'Compra no crédito aprovada',
				text: 'Compra de R$ 480,00 APROVADA em LOJA para o cartão com final 7777.',
				postedAt: '2026-10-06T19:00:00.000Z',
			},
			{ amountCents: 48_000, direction: 'out', kind: 'purchase', counterparty: 'LOJA', cardLast4: '7777', neutral: false, installments: null }
		);

		expect(resolved).toBeNull();
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('aviso repassado por SMS cai na conta do banco que o texto cita, sem levar o app do SMS', async () => {
		const inter = account({ id: 'inter-app', name: 'Inter', bankName: 'Inter', packageName: INTER });
		withAccounts([inter]);

		const resolved = await resolveAccountForNotification(
			{
				packageName: 'com.google.android.apps.messaging',
				appLabel: 'Messages',
				title: 'Inter',
				text: 'Banco Inter: compra no débito aprovada de R$ 26,47 no ATACADAO DIA A DIA.',
				postedAt: '2026-09-19T23:51:00.000Z',
			},
			parsed
		);

		expect(resolved?.id).toBe('inter-app');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		// O pacote do SMS nunca vira a origem da conta: senão o Messages "viraria" o banco.
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('final de débito nomeado numa conta corrente leva a compra para ela', async () => {
		withAccounts([
			account({
				id: 'inter-pf',
				name: 'Inter PF',
				bankName: 'Inter',
				cardNames: '{"0443":"Débito Inter"}',
			}),
			account({ id: 'inter-credito', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER }),
		]);

		const resolved = await resolveAccountForNotification(
			{ ...debitPurchase, text: 'Compra aprovada no cartão final 0443 no ATACADAO DIA A DIA de R$ 26,47' },
			{ ...parsed, cardLast4: '0443' }
		);

		// O cartão de crédito do Inter é o único do banco, mas o final declarado vence.
		expect(resolved?.id).toBe('inter-pf');
		expect(mocked.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'inter-pf', packageName: INTER }));
	});

	it('a conta que já tem o app vem direto, sem adoção', async () => {
		const bound = account({ id: 'inter-app', name: 'Inter', bankName: 'Inter', packageName: INTER });
		mocked.findAccountBySource.mockResolvedValue(bound);
		withAccounts([bound]);

		expect((await resolveAccountForNotification(debitPurchase, parsed))?.id).toBe('inter-app');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});
});

describe('conta arquivada ligada ao app (SPD-002)', () => {
	it('só a arquivada é do app: a captura fica sem conta, sem nascer outra no lugar dela', async () => {
		withAccounts([account({ id: 'inter-velha', name: 'Inter', bankName: 'Inter', packageName: INTER, archived: true })]);

		const resolved = await resolveAccountForNotification(debitPurchase, parsed);

		expect(resolved).toBeNull();
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('não adota uma conta arquivada sem app como gêmea', async () => {
		withAccounts([account({ id: 'inter-arquivada', name: 'Inter PF', bankName: 'Inter', archived: true })]);

		await resolveAccountForNotification(debitPurchase, parsed);

		expect(mocked.updateAccount).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'inter-arquivada' }));
	});

	it('arquivada ligada ao app + a do mesmo banco ativa sem app: vai para a ativa', async () => {
		withAccounts([
			account({ id: 'inter-velha', name: 'Inter', bankName: 'Inter', packageName: INTER, archived: true }),
			account({ id: 'inter-pf', name: 'Inter PF', bankName: 'Inter' }),
		]);

		expect((await resolveAccountForNotification(debitPurchase, parsed))?.id).toBe('inter-pf');
		expect(mocked.addAccount).not.toHaveBeenCalled();
	});
});

/**
 * SPD-022 (DEC-08 a): aviso de app que não é banco e não cita banco nenhum é ignorado
 * direto. As exceções são o que conta como banco: o app do banco, a carteira (que tem
 * tratamento próprio) e o Mercado Pago, que é conta do usuário — onde fica a reserva.
 */
describe('o que conta como banco (SPD-022)', () => {
	const MERCADO_PAGO = 'com.mercadopago.wallet';
	const notice = (packageName: string, appLabel: string, title: string, text: string): RawCapture => ({
		packageName,
		appLabel,
		title,
		text,
		postedAt: '2026-10-23T15:00:00.000Z',
	});

	it('conversa no WhatsApp citando Pix não diz de banco nenhum (C67)', () => {
		const raw = notice('com.whatsapp', 'WhatsApp', 'Maria', 'Pix enviado! R$ 50,00, confere aí');
		expect(isNonBankApp(raw)).toBe(true);
		expect(isNoBankNotice(raw)).toBe(true);
	});

	it('"pedido enviado" do app de compras também não (C66)', () => {
		expect(isNoBankNotice(notice('com.amazon.mShop.android.shopping', 'Amazon', 'Pedido enviado', 'Seu pedido de R$ 129,90 foi enviado.'))).toBe(true);
	});

	it('SMS e e-mail que citam o banco não são ignorados direto: seguem para a revisão', () => {
		const sms = notice('com.google.android.apps.messaging', 'Mensagens', 'Bradesco', 'BRADESCO CARTOES: COMPRA APROVADA NO CARTAO FINAL 3456 DE R$ 45,00');
		const mail = notice('com.google.android.gm', 'Gmail', 'Santander', 'Compra no cartão final 7890 aprovada: R$ 199,90 em LOJA ABC.');
		expect(isNonBankApp(sms)).toBe(true);
		expect(isNoBankNotice(sms)).toBe(false);
		expect(isNoBankNotice(mail)).toBe(false);
	});

	it('os apps de SMS conhecidos estão na lista, e só eles', () => {
		for (const sms of [
			'com.google.android.apps.messaging',
			'com.samsung.android.messaging',
			'com.android.mms',
			'com.android.messaging',
			'com.motorola.messaging',
			'com.oneplus.mms',
			'com.miui.mms',
		]) {
			expect(SMS_PACKAGES.has(sms)).toBe(true);
			expect(isSmsPackage(sms)).toBe(true);
		}
		for (const other of ['com.google.android.gm', 'com.whatsapp', INTER, 'com.mercadopago.wallet']) {
			expect(isSmsPackage(other)).toBe(false);
		}
	});

	it('o SMS continua sendo app que não é banco: sem banco citado, é ignorado direto', () => {
		const raw = notice('com.samsung.android.messaging', 'Mensagens', 'Loja', 'Seu pedido de R$ 129,90 foi enviado.');
		expect(isNonBankApp(raw)).toBe(true);
		expect(isNoBankNotice(raw)).toBe(true);
	});

	it('o app do banco nunca é "app que não é banco", diga o texto o que disser', () => {
		const raw = notice(INTER, 'Inter', 'Inter', 'Você tem uma nova mensagem de R$ 10,00');
		expect(isNonBankApp(raw)).toBe(false);
		expect(isNoBankNotice(raw)).toBe(false);
	});

	it('a carteira não cai nessas regras, mesmo sem citar banco: ela tem tratamento próprio', () => {
		for (const wallet of ['com.samsung.android.spay', 'com.google.android.apps.walletnfcrel']) {
			const raw = notice(wallet, 'Carteira', 'IFOOD', 'R$ 35,90 com Mastercard •••• 1534');
			expect(isNonBankApp(raw)).toBe(false);
			expect(isNoBankNotice(raw)).toBe(false);
		}
	});

	it('o Mercado Pago é banco pelo pacote, com o nome de sempre ou com outro nome na tela', () => {
		for (const appLabel of ['Mercado Pago', 'Carteira']) {
			const raw = notice(MERCADO_PAGO, appLabel, 'Pagamento aprovado', 'Você pagou R$ 32,50 para LOJA DO ZE.');
			expect(isNonBankApp(raw)).toBe(false);
			expect(isNoBankNotice(raw)).toBe(false);
		}
	});

	it('o aviso do Mercado Pago vira a conta do Mercado Pago, mesmo com outro nome na tela', async () => {
		withAccounts([]);

		await resolveAccountForNotification(
			notice(MERCADO_PAGO, 'Carteira', 'Pagamento aprovado', 'Você pagou R$ 32,50 para LOJA DO ZE.'),
			{ ...parsed, amountCents: 3250, counterparty: 'LOJA DO ZE' }
		);

		expect(mocked.addAccount).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Mercado Pago', bankName: 'Mercado Pago', packageName: MERCADO_PAGO, kind: 'checking' })
		);
	});

	it('e adota a conta Mercado Pago cadastrada à mão (a da reserva), em vez de criar outra', async () => {
		withAccounts([account({ id: 'reserva', name: 'Reserva', role: 'reserve', bankName: 'Mercado Pago' })]);

		const resolved = await resolveAccountForNotification(
			notice(MERCADO_PAGO, 'Mercado Pago', 'Pix recebido', 'Você recebeu R$ 100,00 de FULANO.'),
			{ ...parsed, amountCents: 10_000, direction: 'in', kind: 'pix_in', counterparty: 'FULANO' }
		);

		expect(resolved?.id).toBe('reserva');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(mocked.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'reserva', packageName: MERCADO_PAGO }));
	});
});
