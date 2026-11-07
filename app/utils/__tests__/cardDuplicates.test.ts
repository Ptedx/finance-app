import { accountPairKey } from '../accountBinding';
import {
	CARD_DUPLICATE_DAYS,
	type CardDuplicateEntry,
	findCardDuplicates,
	isLikelyCardDuplicate,
	summarizeCardDuplicates,
} from '../cardDuplicates';
import { CARD_ADJUSTMENT_NOTE, cardChargeNote } from '../cardMath';

/**
 * "Provável repetido" no cartão (E2E-34, SPD-098).
 *
 * O dono lançou à mão no Nubank Teste a padaria de R$ 50 (01/11) e o mercado de R$ 100
 * (07/11); o extrato OFX trouxe as mesmas compras, e juntar os cartões levou as duas cópias
 * para o mesmo cartão: a fatura dá R$ 345,90 e o banco diz R$ 195,90. O app marca o que bate
 * em valor com até um dia de diferença no mesmo cartão, sem apagar nada sozinho.
 */

const entry = (overrides: Partial<CardDuplicateEntry> & Pick<CardDuplicateEntry, 'id'>): CardDuplicateEntry => ({
	amountCents: 0,
	isIncome: false,
	date: '2026-11-01',
	note: '',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: null,
	...overrides,
});

// O que o Nubank Teste tem depois de juntar: o digitado à mão e o que veio do extrato.
const PADARIA_MAO = entry({ id: 'm-padaria', amountCents: 5000, date: '2026-11-01', note: 'Padaria' });
const PADARIA_OFX = entry({ id: 'x-padaria', amountCents: 5000, date: '2026-11-01', note: 'PADARIA', cardLast4: '1111' });
const DROGASIL_OFX = entry({ id: 'x-drogasil', amountCents: 4590, date: '2026-11-06', note: 'DROGASIL', cardLast4: '1111' });
const MERCADO_MAO = entry({ id: 'm-mercado', amountCents: 10000, date: '2026-11-07', note: 'Mercado' });
const MERCADO_OFX = entry({ id: 'x-mercado', amountCents: 10000, date: '2026-11-08', note: 'SUPERMERCADO', cardLast4: '1111' });

const ACHADO = [PADARIA_MAO, PADARIA_OFX, DROGASIL_OFX, MERCADO_MAO, MERCADO_OFX];

const keysOf = (entries: CardDuplicateEntry[]) => findCardDuplicates(entries).pairs.map((pair) => pair.key).sort();

