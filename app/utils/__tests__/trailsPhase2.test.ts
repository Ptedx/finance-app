import {
	dropsOrigin,
	navigateTrail,
	planTrail,
	resolveTrailStep,
	startIndexOf,
	TRAILS,
	type TrailLocation,
	type TrailRecords,
} from '../trails';

/**
 * As trilhas 9 a 15 do tutorial (SPD-131b): Dívidas; Reserva de emergência e "Por onde
 * começar"; Patrimônio; "Este mês" e o orçamento; Lançamentos; e as duas dos Relatórios. Aqui
 * só a parte que não depende de tela: o plano a partir do que o usuário tem, o passo cujo
 * alvo não está na tela (o `[sem dado]` do texto aprovado) e a navegação — Patrimônio › Nova
 * dívida › a dívida › Editar dívida e a volta.
 */

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Um usuário com duas dívidas, um cartão e o resto das trilhas 1 a 7. */
const full: TrailRecords = {
	account: [{ id: 'corrente' }],
	card: [{ id: 'cartao' }],
	debt: [{ id: 'carro' }, { id: 'casa' }],
	transaction: [{ id: 'lanc1' }],
	pending: [{}],
	capture: [{}],
};

const wealth: TrailLocation = { screen: 'wealth' };
const locations = (plan: ReturnType<typeof planTrail>) =>
	plan.map(
		(step) =>
			`${step.id}@${step.location.screen}${step.location.params ? `:${Object.values(step.location.params).join('/')}` : ''}`
	);
const stepOf = (plan: ReturnType<typeof planTrail>, id: string) => {
	const found = plan.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`passo ${id} fora do plano`);
	return found;
};

describe('Trilha 9 — Dívidas', () => {
	it('com dívidas: Patrimônio › Nova dívida › a primeira dívida › Editar dívida', () => {
		const plan = planTrail(TRAILS.debts, full, wealth);
		expect(locations(plan)).toEqual([
			'1@wealth',
			'2@debtNew',
			'3@debtNew',
			'4@debtNew',
			'5@debtNew',
			'6@debtNew',
			'7@debtNew',
			'8@debtNew',
			'9@debt:carro',
			'10@debt:carro',
			'11@debt:carro',
			'12@debtEdit:carro',
		]);
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['5', '7']);
		expect(stepOf(plan, '1')).toMatchObject({
			titleKey: 'trails.debts.steps.1.title',
			bodyKey: 'trails.debts.steps.1.body',
			targets: [['wealth.debts']],
		});
	});

	it('sem nenhuma dívida: o 9 vira o texto do [sem dado]; 10, 11 e 12, o texto sem apontar, na Nova dívida', () => {
		const plan = planTrail(TRAILS.debts, { ...full, debt: [] }, wealth);
		expect(plan).toHaveLength(12);
		expect(stepOf(plan, '9')).toMatchObject({
			textOnly: true,
			bodyKey: 'trails.debts.steps.9.missing',
			location: { screen: 'debtNew' },
		});
		for (const id of ['10', '11', '12'])
			expect(stepOf(plan, id)).toMatchObject({
				textOnly: true,
				bodyKey: `trails.debts.steps.${id}.body`,
				location: { screen: 'debtNew' },
			});
	});

	it('o "?" da tela de uma dívida abre no passo 9, nela mesma (não na primeira da lista)', () => {
		const here: TrailLocation = { screen: 'debt', params: { id: 'casa' } };
		const plan = planTrail(TRAILS.debts, full, here);
		expect(startIndexOf(plan, '9')).toBe(8);
		expect(plan[8].location).toEqual(here);
		expect(plan[11].location).toEqual({ screen: 'debtEdit', params: { id: 'casa' } });
	});

	it('consórcio: sem o campo do reajuste, aponta o "Tipo", onde fica o Consórcio, com o mesmo texto', () => {
		const seven = stepOf(planTrail(TRAILS.debts, full, wealth), '7');
		expect(resolveTrailStep(seven, { 'debtEdit.kind': rect(0, 100, 300, 80) })).toEqual({
			kind: 'point',
			ids: ['debtEdit.kind'],
			bodyKey: 'trails.debts.steps.7.body',
		});
		expect(resolveTrailStep(seven, { 'debtEdit.adjustment': rect(0, 400, 300, 80), 'debtEdit.kind': rect(0, 100, 300, 80) })).toMatchObject({
			ids: ['debtEdit.adjustment'],
		});
	});

	it('a prévia só existe com os números digitados: sem ela, o texto sem apontar', () => {
		const six = stepOf(planTrail(TRAILS.debts, full, wealth), '6');
		expect(resolveTrailStep(six, {})).toEqual({ kind: 'text', bodyKey: 'trails.debts.steps.6.body' });
	});

	it('ida e volta: abre a Nova dívida, fecha sem salvar, abre a dívida e a edição dela, e no fim volta ao Patrimônio', () => {
		const plan = planTrail(TRAILS.debts, full, wealth);
		let stack: TrailLocation[] = [wealth];
		const actions: string[] = [];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			for (const action of next.actions)
				actions.push(action.type === 'push' ? `push ${action.location.screen}` : action.type === 'pop' ? `pop ${action.count}` : action.type);
			stack = next.stack;
		}
		expect(actions).toEqual(['push debtNew', 'pop 1', 'push debt', 'push debtEdit']);
		expect(stack).toEqual([wealth, { screen: 'debt', params: { id: 'carro' } }, { screen: 'debtEdit', params: { id: 'carro' } }]);
		// "Voltar" do 12 para o 11: fecha a edição, sem salvar.
		expect(navigateTrail(stack, plan[10].location).actions).toEqual([{ type: 'pop', count: 1 }]);
		expect(navigateTrail(stack, wealth)).toEqual({ actions: [{ type: 'pop', count: 2 }], stack: [wealth] });
	});

	it('começando pela Nova dívida (com algo digitado), o passo do Patrimônio não tira o formulário da pilha', () => {
		expect(dropsOrigin([{ screen: 'debtNew' }], wealth)).toBe(true);
		expect(dropsOrigin([{ screen: 'debtEdit', params: { id: 'carro' } }], wealth)).toBe(true);
		// A tela da dívida abre por cima do formulário, que fica.
		expect(dropsOrigin([{ screen: 'debtNew' }], { screen: 'debt', params: { id: 'carro' } })).toBe(false);
		// A tela da dívida não guarda nada digitado: pode sair.
		expect(dropsOrigin([{ screen: 'debt', params: { id: 'carro' } }], wealth)).toBe(false);
	});
});

