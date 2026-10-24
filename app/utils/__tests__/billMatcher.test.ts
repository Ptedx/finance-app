/**
 * Baixa automática das contas a pagar (REM-04): qual conta e qual mês um pagamento quita.
 *
 * O casador é puro e trabalha com datas de calendário (`YYYY-MM-DD`), então a suíte vale em
 * qualquer fuso (roda com `TZ` variado). A regra de ouro das bordas é a mesma do resto do
 * app: na dúvida não casa — uma conta que continua pendente rende um lembrete a mais, uma
 * baixa errada esconde um vencimento de verdade.
 */

import type { Bill } from '../../database/schema';
import { type BillMovement, billPaymentPatch, billPaymentUndo, dueMonthFor, matchBillPayment } from '../billMatcher';

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'tim',
	name: 'TIM',
	dueDay: 15,
	amountCents: 8_990,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const movement = (overrides: Partial<BillMovement> = {}): BillMovement => ({
	id: 'tx-1',
	amountCents: 8_990,
	date: '2026-10-14',
	accountId: 'nubank',
	text: 'TIM S.A.',
	isExpense: true,
	...overrides,
});

/** "tim 2026-10", ou null: o que importa é a conta e o mês. */
const matchOf = (bills: Bill[], mv: BillMovement): string | null => {
	const match = matchBillPayment(bills, mv);
	return match ? `${match.bill.id} ${match.month}` : null;
};

describe('matchBillPayment — o básico', () => {
	it('valor e nome batendo, dentro da janela: quita o mês do vencimento', () => {
		expect(matchOf([bill()], movement())).toBe('tim 2026-10');
	});

	it('receita não paga conta', () => {
		expect(matchOf([bill()], movement({ isExpense: false }))).toBeNull();
	});

	it('conta inativa ou apagada não casa', () => {
		expect(matchOf([bill({ active: false })], movement())).toBeNull();
		expect(matchOf([bill({ deletedAt: '2026-10-02T00:00:00.000Z' })], movement())).toBeNull();
	});

	it('mês já pago não casa de novo', () => {
		expect(matchOf([bill({ paidThrough: '2026-10' })], movement())).toBeNull();
		expect(matchOf([bill({ paidThrough: '2026-11' })], movement())).toBeNull();
		expect(matchOf([bill({ paidThrough: '2026-09' })], movement())).toBe('tim 2026-10');
	});

	it('o mesmo movimento duas vezes não casa duas vezes', () => {
		// Depois da primeira baixa o `paidByRef` é ele; mesmo que o mês fosse outro (a conta
		// voltou a ficar pendente à mão), o mesmo lançamento não quita outra vez.
		expect(matchOf([bill({ paidByRef: 'tx-1' })], movement())).toBeNull();
		expect(matchOf([bill({ paidByRef: 'tx-0' })], movement())).toBe('tim 2026-10');
	});

	it('a conta de pagamento da conta a pagar tem de ser a do movimento', () => {
		expect(matchOf([bill({ accountId: 'itau' })], movement())).toBeNull();
		expect(matchOf([bill({ accountId: 'nubank' })], movement())).toBe('tim 2026-10');
		// Movimento sem conta não prova que saiu da conta exigida.
		expect(matchOf([bill({ accountId: 'nubank' })], movement({ accountId: null }))).toBeNull();
		// Sem conta exigida, qualquer uma serve.
		expect(matchOf([bill()], movement({ accountId: null }))).toBe('tim 2026-10');
	});

	it('sem conta nenhuma, nada', () => {
		expect(matchBillPayment([], movement())).toBeNull();
	});
});

