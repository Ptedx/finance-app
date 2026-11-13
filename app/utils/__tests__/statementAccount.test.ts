/**
 * A conta de um extrato OFX (E2E-34).
 *
 * O extrato do cartão Nubank que já existia no app ("Nubank Teste", final 1111) criou um
 * segundo cartão, "NU PAGAMENTOS S.A. · cartão final 1111", e esse cartão mostrou
 * "Crédito no cartão R$ 1.038,66" quando o banco dizia R$ 195,90 devidos. O arquivo do
 * teste é o mesmo do aparelho (`fixtures/e2e-cartao.ofx`, dados fictícios).
 */

jest.mock('../../database/database', () => ({
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addAccount, findAccountByKey, getAccounts, updateAccount } from '../../database/database';
import type { Account } from '../../database/schema';
import { resolveAccountForStatement, type StatementAccountChooser } from '../accountResolver';
import { type CardEntry, type CardMovement, owedOn } from '../cardMath';
import { type OfxAccount, parseOfx } from '../ofxParser';

const E2E_CARD_OFX = readFileSync(join(__dirname, 'fixtures', 'e2e-cartao.ofx'), 'latin1');

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

const nubankTeste = account({
	id: 'nubank-teste',
	name: 'Nubank Teste',
	kind: 'credit_card',
	role: 'card',
	bankName: 'Nubank',
	last4: '1111',
	packageName: 'com.nu.production',
	closingDay: 3,
	dueDay: 10,
	openingBalanceDate: '2026-10-20',
});

const mocked = {
	addAccount: addAccount as jest.Mock,
	updateAccount: updateAccount as jest.Mock,
	findAccountByKey: findAccountByKey as jest.Mock,
	getAccounts: getAccounts as jest.Mock,
};

/** O banco falso: devolve as contas dadas e, depois de criar, também a nova (com o rascunho). */
const withAccounts = (accounts: Account[]) => {
	let created: Account | null = null;
	mocked.addAccount.mockImplementation(async (draft: Omit<Account, 'id' | 'updatedAt'>) => {
		created = { ...draft, id: 'nova', updatedAt: '' } as Account;
		return 'nova';
	});
	mocked.getAccounts.mockImplementation(async () => (created ? [...accounts, created] : accounts));
};

const e2eCard = (): OfxAccount => parseOfx(E2E_CARD_OFX).accounts[0];

beforeEach(() => {
	jest.clearAllMocks();
	mocked.findAccountByKey.mockResolvedValue(null);
});

describe('o banco de um extrato de cartão (E2E-34)', () => {
	it('vem do FID do cabeçalho quando o cartão não traz BANKID: 260 é o Nubank', () => {
		const statement = e2eCard();
		expect(statement.isCard).toBe(true);
		expect(statement.bankName).toBe('Nubank');
		// A chave não muda: é por ela que os próximos imports acham o cartão.
		expect(statement.accountKey).toBe('card:e2e-1111');
	});

	it('sem FID conhecido, o ORG vira a marca: "NU PAGAMENTOS S.A." é o Nubank', () => {
		const statement = parseOfx(E2E_CARD_OFX.replace('<FID>260', '<FID>999')).accounts[0];
		expect(statement.bankName).toBe('Nubank');
	});
});

describe('extrato do cartão que já existe (E2E-34)', () => {
	it('casa com o cartão do mesmo final e do mesmo banco, sem perguntar e sem criar outro', async () => {
		withAccounts([nubankTeste]);
		const choose = jest.fn<ReturnType<StatementAccountChooser>, Parameters<StatementAccountChooser>>();

		const resolved = await resolveAccountForStatement(e2eCard(), choose);

		expect(resolved.id).toBe('nubank-teste');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(choose).not.toHaveBeenCalled();
		// O cartão ganha a chave do extrato: o próximo import o acha direto.
		expect(mocked.updateAccount).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'nubank-teste', accountKey: 'card:e2e-1111', last4: '1111' })
		);
	});

	it('casa também pelo ORG quando o FID não é conhecido', async () => {
		withAccounts([nubankTeste]);
		const statement = parseOfx(E2E_CARD_OFX.replace('<FID>260', '<FID>999')).accounts[0];

		expect((await resolveAccountForStatement(statement)).id).toBe('nubank-teste');
		expect(mocked.addAccount).not.toHaveBeenCalled();
	});

	it('casa pelo final de um cartão virtual nomeado', async () => {
		withAccounts([{ ...nubankTeste, last4: '2222', cardNames: JSON.stringify({ '1111': 'Virtual' }) }]);

		expect((await resolveAccountForStatement(e2eCard())).id).toBe('nubank-teste');
	});

	it('o cartão arquivado não é adotado', async () => {
		withAccounts([{ ...nubankTeste, archived: true }]);

		expect((await resolveAccountForStatement(e2eCard())).id).toBe('nova');
	});

	it('só o final bate (banco diferente): pergunta, e "este" adota o cartão', async () => {
		const itau = { ...nubankTeste, id: 'itau-1111', name: 'Itaú Click', bankName: 'Itaú' };
		const other = account({ id: 'inter-card', name: 'Inter', kind: 'credit_card', bankName: 'Inter', last4: '9999' });
		withAccounts([itau, other]);
		const choose = jest.fn<ReturnType<StatementAccountChooser>, Parameters<StatementAccountChooser>>(async () => ({
			type: 'existing' as const,
			accountId: 'itau-1111',
		}));

		const resolved = await resolveAccountForStatement(e2eCard(), choose);

		expect(choose).toHaveBeenCalledTimes(1);
		const question = choose.mock.calls[0][0];
		expect(question.isCard).toBe(true);
		expect(question.last4).toBe('1111');
		expect(question.candidates.map((card) => card.id)).toEqual(['itau-1111']);
		// "Outro cartão": os outros cartões sem extrato, para o usuário escolher.
		expect(question.others.map((card) => card.id)).toEqual(['inter-card']);
		expect(resolved.id).toBe('itau-1111');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(mocked.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'itau-1111', accountKey: 'card:e2e-1111' }));
	});

	it('só o final bate e o usuário escolhe "criar novo": nasce o cartão do extrato', async () => {
		withAccounts([{ ...nubankTeste, bankName: 'Itaú' }]);

		const resolved = await resolveAccountForStatement(e2eCard(), async () => ({ type: 'new' }));

		expect(resolved.id).toBe('nova');
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('só o final bate e não há a quem perguntar: cria, sem juntar no chute', async () => {
		withAccounts([{ ...nubankTeste, bankName: 'Itaú' }]);

		expect((await resolveAccountForStatement(e2eCard())).id).toBe('nova');
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});

	it('dois cartões Nubank com final 1111: pergunta entre os dois', async () => {
		const twin = { ...nubankTeste, id: 'nubank-2', name: 'Nubank Ultravioleta' };
		withAccounts([nubankTeste, twin]);
		const choose = jest.fn<ReturnType<StatementAccountChooser>, Parameters<StatementAccountChooser>>(async () => ({
			type: 'existing' as const,
			accountId: 'nubank-2',
		}));

		const resolved = await resolveAccountForStatement(e2eCard(), choose);

		expect(choose.mock.calls[0][0].candidates.map((card) => card.id)).toEqual(['nubank-teste', 'nubank-2']);
		expect(resolved.id).toBe('nubank-2');
	});

	it('o cartão já ligado ao extrato é achado pela chave, sem pergunta', async () => {
		const linked = { ...nubankTeste, accountKey: 'card:e2e-1111' };
		withAccounts([linked]);
		mocked.findAccountByKey.mockResolvedValue(linked);
		const choose = jest.fn();

		expect((await resolveAccountForStatement(e2eCard(), choose)).id).toBe('nubank-teste');
		expect(choose).not.toHaveBeenCalled();
	});
});

