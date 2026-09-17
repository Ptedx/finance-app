import { type Candidate, decide, type KnownCapture, type MerchantRule } from '../captureMatcher';
import { addDays } from '../dateUtils';
import {
	findCaptureForLine,
	findTransactionForLine,
	type LedgerTransaction,
	planStatementImport,
	type PlannedLine,
	type StatementLine,
	type StatementPlanContext,
	statementFingerprint,
	statementPackageName,
	statementPostedAt,
} from '../statementMatcher';

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const NU_ACCOUNT = '0260:123';
const INTER_ACCOUNT = '0077:456';

/** Meio-dia UTC: o mesmo dia de calendário em qualquer fuso em que a suíte rode. */
const noticeAt = (date: string, offsetMinutes = 0): string =>
	new Date(new Date(`${date}T12:00:00.000Z`).getTime() + offsetMinutes * 60_000).toISOString();

const line = (overrides: Partial<StatementLine> = {}): StatementLine => ({
	accountKey: NU_ACCOUNT,
	bankName: 'Nubank',
	isCard: false,
	fitid: overrides.fitid ?? 'f1',
	postedDate: '2026-09-03',
	amountCents: 3590,
	direction: 'out',
	trnType: 'DEBIT',
	name: '',
	memo: 'Compra no débito - IFOOD',
	text: 'Compra no débito - IFOOD',
	kind: 'purchase',
	neutral: false,
	counterparty: 'IFOOD',
	merchantKey: 'ifood',
	suggestedCategory: 'food',
	...overrides,
});

const capture = (overrides: Partial<KnownCapture> = {}): KnownCapture => ({
	id: 'c1',
	packageName: NUBANK,
	postedAt: noticeAt('2026-09-03'),
	amountCents: 3590,
	direction: 'out',
	kind: 'purchase',
	merchantKey: 'ifood',
	status: 'pending',
	relatedId: null,
	transactionId: null,
	...overrides,
});

const tx = (overrides: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
	id: 't1',
	amountCents: 3590,
	isIncome: false,
	date: '2026-09-03',
	...overrides,
});

const context = (overrides: Partial<StatementPlanContext> = {}): StatementPlanContext => {
	let counter = 0;
	return {
		existingFingerprints: new Set(),
		captures: [],
		matchedCaptureIds: new Set(),
		transactions: [],
		linkedTransactionIds: new Set(),
		rules: new Map(),
		ownNames: [],
		autoConfirmThreshold: 3,
		nextId: () => `id-${++counter}`,
		...overrides,
	};
};

const actionOf = (planned: PlannedLine[], fitid: string) =>
	planned.find((p) => p.line.fitid === fitid)?.action;

describe('idempotência pelo FITID', () => {
	it('reimportar o mesmo arquivo não faz nada', () => {
		const lines = [line({ fitid: 'a' }), line({ fitid: 'b', amountCents: 1000 })];
		const first = planStatementImport(lines, context());
		expect(first.summary.skippedExisting).toBe(0);

		const second = planStatementImport(
			lines,
			context({ existingFingerprints: new Set(first.planned.map((p) => p.fingerprint)) })
		);
		expect(second.planned.every((p) => p.action.type === 'skip_existing')).toBe(true);
		expect(second.summary.skippedExisting).toBe(2);
		expect(second.summary.pending).toBe(0);
	});

	it('dois meses com sobreposição só processam as linhas novas', () => {
		const known = new Set([statementFingerprint(NU_ACCOUNT, 'a'), statementFingerprint(NU_ACCOUNT, 'b')]);
		const { planned, summary } = planStatementImport(
			[line({ fitid: 'b' }), line({ fitid: 'c', postedDate: '2026-09-20' })],
			context({ existingFingerprints: known })
		);
		expect(actionOf(planned, 'b')?.type).toBe('skip_existing');
		expect(actionOf(planned, 'c')?.type).toBe('decision');
		expect(summary).toMatchObject({ total: 2, skippedExisting: 1, pending: 1 });
	});

	it('o mesmo FITID em contas diferentes são linhas diferentes', () => {
		const { planned } = planStatementImport(
			[line({ fitid: 'x' }), line({ fitid: 'x', accountKey: INTER_ACCOUNT, bankName: 'Inter' })],
			context()
		);
		expect(planned.map((p) => p.action.type)).toEqual(['decision', 'decision']);
		expect(new Set(planned.map((p) => p.fingerprint)).size).toBe(2);
	});

	it('a mesma linha repetida dentro de um import entra uma vez', () => {
		const { summary } = planStatementImport([line({ fitid: 'a' }), line({ fitid: 'a' })], context());
		expect(summary).toMatchObject({ skippedExisting: 1, pending: 1 });
	});
});