describe('E2E-34 — provável repetido no mesmo cartão', () => {
	it('a folga é a mesma do pagamento repetido: um dia', () => {
		expect(CARD_DUPLICATE_DAYS).toBe(1);
	});

	it('padaria 50 + 50 no mesmo dia e mercado 100 em 07/11 + 08/11: dois pares, a drogaria fica de fora', () => {
		const found = findCardDuplicates(ACHADO);
		expect(found.pairs.map((pair) => pair.key).sort()).toEqual(
			[accountPairKey('m-padaria', 'x-padaria'), accountPairKey('m-mercado', 'x-mercado')].sort()
		);
		expect(found.partners.get('m-padaria')).toEqual(['x-padaria']);
		expect(found.partners.get('x-mercado')).toEqual(['m-mercado']);
		expect(found.partners.has('x-drogasil')).toBe(false);
		expect(found.groups.map((group) => group.map((member) => member.id))).toEqual([
			['m-padaria', 'x-padaria'],
			['m-mercado', 'x-mercado'],
		]);
	});

	it('se os dois forem repetidos, a fatura de R$ 345,90 cai R$ 150,00 e bate com os R$ 195,90 do banco', () => {
		const invoice = ACHADO.reduce((total, item) => total + item.amountCents, 0);
		expect(invoice).toBe(34_590);
		const summary = summarizeCardDuplicates(findCardDuplicates(ACHADO).groups);
		expect(summary.count).toBe(2);
		expect(summary.extraCents).toBe(15_000);
		expect(invoice - summary.extraCents).toBe(19_590);
		expect([...summary.ids].sort()).toEqual(['m-mercado', 'm-padaria', 'x-mercado', 'x-padaria']);
	});

	it('mercado 100 em 07/11 e 100 em 09/11: dois dias, não é par', () => {
		expect(keysOf([MERCADO_MAO, { ...MERCADO_OFX, date: '2026-11-09' }])).toEqual([]);
		expect(keysOf([MERCADO_MAO, { ...MERCADO_OFX, date: '2026-11-05' }])).toEqual([]);
	});

	it('na virada do mês ainda é um dia: 31/10 e 01/11', () => {
		expect(keysOf([{ ...PADARIA_MAO, date: '2026-10-31' }, PADARIA_OFX])).toEqual([accountPairKey('m-padaria', 'x-padaria')]);
	});

	it('valor diferente por um centavo não é par', () => {
		expect(keysOf([PADARIA_MAO, { ...PADARIA_OFX, amountCents: 5001 }])).toEqual([]);
	});

	it('parcela 2/5 de R$ 300 com outra de R$ 300 do mesmo parcelamento: nunca', () => {
		const a = entry({ id: 'p2', amountCents: 30_000, date: '2026-11-03', installmentGroup: 'g1', installmentIndex: 2, installmentCount: 5 });
		const b = entry({ id: 'p3', amountCents: 30_000, date: '2026-11-03', installmentGroup: 'g1', installmentIndex: 3, installmentCount: 5 });
		expect(isLikelyCardDuplicate(a, b)).toBe(false);
		expect(keysOf([a, b])).toEqual([]);
	});

	it('a mesma parcela 2/5 cadastrada duas vezes (dois parcelamentos) é par; 2/5 com 3/5 de outro não', () => {
		const a = entry({ id: 'p2', amountCents: 30_000, date: '2026-11-03', installmentGroup: 'g1', installmentIndex: 2, installmentCount: 5 });
		const b = entry({ id: 'q2', amountCents: 30_000, date: '2026-11-03', installmentGroup: 'g2', installmentIndex: 2, installmentCount: 5 });
		const c = entry({ id: 'q3', amountCents: 30_000, date: '2026-11-04', installmentGroup: 'g3', installmentIndex: 3, installmentCount: 5 });
		expect(isLikelyCardDuplicate(a, b)).toBe(true);
		expect(isLikelyCardDuplicate(a, c)).toBe(false);
	});

	it('o ajuste com a fatura do banco nunca é par, nem com uma compra do mesmo valor nem com outro ajuste', () => {
		const ajuste = entry({ id: 'aj', amountCents: 5000, date: '2026-11-01', note: CARD_ADJUSTMENT_NOTE });
		const outro = entry({ id: 'aj2', amountCents: 5000, date: '2026-11-01', note: CARD_ADJUSTMENT_NOTE });
		expect(keysOf([ajuste, PADARIA_MAO])).toEqual([]);
		expect(keysOf([ajuste, outro])).toEqual([]);
		// Com o ajuste no meio, o par de verdade continua sendo achado.
		expect(keysOf([ajuste, PADARIA_MAO, PADARIA_OFX])).toEqual([accountPairKey('m-padaria', 'x-padaria')]);
	});

	it('o encargo lançado à mão e a linha de IOF do extrato com o mesmo valor: par', () => {
		const encargo = entry({ id: 'enc', amountCents: 1234, date: '2026-11-05', note: cardChargeNote('iof') });
		const linha = entry({ id: 'iof', amountCents: 1234, date: '2026-11-05', note: 'IOF COMPRA INTERNACIONAL' });
		expect(keysOf([encargo, linha])).toEqual([accountPairKey('enc', 'iof')]);
	});

	it('compra e estorno do mesmo valor não são repetidos: um anula o outro de propósito', () => {
		expect(keysOf([PADARIA_MAO, { ...PADARIA_OFX, isIncome: true }])).toEqual([]);
	});

	it('dois estornos iguais são par, e se forem repetidos a fatura sobe', () => {
		const a = entry({ id: 'e1', amountCents: 2000, isIncome: true, date: '2026-11-02' });
		const b = entry({ id: 'e2', amountCents: 2000, isIncome: true, date: '2026-11-03' });
		const summary = summarizeCardDuplicates(findCardDuplicates([a, b]).groups);
		expect(summary.count).toBe(1);
		expect(summary.extraCents).toBe(-2000);
	});

	it('finais diferentes (o físico e o virtual) são duas compras; final em branco casa com qualquer um', () => {
		expect(keysOf([{ ...PADARIA_MAO, cardLast4: '2222' }, PADARIA_OFX])).toEqual([]);
		expect(keysOf([{ ...PADARIA_MAO, cardLast4: '1111' }, PADARIA_OFX])).toEqual([accountPairKey('m-padaria', 'x-padaria')]);
	});

	it('valor zero não é marcado', () => {
		expect(keysOf([entry({ id: 'z1' }), entry({ id: 'z2' })])).toEqual([]);
	});

	it('três iguais em 07, 08 e 09/11: um grupo só, e dois deles sobrariam', () => {
		const tres = [MERCADO_MAO, MERCADO_OFX, { ...MERCADO_OFX, id: 'x-mercado-2', date: '2026-11-09' }];
		const found = findCardDuplicates(tres);
		expect(found.groups.map((group) => group.map((member) => member.id))).toEqual([['m-mercado', 'x-mercado', 'x-mercado-2']]);
		// 07 e 09 estão a dois dias: não são par entre si, só pelo do meio.
		expect(found.partners.get('m-mercado')).toEqual(['x-mercado']);
		expect(found.partners.get('x-mercado')).toEqual(['m-mercado', 'x-mercado-2']);
		expect(summarizeCardDuplicates(found.groups).count).toBe(2);
	});

	it('"não é repetido" tira só aquele par', () => {
		const dismissed = new Set([accountPairKey('m-padaria', 'x-padaria')]);
		const found = findCardDuplicates(ACHADO, dismissed);
		expect(found.pairs.map((pair) => pair.key)).toEqual([accountPairKey('m-mercado', 'x-mercado')]);
		expect(found.partners.has('m-padaria')).toBe(false);
		expect(summarizeCardDuplicates(found.groups).count).toBe(1);
	});

	it('na fatura da tela conta só o grupo com algum lançamento dela', () => {
		const groups = findCardDuplicates(ACHADO).groups;
		const summary = summarizeCardDuplicates(groups, new Set(['m-mercado', 'x-drogasil']));
		expect(summary.count).toBe(1);
		expect(summary.extraCents).toBe(10_000);
		expect([...summary.ids].sort()).toEqual(['m-mercado', 'x-mercado']);
	});

	it('a ordem de entrada não muda o resultado', () => {
		const reversed = findCardDuplicates([...ACHADO].reverse());
		expect(reversed.groups.map((group) => group.map((member) => member.id))).toEqual([
			['m-padaria', 'x-padaria'],
			['m-mercado', 'x-mercado'],
		]);
	});
});