describe('extrato da conta corrente: ACCTID + banco', () => {
	const checkingOfx = (acctId: string): OfxAccount => ({
		accountKey: `0260:${acctId}`,
		bankId: '0260',
		acctId,
		acctType: 'CHECKING',
		isCard: false,
		bankName: 'Nubank',
		currency: 'BRL',
		entries: [],
		skipped: 0,
		ledgerBalanceCents: null,
		ledgerDate: null,
	});

	it('uma conta do banco: adota', async () => {
		withAccounts([account({ id: 'nu-pf', name: 'Nubank', bankName: 'Nubank' })]);

		expect((await resolveAccountForStatement(checkingOfx('12345678-9'))).id).toBe('nu-pf');
	});

	it('duas contas do banco, uma com o final da conta do extrato: adota essa', async () => {
		withAccounts([
			account({ id: 'nu-pj', name: 'Nubank PJ', bankName: 'Nubank', last4: '4321' }),
			account({ id: 'nu-pf', name: 'Nubank PF', bankName: 'Nubank', last4: '6789' }),
		]);

		expect((await resolveAccountForStatement(checkingOfx('12345678-9'))).id).toBe('nu-pf');
	});

	it('duas contas do banco sem nada que as separe: pergunta', async () => {
		withAccounts([
			account({ id: 'nu-pj', name: 'Nubank PJ', bankName: 'Nubank' }),
			account({ id: 'nu-pf', name: 'Nubank PF', bankName: 'Nubank' }),
		]);
		const choose = jest.fn<ReturnType<StatementAccountChooser>, Parameters<StatementAccountChooser>>(async () => ({
			type: 'existing' as const,
			accountId: 'nu-pf',
		}));

		const resolved = await resolveAccountForStatement(checkingOfx('12345678-9'), choose);

		expect(choose.mock.calls[0][0].isCard).toBe(false);
		expect(choose.mock.calls[0][0].candidates.map((item) => item.id)).toEqual(['nu-pj', 'nu-pf']);
		expect(resolved.id).toBe('nu-pf');
		expect(mocked.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'nu-pf', accountKey: '0260:12345678-9' }));
	});
});