describe('casar com notificação capturada', () => {
	it('mesmo dia, mesmo valor e direção: a linha vira "já vista", sem novo lançamento', () => {
		const { planned, summary } = planStatementImport([line()], context({ captures: [capture()] }));
		expect(planned[0].action).toEqual({ type: 'match_capture', captureId: 'c1' });
		expect(summary).toMatchObject({ matchedCaptures: 1, pending: 0 });
	});

	it('o extrato pode atrasar até 5 dias depois do aviso, e no máximo 1 dia antes', () => {
		const at = (statementDate: string) =>
			findCaptureForLine(line({ postedDate: statementDate }), [capture({ postedAt: noticeAt('2026-09-03') })], new Set());
		expect(at('2026-09-08')?.id).toBe('c1');
		expect(at('2026-09-09')).toBeUndefined();
		expect(at('2026-09-02')?.id).toBe('c1');
		expect(at('2026-09-01')).toBeUndefined();
	});

	it('valor ou direção diferentes nunca casam', () => {
		expect(findCaptureForLine(line({ amountCents: 3591 }), [capture()], new Set())).toBeUndefined();
		expect(findCaptureForLine(line({ direction: 'in' }), [capture()], new Set())).toBeUndefined();
	});

	it('duas linhas iguais e uma notificação: uma casa, a outra vai para revisão', () => {
		const { planned, summary } = planStatementImport(
			[line({ fitid: 'a' }), line({ fitid: 'b' })],
			context({ captures: [capture()] })
		);
		expect(planned.map((p) => p.action.type)).toEqual(['match_capture', 'decision']);
		expect(summary).toMatchObject({ matchedCaptures: 1, pending: 1 });
	});

	it('uma notificação já reivindicada por import anterior não casa de novo', () => {
		const { planned } = planStatementImport(
			[line()],
			context({ captures: [capture()], matchedCaptureIds: new Set(['c1']) })
		);
		expect(planned[0].action.type).toBe('decision');
	});

	it('descartada e ignorada não casam; transferência e confirmada casam', () => {
		const status = (s: KnownCapture['status']) =>
			findCaptureForLine(line(), [capture({ status: s })], new Set())?.id;
		expect(status('dismissed')).toBeUndefined();
		expect(status('ignored')).toBeUndefined();
		expect(status('duplicate')).toBeUndefined();
		expect(status('transfer')).toBe('c1');
		expect(status('confirmed')).toBe('c1');
		expect(status('pending')).toBe('c1');
	});

	it('linhas de extrato anteriores nunca são "notificação" de uma linha nova', () => {
		const previous = capture({
			id: 'old',
			packageName: statementPackageName(NU_ACCOUNT),
			postedAt: statementPostedAt('2026-09-03'),
		});
		const { planned } = planStatementImport([line({ fitid: 'new' })], context({ captures: [previous] }));
		// Mesmo valor, mesma conta, FITID diferente: é uma segunda compra de verdade.
		expect(planned[0].action).toEqual({ type: 'decision', decision: { action: 'pending', categoryId: 'food' } });
	});

	it('a notificação confirmada leva sua transação junto: a segunda linha não casa com ela', () => {
		const confirmed = capture({ status: 'confirmed', transactionId: 't1' });
		const { planned } = planStatementImport(
			[line({ fitid: 'a' }), line({ fitid: 'b' })],
			context({ captures: [confirmed], transactions: [tx({ id: 't1' })], linkedTransactionIds: new Set(['t1']) })
		);
		expect(planned.map((p) => p.action.type)).toEqual(['match_capture', 'decision']);
	});

	it('entre várias notificações compatíveis, casa a mais antiga (prazo mais cedo primeiro)', () => {
		const early = capture({ id: 'early', postedAt: noticeAt('2026-09-01') });
		const late = capture({ id: 'late', postedAt: noticeAt('2026-09-03') });
		expect(findCaptureForLine(line({ postedDate: '2026-09-03' }), [late, early], new Set())?.id).toBe('early');
	});

	it('o guloso não deixa notificação sem par quando existe um pareamento completo', () => {
		// R em 09-01 (linha em 09-03), R' em 09-04 (linha em 09-07). "Mais próximo" faria
		// a linha de 09-03 tomar R' e deixar R sem par; "mais antigo" casa os dois.
		const r = capture({ id: 'r', postedAt: noticeAt('2026-09-01') });
		const r2 = capture({ id: 'r2', postedAt: noticeAt('2026-09-04') });
		const { planned, summary } = planStatementImport(
			[line({ fitid: 'l1', postedDate: '2026-09-03' }), line({ fitid: 'l2', postedDate: '2026-09-07' })],
			context({ captures: [r2, r] })
		);
		expect(actionOf(planned, 'l1')).toEqual({ type: 'match_capture', captureId: 'r' });
		expect(actionOf(planned, 'l2')).toEqual({ type: 'match_capture', captureId: 'r2' });
		expect(summary.pending).toBe(0);
	});
});

