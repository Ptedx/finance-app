/**
 * O filtro de privacidade do Mirai (SPD-163b) e a validação da entrada das ferramentas, com
 * nomes inventados: nenhum é de alguém.
 */
import { MIRAI_TOOLS } from '../contract';
import {
	applyPrivacy,
	isBusinessName,
	merchantOf,
	PIX_FROM_PERSON,
	PIX_FROM_YOU,
	PIX_TO_PERSON,
	PIX_TO_YOU,
	type PrivacyContext,
	scrubText,
	TRANSFER_TO_PERSON,
	YOU,
} from '../privacy';
import { assertPeriod, isCalendarDate, isMiraiInputError, type ObjectSchema, validateToolInput } from '../tools/validate';
import { ownNamesOf } from '../../ownName';

const context: PrivacyContext = { ownNames: ownNamesOf(['Helena Quintanilha Duarte']) };
const none: PrivacyContext = { ownNames: [] };

describe('isBusinessName', () => {
	it.each([
		['Loja Estrela Ltda', true],
		['Padaria Sol & Filhos', true],
		['Mercado Bom Preço S/A', true],
		['Distribuidora Leste S.A.', true],
		['loja.com', true],
		['Posto 24 Horas', true],
		['Empresa 12.345.678/0001-90', true],
		['IFOOD *RESTAURANTE', true],
		['Otávio Ramalho Siqueira', false],
		['Otávio Ramalho Siqueira ***.456.789-**', false],
		['Otávio Ramalho Siqueira 123.456.789-09', false],
		['', false],
		[null, false],
	])('%s → %s', (value, expected) => {
		expect(isBusinessName(value)).toBe(expected);
	});
});

describe('merchantOf', () => {
	const pixOut = (counterparty: string | null) => ({ kind: 'pix_out', direction: 'out' as const, counterparty });
	const pixIn = (counterparty: string | null) => ({ kind: 'pix_in', direction: 'in' as const, counterparty });

	it('Pix com pessoa, pela captura, vira "pessoa" para os dois lados', () => {
		expect(merchantOf('Otávio Ramalho Siqueira', false, pixOut('Otávio Ramalho Siqueira'), context)).toBe(PIX_TO_PERSON);
		expect(merchantOf('Marta Albuquerque', true, pixIn('Marta Albuquerque'), context)).toBe(PIX_FROM_PERSON);
	});

	it('na dúvida esconde: Pix sem contraparte e sem marca de empresa é de pessoa', () => {
		expect(merchantOf('Marta Albuquerque', false, pixOut(null), context)).toBe(PIX_TO_PERSON);
		// Sem contraparte, o texto é o nome do app do banco: sai como está.
		expect(merchantOf('Banco Azul', false, pixOut(null), context)).toBe('Banco Azul');
	});

	it('Pix para empresa, pela captura, fica com o nome', () => {
		expect(merchantOf('Loja Estrela Ltda', false, pixOut('Loja Estrela Ltda'), context)).toBe('Loja Estrela Ltda');
	});

	it('Pix do próprio usuário é "você"', () => {
		expect(merchantOf('Helena Q Duarte', false, pixOut('HELENA QUINTANILHA DUARTE'), context)).toBe(PIX_TO_YOU);
		expect(merchantOf('Pix recebido de Helena Quintanilha Duarte', true, null, context)).toBe(PIX_FROM_YOU);
	});

	it('sem captura, o texto "Pix para Fulano" também esconde o nome', () => {
		expect(merchantOf('Pix para Otávio Ramalho', false, null, context)).toBe(PIX_TO_PERSON);
		expect(merchantOf('PIX ENVIADO - Marta Albuquerque', false, null, context)).toBe(PIX_TO_PERSON);
		expect(merchantOf('Pix de Marta Albuquerque', true, null, context)).toBe(PIX_FROM_PERSON);
		expect(merchantOf('TED para Gustavo Penha', false, null, context)).toBe(TRANSFER_TO_PERSON);
		expect(merchantOf('Transferência enviada para Gustavo Penha', false, null, context)).toBe(TRANSFER_TO_PERSON);
		expect(merchantOf('Pix para Gustavo Penha CPF 123.456.789-09', false, null, context)).toBe(PIX_TO_PERSON);
	});

	it('sem captura, Pix para empresa fica, limpo', () => {
		expect(merchantOf('Pix para Loja Estrela Ltda', false, null, context)).toBe('Pix para Loja Estrela Ltda');
		expect(merchantOf('Pix para Empresa 12.345.678/0001-90', false, null, context)).toBe('Pix para Empresa [documento]');
	});

	it('estabelecimento comum fica como está', () => {
		expect(merchantOf('Mercado Bom Preço', false, null, context)).toBe('Mercado Bom Preço');
		expect(merchantOf('Padaria Sol Nascente', false, null, context)).toBe('Padaria Sol Nascente');
		expect(merchantOf('Pix', false, null, context)).toBe('Pix');
	});

	it('o nome do usuário sozinho é "você"', () => {
		expect(merchantOf('Helena Quintanilha Duarte', true, null, context)).toBe(YOU);
	});
});

