import { TRAIL_SAMPLE_RECORDS } from '../trailSample';
import {
	dropsOrigin,
	navigateTrail,
	planTrail,
	resolveTrailStep,
	startIndexOf,
	TRAIL_SCREENS,
	TRAILS,
	type TrailLocation,
	type TrailRecords,
	unionRect,
} from '../trails';

/**
 * As trilhas do tutorial (SPD-131): o guia anda pelas telas de verdade. Aqui só a parte que
 * não depende de tela — o plano de cada trilha a partir do que o usuário tem (registros), o
 * passo cujo alvo não está na tela (o `[sem dado]` do texto aprovado), e a navegação entre as
 * telas: ir, voltar um passo e, no fim, voltar para onde começou.
 */

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Um usuário com duas contas (a poupança criada pela captura), um cartão e lançamentos. */
const full: TrailRecords = {
	account: [{ id: 'corrente' }, { id: 'poupanca' }],
	capturedAccount: [{ id: 'poupanca' }],
	feedAccount: [{ id: 'corrente' }],
	businessAccount: [{ id: 'corrente' }],
	card: [{ id: 'cartao' }],
	cardNoClosing: [],
	otherCard: [],
	debitCard: [{ accountId: 'corrente', last4: '1234' }],
	transaction: [{ id: 'lanc1' }],
	pending: [{}],
	capture: [{}],
};

const accounts: TrailLocation = { screen: 'accounts' };
const locations = (plan: ReturnType<typeof planTrail>) =>
	plan.map((step) => `${step.id}@${step.location.screen}${step.location.params ? `:${Object.values(step.location.params).join('/')}` : ''}`);