describe('casar com lançamento do livro', () => {
	it('lançamento digitado no mesmo dia: a linha é ligada a ele', () => {
		const { planned, summary } = planStatementImport([line()], context({ transactions: [tx()] }));
		expect(planned[0].action).toEqual({ type: 'match_transaction', transactionId: 't1' });
		expect(summary.matchedTransactions).toBe(1);
	});

	it('o extrato pode vir até 5 dias depois do lançamento digitado, e até 2 dias antes', () => {
		// Linha em 09-03. Lançamento digitado entre 08-29 e 09-05 casa; fora disso, não.
		const at = (date: string) => findTransactionForLine(line(), [tx({ date })], new Set())?.id;
		expect(at('2026-08-29')).toBe('t1');
		expect(at('2026-09-05')).toBe('t1');
		expect(at('2026-08-28')).toBeUndefined();
		expect(at('2026-09-06')).toBeUndefined();
	});

	it('lançamentos criados a partir de captura não casam por aqui', () => {
		const { planned } = planStatementImport(
			[line()],
			context({ transactions: [tx()], linkedTransactionIds: new Set(['t1']) })
		);
		expect(planned[0].action.type).toBe('decision');
	});

	it('duas linhas e um lançamento: uma casa, a outra vai para revisão', () => {
		const { planned } = planStatementImport(
			[line({ fitid: 'a' }), line({ fitid: 'b' })],
			context({ transactions: [tx()] })
		);
		expect(planned.map((p) => p.action.type)).toEqual(['match_transaction', 'decision']);
	});

	it('direção errada não casa', () => {
		expect(findTransactionForLine(line(), [tx({ isIncome: true })], new Set())).toBeUndefined();
	});

	it('empate na data: id menor, para o plano ser determinístico', () => {
		expect(findTransactionForLine(line(), [tx({ id: 'b' }), tx({ id: 'a' })], new Set())?.id).toBe('a');
	});

	it('entre notificação e lançamento, vence o que expira antes; no empate, a notificação', () => {
		// Mesmo dia: os dois aceitam extrato até 09-08. Empate, notificação.
		const sameDay = planStatementImport([line()], context({ captures: [capture()], transactions: [tx()] }));
		expect(sameDay.planned[0].action).toEqual({ type: 'match_capture', captureId: 'c1' });

		// Lançamento de 09-01 expira em 09-06, antes da notificação de 09-03 (09-08).
		const olderTransaction = planStatementImport(
			[line()],
			context({ captures: [capture()], transactions: [tx({ date: '2026-09-01' })] })
		);
		expect(olderTransaction.planned[0].action).toEqual({ type: 'match_transaction', transactionId: 't1' });

		// Notificação de 08-30 expira em 09-04, antes do lançamento de 09-03 (09-08).
		const olderCapture = planStatementImport(
			[line()],
			context({ captures: [capture({ postedAt: noticeAt('2026-08-30') })], transactions: [tx()] })
		);
		expect(olderCapture.planned[0].action).toEqual({ type: 'match_capture', captureId: 'c1' });
	});

	it('o guloso unificado não deixa lançamento digitado sem par por causa de uma notificação de prazo longo', () => {
		// T digitado em 09-01 (aceita extrato até 09-06); C avisado em 09-03 (até 09-08).
		// Linhas em 09-05 e 09-07. Olhar notificações primeiro daria C à linha de 09-05
		// e deixaria T expirar: a linha de 09-07 iria para revisão como se fosse nova.
		const { planned, summary } = planStatementImport(
			[line({ fitid: 'l1', postedDate: '2026-09-05' }), line({ fitid: 'l2', postedDate: '2026-09-07' })],
			context({ captures: [capture()], transactions: [tx({ date: '2026-09-01' })] })
		);
		expect(actionOf(planned, 'l1')).toEqual({ type: 'match_transaction', transactionId: 't1' });
		expect(actionOf(planned, 'l2')).toEqual({ type: 'match_capture', captureId: 'c1' });
		expect(summary.pending).toBe(0);
	});

	it('linha de parcela "2/3" casa só com a parcela 2 de 3, com janela larga', () => {
		const parcels: LedgerTransaction[] = [1, 2, 3].map((index) => ({
			id: `p${index}`,
			amountCents: 10000,
			isIncome: false,
			date: ['2026-07-10', '2026-08-10', '2026-09-10'][index - 1],
			installmentIndex: index,
			installmentCount: 3,
		}));
		const parcelLine = line({
			fitid: 'fat',
			amountCents: 10000,
			postedDate: '2026-09-03',
			text: 'MAGAZINE LUIZA 2/3',
			name: 'MAGAZINE LUIZA 2/3',
		});

		// A parcela 2 é de 08-10; a fatura de setembro a lança em 09-03 (24 dias). Casa.
		expect(findTransactionForLine(parcelLine, parcels, new Set())?.id).toBe('p2');
		// A parcela 3, de 09-10, está mais perto pela data — mas o índice é outro.
		expect(findTransactionForLine(parcelLine, parcels, new Set(['p2']))).toBeUndefined();
	});

	it('linha sem marca de parcela não usa a janela larga', () => {
		const parcel: LedgerTransaction = {
			id: 'p2',
			amountCents: 10000,
			isIncome: false,
			date: '2026-08-10',
			installmentIndex: 2,
			installmentCount: 3,
		};
		expect(
			findTransactionForLine(line({ amountCents: 10000, postedDate: '2026-09-03', text: 'MAGAZINE LUIZA' }), [parcel], new Set())
		).toBeUndefined();
	});

	it('linha neutra não casa com nada e vai para o histórico como ignorada', () => {
		const invoice = line({
			fitid: 'inv',
			amountCents: 234567,
			kind: 'invoice_payment',
			neutral: true,
			memo: 'Pagamento de fatura',
			counterparty: null,
			merchantKey: null,
		});
		const manual = tx({ id: 'manual', amountCents: 234567 });
		const { planned, summary } = planStatementImport([invoice], context({ transactions: [manual] }));
		expect(planned[0].action).toEqual({ type: 'decision', decision: { action: 'neutral', reason: 'invoice_payment' } });
		expect(summary.ignored).toBe(1);
	});
});

