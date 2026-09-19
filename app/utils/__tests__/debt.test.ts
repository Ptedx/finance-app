import {
	annualRateBpOf,
	buildSchedule,
	type DebtTerms,
	debtMonthLines,
	debtStateOn,
	dueDatesAfter,
	effectiveRateBp,
	installmentFeeCents,
	impliedRateBp,
	installmentInRecurring,
	monthlyRateOf,
	priceInstallmentCents,
	principalFromRateCents,
	simulateExtraPayment,
	summarizeDebts,
	termsAfterExtraPayment,
	worthPayingOff,
} from '../debt';

const R = (reais: number) => Math.round(reais * 100);

/** Um financiamento de carro: R$ 40.000 em 36x a 22% ao ano, vence dia 10. */
const car = (overrides: Partial<DebtTerms> = {}): DebtTerms => {
	const rateBp = 2_200;
	const installmentCents = priceInstallmentCents(R(40_000), monthlyRateOf(rateBp), 36);
	return { system: 'price', balanceCents: R(40_000), balanceDate: '2026-09-01', installmentCents, remaining: 36, dueDay: 10, rateBp, ...overrides };
};

/** Um consórcio contemplado: 60 parcelas de R$ 800, reajuste de 5% ao ano. */
const consortium = (overrides: Partial<DebtTerms> = {}): DebtTerms => ({
	system: 'none',
	balanceCents: R(800) * 60,
	balanceDate: '2026-09-01',
	installmentCents: R(800),
	remaining: 60,
	dueDay: 20,
	rateBp: 500,
	...overrides,
});

describe('taxas', () => {
	it('a mensal é a equivalente composta da anual, e volta', () => {
		expect(monthlyRateOf(0)).toBe(0);
		expect(monthlyRateOf(1_200)).toBeCloseTo(0.009489, 5);
		expect(annualRateBpOf(monthlyRateOf(2_200))).toBe(2_200);
	});

	it('parcela Price confere com a fórmula; sem juros é a divisão', () => {
		expect(priceInstallmentCents(R(10_000), 0.01, 12)).toBe(88_849);
		expect(priceInstallmentCents(R(1_200), 0, 12)).toBe(R(100));
	});
});