describe('plano de uma trilha', () => {
	it('Trilha 1 com contas: Contas › Nova conta › a conta (a primeira da lista) › Contas › a conta', () => {
		const plan = planTrail(TRAILS.accounts, full, accounts);
		expect(locations(plan)).toEqual([
			'1@accounts',
			'2@accounts',
			'3@accountNew',
			'4@accountNew',
			'5@accountNew',
			'6@accountNew',
			'7@accountNew',
			'8@accountNew',
			'9@account:corrente',
			// "Saldo não informado" aparece numa conta criada pela captura: a poupança.
			'10@account:poupanca',
			'11@accounts',
			'12@account:corrente',
		]);
		expect(plan.map((step) => step.titleKey)).toContain('trails.accounts.steps.1.title');
		expect(plan[9]).toMatchObject({ attention: true, bodyKey: 'trails.accounts.steps.10.body' });
		expect(plan[0].attention).toBe(false);
	});

	it('Trilha 1 sem nenhuma conta: o passo 9 vira o texto do [sem dado], sem apontar, onde o guia já está', () => {
		const plan = planTrail(TRAILS.accounts, { ...full, account: [], capturedAccount: [] }, accounts);
		const nine = plan.find((step) => step.id === '9');
		expect(nine).toMatchObject({
			textOnly: true,
			bodyKey: 'trails.accounts.steps.9.missing',
			titleKey: 'trails.accounts.steps.9.title',
			location: { screen: 'accountNew' },
		});
		// O 10 ("mesmo texto, sem apontar") e o 12 (sem [sem dado]: o texto, sem apontar).
		expect(plan.find((step) => step.id === '10')).toMatchObject({ textOnly: true, bodyKey: 'trails.accounts.steps.10.body' });
		expect(plan.find((step) => step.id === '12')).toMatchObject({ textOnly: true, location: { screen: 'accounts' } });
		expect(plan).toHaveLength(12);
	});

	it('aberta pelo "?" do Acertar de uma conta: a trilha começa no passo 9, na própria conta', () => {
		const here: TrailLocation = { screen: 'account', params: { id: 'poupanca' } };
		const plan = planTrail(TRAILS.accounts, full, here);
		expect(startIndexOf(plan, '9')).toBe(8);
		expect(plan[8].location).toEqual(here);
		expect(plan[11].location).toEqual(here);
	});

	it('passo com [sem dado: passo pulado] sai do plano: sem cartão de débito, sem conta do Nubank', () => {
		const extras = planTrail(TRAILS.cardExtras, { ...full, debitCard: [] }, { screen: 'card', params: { id: 'cartao' } });
		expect(extras.map((step) => step.id)).toEqual(['1', '2', '3', '4', '6', '8', '9']);
		const capture = planTrail(TRAILS.capture, { ...full, businessAccount: [] }, { screen: 'settings' });
		expect(capture.map((step) => step.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '11', '12']);
	});

	it('com dois cartões, o "Juntar" (passo 7) aparece', () => {
		const extras = planTrail(TRAILS.cardExtras, { ...full, otherCard: [{ id: 'outro' }] }, { screen: 'cards' });
		expect(extras.map((step) => step.id)).toContain('7');
		expect(extras.find((step) => step.id === '6')?.location).toEqual({ screen: 'cardEdit', params: { id: 'cartao' } });
	});

	it('Trilha 3 sem cartão: anda no cartão de exemplo (SPD-147), sem o "Nenhum cartão ainda"', () => {
		const plan = planTrail(TRAILS.cardInvoice, { ...full, card: [] }, { screen: 'cards' }, TRAIL_SAMPLE_RECORDS);
		expect(plan).toHaveLength(12);
		expect(plan[0]).toMatchObject({
			location: { screen: 'card', params: { id: 'exemplo-cartao' } },
			textOnly: false,
			sample: true,
			bodyKey: 'trails.cardInvoice.steps.1.body',
		});
	});

	it('Trilha 6 sem captura (iPhone): só o passo 1, com o texto do iPhone', () => {
		const plan = planTrail(TRAILS.capture, { ...full, capture: [] }, { screen: 'home' });
		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatchObject({ id: '1', textOnly: true, bodyKey: 'trails.capture.steps.ios.body', location: { screen: 'settings' } });
	});

	it('Trilha 7 sem nada para revisar: "Para revisar" vazia, passos 1, 9 e 11 sem apontar', () => {
		const plan = planTrail(TRAILS.review, { ...full, pending: [] }, { screen: 'inbox' });
		expect(plan.map((step) => step.id)).toEqual(['1', '9', '11']);
		expect(plan.every((step) => step.textOnly && step.location.screen === 'inbox')).toBe(true);
		expect(plan[1].bodyKey).toBe('trails.review.steps.9.body');
	});

	it('o registro de onde a trilha começou vale antes do primeiro da lista', () => {
		const plan = planTrail(TRAILS.cardInvoice, { ...full, card: [{ id: 'a' }, { id: 'b' }] }, { screen: 'card', params: { id: 'b' } });
		expect(plan[0].location).toEqual({ screen: 'card', params: { id: 'b' } });
	});

	it('cada passo das trilhas 1 a 7 e 9 a 15 tem tela, alvo ou texto sem apontar, e o "Atenção" dos textos aprovados', () => {
		const attention: Record<string, string[]> = {
			accounts: ['10', '11'],
			cardSetup: ['9', '11'],
			cardInvoice: ['3', '5', '10', '11'],
			cardExtras: ['8'],
			add: ['10', '12'],
			capture: ['3', '7', '8', '12'],
			review: ['7', '8'],
			// Trilhas 9 a 15 (SPD-131b).
			debts: ['5', '7'],
			reserve: ['3', '5'],
			netWorth: ['7', '8'],
			month: ['7'],
			transactions: ['3', '8'],
			health: [],
			freedom: ['5'],
		};
		const sizes: Record<string, number> = {
			accounts: 12,
			cardSetup: 11,
			cardInvoice: 12,
			cardExtras: 9,
			add: 12,
			capture: 12,
			review: 11,
			debts: 12,
			reserve: 9,
			netWorth: 8,
			month: 8,
			transactions: 8,
			health: 10,
			freedom: 10,
		};
		for (const [id, trail] of Object.entries(TRAILS)) {
			expect(trail.steps.map((step) => step.id)).toEqual(Array.from({ length: sizes[id] }, (_, index) => String(index + 1)));
			expect(trail.steps.filter((step) => step.attention).map((step) => step.id)).toEqual(attention[id]);
			for (const step of trail.steps) {
				expect(TRAIL_SCREENS[step.screen]).toBeDefined();
				expect(step.textOnly || (step.targets?.length ?? 0) > 0).toBe(true);
			}
		}
	});
});