describe('matchBillPayment — janela de data', () => {
	it('vale de 10 dias antes a 5 dias depois do vencimento, bordas inclusas', () => {
		expect(matchOf([bill()], movement({ date: '2026-10-05' }))).toBe('tim 2026-10');
		expect(matchOf([bill()], movement({ date: '2026-10-04' }))).toBeNull();
		expect(matchOf([bill()], movement({ date: '2026-10-20' }))).toBe('tim 2026-10');
		expect(matchOf([bill()], movement({ date: '2026-10-21' }))).toBeNull();
	});

	it('dia 31 em mês de 30 vence no dia 30, e a janela conta dali', () => {
		const b = bill({ dueDay: 31 });
		// Novembro: vence 30/11, janela 20/11 a 05/12.
		expect(matchOf([b], movement({ date: '2026-11-20' }))).toBe('tim 2026-11');
		expect(matchOf([b], movement({ date: '2026-11-19' }))).toBeNull();
		expect(matchOf([b], movement({ date: '2026-12-05' }))).toBe('tim 2026-11');
		expect(matchOf([b], movement({ date: '2026-12-06' }))).toBeNull();
	});

	it('fevereiro: dia 30 vence em 28 (ou 29 no bissexto)', () => {
		const b = bill({ dueDay: 30 });
		expect(matchOf([b], movement({ date: '2027-03-05' }))).toBe('tim 2027-02');
		expect(matchOf([b], movement({ date: '2027-03-06' }))).toBeNull();
		expect(matchOf([b], movement({ date: '2027-02-18' }))).toBe('tim 2027-02');
		expect(matchOf([b], movement({ date: '2027-02-17' }))).toBeNull();
		// 2028 é bissexto: vence 29/02, a janela vai até 05/03.
		expect(matchOf([b], movement({ date: '2028-02-19' }))).toBe('tim 2028-02');
		expect(matchOf([b], movement({ date: '2028-03-05' }))).toBe('tim 2028-02');
		expect(matchOf([b], movement({ date: '2028-03-06' }))).toBeNull();
	});

	it('pagamento no fim do mês para o vencimento do dia 1º é do mês seguinte', () => {
		const b = bill({ dueDay: 1 });
		expect(matchOf([b], movement({ date: '2026-10-25' }))).toBe('tim 2026-11');
		expect(matchOf([b], movement({ date: '2026-10-22' }))).toBe('tim 2026-11');
		expect(matchOf([b], movement({ date: '2026-10-21' }))).toBeNull();
		expect(matchOf([b], movement({ date: '2026-11-06' }))).toBe('tim 2026-11');
	});

	it('virada de ano: dezembro paga janeiro, janeiro paga dezembro atrasado', () => {
		expect(matchOf([bill({ dueDay: 5 })], movement({ date: '2026-12-28' }))).toBe('tim 2027-01');
		expect(matchOf([bill({ dueDay: 28 })], movement({ date: '2027-01-02' }))).toBe('tim 2026-12');
		expect(matchOf([bill({ dueDay: 28 })], movement({ date: '2027-01-03' }))).toBeNull();
	});

	it('pagamento atrasado de um mês já pago não casa o mês seguinte por engano', () => {
		// Vence dia 15; 18/10 é atraso de outubro. Outubro pago → não vira novembro.
		expect(matchOf([bill({ paidThrough: '2026-10' })], movement({ date: '2026-10-18' }))).toBeNull();
	});
});

