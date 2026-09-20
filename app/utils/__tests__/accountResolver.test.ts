jest.mock('../../database/database', () => ({
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
}));

import { addAccount, findAccountByKey, findAccountBySource, getAccounts, updateAccount } from '../../database/database';
import type { Account } from '../../database/schema';
import { resolveAccountForNotification } from '../accountResolver';
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

		expect(resolved.id).toBe('inter-pf');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		// A conta passa a conhecer o app: a próxima notificação cai nela direto.
		expect(mocked.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'inter-pf', packageName: INTER }));
	});

	it('adota também a conta que veio do extrato (OFX)', async () => {
		withAccounts([account({ id: 'inter-ofx', name: 'Inter', bankName: 'Inter', accountKey: 'inter:0001' })]);

		expect((await resolveAccountForNotification(debitPurchase, parsed)).id).toBe('inter-ofx');
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

	it('a conta que já tem o app vem direto, sem adoção', async () => {
		const bound = account({ id: 'inter-app', name: 'Inter', bankName: 'Inter', packageName: INTER });
		mocked.findAccountBySource.mockResolvedValue(bound);
		withAccounts([bound]);

		expect((await resolveAccountForNotification(debitPurchase, parsed)).id).toBe('inter-app');
		expect(mocked.addAccount).not.toHaveBeenCalled();
		expect(mocked.updateAccount).not.toHaveBeenCalled();
	});
});