describe('o passo na tela: alvo, [sem dado] ou pular', () => {
	const plan = planTrail(TRAILS.accounts, full, accounts);
	const step = (id: string) => {
		const found = plan.find((candidate) => candidate.id === id);
		if (!found) throw new Error(id);
		return found;
	};

	it('lista vazia: o passo 2 aponta para "Suas contas e cartões aparecem aqui…", mesmo texto', () => {
		expect(resolveTrailStep(step('2'), { 'accounts.empty': rect(0, 300, 300, 40), 'accounts.add': rect(0, 200, 300, 48) })).toEqual({
			kind: 'point',
			ids: ['accounts.empty'],
			bodyKey: 'trails.accounts.steps.2.body',
		});
		expect(resolveTrailStep(step('2'), { 'accounts.add': rect(0, 200, 300, 48) })).toMatchObject({ kind: 'point', ids: ['accounts.add'] });
	});

	it('"Nome" e "Tipo" juntos: os dois alvos viram um destaque só', () => {
		expect(resolveTrailStep(step('3'), { 'accountEdit.name': rect(0, 100, 300, 60), 'accountEdit.kind': rect(0, 170, 300, 80) })).toMatchObject({
			kind: 'point',
			ids: ['accountEdit.name', 'accountEdit.kind'],
		});
		expect(unionRect([rect(0, 100, 300, 60), rect(10, 170, 300, 80)])).toEqual(rect(0, 100, 310, 150));
	});

	it('"Este dinheiro é…" só existe com o papel Reserva: aponta para o botão "Reserva", mesmo texto', () => {
		expect(resolveTrailStep(step('6'), { 'accountEdit.roleReserve': rect(0, 100, 120, 48) })).toMatchObject({
			kind: 'point',
			ids: ['accountEdit.roleReserve'],
			bodyKey: 'trails.accounts.steps.6.body',
		});
	});

	it('o aviso de duas contas do mesmo banco não está na tela: mesmo texto, sem apontar', () => {
		expect(resolveTrailStep(step('11'), {})).toEqual({ kind: 'text', bodyKey: 'trails.accounts.steps.11.body' });
		// Alvo com tamanho zero (o componente não desenhou nada) também não conta.
		expect(resolveTrailStep(step('11'), { 'accounts.duplicate': rect(0, 0, 0, 0) })).toEqual({
			kind: 'text',
			bodyKey: 'trails.accounts.steps.11.body',
		});
	});

	it('o texto do [sem dado] quando o campo não aparece: as parcelas sem cartão de crédito', () => {
		const add = planTrail(TRAILS.add, full, { screen: 'add' });
		const six = add.find((candidate) => candidate.id === '6');
		if (!six) throw new Error('6');
		expect(resolveTrailStep(six, {})).toEqual({ kind: 'text', bodyKey: 'trails.add.steps.6.missing' });
		expect(resolveTrailStep(six, { 'add.installments': rect(0, 0, 300, 90) })).toMatchObject({ kind: 'point', bodyKey: 'trails.add.steps.6.body' });
	});

	it('[sem dado: passo pulado] na tela: o passo sai', () => {
		const extras = planTrail(TRAILS.cardExtras, { ...full, otherCard: [{ id: 'outro' }] }, { screen: 'cards' });
		const seven = extras.find((candidate) => candidate.id === '7');
		if (!seven) throw new Error('7');
		expect(resolveTrailStep(seven, {})).toEqual({ kind: 'skip' });
	});

	it('passo planejado sem apontar nem mede alvo', () => {
		const plan9 = planTrail(TRAILS.accounts, { ...full, account: [] }, accounts).find((candidate) => candidate.id === '9');
		if (!plan9) throw new Error('9');
		expect(resolveTrailStep(plan9, { 'account.adjust': rect(0, 0, 100, 48) })).toEqual({
			kind: 'text',
			bodyKey: 'trails.accounts.steps.9.missing',
		});
	});
});

