/**
 * O que a tela de revisão escreve em cada item (achado 7.7).
 *
 * As duas coisas que faltavam ali são as mais caras do fluxo: em qual conta a captura
 * caiu — a decisão mais arriscada, porque dinheiro no lugar errado não aparece em lugar
 * nenhum — e a divisão em parcelas, que é o que mais muda o caixa dos meses seguintes.
 * Uma compra em 3x aparecia só como "− R$ 300,00" e ao confirmar virava três parcelas.
 *
 * Só os rótulos são testados: montar a tela exigiria o Android inteiro, e o que estava
 * errado era o texto, não o layout. O `t` daqui resolve no português de verdade, então o
 * teste também falha se a chave não existir (o paralelo em inglês e italiano é garantido
 * por `i18n/__tests__/localeParity.test.ts`).
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async () => undefined),
		runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
		getFirstAsync: jest.fn(async () => null),
		getAllAsync: jest.fn(async () => []),
		withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body()),
	}),
}));

import type { Account, Capture } from '../../database/schema';
import pt from '../../i18n/locales/pt';
import { formatCents } from '../../utils/money';
import { currencyWarning, destinationLabel, ignoredAppLabel, installmentsLabel, resolvedReasonLabel } from '../CaptureInboxScreen';

/** `t` mínimo: busca a chave no português e interpola `{{assim}}`, como o i18next. */
const t = (key: string, options: Record<string, unknown> = {}): string => {
	const found = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pt as unknown);
	if (typeof found !== 'string') throw new Error(`chave de tradução ausente: ${key}`);
	return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
};

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

const CARD = account({ id: 'card', name: 'Cartão Nubank', kind: 'credit_card', role: 'card' });
const CHECKING = account({ id: 'cc', name: 'Inter PF' });

describe('a conta de destino aparece no item', () => {
	it('mostra o nome do cartão ou da conta em que a captura caiu', () => {
		expect(destinationLabel({ accountId: CARD.id } as Capture, [CHECKING, CARD], t)).toBe('Cartão Nubank');
		expect(destinationLabel({ accountId: CHECKING.id } as Capture, [CHECKING, CARD], t)).toBe('Inter PF');
	});

	it('"Sem conta" quando é nulo — o que desde a 1.2.6 acontece de propósito', () => {
		expect(destinationLabel({ accountId: null } as Capture, [CHECKING, CARD], t)).toBe('Sem conta');
	});

	it('conta que já não existe também é "Sem conta", nunca um id cru na tela', () => {
		expect(destinationLabel({ accountId: 'apagada' } as Capture, [CHECKING], t)).toBe('Sem conta');
	});
});

describe('a divisão em parcelas aparece no item', () => {
	it('uma compra em 3x diz "3x de R$ 100,00"', () => {
		expect(installmentsLabel({ amountCents: 30_000, installments: 3 } as Capture, t)).toBe(
			`3x de ${formatCents(10_000)}`
		);
	});

	it('à vista não diz nada: nem com parcelas nulas, nem com uma só', () => {
		expect(installmentsLabel({ amountCents: 30_000, installments: null } as Capture, t)).toBeNull();
		expect(installmentsLabel({ amountCents: 30_000, installments: 1 } as Capture, t)).toBeNull();
	});

	it('quando a divisão não é exata, mostra a parcela que o app vai lançar', () => {
		// 100,01 em 3: o centavo sobrando vai para a primeira parcela (`splitInstallments`).
		expect(installmentsLabel({ amountCents: 10_001, installments: 3 } as Capture, t)).toBe(
			`3x de ${formatCents(3335)}`
		);
	});
});

describe('a compra em moeda estrangeira avisa no item (SPD-037)', () => {
	/**
	 * Como o i18next: chave ausente cai no `defaultValue`. A chave nova entra no i18n na
	 * integração (o i18n é de outro card nesta onda); até lá vale o texto em português.
	 */
	const tWithDefault = (key: string, options: Record<string, unknown> = {}): string => {
		try {
			return t(key, options);
		} catch {
			return String(options.defaultValue ?? key);
		}
	};

	it('o item pendente por moeda estrangeira pede para conferir o valor em reais', () => {
		expect(currencyWarning({ reason: 'foreign_currency' } as Capture, tWithDefault)).toMatch(/confira o valor em reais/i);
	});

	it('os outros itens não dizem nada', () => {
		expect(currencyWarning({ reason: null } as Capture, tWithDefault)).toBeNull();
		expect(currencyWarning({ reason: 'rule' } as Capture, tWithDefault)).toBeNull();
	});
});

describe('o app que o usuário ensinou a ignorar aparece com "desfazer" (SPD-022)', () => {
	/** Como o i18next: chave ausente cai no `defaultValue`, interpolado. */
	const tWithDefault = (key: string, options: Record<string, unknown> = {}): string => {
		try {
			return t(key, options);
		} catch {
			return String(options.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
		}
	};

	it('diz qual app está sendo ignorado', () => {
		expect(ignoredAppLabel('WhatsApp', tWithDefault)).toBe('Avisos do WhatsApp estão sendo ignorados');
	});

	it('no histórico, o item ignorado pela regra diz o porquê', () => {
		expect(resolvedReasonLabel({ reason: 'app_rule', appLabel: 'Mensagens' } as Capture, tWithDefault)).toBe(
			'Avisos do Mensagens estão sendo ignorados'
		);
	});

	it('os outros motivos continuam como antes', () => {
		expect(resolvedReasonLabel({ reason: 'manual', appLabel: 'Nubank' } as Capture, tWithDefault)).toBe('Sua escolha');
		expect(resolvedReasonLabel({ reason: null, appLabel: 'Nubank' } as Capture, tWithDefault)).toBe('');
	});
});