describe('matchBillPayment — valor e texto', () => {
	it('com valor: tolerância de 1% ou R$ 1, o maior, mas só com o nome no texto', () => {
		// R$ 89,90: 1% é 90 centavos, vale R$ 1,00.
		expect(matchOf([bill()], movement({ amountCents: 9_090 }))).toBe('tim 2026-10');
		expect(matchOf([bill()], movement({ amountCents: 8_890 }))).toBe('tim 2026-10');
		expect(matchOf([bill()], movement({ amountCents: 9_091 }))).toBeNull();
		// R$ 450,00: 1% é R$ 4,50.
		const consorcio = bill({ id: 'consorcio', name: 'Consórcio', amountCents: 45_000 });
		expect(matchOf([consorcio], movement({ amountCents: 45_450, text: 'CONSORCIO MAGALU' }))).toBe(
			'consorcio 2026-10'
		);
		expect(matchOf([consorcio], movement({ amountCents: 45_451, text: 'CONSORCIO MAGALU' }))).toBeNull();
	});

	it('com valor aproximado e sem o nome no texto, não casa; com valor exato, casa', () => {
		expect(matchOf([bill()], movement({ amountCents: 9_000, text: 'Mercado Pão' }))).toBeNull();
		expect(matchOf([bill()], movement({ amountCents: 8_990, text: 'Mercado Pão' }))).toBe('tim 2026-10');
		expect(matchOf([bill()], movement({ amountCents: 8_990, text: null }))).toBe('tim 2026-10');
	});

	it('o texto casa sem acento, sem caixa e por palavra inteira', () => {
		const b = bill({ name: 'Energia', matchHint: 'cemig, conta de luz', amountCents: null });
		expect(matchOf([b], movement({ text: 'CEMIG DISTRIBUICAO' }))).toBe('tim 2026-10');
		expect(matchOf([b], movement({ text: 'Pagamento conta de luz' }))).toBe('tim 2026-10');
		expect(matchOf([b], movement({ text: 'ENERGIA' }))).toBe('tim 2026-10');
		// Pedaço de palavra não é a palavra: "timbre" não é "tim".
		const tim = bill({ amountCents: null });
		expect(matchOf([tim], movement({ text: 'Papelaria Timbre' }))).toBeNull();
		expect(matchOf([tim], movement({ text: 'pgto*TIM-celular' }))).toBe('tim 2026-10');
		// A frase tem de vir inteira e em ordem.
		expect(matchOf([b], movement({ text: 'Luz de conta' }))).toBeNull();
	});

	it('acento de um lado só não atrapalha', () => {
		const b = bill({ id: 'saude', name: 'Plano de Saúde', matchHint: 'unimed', amountCents: null });
		expect(matchOf([b], movement({ text: 'PLANO DE SAUDE' }))).toBe('saude 2026-10');
		expect(matchOf([b], movement({ text: 'Unimed-BH' }))).toBe('saude 2026-10');
	});

	it('valor que varia: precisa do nome ou de uma palavra da dica', () => {
		const b = bill({ amountCents: null, matchHint: 'tim celular' });
		expect(matchOf([b], movement({ amountCents: 13_517, text: 'TIM' }))).toBe('tim 2026-10');
		expect(matchOf([b], movement({ amountCents: 13_517, text: 'Fatura tim celular' }))).toBe('tim 2026-10');
		expect(matchOf([b], movement({ amountCents: 13_517, text: 'Padaria' }))).toBeNull();
		expect(matchOf([b], movement({ amountCents: 13_517, text: null }))).toBeNull();
	});

	it('dica com vírgulas sobrando ou vazia não vira "casa com tudo"', () => {
		const b = bill({ name: 'Internet', amountCents: null, matchHint: ' , ,vivo,, ' });
		expect(matchOf([b], movement({ text: 'Padaria' }))).toBeNull();
		expect(matchOf([b], movement({ text: 'VIVO FIBRA' }))).toBe('tim 2026-10');
		expect(matchOf([b], movement({ text: '' }))).toBeNull();
	});

	it('valor zero ou negativo não paga nada', () => {
		expect(matchOf([bill({ amountCents: null })], movement({ amountCents: 0 }))).toBeNull();
	});
});