describe('navegação entre as telas', () => {
	const account = (id: string): TrailLocation => ({ screen: 'account', params: { id } });

	it('Contas › Nova conta: abre a Nova conta por cima', () => {
		expect(navigateTrail([accounts], { screen: 'accountNew' })).toEqual({
			actions: [{ type: 'push', location: { screen: 'accountNew' } }],
			stack: [accounts, { screen: 'accountNew' }],
		});
	});

	it('Nova conta › a conta: fecha o formulário (sem salvar) e abre a conta a partir de Contas', () => {
		expect(navigateTrail([accounts, { screen: 'accountNew' }], account('corrente'))).toEqual({
			actions: [
				{ type: 'pop', count: 1 },
				{ type: 'push', location: account('corrente') },
			],
			stack: [accounts, account('corrente')],
		});
	});

	it('a conta › Contas: volta; Contas › outra conta: abre de novo', () => {
		expect(navigateTrail([accounts, account('corrente')], accounts)).toEqual({ actions: [{ type: 'pop', count: 1 }], stack: [accounts] });
		expect(navigateTrail([accounts, account('corrente')], account('poupanca'))).toEqual({
			actions: [
				{ type: 'pop', count: 1 },
				{ type: 'push', location: account('poupanca') },
			],
			stack: [accounts, account('poupanca')],
		});
	});

	it('mesma tela: nada a fazer', () => {
		expect(navigateTrail([accounts, account('corrente')], account('corrente'))).toEqual({ actions: [], stack: [accounts, account('corrente')] });
	});

	it('começou na conta e o passo é Contas: Contas abre por cima (a pilha de baixo não é do guia)', () => {
		expect(navigateTrail([account('corrente')], accounts)).toEqual({
			actions: [{ type: 'push', location: accounts }],
			stack: [account('corrente'), accounts],
		});
	});

	it('de uma tela da pilha para uma aba: volta ao início das abas e troca de aba', () => {
		expect(navigateTrail([{ screen: 'card', params: { id: 'cartao' } }], { screen: 'add' })).toEqual({
			actions: [{ type: 'root' }, { type: 'tab', screen: 'add' }],
			stack: [{ screen: 'add' }],
		});
		expect(navigateTrail([{ screen: 'home' }, { screen: 'inbox' }], { screen: 'add' })).toEqual({
			actions: [
				{ type: 'pop', count: 1 },
				{ type: 'tab', screen: 'add' },
			],
			stack: [{ screen: 'add' }],
		});
	});

	it('saindo do formulário do "+" para uma tela da pilha, passa pela Início (o "+" não fica por baixo)', () => {
		expect(navigateTrail([{ screen: 'add' }], { screen: 'transaction', params: { id: 'lanc1' } })).toEqual({
			actions: [
				{ type: 'tab', screen: 'home' },
				{ type: 'push', location: { screen: 'transaction', params: { id: 'lanc1' } } },
			],
			stack: [{ screen: 'home' }, { screen: 'transaction', params: { id: 'lanc1' } }],
		});
	});

	it('editar cartão abre por cima do mesmo cartão', () => {
		const card = { screen: 'card', params: { id: 'cartao' } } as const;
		const edit = { screen: 'cardEdit', params: { id: 'cartao' } } as const;
		expect(navigateTrail([{ screen: 'cards' }, card, { screen: 'debitCard', params: { accountId: 'c', last4: '1' } }], edit)).toEqual({
			actions: [
				{ type: 'pop', count: 1 },
				{ type: 'push', location: edit },
			],
			stack: [{ screen: 'cards' }, card, edit],
		});
		expect(navigateTrail([{ screen: 'cards' }, card], edit).actions).toEqual([{ type: 'push', location: edit }]);
	});

	it('Trilha 1 inteira, ida e volta: termina em Contas, onde começou', () => {
		const plan = planTrail(TRAILS.accounts, full, accounts);
		let stack: TrailLocation[] = [accounts];
		const pushes: string[] = [];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			for (const action of next.actions) if (action.type === 'push') pushes.push(action.location.screen);
			stack = next.stack;
		}
		expect(pushes).toEqual(['accountNew', 'account', 'account', 'account']);
		// O "Voltar" do passo 12 para o 11: volta para Contas.
		expect(navigateTrail(stack, plan[10].location).actions).toEqual([{ type: 'pop', count: 1 }]);
		// O fim: de volta a Contas.
		expect(navigateTrail(stack, accounts)).toEqual({ actions: [{ type: 'pop', count: 1 }], stack: [accounts] });
	});

	it('o fim numa tela que saiu da pilha (começou nos Ajustes, terminou na Início): os Ajustes abrem de novo', () => {
		expect(navigateTrail([{ screen: 'home' }], { screen: 'settings' })).toEqual({
			actions: [{ type: 'push', location: { screen: 'settings' } }],
			stack: [{ screen: 'home' }, { screen: 'settings' }],
		});
	});
});

