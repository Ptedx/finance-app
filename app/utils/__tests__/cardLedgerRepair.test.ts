import type { Account, Capture, Transaction } from '../../database/schema';
import { changesCardRouting, planCardLedgerRepair } from '../cardLedgerRepair';

const NUBANK = 'com.nu.production';
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

// O cartão como a tela de cartão grava: banco escolhido, sem app ligado ainda.
const nubankCard = account({
	id: 'nu-card',
	name: 'Nubank',
	kind: 'credit_card',
	role: 'card',
	bankName: 'Nubank',
	last4: '1534',
	closingDay: 25,
	closingDaysBefore: 7,
});
const nubankPF = account({
	id: 'nu-pf',
	name: 'Nubank PF',
	bankName: 'Nubank',
	packageName: NUBANK,
});
const interPF = account({
	id: 'inter-pf',
	name: 'Inter PF',
	bankName: 'Inter',
	packageName: INTER,
});
const interCard = account({
	id: 'inter-card',
	name: 'Inter Black',
	kind: 'credit_card',
	role: 'card',
	bankName: 'Inter',
	packageName: INTER,
	last4: '9999',
	closingDay: 5,
});

// Meio-dia local: a data da compra é a mesma em qualquer fuso.
const POSTED = new Date(2026, 8, 17, 12, 0).toISOString();