describe('decisão sobre o que sobra', () => {
	const pixOut = line({
		fitid: 'out',
		kind: 'pix_out',
		amountCents: 50_000,
		counterparty: 'VINICIUS COSTA',
		merchantKey: 'vinicius costa',
		memo: 'Pix enviado',
		text: 'Pix enviado',
		suggestedCategory: 'other_expense',
	});
	const pixIn = line({
		fitid: 'in',
		accountKey: INTER_ACCOUNT,
		bankName: 'Inter',
		kind: 'pix_in',
		direction: 'in',
		amountCents: 50_000,
		counterparty: 'VINICIUS COSTA',
		merchantKey: 'vinicius costa',
		memo: 'Pix recebido',
		text: 'Pix recebido',
		suggestedCategory: 'other_income',
	});

	it('saída numa conta e entrada noutra, no mesmo arquivo: pergunta de transferência', () => {
		const { planned, summary } = planStatementImport([pixIn, pixOut], context());
		const first = planned[0];
		const second = planned[1];
		expect(first.action.type).toBe('decision');
		expect(second.action).toEqual({ type: 'decision', decision: { action: 'ask_transfer', relatedId: first.id } });
		expect(summary.questions).toBe(1);
	});

	it('com o nome do usuário, a transferência é certa e leva a primeira perna junto', () => {
		const { planned, summary } = planStatementImport([pixOut, pixIn], context({ ownNames: ['Vinicius Costa'] }));
		expect(planned[0].action).toEqual({ type: 'decision', decision: { action: 'transfer', relatedId: null, reason: 'own_name' } });
		expect(planned[1].action).toEqual({
			type: 'decision',
			decision: { action: 'transfer', relatedId: planned[0].id, reason: 'own_name' },
		});
		expect(summary.transfers).toBe(2);
	});

	it('duas linhas iguais no mesmo dia e conta nunca perguntam "é duplicata?"', () => {
		const { planned, summary } = planStatementImport([line({ fitid: 'a' }), line({ fitid: 'b' })], context());
		expect(planned.map((p) => p.action)).toEqual([
			{ type: 'decision', decision: { action: 'pending', categoryId: 'food' } },
			{ type: 'decision', decision: { action: 'pending', categoryId: 'food' } },
		]);
		expect(summary.questions).toBe(0);
	});

	it('estabelecimento aprendido lança sozinho; abaixo do limite só sugere', () => {
		const rules = new Map<string, MerchantRule>([
			['ifood', { merchantKey: 'ifood', categoryId: 'food', treatAs: 'transaction', confirmations: 3 }],
		]);
		const auto = planStatementImport([line()], context({ rules }));
		expect(auto.planned[0].action).toEqual({ type: 'decision', decision: { action: 'auto_confirm', categoryId: 'food' } });
		expect(auto.summary.autoConfirmed).toBe(1);

		rules.set('ifood', { merchantKey: 'ifood', categoryId: 'food', treatAs: 'transaction', confirmations: 2 });
		expect(planStatementImport([line()], context({ rules })).summary.pending).toBe(1);
	});

	it('conta marcada como "minha" vira transferência sem perguntar', () => {
		const rules = new Map<string, MerchantRule>([
			['conta inter', { merchantKey: 'conta inter', categoryId: null, treatAs: 'transfer', confirmations: 1 }],
		]);
		const { planned } = planStatementImport(
			[line({ kind: 'pix_out', counterparty: 'Conta Inter', merchantKey: 'conta inter' })],
			context({ rules })
		);
		expect(planned[0].action).toEqual({ type: 'decision', decision: { action: 'transfer', relatedId: null, reason: 'rule' } });
	});

	it('a ordem de leitura do arquivo não muda o plano', () => {
		const lines = [
			line({ fitid: 'c', postedDate: '2026-09-05' }),
			line({ fitid: 'a', postedDate: '2026-09-01' }),
			line({ fitid: 'b', postedDate: '2026-09-03', amountCents: 1000 }),
		];
		const forward = planStatementImport(lines, context({ captures: [capture({ postedAt: noticeAt('2026-09-01') })] }));
		const reversed = planStatementImport([...lines].reverse(), context({ captures: [capture({ postedAt: noticeAt('2026-09-01') })] }));
		expect(reversed.planned.map((p) => [p.line.fitid, p.action])).toEqual(forward.planned.map((p) => [p.line.fitid, p.action]));
	});
});