describe('o saldo do cartão novo pelo LEDGERBAL (E2E-34)', () => {
	it('a âncora fica na véspera da primeira linha, com o que se devia antes do extrato', async () => {
		withAccounts([]);

		const created = await resolveAccountForStatement(e2eCard());

		expect(created.kind).toBe('credit_card');
		expect(created.openingBalanceDate).toBe('2026-10-31');
		// −195,90 no fim do extrato, menos o que as linhas moveram (−50 −45,90 −100 +1.234,56):
		// antes do extrato o cartão devia R$ 1.234,56, a fatura que o pagamento quitou.
		expect(created.openingBalanceCents).toBe(-123_456);
	});

	it('com as compras e o pagamento do extrato, o valor devido é o do banco: R$ 195,90', async () => {
		withAccounts([]);
		const statement = e2eCard();
		const created = await resolveAccountForStatement(statement);

		// As compras entram no cartão (revisadas ou provisórias); o "Pagamento recebido" entra
		// como transferência para o cartão (`recordInvoicePayment`).
		const entries: CardEntry[] = statement.entries
			.filter((entry) => entry.direction === 'out')
			.map((entry) => ({
				id: entry.fitid,
				amountCents: entry.amountCents,
				isIncome: false,
				date: entry.postedDate,
				note: entry.memo,
				category: 'outros',
				installmentGroup: null,
				installmentIndex: null,
				installmentCount: null,
				cardLast4: null,
			}));
		const movements: CardMovement[] = [{ amountCents: 123_456, date: '2026-11-05', inbound: true }];

		expect(owedOn(created, entries, movements, '2026-11-07')).toBe(19_590);
	});

	it('LEDGERBAL positivo num cartão (sinal invertido por alguns bancos) não vira âncora', async () => {
		withAccounts([]);
		const statement = parseOfx(E2E_CARD_OFX.replace('<BALAMT>-195.90', '<BALAMT>195.90')).accounts[0];

		const created = await resolveAccountForStatement(statement);

		expect(created.openingBalanceCents).toBe(0);
		expect(created.openingBalanceDate).toBe('2026-10-31');
	});

	it('o cartão que já existia não é reancorado: o saldo dele é o que o usuário informou', async () => {
		withAccounts([nubankTeste]);

		await resolveAccountForStatement(e2eCard());

		expect(mocked.updateAccount).toHaveBeenCalledWith(
			expect.objectContaining({ openingBalanceCents: 0, openingBalanceDate: '2026-10-20' })
		);
	});
});