describe('Trilha 10 — Reserva de emergência e "Por onde começar"', () => {
	const plan = planTrail(TRAILS.reserve, full, wealth);

	it('tudo no Patrimônio, sem trocar de tela', () => {
		expect(locations(plan)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((id) => `${id}@wealth`));
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['3', '5']);
		let stack: TrailLocation[] = [wealth];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			expect(next.actions).toEqual([]);
			stack = next.stack;
		}
	});

	it('"Quando enche" sem custo conhecido: aponta "Informar o custo mensal" com o texto do [sem dado]', () => {
		const seven = stepOf(plan, '7');
		expect(resolveTrailStep(seven, { 'reserve.fill': rect(0, 300, 300, 40) })).toEqual({
			kind: 'point',
			ids: ['reserve.fill'],
			bodyKey: 'trails.reserve.steps.7.body',
		});
		expect(resolveTrailStep(seven, { 'reserve.setCost': rect(0, 300, 300, 48) })).toEqual({
			kind: 'point',
			ids: ['reserve.setCost'],
			bodyKey: 'trails.reserve.steps.7.missing',
		});
		expect(resolveTrailStep(seven, {})).toEqual({ kind: 'text', bodyKey: 'trails.reserve.steps.7.missing' });
	});

	it('reserva cheia: a linha da cascata some, e o passo 6 mostra o mesmo texto sem apontar', () => {
		expect(resolveTrailStep(stepOf(plan, '6'), {})).toEqual({ kind: 'text', bodyKey: 'trails.reserve.steps.6.body' });
	});
});

describe('Trilha 11 — Patrimônio', () => {
	const plan = planTrail(TRAILS.netWorth, full, wealth);

	it('reserva zerada: o passo 3 aponta só "Investimentos"', () => {
		expect(resolveTrailStep(stepOf(plan, '3'), { 'netWorth.invested': rect(0, 200, 150, 40) })).toEqual({
			kind: 'point',
			ids: ['netWorth.invested'],
			bodyKey: 'trails.netWorth.steps.3.body',
		});
	});

	it('nada informado fora do app: o passo 4 aponta "Tenho", com o mesmo texto', () => {
		expect(resolveTrailStep(stepOf(plan, '4'), { 'netWorth.have': rect(0, 150, 150, 20) })).toEqual({
			kind: 'point',
			ids: ['netWorth.have'],
			bodyKey: 'trails.netWorth.steps.4.body',
		});
	});

	it('o título da tela fica fora da rolagem; os passos 7 e 8 são "Atenção"', () => {
		expect(stepOf(plan, '8')).toMatchObject({ fixed: true, attention: true, targets: [['wealth.title']] });
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['7', '8']);
	});
});