describe('notificação que chega depois do extrato', () => {
	const statementKnown = capture({
		id: 'stmt',
		packageName: statementPackageName(NU_ACCOUNT),
		postedAt: statementPostedAt('2026-09-03'),
	});
	const notice = (overrides: Partial<Candidate> = {}): Candidate => ({
		packageName: NUBANK,
		postedAt: noticeAt('2026-09-03', 180),
		amountCents: 3590,
		direction: 'out',
		kind: 'purchase',
		counterparty: 'IFOOD',
		merchantKey: 'ifood',
		neutral: false,
		...overrides,
	});
	const ctx = (recent: KnownCapture[]) => ({
		recent,
		rule: undefined,
		ownNames: [],
		autoConfirmThreshold: 3,
		fallbackCategoryId: 'food',
	});

	it('a notificação vira duplicata da linha do extrato, não um segundo lançamento', () => {
		expect(decide(notice(), ctx([statementKnown]))).toEqual({ action: 'duplicate', relatedId: 'stmt', reason: 'statement' });
	});

	it('só dentro da janela do extrato', () => {
		expect(decide(notice({ postedAt: noticeAt('2026-08-27') }), ctx([statementKnown])).action).toBe('pending');
		expect(decide(notice({ postedAt: noticeAt('2026-09-05') }), ctx([statementKnown])).action).toBe('pending');
	});

	it('valor ou direção diferentes não são a mesma coisa', () => {
		expect(decide(notice({ amountCents: 3591 }), ctx([statementKnown])).action).toBe('pending');
		expect(decide(notice({ direction: 'in', kind: 'refund' }), ctx([statementKnown])).action).toBe('pending');
	});

	it('uma linha de extrato nunca vira "duplicata provável" de uma notificação', () => {
		const stmtIn = capture({ ...statementKnown, id: 'stmt-in', direction: 'in', kind: 'refund' });
		expect(decide(notice({ postedAt: statementPostedAt('2026-09-03') }), ctx([stmtIn])).action).toBe('pending');
	});
});