describe('matchBillPayment — mais de uma candidata', () => {
	it('escolhe a de texto casado', () => {
		const tim = bill();
		const claro = bill({ id: 'claro', name: 'Claro' });
		expect(matchOf([claro, tim], movement())).toBe('tim 2026-10');
		expect(matchOf([tim, claro], movement({ text: 'CLARO S.A.' }))).toBe('claro 2026-10');
	});

	it('duas candidatas só pelo valor exato: ambíguo, não casa', () => {
		const tim = bill();
		const claro = bill({ id: 'claro', name: 'Claro' });
		expect(matchOf([tim, claro], movement({ text: 'Débito automático' }))).toBeNull();
	});

	it('duas contas iguais: ambíguo, não casa', () => {
		const a = bill({ id: 'tim-a' });
		const b = bill({ id: 'tim-b' });
		expect(matchOf([a, b], movement())).toBeNull();
	});

	it('a igual já paga sai da disputa, e a outra casa', () => {
		const a = bill({ id: 'tim-a', paidThrough: '2026-10' });
		const b = bill({ id: 'tim-b' });
		expect(matchOf([a, b], movement())).toBe('tim-b 2026-10');
	});

	it('a de outra conta de pagamento sai da disputa', () => {
		const a = bill({ id: 'tim-a', accountId: 'itau' });
		const b = bill({ id: 'tim-b', accountId: 'nubank' });
		expect(matchOf([a, b], movement())).toBe('tim-b 2026-10');
	});
});

describe('dueMonthFor', () => {
	it('é o mês do vencimento mais próximo dentro da janela, pago ou não', () => {
		expect(dueMonthFor(bill({ paidThrough: '2026-12' }), '2026-10-14')).toBe('2026-10');
		expect(dueMonthFor(bill(), '2026-10-30')).toBeNull();
		expect(dueMonthFor(bill({ dueDay: 1 }), '2026-12-31')).toBe('2027-01');
	});
});

describe('billPaymentPatch', () => {
	it('grava o mês e quem deu a baixa', () => {
		const patch = billPaymentPatch(bill({ paidThrough: '2026-09' }), '2026-10', 'tx-9');
		expect(patch.paidThrough).toBe('2026-10');
		expect(patch.paidByRef).toBe('tx-9');
		expect(patch.name).toBe('TIM');
		expect('id' in patch).toBe(false);
		expect('updatedAt' in patch).toBe(false);
	});

	it('nunca diminui um paidThrough maior', () => {
		const patch = billPaymentPatch(bill({ paidThrough: '2026-12' }), '2026-10', 'tx-9');
		expect(patch.paidThrough).toBe('2026-12');
		expect(patch.paidByRef).toBe('tx-9');
	});
});

describe('billPaymentUndo', () => {
	it('volta ao mês anterior ao casado e limpa a referência', () => {
		const paid = bill({ paidThrough: '2026-10', paidByRef: 'tx-1' });
		const undo = billPaymentUndo(paid, 'tx-1', '2026-10-14');
		expect(undo?.paidThrough).toBe('2026-09');
		expect(undo?.paidByRef).toBeNull();
	});

	it('virada de ano: janeiro desfeito volta a dezembro', () => {
		const paid = bill({ dueDay: 5, paidThrough: '2027-01', paidByRef: 'tx-1' });
		expect(billPaymentUndo(paid, 'tx-1', '2026-12-28')?.paidThrough).toBe('2026-12');
	});

	it('não mexe se a última baixa foi de outro lançamento', () => {
		const paid = bill({ paidThrough: '2026-10', paidByRef: 'tx-2' });
		expect(billPaymentUndo(paid, 'tx-1', '2026-10-14')).toBeNull();
		expect(billPaymentUndo(bill(), 'tx-1', '2026-10-14')).toBeNull();
	});

	it('um mês pago depois, à mão, fica: só a referência sai', () => {
		const paid = bill({ paidThrough: '2026-12', paidByRef: 'tx-1' });
		const undo = billPaymentUndo(paid, 'tx-1', '2026-10-14');
		expect(undo?.paidThrough).toBe('2026-12');
		expect(undo?.paidByRef).toBeNull();
	});

	it('sem a data do lançamento, volta um mês do que está gravado', () => {
		const paid = bill({ paidThrough: '2027-01', paidByRef: 'tx-1' });
		expect(billPaymentUndo(paid, 'tx-1', null)?.paidThrough).toBe('2026-12');
	});
});
