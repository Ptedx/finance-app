import type { Account } from '../../database/schema';
import { parseCardNames, planDebitCardConversions, serializeCardNames, usageByCard, withCardName } from '../cardNames';
import { pickNotificationTarget } from '../notificationTarget';

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

describe('nomes de cartões', () => {
	it('lê, grava em ordem estável e ignora lixo', () => {
		expect(parseCardNames('{"6422":"iFood/99","abc":"x","1534":""}')).toEqual({ '6422': 'iFood/99' });
		expect(parseCardNames('não é json')).toEqual({});
		expect(serializeCardNames({ '6422': 'iFood/99', '1534': 'Físico' })).toBe('{"1534":"Físico","6422":"iFood/99"}');
		expect(serializeCardNames({})).toBeNull();
	});

	it('dá e tira nome', () => {
		const named = withCardName(null, '6422', ' iFood/99 ');
		expect(named).toBe('{"6422":"iFood/99"}');
		expect(withCardName(named, '6422', '')).toBeNull();
	});
});

describe('usageByCard — quem gastou na fatura', () => {
	it('soma por final, estorno subtrai, maior gasto primeiro, sem cartão por último', () => {
		const usage = usageByCard(
			[
				{ amountCents: 2_938, isIncome: false, cardLast4: '6422' },
				{ amountCents: 1_000, isIncome: false, cardLast4: '6422' },
				{ amountCents: 500, isIncome: true, cardLast4: '6422' },
				{ amountCents: 9_000, isIncome: false, cardLast4: '1534' },
				{ amountCents: 380_000, isIncome: false, cardLast4: null },
			],
			'{"6422":"iFood/99"}',
			'1534'
		);
		expect(usage).toEqual([
			{ last4: '1534', name: null, totalCents: 9_000, count: 1 },
			{ last4: '6422', name: 'iFood/99', totalCents: 3_438, count: 3 },
			{ last4: null, name: null, totalCents: 380_000, count: 1 },
		]);
	});

	it('cartão nomeado sem compra aparece com zero; "sem cartão" só se houver compra', () => {
		expect(usageByCard([], '{"2513":"Assinaturas"}', '1534')).toEqual([
			{ last4: '1534', name: null, totalCents: 0, count: 0 },
			{ last4: '2513', name: 'Assinaturas', totalCents: 0, count: 0 },
		]);
	});
});

describe('planDebitCardConversions — débito não tem fatura', () => {
	const interPF = account({ id: 'inter-pf', name: 'Inter PF', role: 'envelope', bankName: 'Inter', packageName: 'br.com.intermedium' });
	const interPJ = account({ id: 'inter-pj', name: 'Inter PJ', role: 'external', bankName: 'Inter', packageName: 'br.com.intermedium' });
	const debitInter = account({ id: 'debito', name: 'Débito Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', last4: '5678' });

	it('"Débito Inter" vira o cartão de débito da conta Inter PF, com o nome', () => {
		expect(planDebitCardConversions([interPF, interPJ, debitInter])).toEqual([
			{ card: debitInter, checking: interPF, cardNames: '{"5678":"Débito Inter"}' },
		]);
	});

	it('cartão de crédito de verdade não é tocado; sem conta do banco, nada acontece', () => {
		const nubankCard = account({ id: 'nu', name: 'Cartão 1534', kind: 'credit_card', role: 'card', bankName: 'Nubank', last4: '1534' });
		expect(planDebitCardConversions([nubankCard, interPF])).toEqual([]);
		expect(planDebitCardConversions([debitInter])).toEqual([]);
	});
});

describe('final nomeado decide a fatura', () => {
	it('com dois cartões de crédito do Nubank, o virtual nomeado vai para a conta dele', () => {
		const pf = account({ id: 'pf', name: 'Nubank PF', kind: 'credit_card', role: 'card', bankName: 'Nubank', last4: '1534', packageName: 'com.nu.production', closingDay: 25 });
		const pj = account({ id: 'pj', name: 'Nubank PJ', kind: 'credit_card', role: 'card', bankName: 'Nubank', last4: '7777', packageName: 'com.nu.production', closingDay: 10, cardNames: '{"6422":"iFood/99"}' });
		const target = pickNotificationTarget([pf, pj], {
			packageName: 'com.nu.production',
			appLabel: 'Nubank',
			title: 'Compra no crédito aprovada',
			text: 'Compra de R$ 29,38 APROVADA em IFOOD para o cartão com final 6422.',
			cardLast4: '6422',
		});
		expect(target).toEqual({ type: 'card', account: pj });
	});
});