describe('scrubText', () => {
	it('esconde CPF, CNPJ e e-mail', () => {
		expect(scrubText('CPF 123.456.789-09', none)).toBe('CPF [documento]');
		expect(scrubText('CPF ***.456.789-**', none)).toBe('CPF [documento]');
		expect(scrubText('CNPJ 12.345.678/0001-90', none)).toBe('CNPJ [documento]');
		expect(scrubText('fale com otavio.r@exemplo.com.br', none)).toBe('fale com [e-mail]');
	});

	it('número de conta ou cartão sai só com o final de 4 dígitos', () => {
		expect(scrubText('Conta 0012345-6', none)).toBe('Conta •3456');
		expect(scrubText('Cartão 5502 0911 2233 4321', none)).toBe('Cartão •4321');
		expect(scrubText('Ag 0001 conta 12345 6', none)).toBe('Ag 0001 conta •2345 6');
		expect(scrubText('Ag 0001 12345 6', none)).toBe('Ag •3456');
		expect(scrubText('Loja 123 Centro', none)).toBe('Loja 123 Centro');
		expect(scrubText('Cartão 5502091122334321', none)).toBe('Cartão •4321');
		expect(scrubText('final 4321', none)).toBe('final 4321');
	});

	it('datas e números curtos ficam', () => {
		expect(scrubText('Parcela 2/3 de 10/11/2026', none)).toBe('Parcela 2/3 de 10/11/2026');
		expect(scrubText('2026-11-10', none)).toBe('2026-11-10');
	});

	it('o nome do usuário vira "você" no meio do texto, com a pontuação', () => {
		expect(scrubText('Corrente Helena Quintanilha Duarte', context)).toBe('Corrente você');
		expect(scrubText('De Helena Duarte, para a reserva', context)).toBe('De você, para a reserva');
		expect(scrubText('Pix de Helena Q. Duarte', context)).toBe('Pix de você');
		expect(scrubText('Helena sozinha', context)).toBe('Helena sozinha');
		expect(scrubText('Helena Prates', context)).toBe('Helena Prates');
	});
});

describe('applyPrivacy', () => {
	it('limpa todo texto, em qualquer profundidade; ids, datas e números passam', () => {
		const value = {
			id: 'conta-12345678',
			accountId: '99887766',
			name: 'Corrente Helena Quintanilha Duarte',
			date: '2026-11-10',
			month: '2026-11',
			amountCents: 1234567,
			rows: [{ note: 'e-mail helena@exemplo.com', nested: { text: 'CPF 123.456.789-09' } }],
			flag: true,
			empty: null,
		};
		expect(applyPrivacy(value, context)).toEqual({
			id: 'conta-12345678',
			accountId: '99887766',
			name: 'Corrente você',
			date: '2026-11-10',
			month: '2026-11',
			amountCents: 1234567,
			rows: [{ note: 'e-mail [e-mail]', nested: { text: 'CPF [documento]' } }],
			flag: true,
			empty: null,
		});
		// Não mexe no original.
		expect(value.name).toBe('Corrente Helena Quintanilha Duarte');
	});
});

describe('validateToolInput', () => {
	const schemaOf = (name: string) => MIRAI_TOOLS.find((tool) => tool.name === name)?.input_schema as unknown as ObjectSchema;
	const list = { from: '2026-11-01', to: '2026-11-30', category: null, accountId: null, text: null, kind: null, limit: 20 };

	it('aceita a entrada do contrato', () => {
		expect(validateToolInput(schemaOf('list_transactions'), list)).toBeNull();
		expect(validateToolInput(schemaOf('get_accounts'), {})).toBeNull();
		expect(validateToolInput(schemaOf('get_net_worth'), { months: null })).toBeNull();
		expect(validateToolInput(schemaOf('get_net_worth'), { months: 12 })).toBeNull();
	});

	it.each([
		['não objeto', 'get_accounts', []],
		['nulo', 'get_accounts', null],
		['campo a mais', 'get_accounts', { x: 1 }],
		['falta campo', 'list_transactions', { ...list, limit: undefined }],
		['tipo errado', 'list_transactions', { ...list, limit: '20' }],
		['inteiro', 'list_transactions', { ...list, limit: 1.5 }],
		['mínimo', 'list_transactions', { ...list, limit: 0 }],
		['máximo', 'list_transactions', { ...list, limit: 101 }],
		['enum', 'list_transactions', { ...list, kind: 'outro' }],
		['formato da data', 'list_transactions', { ...list, from: '01/11/2026' }],
		['formato do mês', 'get_month_overview', { month: '2026-1' }],
		['nulo onde não pode', 'get_month_overview', { month: null }],
	])('recusa %s', (_label, name, input) => {
		const clean = input && typeof input === 'object' && !Array.isArray(input) ? JSON.parse(JSON.stringify(input)) : input;
		expect(validateToolInput(schemaOf(name), clean)).toEqual(expect.any(String));
	});

	it('datas que não existem e período invertido', () => {
		expect(isCalendarDate('2026-02-28')).toBe(true);
		expect(isCalendarDate('2028-02-29')).toBe(true);
		expect(isCalendarDate('2026-02-29')).toBe(false);
		expect(isCalendarDate('2026-04-31')).toBe(false);
		expect(() => assertPeriod('2026-11-01', '2026-11-30')).not.toThrow();
		let caught: unknown = null;
		try {
			assertPeriod('2026-11-30', '2026-11-01');
		} catch (error) {
			caught = error;
		}
		expect(isMiraiInputError(caught)).toBe(true);
		expect(isMiraiInputError(new Error('outro'))).toBe(false);
	});
});
