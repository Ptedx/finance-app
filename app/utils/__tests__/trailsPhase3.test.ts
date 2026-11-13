import { billRecords } from '../../components/tour/TrailRecordsSource';
import type { Bill } from '../../database/schema';
import { TRAIL_SAMPLE_RECORDS } from '../trailSample';
import {
	navigateTrail,
	planTrail,
	resolveTrailStep,
	startIndexOf,
	TRAIL_SCREENS,
	TRAILS,
	type TrailId,
	type TrailLocation,
	type TrailRecords,
} from '../trails';

/**
 * As trilhas 8, 16 e 21 do tutorial (SPD-131c): Contas a pagar e lembretes; Extrato do banco
 * (OFX); e Tela inicial. Aqui só a parte que não depende de tela: o plano com e sem dado, o
 * passo cujo alvo não está na tela (o `[sem dado]` do texto aprovado) e a navegação — Início ›
 * Contas a pagar › Nova conta a pagar › a conta e a volta.
 */

// `billRecords` mora junto do componente que lê os contextos: eles carregam, sem banco nem
// armazenamento.
jest.mock('../../database/database', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Um usuário com duas contas a pagar e o resto das outras trilhas. */
const full: TrailRecords = {
	account: [{ id: 'corrente' }],
	card: [{ id: 'cartao' }],
	transaction: [{ id: 'lanc1' }],
	pending: [{}],
	capture: [{}],
	bill: [{ id: 'internet' }, { id: 'plano' }],
	// As condições da tela inicial e de Contas a pagar (SPD-160).
	anyBill: [{}],
	anyCard: [{}],
	anyAccount: [{}],
	unassigned: [{}],
};

const home: TrailLocation = { screen: 'home' };
// Os parâmetros vazios (`{}`, as condições do SPD-160) são a mesma tela, sem parâmetro.
const locations = (plan: ReturnType<typeof planTrail>) =>
	plan.map((step) => {
		const params = Object.values(step.location.params ?? {});
		return `${step.id}@${step.location.screen}${params.length > 0 ? `:${params.join('/')}` : ''}`;
	});
const stepOf = (plan: ReturnType<typeof planTrail>, id: string) => {
	const found = plan.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`passo ${id} fora do plano`);
	return found;
};

const NEW_TRAILS: TrailId[] = ['bills', 'ofx', 'home'];

describe('o app sem nenhum dado', () => {
	it.each(
		NEW_TRAILS
	)('%s: nenhum passo pede uma tela de registro que não existe; com o exemplo, nenhum sai do plano', (id) => {
		for (const samples of [undefined, TRAIL_SAMPLE_RECORDS]) {
			const plan = planTrail(TRAILS[id], {}, home, samples);
			// Sem os exemplos (SPD-160), "Revisar" e "Sem conta" da tela inicial saem pelos dados.
			const out = samples === undefined && id === 'home' ? ['1', '7', '8'] : [];
			expect(plan.map((step) => step.id)).toEqual(
				TRAILS[id].steps.map((step) => step.id).filter((step) => !out.includes(step))
			);
			for (const step of plan) {
				const kind = TRAIL_SCREENS[step.location.screen].record;
				// Tela de registro sem o registro: o passo é texto, na tela anterior.
				if (kind !== undefined) expect(step.location.params).toBeDefined();
			}
		}
	});

	it.each(NEW_TRAILS)('%s: sem nenhum alvo na tela, cada passo mostra um texto ou sai — nunca aponta', (id) => {
		for (const step of planTrail(TRAILS[id], {}, home)) {
			const resolved = resolveTrailStep(step, {});
			expect(resolved.kind === 'text' || resolved.kind === 'skip').toBe(true);
		}
	});
});

