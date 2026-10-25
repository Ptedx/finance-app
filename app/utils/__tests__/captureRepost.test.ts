/**
 * A mesma notificação de novo e duas notificações iguais (SPD-041), pela ingestão inteira.
 *
 * O serviço nativo manda a chave da notificação do Android (`StatusBarNotification.getKey()`)
 * e o `when` dela. Com a chave, a impressão digital não depende do minuto em que o aviso foi
 * publicado: a repostagem minutos depois é a mesma captura (D8), e duas compras iguais no
 * mesmo minuto, com chaves diferentes, são duas (D6). Sem a chave (binário antigo, OTA,
 * extrato), a regra é a de sempre.
 *
 * O banco é o mesmo dublê em Maps de `captureActions.test.ts`, com `hasCaptureFingerprint`
 * olhando as capturas gravadas, lápide inclusa, como o SQL de verdade.
 */

import type { Account, Capture, MerchantRule } from '../../database/schema';

const mockAccounts = new Map<string, Account>();
const mockCaptures = new Map<string, Capture>();
const mockRules = new Map<string, MerchantRule>();
const mockTransactions = new Map<string, { id: string; deleted?: boolean }>();
const mockCounter = { value: 0 };
const mockMakeId = (prefix: string): string => {
	mockCounter.value += 1;
	return `${prefix}-${mockCounter.value}`;
};

jest.mock('../../diagnostics/log', () => ({ ...jest.requireActual('../../diagnostics/log'), log: jest.fn() }));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../notificationUtils', () => ({ scheduleBillReminders: jest.fn(async () => 0) }));

jest.mock('../../database/database', () => ({
	addTransaction: jest.fn(async () => {
		const id = mockMakeId('tx');
		mockTransactions.set(id, { id });
		return id;
	}),
	deleteTransaction: jest.fn(async (id: string) => {
		mockTransactions.set(id, { id, deleted: true });
	}),
	deleteTransactionsInGroup: jest.fn(async () => undefined),
	addTransfer: jest.fn(async () => mockMakeId('tr')),
	updateTransfer: jest.fn(async () => undefined),
	getTransfer: jest.fn(async () => null),
	deleteTransfer: jest.fn(async () => undefined),
	findLiveTransfer: jest.fn(async () => null),
	getAccount: jest.fn(async (id: string) => mockAccounts.get(id) ?? null),
	getAccounts: jest.fn(async () => [...mockAccounts.values()]),
	addAccount: jest.fn(async (draft: Omit<Account, 'id' | 'updatedAt'>) => {
		const id = mockMakeId('acc');
		mockAccounts.set(id, { ...draft, id, updatedAt: '' } as Account);
		return id;
	}),
	updateAccount: jest.fn(async (updated: Account) => {
		mockAccounts.set(updated.id, { ...updated });
	}),
	findAccountBySource: jest.fn(
		async (packageName: string, last4: string | null) =>
			[...mockAccounts.values()].find((item) => item.packageName === packageName && item.last4 === last4) ?? null
	),
	findAccountByKey: jest.fn(async () => null),
	reassignCaptureLedger: jest.fn(async () => undefined),
	getBills: jest.fn(async () => []),
	updateBill: jest.fn(async () => undefined),
}));

jest.mock('../../database/captures', () => ({
	insertCapture: jest.fn(async (row: Omit<Capture, 'id' | 'createdAt' | 'updatedAt'>, explicitId?: string) => {
		const id = explicitId ?? mockMakeId('cap');
		const capture = { ...row, id, createdAt: '', updatedAt: '' } as Capture;
		mockCaptures.set(id, capture);
		return capture;
	}),
	updateCapture: jest.fn(async (id: string, patch: Partial<Capture>) => {
		const found = mockCaptures.get(id);
		if (found) mockCaptures.set(id, { ...found, ...patch });
	}),
	getCapture: jest.fn(async (id: string) => mockCaptures.get(id) ?? null),
	getRecentCaptures: jest.fn(async (since: string) =>
		[...mockCaptures.values()].filter((capture) => capture.postedAt >= since && !capture.deletedAt)
	),
	hasCaptureFingerprint: jest.fn(async (fingerprint: string) =>
		[...mockCaptures.values()].some((capture) => capture.fingerprint === fingerprint)
	),
	getMerchantRule: jest.fn(async (key: string) => mockRules.get(key) ?? null),
	saveMerchantRule: jest.fn(async (rule: Omit<MerchantRule, 'updatedAt'>) => {
		mockRules.set(rule.merchantKey, { ...rule, updatedAt: '' });
	}),
	deleteMerchantRule: jest.fn(async (key: string) => {
		mockRules.delete(key);
	}),
	findUnpairedTransferLeg: jest.fn(async () => null),
}));

import { log } from '../../diagnostics/log';
import { ingestRawCaptures } from '../captureActions';
import { candidateFrom } from '../captureMatcher';
import { parseCapture, type RawCapture } from '../captureParser';

const NUBANK = 'com.nu.production';
const T0 = '2026-10-23T15:00:00.000Z';
const MIN = 60_000;
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

