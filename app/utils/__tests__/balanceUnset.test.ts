jest.mock('../../database/database', () => ({
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
}));

import { addAccount, getAccounts } from '../../database/database';
import type { Account, AccountDraft } from '../../database/schema';
import { resolveAccountForNotification } from '../accountResolver';
import { isBalanceNeverInformed, showsBalanceUnset } from '../balanceUnset';
import type { ParsedCapture, RawCapture } from '../captureParser';

/**
 * "Saldo não informado" (SPD-114, AUTO-09): a conta que a captura criou sozinha nasce com
 * saldo 0 e âncora na véspera da compra, e o usuário só descobria depois que o saldo estava
 * errado. O selo fica até ele definir o saldo ou dispensar — e nunca marca a conta que ele
 * mesmo cadastrou com saldo zero.
 */

const NONE = new Set<string>();

/** A conta como a captura cria (`newAccountDraft` em `accountResolver`): de um banco qualquer. */
const fromCapture = (overrides: Partial<Account> = {}): Account => ({
	id: 'captura',
	name: 'Banco Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'Banco Teste',
	color: '#4CAF50',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: 'br.com.bancoteste',
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-05',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

/** A conta cadastrada à mão (`AccountEditScreen`): sem app, na posição das que já havia. */
const byHand = (overrides: Partial<Account> = {}): Account =>
	fromCapture({ id: 'mao', name: 'Corrente', packageName: null, sortOrder: 2, ...overrides });

describe('a conta criada pela captura, sem saldo informado', () => {
	it('mostra o selo', () => {
		expect(isBalanceNeverInformed(fromCapture())).toBe(true);
		expect(showsBalanceUnset(fromCapture(), NONE)).toBe(true);
	});

	it('mostra o selo também com lançamentos: o que falta é o ponto de partida, não o movimento', () => {
		// O saldo na tela (−R$ 26,47 da primeira compra) não entra na conta: só a âncora.
		expect(showsBalanceUnset(fromCapture({ openingBalanceDate: '2026-09-18' }), NONE)).toBe(true);
	});

	it('a conta que o resolvedor de verdade cria a partir do aviso do banco ganha o selo', async () => {
		const drafts: AccountDraft[] = [];
		(addAccount as jest.Mock).mockImplementation(async (draft: AccountDraft) => {
			drafts.push(draft);
			return 'nova';
		});
		(getAccounts as jest.Mock).mockImplementation(async () =>
			drafts.map((draft) => ({ ...draft, id: 'nova', updatedAt: '' }))
		);
		const raw: RawCapture = {
			packageName: 'br.com.intermedium',
			appLabel: 'Inter',
			title: 'Inter',
			text: 'Você acaba de comprar no débito no MERCADO TESTE o valor de R$ 26,47.',
			postedAt: '2026-09-19T15:00:00.000Z',
		};
		const parsed: ParsedCapture = {
			amountCents: 2647,
			direction: 'out',
			kind: 'purchase',
			counterparty: 'MERCADO TESTE',
			cardLast4: null,
			neutral: false,
			installments: null,
		};

		const created = await resolveAccountForNotification(raw, parsed);

		expect(created).not.toBeNull();
		expect(created?.openingBalanceCents).toBe(0);
		expect(showsBalanceUnset(created as Account, NONE)).toBe(true);
	});
});

describe('a conta cadastrada à mão com saldo zero não ganha o selo', () => {
	it('sem app ligado: é a conta como o formulário cria, com o saldo em branco', () => {
		expect(showsBalanceUnset(byHand(), NONE)).toBe(false);
	});

	it('depois de a captura adotá-la (ganhou o app), com o nome que o usuário deu', () => {
		expect(showsBalanceUnset(byHand({ packageName: 'br.com.bancoteste' }), NONE)).toBe(false);
	});

	it('adotada e com o nome igual ao do banco: a posição na lista é a de quem já tinha contas', () => {
		const adopted = byHand({ name: 'Banco Teste', packageName: 'br.com.bancoteste', sortOrder: 3 });
		expect(showsBalanceUnset(adopted, NONE)).toBe(false);
	});

	it('a conta do extrato (OFX) tem o saldo que o arquivo trouxe', () => {
		expect(showsBalanceUnset(fromCapture({ accountKey: 'bancoteste:0001:12345' }), NONE)).toBe(false);
	});
});

describe('o selo some', () => {
	it('depois de definir o saldo: R$ 1.234,56 no fim de ontem', () => {
		const informed = fromCapture({ openingBalanceCents: 123_456, openingBalanceDate: '2026-11-06' });
		expect(showsBalanceUnset(informed, NONE)).toBe(false);
	});

	it('depois de definir um saldo negativo (cheque especial): − R$ 50,00', () => {
		expect(showsBalanceUnset(fromCapture({ openingBalanceCents: -5_000 }), NONE)).toBe(false);
	});

	it('quando o usuário dispensa, só para aquela conta', () => {
		const dismissed = new Set(['captura']);
		expect(showsBalanceUnset(fromCapture(), dismissed)).toBe(false);
		expect(showsBalanceUnset(fromCapture({ id: 'outra' }), dismissed)).toBe(true);
	});

	it('quando o usuário renomeia: ele já mexeu na conta', () => {
		expect(showsBalanceUnset(fromCapture({ name: 'Conta do dia a dia' }), NONE)).toBe(false);
	});

	it('na conta arquivada ou apagada', () => {
		expect(showsBalanceUnset(fromCapture({ archived: true }), NONE)).toBe(false);
		expect(showsBalanceUnset(fromCapture({ deletedAt: '2026-11-07T10:00:00.000Z' }), NONE)).toBe(false);
	});

	it('não vale para cartão: a fatura tem o "valor a pagar agora" na tela dele', () => {
		const card = fromCapture({ kind: 'credit_card', role: 'card', name: 'Banco Teste · final 1234', last4: '1234' });
		expect(showsBalanceUnset(card, NONE)).toBe(false);
	});
});