describe('Trilha 8 — Contas a pagar e lembretes', () => {
	it('com contas: Início › Contas a pagar › Nova conta a pagar › Contas a pagar › a primeira conta', () => {
		const plan = planTrail(TRAILS.bills, full, home);
		expect(locations(plan)).toEqual([
			'1@home',
			'2@bills',
			'3@billNew',
			'4@billNew',
			'5@billNew',
			'6@billNew',
			'7@billNew',
			'8@bills',
			'9@bills',
			'10@bills',
			'11@bills',
			'12@billEdit:internet',
		]);
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['7', '9', '11']);
		expect(plan.filter((step) => step.textOnly)).toEqual([]);
		expect(stepOf(plan, '3')).toMatchObject({
			titleKey: 'trails.bills.steps.3.title',
			bodyKey: 'trails.bills.steps.3.body',
			targets: [['billEdit.name', 'billEdit.dueDay']],
		});
	});

	it('sem nenhuma conta a pagar e sem os exemplos: o card, "Já paguei", "Desfazer", a lista e a edição viram texto sem apontar', () => {
		const plan = planTrail(TRAILS.bills, { ...full, bill: [], anyBill: [] }, home);
		expect(plan).toHaveLength(12);
		expect(plan.filter((step) => step.textOnly).map((step) => step.id)).toEqual([
			'1',
			'8',
			'9',
			'10',
			'11',
			'12',
		]);
		expect(stepOf(plan, '1')).toMatchObject({
			bodyKey: 'trails.bills.steps.1.missing',
			location: home,
		});
		expect(stepOf(plan, '12')).toMatchObject({
			bodyKey: 'trails.bills.steps.12.body',
			location: { screen: 'billNew' },
		});
		expect(plan.some((step) => step.sample)).toBe(false);
	});

	it('sem nenhuma conta a pagar, com os exemplos (SPD-160): o card, a lista e a edição de exemplo, e cada passo aponta', () => {
		const plan = planTrail(
			TRAILS.bills,
			{ ...full, bill: [], anyBill: [] },
			home,
			TRAIL_SAMPLE_RECORDS
		);
		expect(locations(plan)).toEqual([
			'1@home',
			'2@bills',
			'3@billNew',
			'4@billNew',
			'5@billNew',
			'6@billNew',
			'7@billNew',
			'8@bills',
			'9@bills',
			'10@bills',
			'11@bills',
			'12@billEdit:exemplo-conta-a-pagar',
		]);
		expect(plan.filter((step) => step.textOnly)).toEqual([]);
		expect(plan.filter((step) => step.sample).map((step) => step.id)).toEqual([
			'1',
			'8',
			'9',
			'10',
			'11',
			'12',
		]);
		// A lista de exemplo é a lista de sempre: `{}` e sem parâmetro são a mesma tela.
		let stack: TrailLocation[] = [home];
		const actions: string[] = [];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			for (const action of next.actions)
				actions.push(action.type === 'push' ? `push ${action.location.screen}` : action.type === 'pop' ? `pop ${action.count}` : action.type);
			stack = next.stack;
		}
		expect(actions).toEqual(['push bills', 'push billNew', 'pop 1', 'push billEdit']);
	});

	it('com contas a pagar de verdade, nada de exemplo, mesmo com os exemplos', () => {
		const plan = planTrail(TRAILS.bills, full, home, TRAIL_SAMPLE_RECORDS);
		expect(plan.some((step) => step.sample)).toBe(false);
		expect(stepOf(plan, '12').location).toEqual({ screen: 'billEdit', params: { id: 'internet' } });
		// Só desativadas: ainda são do usuário — o exemplo não entra.
		const inactive = planTrail(
			TRAILS.bills,
			{ bill: [{ id: 'desligada' }], anyBill: [{}] },
			home,
			TRAIL_SAMPLE_RECORDS
		);
		expect(inactive.some((step) => step.sample)).toBe(false);
	});

	it('passo 1: o card com contas; sem nenhuma, o "Cadastrar" com o texto próprio; sem os dois, o texto próprio sem apontar', () => {
		const one = stepOf(planTrail(TRAILS.bills, full, home), '1');
		expect(resolveTrailStep(one, { 'home.billsCard': rect(0, 300, 360, 200) })).toEqual({
			kind: 'point',
			ids: ['home.billsCard'],
			bodyKey: 'trails.bills.steps.1.body',
		});
		expect(resolveTrailStep(one, { 'home.billsInvite': rect(250, 300, 100, 44) })).toEqual({
			kind: 'point',
			ids: ['home.billsInvite'],
			bodyKey: 'trails.bills.steps.1.missing',
		});
		expect(resolveTrailStep(one, {})).toEqual({ kind: 'text', bodyKey: 'trails.bills.steps.1.missing' });
	});

	it('passo 2: o "Cadastrar conta" da lista vazia; com contas, o "+" do topo', () => {
		const two = stepOf(planTrail(TRAILS.bills, full, home), '2');
		expect(resolveTrailStep(two, { 'bills.add': rect(320, 40, 44, 44) })).toMatchObject({ ids: ['bills.add'] });
		expect(resolveTrailStep(two, { 'bills.add': rect(320, 40, 44, 44), 'bills.emptyAdd': rect(100, 200, 160, 44) })).toMatchObject({
			ids: ['bills.emptyAdd'],
		});
	});

	it('"Já paguei", "Desfazer" e a lista sem nada na tela (nada a pagar, nada pago): o mesmo texto, sem apontar', () => {
		const plan = planTrail(TRAILS.bills, full, home);
		for (const id of ['8', '9', '10', '11'])
			expect(resolveTrailStep(stepOf(plan, id), {})).toEqual({ kind: 'text', bodyKey: `trails.bills.steps.${id}.body` });
	});

	it('passo 5 sem conta cadastrada: aponta só a categoria', () => {
		const five = stepOf(planTrail(TRAILS.bills, full, home), '5');
		expect(resolveTrailStep(five, { 'billEdit.category': rect(0, 400, 360, 60) })).toMatchObject({ ids: ['billEdit.category'] });
	});

	it('o "?" de Contas a pagar abre no passo 2, nela mesma', () => {
		const here: TrailLocation = { screen: 'bills' };
		const plan = planTrail(TRAILS.bills, full, here);
		expect(startIndexOf(plan, '2')).toBe(1);
		expect(plan[1].location).toEqual(here);
	});

	it('ida e volta: abre Contas a pagar, a Nova conta, fecha sem salvar, abre a conta, e no fim volta ao Início', () => {
		const plan = planTrail(TRAILS.bills, full, home);
		let stack: TrailLocation[] = [home];
		const actions: string[] = [];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			for (const action of next.actions)
				actions.push(action.type === 'push' ? `push ${action.location.screen}` : action.type === 'pop' ? `pop ${action.count}` : action.type);
			stack = next.stack;
		}
		// Do 7 (Nova conta) para o 8 (Contas a pagar): fecha o formulário, sem salvar. Contas a
		// pagar abre direto do Início, como o toque no card.
		expect(actions).toEqual(['push bills', 'push billNew', 'pop 1', 'push billEdit']);
		expect(stack).toEqual([home, { screen: 'bills' }, { screen: 'billEdit', params: { id: 'internet' } }]);
		// "Voltar" do 12 para o 11: fecha a edição, sem salvar.
		expect(navigateTrail(stack, plan[10].location).actions).toEqual([{ type: 'pop', count: 1 }]);
		expect(navigateTrail(stack, home)).toEqual({ actions: [{ type: 'pop', count: 2 }], stack: [home] });
	});
});