describe('vencimentos', () => {
	it('o primeiro é o próximo dia do vencimento depois da âncora', () => {
		expect(dueDatesAfter('2026-09-01', 10, 2)).toEqual(['2026-09-10', '2026-10-10']);
		expect(dueDatesAfter('2026-09-10', 10, 1)).toEqual(['2026-10-10']);
	});

	it('dia 31 encolhe nos meses curtos sem escorregar', () => {
		expect(dueDatesAfter('2026-01-15', 31, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
	});
});

describe('cronograma', () => {
	it('Price: parcela fixa, e o saldo zera exatamente na última', () => {
		const schedule = buildSchedule(car());
		expect(schedule.entries).toHaveLength(36);
		expect(schedule.entries[35].balanceCents).toBe(0);
		expect(schedule.amortizes).toBe(true);
		for (const entry of schedule.entries.slice(0, 35)) expect(entry.installmentCents).toBe(car().installmentCents);
		expect(schedule.totalPaidCents - schedule.totalInterestCents).toBe(R(40_000));
		expect(schedule.payoffDate).toBe('2029-08-10');
	});

	it('Price: juros caem e amortização sobe a cada mês', () => {
		const [first, second] = buildSchedule(car()).entries;
		expect(second.interestCents).toBeLessThan(first.interestCents);
		expect(second.amortizationCents).toBeGreaterThan(first.amortizationCents);
	});

	it('SAC: amortização constante, parcela caindo', () => {
		const terms: DebtTerms = { system: 'sac', balanceCents: R(12_000), balanceDate: '2026-09-01', installmentCents: 0, remaining: 12, dueDay: 5, rateBp: 1_200 };
		const schedule = buildSchedule(terms);
		expect(schedule.entries).toHaveLength(12);
		expect(new Set(schedule.entries.slice(0, 11).map((e) => e.amortizationCents)).size).toBe(1);
		expect(schedule.entries[1].installmentCents).toBeLessThan(schedule.entries[0].installmentCents);
		expect(schedule.entries[11].balanceCents).toBe(0);
	});

	it('consórcio: sem juros, e o reajuste só no aniversário', () => {
		const schedule = buildSchedule(consortium());
		expect(schedule.entries.slice(0, 12).every((e) => e.installmentCents === R(800) && e.interestCents === 0)).toBe(true);
		expect(schedule.entries[12].installmentCents).toBe(R(840));
		expect(schedule.entries[12].interestCents).toBeGreaterThan(0);
		expect(schedule.entries).toHaveLength(60);
		expect(schedule.entries[59].balanceCents).toBe(0);
	});

	it('consórcio sem reajuste: total pago é o saldo', () => {
		const schedule = buildSchedule(consortium({ rateBp: 0 }));
		expect(schedule.totalPaidCents).toBe(R(48_000));
		expect(schedule.totalInterestCents).toBe(0);
	});

	it('parcela que não cobre os juros não quita — e não trava', () => {
		const schedule = buildSchedule(car({ installmentCents: R(100) }));
		expect(schedule).toMatchObject({ amortizes: false, payoffDate: null, entries: [] });
	});

	it('saldo zero é uma dívida quitada', () => {
		expect(buildSchedule(car({ balanceCents: 0 }))).toMatchObject({ amortizes: true, entries: [] });
	});
});

describe('o estado de hoje sai da âncora', () => {
	it('o que venceu até hoje sai do saldo sozinho', () => {
		const terms = car();
		const state = debtStateOn(terms, '2026-12-15');
		const schedule = buildSchedule(terms);
		expect(state.paidSinceAnchor).toBe(4);
		expect(state.remaining).toBe(32);
		expect(state.balanceCents).toBe(schedule.entries[3].balanceCents);
		expect(state.next?.date).toBe('2027-01-10');
		expect(state.interestAheadCents).toBe(schedule.entries.slice(4).reduce((sum, e) => sum + e.interestCents, 0));
	});

	it('antes do primeiro vencimento, o saldo é a âncora', () => {
		expect(debtStateOn(car(), '2026-09-05').balanceCents).toBe(R(40_000));
	});
});

describe('cadastro: derivar o que não se sabe', () => {
	it('a taxa implícita da Price é o inverso da parcela', () => {
		for (const rateBp of [800, 2_200, 3_500]) {
			const installment = priceInstallmentCents(R(40_000), monthlyRateOf(rateBp), 36);
			const implied = impliedRateBp({ system: 'price', balanceCents: R(40_000), installmentCents: installment, remaining: 36 }) as number;
			expect(Math.abs(implied - rateBp)).toBeLessThanOrEqual(2);
		}
	});

	it('o saldo implícito é o inverso da taxa', () => {
		const installment = priceInstallmentCents(R(40_000), monthlyRateOf(2_200), 36);
		expect(Math.abs(principalFromRateCents({ system: 'price', installmentCents: installment, remaining: 36, rateBp: 2_200 }) - R(40_000))).toBeLessThanOrEqual(R(1));
		expect(principalFromRateCents({ system: 'none', installmentCents: R(800), remaining: 60, rateBp: 500 })).toBe(R(48_000));
	});

	it('SAC: a taxa sai da primeira parcela', () => {
		const implied = impliedRateBp({ system: 'sac', balanceCents: R(12_000), installmentCents: R(1_000) + Math.round(R(12_000) * monthlyRateOf(1_200)), remaining: 12 }) as number;
		expect(Math.abs(implied - 1_200)).toBeLessThanOrEqual(2);
	});

	it('sem juros dá zero; pagar menos que o saldo não tem taxa; consórcio não tem taxa', () => {
		expect(impliedRateBp({ system: 'price', balanceCents: R(1_200), installmentCents: R(100), remaining: 12 })).toBe(0);
		expect(impliedRateBp({ system: 'price', balanceCents: R(1_200), installmentCents: R(90), remaining: 12 })).toBeNull();
		expect(impliedRateBp({ system: 'none', balanceCents: R(1_200), installmentCents: R(100), remaining: 12 })).toBeNull();
	});
});

describe('amortizar', () => {
	it('reduzir prazo: mesma parcela, menos meses, juros economizados', () => {
		const result = simulateExtraPayment(car(), '2026-09-05', R(5_000), 'shorten');
		expect(result).not.toBeNull();
		expect(result?.monthsSaved).toBeGreaterThan(0);
		expect(result?.savedCents).toBeGreaterThan(0);
		expect(result?.newInstallmentCents).toBe(car().installmentCents);
		expect(result?.newBalanceCents).toBe(R(35_000));
	});

	it('reduzir parcela: mesmo prazo, parcela menor', () => {
		const result = simulateExtraPayment(car(), '2026-09-05', R(5_000), 'lower');
		expect(result?.monthsSaved).toBe(0);
		expect(result?.newRemaining).toBe(36);
		expect(result?.newInstallmentCents).toBeLessThan(car().installmentCents);
		expect(result?.savedCents).toBeGreaterThan(0);
	});

	it('reduzir prazo economiza mais juros que reduzir parcela', () => {
		const shorten = simulateExtraPayment(car(), '2026-09-05', R(5_000), 'shorten');
		const lower = simulateExtraPayment(car(), '2026-09-05', R(5_000), 'lower');
		expect(shorten?.savedCents).toBeGreaterThan(lower?.savedCents ?? Infinity);
	});

	it('consórcio: antecipar evita só o reajuste', () => {
		const result = simulateExtraPayment(consortium(), '2026-09-05', R(8_000), 'shorten');
		expect(result?.monthsSaved).toBe(10);
		expect(result?.savedCents).toBeGreaterThan(0);
		// Sem reajuste, antecipar não economiza nada.
		expect(simulateExtraPayment(consortium({ rateBp: 0 }), '2026-09-05', R(8_000), 'shorten')?.savedCents).toBe(0);
	});

	it('quitar tudo; valor zero ou dívida que não quita não simulam', () => {
		const all = simulateExtraPayment(car(), '2026-09-05', R(99_999), 'shorten');
		expect(all).toMatchObject({ newBalanceCents: 0, newRemaining: 0 });
		expect(simulateExtraPayment(car(), '2026-09-05', 0, 'shorten')).toBeNull();
		expect(simulateExtraPayment(car({ installmentCents: R(100) }), '2026-09-05', R(10), 'shorten')).toBeNull();
	});

	it('confirmar move a âncora para hoje', () => {
		const result = simulateExtraPayment(car(), '2026-09-05', R(5_000), 'shorten');
		if (!result) throw new Error('sem simulação');
		const next = termsAfterExtraPayment(car(), '2026-09-05', result);
		expect(next).toMatchObject({ balanceCents: R(35_000), balanceDate: '2026-09-05', remaining: result.newRemaining });
		expect(buildSchedule(next).entries).toHaveLength(result.newRemaining);
	});
});

describe('o veredito', () => {
	it('dívida mais cara que o investimento líquido: amortize', () => {
		// Carro a 22% contra 10% de CDI, 8,5% depois do IR.
		expect(worthPayingOff({ debtRateBp: 2_200, investmentYieldBp: 1_000 })).toEqual({ verdict: 'pay', netYieldBp: 850, spreadBp: 1_350, perThousandCents: R(135) });
	});

	it('consórcio a 5% contra 8,5% líquido: invista', () => {
		expect(worthPayingOff({ debtRateBp: 500, investmentYieldBp: 1_000 })).toMatchObject({ verdict: 'invest', spreadBp: -350 });
	});

	it('perto demais é empate', () => {
		expect(worthPayingOff({ debtRateBp: 870, investmentYieldBp: 1_000 }).verdict).toBe('tie');
	});
});

describe('efeito no mês e no futuro', () => {
	const recurring = [{ amountCents: R(1_500), isIncome: false, active: true, recurrenceType: 'monthly' }];

	it('a parcela está no custo fixo quando há recorrência mensal do mesmo valor', () => {
		expect(installmentInRecurring(R(1_500), recurring)).toBe(true);
		expect(installmentInRecurring(R(1_510), recurring)).toBe(true);
		expect(installmentInRecurring(R(1_600), recurring)).toBe(false);
		expect(installmentInRecurring(R(1_500), [{ ...recurring[0], active: false }])).toBe(false);
		expect(installmentInRecurring(R(1_500), [{ ...recurring[0], recurrenceType: 'yearly' }])).toBe(false);
	});

	it('as parcelas caem nos meses pedidos', () => {
		const lines = debtMonthLines([{ id: 'car', name: 'Carro', terms: car() }], ['2026-10', '2026-11', '2026-12'], '2026-09-17', []);
		expect(lines.map((l) => l.month)).toEqual(['2026-10', '2026-11', '2026-12']);
		expect(lines.every((l) => l.cents === car().installmentCents && !l.inFixedCost)).toBe(true);
	});

	it('o resumo soma saldos e parcelas, pondera a taxa e diz quando cada parcela sai', () => {
		const summary = summarizeDebts(
			[
				{ id: 'car', name: 'Carro', terms: car() },
				{ id: 'cons', name: 'Consórcio', terms: consortium() },
			],
			'2026-09-05'
		);
		expect(summary.balanceCents).toBe(R(40_000) + R(48_000));
		expect(summary.monthlyCents).toBe(car().installmentCents + R(800));
		expect(summary.weightedRateBp).toBe(Math.round((R(40_000) * 2_200 + R(48_000) * 500) / (R(88_000))));
		expect(summary.releases.map((r) => [r.debtId, r.fromMonth])).toEqual([
			['car', '2029-09'],
			['cons', '2031-09'],
		]);
		expect(summary.lastPayoffDate).toBe('2031-08-20');
	});

	it('dívida quitada não entra no resumo', () => {
		expect(summarizeDebts([{ id: 'x', name: 'X', terms: car({ balanceCents: 0 }) }], '2026-09-05')).toMatchObject({ balanceCents: 0, weightedRateBp: null, releases: [] });
	});
});

describe('encargos na parcela: a taxa do contrato e o custo efetivo', () => {
	// O caso do usuário: contrato a 1,8% ao mês; a parcela cobra mais que isso por causa de
	// seguro e tarifas, e estimar a taxa só pela parcela dava 2,43%.
	const monthly18 = annualRateBpOf(0.018);
	const pure = priceInstallmentCents(R(40_000), monthlyRateOf(monthly18), 36);
	const charged = pure + R(180);
	const withFee = (): DebtTerms => ({ system: 'price', balanceCents: R(40_000), balanceDate: '2026-09-01', installmentCents: charged, remaining: 36, dueDay: 10, rateBp: monthly18, feeCents: R(180) });

	it('os encargos são a parcela cobrada menos a que a taxa do contrato daria', () => {
		expect(installmentFeeCents({ system: 'price', balanceCents: R(40_000), installmentCents: charged, remaining: 36, rateBp: monthly18 })).toBe(R(180));
		expect(installmentFeeCents({ system: 'price', balanceCents: R(40_000), installmentCents: pure - R(50), remaining: 36, rateBp: monthly18 })).toBe(-R(50));
		expect(installmentFeeCents({ system: 'none', balanceCents: R(1), installmentCents: R(1), remaining: 1, rateBp: 500 })).toBe(0);
	});

	it('com encargos, o cronograma ainda quita no prazo e cobra a parcela do banco', () => {
		const schedule = buildSchedule(withFee());
		expect(schedule.entries).toHaveLength(36);
		expect(schedule.entries[0].installmentCents).toBe(charged);
		expect(schedule.entries[35].balanceCents).toBe(0);
		// Juros são só os do contrato; os encargos não amortizam.
		expect(schedule.totalPaidCents - schedule.totalInterestCents - R(40_000)).toBeCloseTo(R(180) * 36, -2);
	});

	it('o custo efetivo com encargos é maior que a taxa do contrato; sem encargos, é a própria', () => {
		expect(effectiveRateBp(withFee(), '2026-09-05')).toBeGreaterThan(monthly18);
		expect(effectiveRateBp({ ...withFee(), installmentCents: pure, feeCents: 0 }, '2026-09-05')).toBe(monthly18);
	});

	it('reduzir o prazo também corta os encargos das parcelas que somem', () => {
		const withFees = simulateExtraPayment(withFee(), '2026-09-05', R(5_000), 'shorten');
		const without = simulateExtraPayment({ ...withFee(), installmentCents: pure, feeCents: 0 }, '2026-09-05', R(5_000), 'shorten');
		expect(withFees?.savedCents).toBeGreaterThan(without?.savedCents ?? Infinity);
	});
});
