/**
 * A confirmação de excluir conta ou cartão diz o que vai acontecer, com os números (SPD-141).
 *
 * `deleteAccount` deixa os lançamentos "Sem conta" e apaga as transferências da conta,
 * inclusive os pagamentos de fatura; a frase antiga só falava dos lançamentos. Os textos
 * vêm da i18n de verdade.
 */

const mockLedger = {
	transactions: [] as Array<{ accountId: string | null; deletedAt?: string }>,
	transfers: [] as Array<{ fromAccountId: string | null; toAccountId: string | null; deletedAt?: string }>,
	fail: false,
};

jest.mock('../../database/database', () => ({
	getAccountTransactions: jest.fn(async (id: string) => {
		if (mockLedger.fail) throw new Error('banco fechado');
		return mockLedger.transactions.filter((transaction) => transaction.accountId === id && !transaction.deletedAt);
	}),
	getAccountTransfers: jest.fn(async (id: string) =>
		mockLedger.transfers.filter((transfer) => !transfer.deletedAt && (transfer.fromAccountId === id || transfer.toAccountId === id))
	),
}));

import i18n from '../../i18n';
import { deletionImpact, deletionMessage, loadDeletionMessage } from '../deletionNotice';

const ACCOUNTS = [
	{ id: 'corrente', kind: 'checking' as const },
	{ id: 'reserva', kind: 'savings' as const },
	{ id: 'cartao', kind: 'credit_card' as const },
	{ id: 'outro-cartao', kind: 'credit_card' as const },
];

const entries = (accountId: string, count: number) => Array.from({ length: count }, (): { accountId: string; deletedAt?: string } => ({ accountId }));
const transfer = (fromAccountId: string | null, toAccountId: string | null, deletedAt?: string) => ({
	fromAccountId,
	toAccountId,
	deletedAt,
});

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

beforeAll(async () => {
	await i18n.changeLanguage('pt');
});

beforeEach(() => {
	mockLedger.transactions = [];
	mockLedger.transfers = [];
	mockLedger.fail = false;
});

describe('deletionImpact: o mesmo que o SQL da exclusão alcança', () => {
	it('conta corrente: 12 lançamentos, 2 pagamentos de fatura e 1 transferência para a reserva', () => {
		const impact = deletionImpact(
			'corrente',
			[...entries('corrente', 12), ...entries('reserva', 4), { accountId: 'corrente', deletedAt: '2026-11-01T00:00:00.000Z' }],
			[
				transfer('corrente', 'cartao'),
				transfer('corrente', 'outro-cartao'),
				transfer('corrente', 'reserva'),
				// Apagada antes: a exclusão não a alcança.
				transfer('corrente', 'cartao', '2026-11-01T00:00:00.000Z'),
				// De outras contas: ficam.
				transfer('reserva', 'cartao'),
			],
			ACCOUNTS
		);
		expect(impact).toEqual({ entries: 12, invoicePayments: 2, transfers: 1 });
	});

	it('cartão: as compras ficam sem conta; os pagamentos que entram nele são os da fatura', () => {
		const impact = deletionImpact(
			'cartao',
			entries('cartao', 7),
			[transfer('corrente', 'cartao'), transfer('reserva', 'cartao'), transfer(null, 'cartao'), transfer('cartao', 'corrente')],
			ACCOUNTS
		);
		expect(impact).toEqual({ entries: 7, invoicePayments: 3, transfers: 1 });
	});
});

describe('deletionMessage: a frase da confirmação', () => {
	it('conta, com tudo: lançamentos, pagamentos de fatura e transferências', () => {
		expect(deletionMessage('accounts.edit', { entries: 12, invoicePayments: 2, transfers: 3 }, t)).toBe(
			'12 lançamentos continuam no histórico, mas ficam "Sem conta". 2 pagamentos de fatura feitos desta conta serão apagados. 3 transferências desta conta serão apagadas. Continuar?'
		);
	});

	it('conta, no singular e sem pagamento de fatura', () => {
		expect(deletionMessage('accounts.edit', { entries: 1, invoicePayments: 0, transfers: 1 }, t)).toBe(
			'1 lançamento continua no histórico, mas fica "Sem conta". 1 transferência desta conta será apagada. Continuar?'
		);
	});

	it('conta vazia: diz que nada está ligado a ela', () => {
		expect(deletionMessage('accounts.edit', { entries: 0, invoicePayments: 0, transfers: 0 }, t)).toBe(
			'Nenhum lançamento nem transferência está ligado a esta conta. Continuar?'
		);
	});

	it('cartão: compras sem conta e pagamentos da fatura apagados', () => {
		expect(deletionMessage('cards.edit', { entries: 7, invoicePayments: 3, transfers: 0 }, t)).toBe(
			'7 lançamentos deste cartão continuam no histórico, mas ficam "Sem conta". 3 pagamentos da fatura deste cartão serão apagados. Continuar?'
		);
	});

	it('cartão com um pagamento e uma transferência que sai dele', () => {
		expect(deletionMessage('cards.edit', { entries: 0, invoicePayments: 1, transfers: 1 }, t)).toBe(
			'1 pagamento da fatura deste cartão será apagado. 1 transferência deste cartão será apagada. Continuar?'
		);
	});

	it('cartão vazio', () => {
		expect(deletionMessage('cards.edit', { entries: 0, invoicePayments: 0, transfers: 0 }, t)).toBe(
			'Nenhum lançamento nem pagamento está ligado a este cartão. Continuar?'
		);
	});

	it('em inglês e italiano, com os números', async () => {
		try {
			await i18n.changeLanguage('en');
			expect(deletionMessage('accounts.edit', { entries: 12, invoicePayments: 1, transfers: 3 }, t)).toBe(
				'12 entries stay in your history but become "No account". 1 bill payment made from this account will be deleted. 3 transfers of this account will be deleted. Continue?'
			);
			await i18n.changeLanguage('it');
			expect(deletionMessage('cards.edit', { entries: 1, invoicePayments: 2, transfers: 0 }, t)).toBe(
				'1 movimento di questa carta resta nello storico, ma diventa "Senza conto". 2 pagamenti dell\'estratto conto di questa carta verranno eliminati. Continuare?'
			);
		} finally {
			await i18n.changeLanguage('pt');
		}
	});
});

describe('loadDeletionMessage: lê do banco e monta a frase', () => {
	it('conta com 12 lançamentos e 3 transferências, uma delas pagamento de fatura', async () => {
		mockLedger.transactions = [...entries('corrente', 12), ...entries('cartao', 5)];
		mockLedger.transfers = [transfer('corrente', 'cartao'), transfer('corrente', 'reserva'), transfer('reserva', 'corrente')];
		expect(await loadDeletionMessage('accounts.edit', 'corrente', ACCOUNTS, t)).toBe(
			'12 lançamentos continuam no histórico, mas ficam "Sem conta". 1 pagamento de fatura feito desta conta será apagado. 2 transferências desta conta serão apagadas. Continuar?'
		);
	});

	it('se a leitura falha, a frase geral, sem números, que diz o mesmo', async () => {
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		mockLedger.fail = true;
		expect(await loadDeletionMessage('cards.edit', 'cartao', ACCOUNTS, t)).toBe(
			'As compras continuam no histórico, mas ficam "Sem conta". Os pagamentos da fatura e as transferências deste cartão são apagados. Continuar?'
		);
	});
});