describe('as contas a pagar que a edição abre', () => {
	const bill = (id: string, extra: Partial<Bill> = {}): Bill => ({
		id,
		name: `Conta ${id}`,
		dueDay: 10,
		amountCents: 10_000,
		accountId: null,
		category: null,
		matchHint: null,
		debtId: null,
		paidThrough: null,
		paidByRef: null,
		active: true,
		sortOrder: 0,
		updatedAt: '2026-11-01T00:00:00.000Z',
		...extra,
	});

	it('primeiro as ativas cadastradas à mão (com "Desativar" e "Apagar"), depois as de dívida e as desativadas; apagadas, nunca', () => {
		expect(
			billRecords([
				bill('divida', { debtId: 'carro' }),
				bill('desligada', { active: false }),
				bill('apagada', { deletedAt: '2026-11-02T00:00:00.000Z' }),
				bill('internet'),
			])
		).toEqual([{ id: 'internet' }, { id: 'divida' }, { id: 'desligada' }]);
		expect(billRecords([])).toEqual([]);
	});
});

describe('Trilha 16 — Extrato do banco (OFX)', () => {
	it('tudo em Configurações: os passos 1 e 2 apontam o item do extrato; 3 a 7 são texto', () => {
		const settings: TrailLocation = { screen: 'settings' };
		const plan = planTrail(TRAILS.ofx, {}, settings);
		expect(locations(plan)).toEqual(['1', '2', '3', '4', '5', '6', '7'].map((id) => `${id}@settings`));
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['4', '7']);
		expect(plan.filter((step) => step.textOnly).map((step) => step.id)).toEqual(['3', '4', '5', '6', '7']);
		expect(stepOf(plan, '1').targets).toEqual([['settings.ofx']]);
		let stack: TrailLocation[] = [settings];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			expect(next.actions).toEqual([]);
			stack = next.stack;
		}
	});
});