// ---------------------------------------------------------------------------
// Propriedades: cenários aleatórios de compras, avisos e lançamentos digitados.
// ---------------------------------------------------------------------------

const makeRandom = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};
const randomInt = (random: () => number, min: number, max: number): number =>
	min + Math.floor(random() * (max - min + 1));

interface TrueEvent {
	index: number;
	date: string;
	amountCents: number;
	direction: 'out' | 'in';
	/** Aviso de notificação no dia do evento (pode já estar confirmado, com transação). */
	notified: false | 'pending' | 'confirmed';
	/** Lançamento digitado no dia do evento. */
	manual: boolean;
	/** Dias até o extrato lançar. */
	lag: number;
}

const AMOUNTS = [1000, 2500, 3590, 5000, 12000];

const scenario = (random: () => number) => {
	const count = randomInt(random, 1, 25);
	const events: TrueEvent[] = [];
	for (let index = 0; index < count; index += 1) {
		const notifiedRoll = random();
		const notified = notifiedRoll < 0.4 ? 'pending' : notifiedRoll < 0.6 ? 'confirmed' : false;
		events.push({
			index,
			date: addDays('2026-09-01', randomInt(random, 0, 9)),
			amountCents: AMOUNTS[randomInt(random, 0, AMOUNTS.length - 1)],
			direction: random() < 0.8 ? 'out' : 'in',
			notified,
			manual: !notified && random() < 0.35,
			lag: randomInt(random, 0, 3),
		});
	}

	const captures: KnownCapture[] = [];
	const transactions: LedgerTransaction[] = [];
	const linkedTransactionIds = new Set<string>();

	for (const event of events) {
		if (event.notified) {
			const transactionId = event.notified === 'confirmed' ? `ctx-${event.index}` : null;
			captures.push({
				id: `cap-${event.index}`,
				packageName: NUBANK,
				postedAt: noticeAt(event.date, randomInt(random, -300, 300)),
				amountCents: event.amountCents,
				direction: event.direction,
				kind: event.direction === 'out' ? 'purchase' : 'unknown',
				merchantKey: null,
				status: event.notified,
				relatedId: null,
				transactionId,
			});
			if (transactionId) {
				transactions.push({ id: transactionId, amountCents: event.amountCents, isIncome: event.direction === 'in', date: event.date });
				linkedTransactionIds.add(transactionId);
			}
		}
		if (event.manual) {
			transactions.push({ id: `man-${event.index}`, amountCents: event.amountCents, isIncome: event.direction === 'in', date: event.date });
		}
	}

	const lines: StatementLine[] = events.map((event) =>
		line({
			fitid: `fit-${event.index}`,
			postedDate: addDays(event.date, event.lag),
			amountCents: event.amountCents,
			direction: event.direction,
			kind: event.direction === 'out' ? 'purchase' : 'unknown',
			counterparty: null,
			merchantKey: null,
			suggestedCategory: event.direction === 'out' ? 'other_expense' : 'other_income',
		})
	);

	return { events, captures, transactions, linkedTransactionIds, lines };
};