describe('a tela de origem com algo digitado não sai da pilha', () => {
	const cardEdit: TrailLocation = { screen: 'cardEdit', params: { id: 'c1' } };

	it('do formulário do cartão para uma aba: ficaria sem o formulário — o passo fica onde está', () => {
		expect(dropsOrigin([cardEdit], { screen: 'add' })).toBe(true);
		expect(dropsOrigin([cardEdit, { screen: 'cards' }], { screen: 'home' })).toBe(true);
		expect(dropsOrigin([{ screen: 'inbox' }], { screen: 'home' })).toBe(true);
		expect(dropsOrigin([{ screen: 'account', params: { id: 'a1' } }], { screen: 'home' })).toBe(true);
	});

	it('telas abertas por cima do formulário e a volta até ele: o formulário fica', () => {
		expect(dropsOrigin([cardEdit], { screen: 'cards' })).toBe(false);
		expect(dropsOrigin([cardEdit, { screen: 'cards' }], { screen: 'cardNew' })).toBe(false);
		expect(dropsOrigin([cardEdit, { screen: 'cards' }, { screen: 'cardNew' }], cardEdit)).toBe(false);
		expect(dropsOrigin([{ screen: 'account', params: { id: 'a1' } }], { screen: 'accountNew' })).toBe(false);
	});

	it('origem sem nada digitado (Contas, o cartão, uma aba): pode sair', () => {
		expect(dropsOrigin([{ screen: 'accounts' }], { screen: 'home' })).toBe(false);
		expect(dropsOrigin([{ screen: 'card', params: { id: 'c1' } }], { screen: 'add' })).toBe(false);
		expect(dropsOrigin([{ screen: 'add' }], { screen: 'home' })).toBe(false);
		expect(dropsOrigin([], { screen: 'home' })).toBe(false);
	});

	it('só os formulários e a revisão guardam algo sem salvar', () => {
		const kept = Object.entries(TRAIL_SCREENS)
			.filter(([, def]) => def.keep)
			.map(([screen]) => screen)
			.sort();
		expect(kept).toEqual(['account', 'accountNew', 'cardEdit', 'cardNew', 'debtEdit', 'debtNew', 'inbox']);
	});
});

describe('onde começa', () => {
	it('sem passo pedido, no primeiro; passo que saiu do plano, no seguinte', () => {
		const plan = planTrail(TRAILS.cardExtras, { ...full, debitCard: [] }, { screen: 'cards' });
		expect(startIndexOf(plan)).toBe(0);
		expect(startIndexOf(plan, '5')).toBe(plan.findIndex((step) => step.id === '6'));
		expect(startIndexOf(plan, '99')).toBe(0);
	});
});