describe('Trilha 21 — Tela inicial', () => {
	const plan = planTrail(TRAILS.home, full, home);

	it('tudo no Início, sem trocar de tela', () => {
		expect(locations(plan)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((id) => `${id}@home`));
		expect(plan.filter((step) => step.attention).map((step) => step.id)).toEqual(['8']);
		let stack: TrailLocation[] = [home];
		for (const step of plan) {
			const next = navigateTrail(stack, step.location);
			expect(next.actions).toEqual([]);
			stack = next.stack;
		}
	});

	it('"Revisar", "Proteja seus dados" e "Sem conta" fora da tela: os passos saem', () => {
		for (const id of ['1', '2', '7', '8']) expect(resolveTrailStep(stepOf(plan, id), {})).toEqual({ kind: 'skip' });
	});

	it('sem cartão, aponta "Adicionar cartão"; sem conta, "Adicionar conta" — com o mesmo texto', () => {
		expect(resolveTrailStep(stepOf(plan, '5'), { 'home.cardsAdd': rect(20, 500, 300, 160) })).toEqual({
			kind: 'point',
			ids: ['home.cardsAdd'],
			bodyKey: 'trails.home.steps.5.body',
		});
		expect(resolveTrailStep(stepOf(plan, '6'), { 'home.accountsAdd': rect(20, 700, 300, 50) })).toEqual({
			kind: 'point',
			ids: ['home.accountsAdd'],
			bodyKey: 'trails.home.steps.6.body',
		});
		// Com cartões: o título e os totais juntos.
		expect(
			resolveTrailStep(stepOf(plan, '5'), { 'home.cards': rect(0, 500, 360, 40), 'home.cardsTotals': rect(0, 540, 360, 60) })
		).toMatchObject({ ids: ['home.cards', 'home.cardsTotals'] });
	});

	it('passo 3: sem contas a pagar, aponta o "Cadastrar" com o texto próprio', () => {
		expect(resolveTrailStep(stepOf(plan, '3'), { 'home.billsInvite': rect(250, 300, 100, 44) })).toEqual({
			kind: 'point',
			ids: ['home.billsInvite'],
			bodyKey: 'trails.home.steps.3.missing',
		});
	});
});

describe('Trilha 21 numa conta vazia: cada bloco que falta de exemplo (SPD-160)', () => {
	const empty: TrailRecords = {};

	it('"Revisar", as contas a pagar, Cartões, Contas e "Sem conta" marcados como exemplo; tudo no Início, sem trocar de tela', () => {
		const plan = planTrail(TRAILS.home, empty, home, TRAIL_SAMPLE_RECORDS);
		expect(plan.map((step) => step.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
		expect(plan.filter((step) => step.sample).map((step) => step.id)).toEqual([
			'1',
			'3',
			'5',
			'6',
			'7',
			'8',
		]);
		expect(plan.filter((step) => step.textOnly)).toEqual([]);
		let stack: TrailLocation[] = [home];
		for (const step of plan) {
			expect(step.location.screen).toBe('home');
			const next = navigateTrail(stack, step.location);
			expect(next.actions).toEqual([]);
			stack = next.stack;
		}
		// Com o bloco de exemplo na tela, cada passo aponta o bloco, com o texto de sempre.
		const rects = {
			'home.review': rect(0, 100, 360, 52),
			'home.billsCard': rect(0, 170, 360, 120),
			'home.cards': rect(0, 600, 360, 40),
			'home.cardsTotals': rect(0, 640, 360, 60),
			'home.accounts': rect(0, 900, 360, 40),
			'home.accountsTotals': rect(0, 940, 360, 60),
			'home.unassigned': rect(0, 1060, 360, 56),
		};
		expect(resolveTrailStep(stepOf(plan, '1'), rects)).toEqual({
			kind: 'point',
			ids: ['home.review'],
			bodyKey: 'trails.home.steps.1.body',
		});
		expect(resolveTrailStep(stepOf(plan, '3'), rects)).toEqual({
			kind: 'point',
			ids: ['home.billsCard'],
			bodyKey: 'trails.home.steps.3.body',
		});
		expect(resolveTrailStep(stepOf(plan, '5'), rects)).toMatchObject({
			ids: ['home.cards', 'home.cardsTotals'],
		});
		expect(resolveTrailStep(stepOf(plan, '6'), rects)).toMatchObject({
			ids: ['home.accounts', 'home.accountsTotals'],
		});
		expect(resolveTrailStep(stepOf(plan, '7'), rects)).toMatchObject({ ids: ['home.unassigned'] });
		expect(resolveTrailStep(stepOf(plan, '8'), rects)).toMatchObject({ ids: ['home.unassigned'] });
	});

	it('"Proteja seus dados" não tem exemplo: com o usuário logado (sem o aviso na tela), o passo 2 sai', () => {
		const plan = planTrail(TRAILS.home, empty, home, TRAIL_SAMPLE_RECORDS);
		expect(stepOf(plan, '2').sample).toBe(false);
		expect(resolveTrailStep(stepOf(plan, '2'), {})).toEqual({ kind: 'skip' });
	});

	it('com o dado de verdade, o bloco é o de verdade: nada de exemplo naquele passo', () => {
		expect(
			planTrail(TRAILS.home, full, home, TRAIL_SAMPLE_RECORDS).some((step) => step.sample)
		).toBe(false);
		const someReal = planTrail(
			TRAILS.home,
			{ pending: [{}], anyCard: [{}] },
			home,
			TRAIL_SAMPLE_RECORDS
		);
		expect(someReal.filter((step) => step.sample).map((step) => step.id)).toEqual([
			'3',
			'6',
			'7',
			'8',
		]);
	});
});
