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
			// Reserva: 1.500 guardados e 30 de rendimento — lançado na categoria de rendimento
			// de investimento, que é o que o faz contar como rendimento e não como receita.
			activity({
				accountId: 'mp',
				name: 'Mercado Pago',
				kind: 'savings',
				role: 'reserve',
				transfersInCents: 150_000,
				incomeCents: 3_000,
				investmentIncomeCents: 3_000,
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
			{
				accountId: 'inter',
				name: 'Inter PF',
				fundedCents: 100_000,
				spentCents: 70_000,
				monthlyCents: 100_000,
				costCents: 100_000,
				targetCents: 100_000,
				remainingCents: 30_000,
			},
		]);
	});

	it('cada reserva tem a sua linha, com o que entrou nela', () => {
		expect(overview.reserves).toEqual([
			{ accountId: 'mp', name: 'Mercado Pago', savedCents: 150_000, yieldCents: 3_000 },
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

	// O teste antigo ('conta externa não entra em nada') congelava o defeito: ele conferia que
	// a conta externa não produz nada e parava aí, então a transferência que ela manda para a
	// principal não era receita em lugar nenhum. O contrato escrito em `AccountRole` sempre
	// disse o contrário — "o que ela manda para a principal é receita" —, e o caso real é
	// quem recebe pela PJ: a PJ é a conta externa, o pró-labore chega na principal como
	// transferência, e o mês em que entraram R$ 12.000 mostrava "Receita R$ 0,00". O que a
	// conta externa movimenta **lá dentro** continua fora de tudo, e é isso que impede a
	// contagem dupla: o dinheiro só entra na receita quando chega numa conta sua.
	it('o que a conta externa movimenta lá dentro não é seu', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ accountId: 'pj', role: 'external', incomeCents: 99_999, expenseCents: 99_999, transfersOutCents: 5 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.incomeCents).toBe(0);
		expect(overview.totalSpendCents).toBe(0);
	});

	it('o que a conta externa manda para a principal é receita do mês', () => {
		const overview = buildMonthOverview({
			accounts: [
				// A PJ faturou 4.000.000 e repassou 12.000 de pró-labore: só os 12.000 são renda.
				activity({ accountId: 'pj', name: 'PJ', role: 'external', incomeCents: 4_000_000, transfersOutCents: 1_200_000 }),
				activity({ accountId: 'nu', role: 'main', transfersInCents: 1_200_000, transfersInFromExternalCents: 1_200_000, expenseCents: 300_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.grossIncomeCents).toBe(1_200_000);
		expect(overview.incomeCents).toBe(1_200_000);
		expect(overview.mainSpendCents).toBe(300_000);
		expect(overview.leftoverCents).toBe(900_000);
		expect(overview.savingsRateBp).toBe(7_500);
	});

	it('transferência entre duas contas suas não é receita', () => {
		// Só a parte que veio de fora do seu patrimônio conta: mandar 1.000 da principal para
		// o envelope não cria renda nenhuma.
		const overview = buildMonthOverview({
			accounts: [
				activity({ accountId: 'nu', role: 'main', incomeCents: 500_000, transfersOutCents: 100_000 }),
				activity({ accountId: 'inter', role: 'envelope', transfersInCents: 100_000, envelopeMonthlyCents: 100_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.incomeCents).toBe(500_000);
	});

	it('o pró-labore que cai na reserva é receita e poupança, não rendimento', () => {
		const overview = buildMonthOverview({
			accounts: [
				activity({ accountId: 'pj', role: 'external', transfersOutCents: 1_200_000 }),
				activity({ accountId: 'mp', kind: 'savings', role: 'reserve', transfersInCents: 1_200_000, transfersInFromExternalCents: 1_200_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.incomeCents).toBe(1_200_000);
		expect(overview.savedCents).toBe(1_200_000);
		expect(overview.yieldCents).toBe(0);
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

/**
 * O critério: rendimento é só o que está em categoria de rendimento de investimento
 * (`investmentIncomeCents`, a parte da receita na categoria `investment`). Toda outra
 * receita que cai numa conta de reserva — um Pix de um amigo, um reembolso — é receita
 * comum do mês. E a despesa lançada dentro da reserva é gasto: o dinheiro saiu do saldo.
 */
describe('reserva: o gasto dela é gasto, e só rendimento é rendimento', () => {
	it('compra no débito da conta de reserva é gasto do mês', () => {
		// R$ 800 no débito do Mercado Pago (papel reserve): saía do saldo e não aparecia em
		// "Gastos", então "sobrou" vinha R$ 800 acima do real.
		const overview = buildMonthOverview({
			accounts: [
				activity({ accountId: 'nu', role: 'main', incomeCents: 1_000_000 }),
				activity({ accountId: 'mp', kind: 'savings', role: 'reserve', expenseCents: 80_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.mainSpendCents).toBe(80_000);
		expect(overview.totalSpendCents).toBe(80_000);
		expect(overview.leftoverCents).toBe(920_000);
	});

	it('Pix de um amigo caindo na reserva é receita, não rendimento de investimento', () => {
		// R$ 2.000 de um amigo, sem categoria de rendimento: era anunciado como rentabilidade
		// que não houve, e o "rendeu nos últimos 12 meses" do Patrimônio ia junto.
		const overview = buildMonthOverview({
			accounts: [activity({ accountId: 'mp', kind: 'savings', role: 'reserve', incomeCents: 200_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.yieldCents).toBe(0);
		expect(overview.incomeCents).toBe(200_000);
		expect(overview.reserves[0]).toMatchObject({ savedCents: 0, yieldCents: 0 });
	});

	it('receita na categoria de rendimento é rendimento, e não entra na receita do mês', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ accountId: 'mp', kind: 'savings', role: 'reserve', incomeCents: 3_000, investmentIncomeCents: 3_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.yieldCents).toBe(3_000);
		expect(overview.incomeCents).toBe(0);
	});

	it('mês com os dois: R$ 40 de rendimento e R$ 2.000 de Pix na mesma reserva', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ accountId: 'mp', kind: 'savings', role: 'reserve', incomeCents: 204_000, investmentIncomeCents: 4_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.yieldCents).toBe(4_000);
		expect(overview.incomeCents).toBe(200_000);
	});

	it('repasse lançado na reserva desconta da receita e não é gasto', () => {
		const overview = buildMonthOverview({
			accounts: [activity({ accountId: 'mp', kind: 'savings', role: 'reserve', incomeCents: 200_000, expenseCents: 150_000, passThroughCents: 150_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.incomeCents).toBe(50_000);
		expect(overview.totalSpendCents).toBe(0);
		expect(overview.passThroughCents).toBe(150_000);
	});

	it('uma linha por reserva: o agregado não serve para a linha da conta', () => {
		// Duas reservas, R$ 1.000 e R$ 300: cada linha mostra o que entrou nela, não 1.300.
		const overview = buildMonthOverview({
			accounts: [
				activity({ accountId: 'mp', name: 'Mercado Pago', kind: 'savings', role: 'reserve', transfersInCents: 100_000 }),
				activity({ accountId: 'cdb', name: 'CDB Inter', kind: 'investment', role: 'reserve', transfersInCents: 30_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(overview.savedCents).toBe(130_000);
		expect(overview.reserves.map((reserve) => [reserve.accountId, reserve.savedCents])).toEqual([
			['mp', 100_000],
			['cdb', 30_000],
		]);
	});
});

describe('envelope: o teto vem do dinheiro que está na conta', () => {
	const envelope = (overrides: Partial<AccountMonthActivity>) =>
		buildMonthOverview({
			accounts: [
				activity({
					accountId: 'inter',
					name: 'Inter PF',
					role: 'envelope',
					envelopeMonthlyCents: 100_000,
					...overrides,
				}),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		}).envelopes[0];

	it('mês normal: entrou 1.000, gastou 845,20, sobram 154,80', () => {
		expect(envelope({ transfersInCents: 100_000, expenseCents: 84_520, startBalanceCents: 0, endBalanceCents: 15_480 })).toMatchObject({
			targetCents: 100_000,
			spentCents: 84_520,
			remainingCents: 15_480,
		});
	});

	it('sobrou dinheiro do mês passado: o teto do mês sobe junto', () => {
		// Sobraram R$ 100 e entraram R$ 1.000: o mês tem R$ 1.100 para gastar.
		expect(envelope({ startBalanceCents: 10_000, transfersInCents: 100_000, expenseCents: 0, endBalanceCents: 110_000 })).toMatchObject({
			targetCents: 110_000,
			remainingCents: 110_000,
		});
	});

	it('mês que terminou zerado volta ao combinado', () => {
		expect(envelope({ startBalanceCents: 0, transfersInCents: 100_000, expenseCents: 100_000, endBalanceCents: 0 })).toMatchObject({
			targetCents: 100_000,
			spentCents: 100_000,
			remainingCents: 0,
		});
	});

	it('antes de o envio do mês cair, vale o combinado', () => {
		expect(envelope({ startBalanceCents: 10_000, transfersInCents: 0, expenseCents: 0, endBalanceCents: 10_000 })).toMatchObject({
			targetCents: 100_000,
		});
	});

	it('quem começou a usar o app com o dinheiro do mês já na conta: o teto é o que está lá', () => {
		// Inter com R$ 1.000 na conta, sem transferência registrada, e R$ 845,20 já gastos.
		expect(
			envelope({ startBalanceCents: 100_000, transfersInCents: 0, expenseCents: 84_520, endBalanceCents: 15_480 })
		).toMatchObject({ targetCents: 100_000, spentCents: 84_520, remainingCents: 15_480 });
	});

	it('o que saiu do envelope para outra conta sua não vira teto nem gasto', () => {
		expect(
			envelope({ startBalanceCents: 0, transfersInCents: 100_000, transfersOutCents: 60_000, expenseCents: 0, endBalanceCents: 40_000 })
		).toMatchObject({ targetCents: 40_000, fundedCents: 40_000, remainingCents: 40_000 });
	});
});

describe('envelope é custo fixo do mês', () => {
	const month = (overrides: Partial<AccountMonthActivity>) =>
		buildMonthOverview({
			accounts: [
				activity({ accountId: 'nu', role: 'main', incomeCents: 0, expenseCents: 0 }),
				activity({
					accountId: 'inter',
					name: 'Inter PF',
					role: 'envelope',
					envelopeMonthlyCents: 100_000,
					...overrides,
				}),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});

	it('conta os R$ 1.000 mesmo quando a transferência não foi registrada', () => {
		// O dinheiro saiu da conta principal para o envelope: é gasto do mês, tenha sido
		// usado lá dentro ou não.
		expect(month({ transfersInCents: 0, expenseCents: 84_020, startBalanceCents: 100_000, endBalanceCents: 15_980 })).toMatchObject({
			envelopeFundingCents: 100_000,
			totalSpendCents: 100_000,
			leftoverCents: -100_000,
		});
	});

	it('gastar menos no envelope não reduz o custo do mês', () => {
		expect(month({ transfersInCents: 100_000, expenseCents: 0 }).totalSpendCents).toBe(100_000);
	});

	it('num mês em que entrou mais que o combinado, vale o que entrou', () => {
		expect(month({ transfersInCents: 130_000, expenseCents: 0 }).envelopeFundingCents).toBe(130_000);
	});

	it('devolver a sobra acumulada para a principal não gera gasto negativo', () => {
		// Sobrou R$ 1.500 de meses anteriores no envelope e o usuário devolve tudo para a
		// principal. O combinado é R$ 1.000, então `max(1.000, 0) − 1.500` dava −R$ 500: o mês
		// ficava R$ 500 mais barato e o "sobrou" inflava, num mês em que o dinheiro foi gasto
		// de verdade pela principal.
		const overview = month({ transfersInCents: 0, transfersOutCents: 150_000, startBalanceCents: 150_000, endBalanceCents: 0 });
		expect(overview.envelopes[0].costCents).toBe(0);
		expect(overview.envelopeFundingCents).toBe(0);
		expect(overview.totalSpendCents).toBe(0);
	});

	it('o envelope que recebeu e devolveu parte custa só a diferença', () => {
		expect(month({ transfersInCents: 100_000, transfersOutCents: 60_000 }).envelopeFundingCents).toBe(40_000);
	});
});

describe('repasse: dinheiro que só passou pela conta', () => {
	it('desconta da receita e não é gasto', () => {
		// Dois Pix entraram (5.000 + 15.000) e 6.000 foram repassados: a renda é 14.000 e o
		// repasse não aparece no gasto — senão receita e despesa inflariam juntas.
		const month = buildMonthOverview({
			accounts: [
				activity({ accountId: 'nu', role: 'main', incomeCents: 2_000_000, expenseCents: 700_000, passThroughCents: 600_000 }),
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(month).toMatchObject({
			grossIncomeCents: 2_000_000,
			passThroughCents: 600_000,
			incomeCents: 1_400_000,
			mainSpendCents: 100_000,
			totalSpendCents: 100_000,
			leftoverCents: 1_300_000,
		});
		expect(month.savingsRateBp).toBe(Math.round((1_300_000 / 1_400_000) * 10_000));
	});

	it('vale também para lançamentos sem conta', () => {
		const month = buildMonthOverview({
			accounts: [],
			unassigned: { incomeCents: 100_000, expenseCents: 30_000, passThroughCents: 30_000 },
		});
		expect(month).toMatchObject({ incomeCents: 70_000, totalSpendCents: 0, passThroughCents: 30_000 });
	});

	it('sem repasse nada muda', () => {
		const month = buildMonthOverview({
			accounts: [activity({ accountId: 'nu', role: 'main', incomeCents: 100_000, expenseCents: 40_000 })],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(month).toMatchObject({ grossIncomeCents: 100_000, incomeCents: 100_000, passThroughCents: 0, mainSpendCents: 40_000 });
	});
});