const categories = [
	{ id: 'other_expense', name: 'Outros', type: 'expense', icon: '', color: '', updatedAt: '' },
	{ id: 'other_income', name: 'Outros', type: 'income', icon: '', color: '', updatedAt: '' },
	{ id: 'food', name: 'Alimentação', type: 'expense', icon: '', color: '', updatedAt: '' },
] as unknown as Parameters<typeof ingestRawCaptures>[1]['categories'];

const COFFEE = 'Compra de R$ 5,00 APROVADA em CAFE DA ESQUINA para o cartão com final 1534.';

/** O aviso do café; `key` e `when` como o serviço nativo os manda (`when` em ISO). */
const coffee = (postedAt: string, key?: string, when?: string): RawCapture => ({
	packageName: NUBANK,
	appLabel: 'Nubank',
	title: 'Compra no crédito aprovada',
	text: COFFEE,
	postedAt,
	...(key ? { notificationKey: key } : {}),
	...(when ? { notificationWhen: when } : {}),
});

const keyOf = (id: number): string => `0|${NUBANK}|${id}|null|10123`;

const ingest = (...raws: RawCapture[]) => ingestRawCaptures(raws, { ownNames: [], categories });

/** Regra aprendida que já lança sozinha (três confirmações). */
const learnedRule = (): void => {
	const notice = coffee(T0);
	const parsed = parseCapture(notice);
	const key = parsed ? candidateFrom(notice, parsed, null).merchantKey : null;
	if (!key) throw new Error('aviso sem estabelecimento');
	mockRules.set(key, { merchantKey: key, categoryId: 'food', treatAs: 'transaction', confirmations: 3, updatedAt: '' });
};

const captures = (): Capture[] => [...mockCaptures.values()];
const liveTransactions = () => [...mockTransactions.values()].filter((row) => !row.deleted);
const decisions = () =>
	(log as jest.Mock).mock.calls
		.filter(([, event]) => event === 'capture_decision')
		.map(([, , options]) => options.data as Record<string, unknown>);

beforeEach(() => {
	mockAccounts.clear();
	mockCaptures.clear();
	mockRules.clear();
	mockTransactions.clear();
	jest.clearAllMocks();
});

describe('com a chave da notificação (SPD-041)', () => {
	it('D8: a mesma notificação repostada 5 min depois, com regra aprendida, lança uma vez só', async () => {
		learnedRule();
		await ingest(coffee(T0, keyOf(1), T0));
		await ingest(coffee(at(5 * MIN), keyOf(1), T0));

		expect(captures()).toHaveLength(1);
		expect(liveTransactions()).toHaveLength(1);
		const [first, second] = decisions();
		expect(second).toMatchObject({ outcome: 'skipped', reason: 'already_seen', fingerprint: first.fingerprint });
	});

	it('D8 sem o `when`: a mesma chave e o mesmo conteúdo, horas depois, ainda é a mesma', async () => {
		learnedRule();
		await ingest(coffee(T0, keyOf(1)));
		await ingest(coffee(at(3 * 60 * MIN), keyOf(1)));

		expect(captures()).toHaveLength(1);
		expect(liveTransactions()).toHaveLength(1);
	});

	it('D6: dois cafés no mesmo minuto, chaves diferentes: a segunda compra não some', async () => {
		await ingest(coffee(T0, keyOf(1), T0), coffee(at(25_000), keyOf(2), at(25_000)));

		expect(captures()).toHaveLength(2);
		// Mesmo valor a segundos de distância: o app não sabe se é cobrança em dobro e pergunta.
		expect(captures().map((capture) => capture.question)).toEqual([null, 'duplicate']);
	});

	it('a mesma chave atualizada com outro valor é captura nova', async () => {
		await ingest(coffee(T0, keyOf(1), T0));
		await ingest({ ...coffee(at(2 * MIN), keyOf(1), T0), text: COFFEE.replace('R$ 5,00', 'R$ 7,50') });

		expect(captures().map((capture) => capture.amountCents)).toEqual([500, 750]);
	});

	it('app que reusa o mesmo id: o café do dia seguinte, com outro `when`, entra', async () => {
		const tomorrow = at(24 * 60 * MIN);
		await ingest(coffee(T0, keyOf(1), T0));
		await ingest(coffee(tomorrow, keyOf(1), tomorrow));

		expect(captures()).toHaveLength(2);
	});

	it('a chave não vai para o diário, só a impressão digital', async () => {
		await ingest(coffee(T0, keyOf(1), T0));

		const [entry] = decisions();
		expect(entry.fingerprint).toMatch(/^n:/);
		expect(JSON.stringify(entry)).not.toContain('10123');
	});
});

describe('sem a chave (binário antigo, OTA): a regra de sempre', () => {
	it('reentrega no mesmo minuto é a mesma captura', async () => {
		await ingest(coffee(T0));
		await ingest(coffee(at(30_000)));

		expect(captures()).toHaveLength(1);
	});

	it('o mesmo texto em outro minuto é outra captura', async () => {
		await ingest(coffee(T0));
		await ingest(coffee(at(5 * MIN)));

		expect(captures()).toHaveLength(2);
		expect(captures()[0].fingerprint).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}$/);
	});
});