const capture = (overrides: Partial<Capture>): Capture => ({
	id: 'c',
	fingerprint: 'f',
	packageName: NUBANK,
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 29,38 APROVADA em IFOOD para o cartão com final 6422.',
	postedAt: POSTED,
	amountCents: 2938,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'IFOOD',
	merchantKey: 'ifood',
	cardLast4: '6422',
	status: 'confirmed',
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: 'tx-c',
	autoConfirmed: false,
	reason: null,
	accountId: 'nu-pf',
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

/** O lançamento exatamente como a captura o gravou na conta corrente. */
const posted = (overrides: Partial<Transaction>): Transaction => ({
	id: 'tx-c',
	amountCents: 2938,
	category: 'food',
	date: '2026-09-17',
	note: 'IFOOD',
	isIncome: false,
	accountId: 'nu-pf',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: '6422',
	updatedAt: '',
	...overrides,
});

const accounts = [nubankCard, nubankPF, interPF, interCard];

describe('planCardLedgerRepair — o cartão novo recebe as compras que caíram na conta', () => {
	it('move a compra confirmada intacta e a pendente para o cartão', () => {
		const pending = capture({ id: 'p', status: 'pending', transactionId: null });
		const plan = planCardLedgerRepair('nu-card', accounts, [capture({}), pending], [posted({})]);
		expect(plan.moves).toEqual([
			{ captureId: 'c', transactionId: 'tx-c', transactionIds: ['tx-c'], toId: 'nu-card' },
			{ captureId: 'p', transactionId: null, transactionIds: [], toId: 'nu-card' },
		]);
		expect(plan.keptEdited).toEqual([]);
	});

	it('não move o que o usuário editou à mão: valor, categoria, nota, data, conta ou lançamento apagado', () => {
		const cases: Array<[string, Transaction[]]> = [
			['valor', [posted({ amountCents: 3000 })]],
			['categoria', [posted({ category: 'transport' })]],
			['nota', [posted({ note: 'Jantar' })]],
			['data', [posted({ date: '2026-09-16' })]],
			['conta', [posted({ accountId: 'inter-pf' })]],
			['final', [posted({ cardLast4: null })]],
			['receita', [posted({ isIncome: true })]],
			['apagado', []],
		];
		for (const [label, ledger] of cases) {
			const plan = planCardLedgerRepair(
				'nu-card',
				accounts,
				[capture({ id: label })],
				ledger.map((tx) => ({ ...tx }))
			);
			expect({ label, plan }).toEqual({ label, plan: { moves: [], keptEdited: [label] } });
		}
	});

	it('compra parcelada intacta vai inteira; com uma parcela editada, fica inteira', () => {
		const parcelado = capture({
			id: 'g',
			transactionId: 'g1',
			amountCents: 10000,
			installments: 3,
		});
		const parcels = [
			posted({
				id: 'g1',
				amountCents: 3334,
				date: '2026-09-17',
				note: 'IFOOD (1/3)',
				installmentGroup: 'g',
				installmentIndex: 1,
				installmentCount: 3,
			}),
			posted({
				id: 'g2',
				amountCents: 3333,
				date: '2026-10-17',
				note: 'IFOOD (2/3)',
				installmentGroup: 'g',
				installmentIndex: 2,
				installmentCount: 3,
			}),
			posted({
				id: 'g3',
				amountCents: 3333,
				date: '2026-11-17',
				note: 'IFOOD (3/3)',
				installmentGroup: 'g',
				installmentIndex: 3,
				installmentCount: 3,
			}),
		];
		expect(planCardLedgerRepair('nu-card', accounts, [parcelado], parcels).moves).toEqual([
			{ captureId: 'g', transactionId: 'g1', transactionIds: ['g1', 'g2', 'g3'], toId: 'nu-card' },
		]);

		const edited = [parcels[0], { ...parcels[1], amountCents: 5000 }, parcels[2]];
		expect(planCardLedgerRepair('nu-card', accounts, [parcelado], edited)).toEqual({
			moves: [],
			keptEdited: ['g'],
		});
		// Uma parcela a menos (apagada) também é edição.
		expect(planCardLedgerRepair('nu-card', accounts, [parcelado], parcels.slice(0, 2))).toEqual({
			moves: [],
			keptEdited: ['g'],
		});
	});

	it('só o que vai para este cartão: a compra do outro banco e o débito ficam', () => {
		const inter = capture({
			id: 'inter',
			packageName: INTER,
			appLabel: 'Inter',
			title: 'Compra no crédito aprovada',
			text: 'Compra no crédito aprovada no cartão final 9999: R$ 50,00 em PADARIA',
			cardLast4: '9999',
			accountId: 'inter-pf',
			transactionId: 'tx-inter',
		});
		const debit = capture({
			id: 'debito',
			title: 'Compra no débito aprovada',
			transactionId: 'tx-debito',
		});
		const ledger = [
			posted({ id: 'tx-inter', accountId: 'inter-pf', cardLast4: '9999', note: 'IFOOD' }),
			posted({ id: 'tx-debito' }),
		];
		expect(planCardLedgerRepair('nu-card', accounts, [inter, debit], ledger)).toEqual({
			moves: [],
			keptEdited: [],
		});
		// O mesmo aviso do Inter vai para o cartão do Inter, quando é ele que se salva.
		expect(
			planCardLedgerRepair('inter-card', accounts, [inter], ledger).moves.map(
				(move) => move.captureId
			)
		).toEqual(['inter']);
	});

	it('compra casada com o extrato fica: quem disse a conta foi o banco', () => {
		const fromStatement = capture({ reason: 'statement_transaction', transactionId: 'ofx-1' });
		const plan = planCardLedgerRepair(
			'nu-card',
			accounts,
			[fromStatement],
			[posted({ id: 'ofx-1', note: 'IFOOD *SAO PAULO' })]
		);
		expect(plan).toEqual({ moves: [], keptEdited: [] });
	});

	it('é idempotente: depois de aplicado, não acha mais nada', () => {
		const moved = capture({ accountId: 'nu-card' });
		expect(
			planCardLedgerRepair('nu-card', accounts, [moved], [posted({ accountId: 'nu-card' })])
		).toEqual({ moves: [], keptEdited: [] });
	});

	it('cartão arquivado ou apagado não recebe nada', () => {
		for (const card of [
			{ ...nubankCard, archived: true },
			{ ...nubankCard, deletedAt: '2026-10-01' },
		]) {
			expect(
				planCardLedgerRepair('nu-card', [card, nubankPF], [capture({})], [posted({})]).moves
			).toEqual([]);
		}
	});
});

describe('changesCardRouting — o que muda para onde as compras vão', () => {
	it('cartão de crédito novo, ativo: sim; conta ou cartão já arquivado: não', () => {
		expect(changesCardRouting(null, nubankCard)).toBe(true);
		expect(changesCardRouting(null, nubankPF)).toBe(false);
		expect(changesCardRouting(null, { ...nubankCard, archived: true })).toBe(false);
	});

	it('banco, final, tipo, app, finais nomeados, desarquivar e "débito" no nome mudam o destino', () => {
		const changed: Array<Partial<Account>> = [
			{ bankName: 'Inter' },
			{ last4: '6422' },
			{ packageName: NUBANK },
			{ cardNames: '{"6422":"iFood"}' },
		];
		for (const patch of changed)
			expect({
				patch,
				changed: changesCardRouting(nubankCard, { ...nubankCard, ...patch }),
			}).toEqual({ patch, changed: true });
		expect(changesCardRouting(nubankPF, { ...nubankPF, kind: 'credit_card', role: 'card' })).toBe(
			true
		);
		expect(changesCardRouting({ ...nubankCard, archived: true }, nubankCard)).toBe(true);
		expect(changesCardRouting({ ...nubankCard, name: 'Nubank débito' }, nubankCard)).toBe(true);
	});

	it('nome, cor, limite e ciclo não mudam o destino; nem um cartão que deixou de ser cartão', () => {
		const unchanged: Array<Partial<Account>> = [
			{ name: 'Roxinho' },
			{ color: '#820AD1' },
			{ creditLimitCents: 500000 },
			{ closingDay: 3, closingDaysBefore: 10, dueDay: 13 },
			{ archived: true },
		];
		for (const patch of unchanged)
			expect({
				patch,
				changed: changesCardRouting(nubankCard, { ...nubankCard, ...patch }),
			}).toEqual({ patch, changed: false });
		expect(changesCardRouting(nubankCard, { ...nubankCard, kind: 'checking', role: 'main' })).toBe(
			false
		);
	});
});
