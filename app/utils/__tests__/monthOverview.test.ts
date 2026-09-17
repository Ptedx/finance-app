import { type AccountMonthActivity, buildMonthOverview } from '../monthOverview';

const activity = (overrides: Partial<AccountMonthActivity>): AccountMonthActivity => ({
	accountId: 'a',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	incomeCents: 0,
	expenseCents: 0,
	transfersInCents: 0,
	transfersOutCents: 0,
	...overrides,
});

describe('buildMonthOverview — o mês que o usuário descreveu', () => {
	const overview = buildMonthOverview({
		accounts: [
			// Principal: pró-labore da PJ caiu como receita; Pix e débito saíram daqui;
			// mandou 1.000 para o envelope, 1.500 para a reserva e pagou 6.800 de fatura.
			activity({
				accountId: 'nu',
				name: 'Nubank PF',
				role: 'main',
				incomeCents: 1_200_000,
				expenseCents: 240_000,
				transfersOutCents: 100_000 + 150_000 + 680_000,
			}),
			// Cartão: 6.800 caem na fatura do mês (à vista + parcelas), 7.400 foram comprados no mês.
			activity({
				accountId: 'card',
				name: 'Cartão Nubank',
				kind: 'credit_card',
				role: 'card',
				expenseCents: 680_000,
				transfersInCents: 680_000,
				purchasesOriginatedCents: 740_000,
			}),
			// Envelope Inter: recebeu 1.000, gastou 700 lá dentro.
			activity({
				accountId: 'inter',
				name: 'Inter PF',
				role: 'envelope',
				transfersInCents: 100_000,
				expenseCents: 70_000,
				envelopeMonthlyCents: 100_000,
			}),
			// Reserva: 1.500 guardados e 30 de rendimento.
			activity({
				accountId: 'mp',
				name: 'Mercado Pago',
				kind: 'savings',
				role: 'reserve',
				transfersInCents: 150_000,
				incomeCents: 3_000,
			}),
		],
		unassigned: { incomeCents: 0, expenseCents: 0 },
	});

	it('o gasto do mês é cartão + pix/débito + envelope, e não a fatura', () => {
		expect(overview.cardSpendCents).toBe(680_000);
		expect(overview.mainSpendCents).toBe(240_000);
		expect(overview.envelopeFundingCents).toBe(100_000);
		expect(overview.totalSpendCents).toBe(1_020_000);
	});

	it('pagar a fatura não é gasto e guardar não é gasto', () => {
		expect(overview.savedCents).toBe(150_000);
		expect(overview.yieldCents).toBe(3_000);
		expect(overview.incomeCents).toBe(1_200_000);
		expect(overview.leftoverCents).toBe(180_000);
		expect(overview.savingsRateBp).toBe(1500);
	});

	it('o envelope conta pelo que entrou, e mostra quanto foi usado', () => {
		expect(overview.envelopes).toEqual([
			{ accountId: 'inter', name: 'Inter PF', fundedCents: 100_000, spentCents: 70_000, monthlyCents: 100_000 },
		]);
	});

	it('o cartão traz as duas métricas: o que cai na fatura e o que foi comprado', () => {
		expect(overview.cards).toEqual([
			{ accountId: 'card', name: 'Cartão Nubank', spendCents: 680_000, purchasesCents: 740_000 },
		]);
		expect(overview.cardPurchasesCents).toBe(740_000);
	});
});

describe('buildMonthOverview — detalhes', () => {
	it('com vencimento informado, o cartão conta pela fatura que vence no mês — não pelas compras datadas nele', () => {
		const month = buildMonthOverview({
			accounts: [
				activity({
					accountId: 'card',
					name: 'Cartão 1534',
					kind: 'credit_card',
					role: 'card',
					expenseCents: 16_460,
					purchasesOriginatedCents: 16_460,
					invoiceCents: 383_280,
				}),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(month.cards[0]).toMatchObject({ spendCents: 383_280, purchasesCents: 16_460 });
		expect(month.totalSpendCents).toBe(383_280);
	});

	it('dinheiro que sai do envelope para outra conta sua não é gasto do envelope — a fatura paga com ele já conta no cartão', () => {
		const month = buildMonthOverview({
			accounts: [
				activity({ accountId: 'nu', role: 'main', incomeCents: 1_000_000, transfersInCents: 60_000, transfersOutCents: 100_000 + 380_000 }),
				activity({ accountId: 'inter', name: 'Inter PF', role: 'envelope', transfersInCents: 100_000, transfersOutCents: 60_000, envelopeMonthlyCents: 100_000 }),
				activity({ accountId: 'card', kind: 'credit_card', role: 'card', invoiceCents: 380_000, transfersInCents: 380_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(month.envelopes[0].fundedCents).toBe(40_000);
		expect(month.totalSpendCents).toBe(420_000);
	});

	it('estorno no cartão reduz o gasto do cartão, nunca abaixo de zero', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ role: 'card', kind: 'credit_card', expenseCents: 5_000, incomeCents: 8_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.cardSpendCents).toBe(0);
	});

	it('lançamentos sem conta contam como se fossem da principal', () => {
		const overview = buildMonthOverview({
			accounts: [],
			unassigned: { incomeCents: 10_000, expenseCents: 4_000 },
		});
		expect(overview.incomeCents).toBe(10_000);
		expect(overview.mainSpendCents).toBe(4_000);
		expect(overview.leftoverCents).toBe(6_000);
		expect(overview.savingsRateBp).toBe(6000);
	});

	it('conta externa não entra em nada', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ role: 'external', incomeCents: 99_999, expenseCents: 99_999, transfersOutCents: 5 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.incomeCents).toBe(0);
		expect(overview.totalSpendCents).toBe(0);
	});

	it('sem receita a taxa de poupança é nula, não infinita', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ role: 'main', expenseCents: 1_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.savingsRateBp).toBeNull();
		expect(overview.leftoverCents).toBe(-1_000);
	});

	it('retirar da reserva reduz o guardado do mês', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ role: 'reserve', transfersInCents: 1_000, transfersOutCents: 4_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.savedCents).toBe(-3_000);
	});
});