describe('Trilha 12 — "Este mês" e o orçamento', () => {
	const home: TrailLocation = { screen: 'home' };

	it('sem cartão, o passo 4 (fatura × compras) sai do plano', () => {
		expect(planTrail(TRAILS.month, full, home).map((step) => step.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
		expect(planTrail(TRAILS.month, { ...full, card: [] }, home).map((step) => step.id)).toEqual(['1', '2', '3', '5', '6', '7', '8']);
	});

	it('sem envelope, o passo 5 é pulado na tela; nada a revisar, o 7 mostra o texto sem apontar', () => {
		const plan = planTrail(TRAILS.month, full, home);
		expect(resolveTrailStep(stepOf(plan, '5'), {})).toEqual({ kind: 'skip' });
		expect(resolveTrailStep(stepOf(plan, '7'), {})).toEqual({ kind: 'text', bodyKey: 'trails.month.steps.7.body' });
		expect(resolveTrailStep(stepOf(plan, '7'), { 'month.pendingSpend': rect(0, 300, 300, 20) })).toMatchObject({
			kind: 'point',
			ids: ['month.pendingSpend'],
		});
	});
});

describe('Trilha 13 — Lançamentos', () => {
	const plan = planTrail(TRAILS.transactions, full, { screen: 'transactions' });

	it('mês vazio: o passo 7 aponta "Nenhum lançamento em …" com o texto do [sem dado]', () => {
		expect(resolveTrailStep(stepOf(plan, '7'), { 'transactions.empty': rect(0, 300, 300, 80) })).toEqual({
			kind: 'point',
			ids: ['transactions.empty'],
			bodyKey: 'trails.transactions.steps.7.missing',
		});
		expect(resolveTrailStep(stepOf(plan, '7'), { 'transactions.first': rect(0, 300, 300, 60) })).toMatchObject({
			bodyKey: 'trails.transactions.steps.7.body',
		});
	});

	it('uma conta só com movimento: o passo 6 mostra o texto sem apontar', () => {
		expect(resolveTrailStep(stepOf(plan, '6'), {})).toEqual({ kind: 'text', bodyKey: 'trails.transactions.steps.6.body' });
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['3', '8']);
	});
});

describe('Trilhas 14 e 15 — Relatórios', () => {
	const reports: TrailLocation = { screen: 'reports' };

	it('sem dívidas, o passo 8 da saúde financeira sai do plano', () => {
		expect(planTrail(TRAILS.health, full, reports)).toHaveLength(10);
		expect(planTrail(TRAILS.health, { ...full, debt: [] }, reports).map((step) => step.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '9', '10']);
	});

	it('sem meta: "Capital hoje" e o ritmo apontam "Definir meta", com o mesmo texto', () => {
		const plan = planTrail(TRAILS.freedom, full, reports);
		const goal = { 'freedom.goal': rect(0, 200, 300, 48) };
		expect(resolveTrailStep(stepOf(plan, '4'), goal)).toEqual({ kind: 'point', ids: ['freedom.goal'], bodyKey: 'trails.freedom.steps.4.body' });
		expect(resolveTrailStep(stepOf(plan, '5'), goal)).toEqual({ kind: 'point', ids: ['freedom.goal'], bodyKey: 'trails.freedom.steps.5.body' });
		expect(resolveTrailStep(stepOf(plan, '6'), goal)).toEqual({ kind: 'text', bodyKey: 'trails.freedom.steps.6.body' });
	});

	it('os campos da meta ficam na folha, que o guia não abre: os passos 2 e 3 apontam o botão da meta', () => {
		const plan = planTrail(TRAILS.freedom, full, reports);
		expect(stepOf(plan, '2').targets).toEqual([['freedom.goal']]);
		expect(stepOf(plan, '3').targets).toEqual([['freedom.goal']]);
	});

	it('as duas ficam nos Relatórios, sem trocar de tela; aberta pelo "?" do Histórico, começa no 7', () => {
		for (const trail of [TRAILS.health, TRAILS.freedom]) {
			const plan = planTrail(trail, full, reports);
			expect(plan.every((step) => step.location.screen === 'reports')).toBe(true);
		}
		expect(startIndexOf(planTrail(TRAILS.freedom, full, reports), '7')).toBe(6);
	});

	it('de outra aba, os Relatórios abrem trocando de aba', () => {
		expect(navigateTrail([{ screen: 'home' }], reports)).toEqual({ actions: [{ type: 'tab', screen: 'reports' }], stack: [reports] });
		expect(navigateTrail([{ screen: 'home' }, { screen: 'settings' }], { screen: 'transactions' })).toEqual({
			actions: [
				{ type: 'pop', count: 1 },
				{ type: 'tab', screen: 'transactions' },
			],
			stack: [{ screen: 'transactions' }],
		});
	});
});