describe('propriedades da conciliação', () => {
	it('nunca insere o que já existe: só eventos sem aviso e sem lançamento vão para revisão', () => {
		const random = makeRandom(4242);

		for (let round = 0; round < 400; round += 1) {
			const { events, captures, transactions, linkedTransactionIds, lines } = scenario(random);
			const { planned, summary } = planStatementImport(lines, context({ captures, transactions, linkedTransactionIds }));

			const decisions = planned.filter((p) => p.action.type === 'decision').length;
			const unrecorded = events.filter((e) => !e.notified && !e.manual).length;
			const claimedCaptures = planned.flatMap((p) => (p.action.type === 'match_capture' ? [p.action.captureId] : []));
			const claimedTransactions = planned.flatMap((p) =>
				p.action.type === 'match_transaction' ? [p.action.transactionId] : []
			);

			expect(summary.skippedExisting).toBe(0);
			expect(summary.matchedCaptures + summary.matchedTransactions + decisions).toBe(lines.length);
			// Cada registro existente é reivindicado no máximo uma vez.
			expect(new Set(claimedCaptures).size).toBe(claimedCaptures.length);
			expect(new Set(claimedTransactions).size).toBe(claimedTransactions.length);
			// Lançamentos vindos de captura nunca casam por si.
			expect(claimedTransactions.some((id) => linkedTransactionIds.has(id))).toBe(false);
			// O que vai para revisão é exatamente o que o app ainda não conhecia.
			expect(decisions).toBe(unrecorded);
			// Nada entra no livro sem passar pela revisão (não há regra aprendida aqui).
			expect(summary.autoConfirmed).toBe(0);
			expect(summary.questions).toBe(0);
		}
	});

	it('reimportar depois de um import é sempre um no-op', () => {
		const random = makeRandom(777);

		for (let round = 0; round < 100; round += 1) {
			const { captures, transactions, linkedTransactionIds, lines } = scenario(random);
			const first = planStatementImport(lines, context({ captures, transactions, linkedTransactionIds }));
			const again = planStatementImport(
				lines,
				context({
					captures,
					transactions,
					linkedTransactionIds,
					existingFingerprints: new Set(first.planned.map((p) => p.fingerprint)),
				})
			);
			expect(again.summary.skippedExisting).toBe(lines.length);
			expect(again.summary.matchedCaptures + again.summary.matchedTransactions + again.summary.pending).toBe(0);
		}
	});

	it('o plano não depende da ordem das linhas nem dos registros', () => {
		const random = makeRandom(99);

		for (let round = 0; round < 100; round += 1) {
			const { captures, transactions, linkedTransactionIds, lines } = scenario(random);
			const base = planStatementImport(lines, context({ captures, transactions, linkedTransactionIds }));
			const shuffled = planStatementImport(
				[...lines].reverse(),
				context({ captures: [...captures].reverse(), transactions: [...transactions].reverse(), linkedTransactionIds })
			);
			expect(shuffled.planned.map((p) => [p.line.fitid, p.action])).toEqual(base.planned.map((p) => [p.line.fitid, p.action]));
		}
	});
});

describe('extrato respeita a conta', () => {
	it('lançamento de outra conta não é esta linha', () => {
		const checking = tx({ id: 'debito', accountId: 'nu-pf' });
		expect(findTransactionForLine(line(), [checking], new Set(), 'nu-card')).toBeUndefined();
		expect(findTransactionForLine(line(), [checking], new Set(), 'nu-pf')?.id).toBe('debito');
		expect(findTransactionForLine(line(), [tx({ id: 'sem-conta', accountId: null })], new Set(), 'nu-card')?.id).toBe('sem-conta');
	});

	it('notificação de compra em outra conta casa (o extrato corrige a conta); Pix de outra conta não', () => {
		const purchaseOnChecking = capture({ id: 'compra', accountId: 'nu-pf', kind: 'purchase' });
		const pixOnChecking = capture({ id: 'pix', accountId: 'nu-pf', kind: 'pix_out' });
		expect(findCaptureForLine(line(), [purchaseOnChecking], new Set(), 'nu-card')?.id).toBe('compra');
		expect(findCaptureForLine(line(), [pixOnChecking], new Set(), 'nu-card')).toBeUndefined();
	});
});
