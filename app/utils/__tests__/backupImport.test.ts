/**
 * Importar um backup: cada linha volta com o **id do arquivo**.
 *
 * O caso real: o mesmo arquivo importado em dois aparelhos. Contas e transferências já
 * preservavam o id; lançamentos, recorrências e dívidas ganhavam id novo em cada
 * aparelho, e o sync não tinha como saber que eram a mesma compra — a conta ficava com
 * duas gerações vivas e o livro-caixa dobrava. A importação também perdia `cardLast4`
 * (de qual cartão saiu a compra) e o relógio das recorrências (`lastProcessed`,
 * `nextDue`), que voltavam a lançar a assinatura já lançada.
 *
 * O banco é todo substituído por mocks: aqui o que se verifica é o que a importação
 * manda gravar.
 */

const mockBackup = { json: '{}' };

jest.mock('../../database/database', () => ({
	getBudgets: jest.fn(async () => []),
	// A leitura do backup, não a da tela: ela inclui a `uncategorized`, que é o destino
	// de todo lançamento cuja categoria não veio no arquivo.
	getCategoriesForBackup: jest.fn(async () => [{ id: 'food' }, { id: 'uncategorized' }]),
	getRecurringTransactions: jest.fn(async () => []),
	getTransactions: jest.fn(async () => []),
	restoreCategory: jest.fn(async () => undefined),
	resetDatabase: jest.fn(async () => undefined),
	restoreBudget: jest.fn(async () => undefined),
	setBudget: jest.fn(async () => 'orcamento'),
	getAccounts: jest.fn(async () => []),
	getDebts: jest.fn(async () => []),
	getReserveGoal: jest.fn(async () => null),
	getRetirementGoal: jest.fn(async () => null),
	getTransfers: jest.fn(async () => []),
	restoreAccount: jest.fn(async () => undefined),
	restoreDebt: jest.fn(async () => undefined),
	restoreRecurringTransaction: jest.fn(async () => undefined),
	restoreTransaction: jest.fn(async () => undefined),
	restoreTransfer: jest.fn(async () => undefined),
	setReserveGoal: jest.fn(async () => undefined),
	setRetirementGoal: jest.fn(async () => undefined),
}));

jest.mock('../../database/captures', () => ({
	getAllCaptures: jest.fn(async () => []),
	getMerchantRules: jest.fn(async () => []),
	restoreCapture: jest.fn(async () => undefined),
	restoreMerchantRule: jest.fn(async () => undefined),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	multiGet: jest.fn(async () => []),
	multiSet: jest.fn(async () => undefined),
	setItem: jest.fn(async () => undefined),
}));

jest.mock('expo-document-picker', () => ({
	getDocumentAsync: jest.fn(async () => ({
		canceled: false,
		assets: [{ uri: 'file:///backup.json' }],
	})),
}));

// `new File(uri).text()` é como a importação lê o arquivo escolhido. Sem `class` aqui de
// propósito: o babel compila classe com funções auxiliares que a fábrica do `jest.mock`
// não tem permissão para alcançar.
jest.mock('expo-file-system', () => ({
	File: function MockFile() {
		return { text: async () => mockBackup.json, write: () => undefined };
	},
	Paths: { document: '/tmp' },
}));

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }));
jest.mock('../../sync/queue', () => ({ notifyDataChanged: jest.fn(), schedule: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreCapture, restoreMerchantRule } from '../../database/captures';
import {
	restoreBudget,
	restoreCategory,
	restoreDebt,
	restoreRecurringTransaction,
	restoreTransaction,
	setBudget,
} from '../../database/database';
import { importDatabaseData } from '../exportUtils';

const BACKUP = {
	formatVersion: 3,
	exportDate: '2026-10-11T12:00:00.000Z',
	categories: [
		{
			id: 'food',
			name: 'Mercado',
			color: '#fff',
			icon: 'cart',
			type: 'expense',
			nature: 'essential',
			updatedAt: '2026-10-01T00:00:00.000Z',
		},
	],
	accounts: [
		{
			id: 'conta-inter',
			name: 'Inter',
			kind: 'checking',
			role: 'main',
			bankName: 'Inter',
			color: '#f60',
			last4: null,
			closingDay: null,
			dueDay: null,
			creditLimitCents: null,
			packageName: null,
			accountKey: null,
			openingBalanceCents: 1000,
			openingBalanceDate: '2026-09-30',
			sortOrder: 0,
			archived: false,
			updatedAt: '2026-10-01T00:00:00.000Z',
		},
	],
	transactions: [
		{
			id: 'tx-1',
			amountCents: 48_000,
			category: 'food',
			date: '2026-10-02',
			note: 'Mercado',
			isIncome: false,
			accountId: 'conta-inter',
			installmentGroup: null,
			installmentIndex: null,
			installmentCount: null,
			cardLast4: '1534',
			updatedAt: '2026-10-02T00:00:00.000Z',
		},
	],
	recurringTransactions: [
		{
			id: 'rec-1',
			amountCents: 2_990,
			isIncome: false,
			note: 'Assinatura',
			category: 'food',
			recurrenceType: 'monthly',
			day: 10,
			lastProcessed: '2026-10-10',
			nextDue: '2026-11-10',
			active: true,
			updatedAt: '2026-10-10T00:00:00.000Z',
		},
	],
	debts: [
		{
			id: 'debt-1',
			name: 'Carro',
			kind: 'financing',
			system: 'price',
			openingBalanceCents: 4_000_000,
			openingBalanceDate: '2026-01-31',
			installmentCents: 123_400,
			remainingAtOpening: 48,
			installmentsTotal: 60,
			dueDay: 10,
			rateBp: 150,
			feeCents: 0,
			adminFeeBp: null,
			accountId: 'conta-inter',
			category: null,
			archived: false,
			sortOrder: 0,
			updatedAt: '2026-10-01T00:00:00.000Z',
		},
	],
	budgets: [{ id: 'bud-out', year: 2026, month: 10, amountCents: 500_000 }],
	transfers: [],
};

const importing = async (backup: unknown) => {
	mockBackup.json = JSON.stringify(backup);
	return importDatabaseData();
};

beforeEach(() => jest.clearAllMocks());

describe('o id de cada coleção sobrevive à importação', () => {
	it('lançamento: id do arquivo e o cartão de onde a compra saiu', async () => {
		const result = await importing(BACKUP);

		expect(result.success).toBe(true);
		expect(restoreTransaction).toHaveBeenCalledTimes(1);

		const [draft, id] = (restoreTransaction as jest.Mock).mock.calls[0];
		expect(id).toBe('tx-1');
		expect(draft).toMatchObject({
			amountCents: 48_000,
			category: 'food',
			date: '2026-10-02',
			accountId: 'conta-inter',
			cardLast4: '1534',
		});
	});

	it('recorrência: id do arquivo e o relógio dela intacto', async () => {
		await importing(BACKUP);

		const [rule, id] = (restoreRecurringTransaction as jest.Mock).mock.calls[0];
		expect(id).toBe('rec-1');
		expect(rule).toMatchObject({
			amountCents: 2_990,
			lastProcessed: '2026-10-10',
			nextDue: '2026-11-10',
			day: 10,
		});
	});

	it('dívida: id do arquivo', async () => {
		await importing(BACKUP);

		const [draft, id] = (restoreDebt as jest.Mock).mock.calls[0];
		expect(id).toBe('debt-1');
		expect(draft).toMatchObject({ name: 'Carro', installmentCents: 123_400, accountId: 'conta-inter' });
	});

	it('orçamento: id do arquivo, senão dois aparelhos criam dois orçamentos do mesmo mês', async () => {
		await importing(BACKUP);

		expect(restoreBudget).toHaveBeenCalledWith(2026, 10, 500_000, 'bud-out');
		expect(setBudget).not.toHaveBeenCalled();
	});

	it('a conta da dívida e do lançamento só vale se veio no mesmo backup', async () => {
		await importing({
			...BACKUP,
			accounts: [],
			transactions: [{ ...BACKUP.transactions[0], accountId: 'conta-que-nao-veio' }],
		});

		expect((restoreTransaction as jest.Mock).mock.calls[0][0].accountId).toBeNull();
		expect((restoreDebt as jest.Mock).mock.calls[0][0].accountId).toBeNull();
	});
});

describe('backups antigos continuam entrando', () => {
	it('orçamento sem id (backup anterior à 1.2.7) ganha uma linha nova, como antes', async () => {
		await importing({ ...BACKUP, budgets: [{ year: 2026, month: 9, amount: 1_500 }] });

		expect(restoreBudget).not.toHaveBeenCalled();
		// `amount` em reais virou centavos.
		expect(setBudget).toHaveBeenCalledWith(2026, 9, 150_000);
	});

	it('lançamento sem `cardLast4` entra com nulo, não com undefined', async () => {
		const { cardLast4: _cardLast4, ...withoutCard } = BACKUP.transactions[0];
		await importing({ ...BACKUP, transactions: [withoutCard] });

		expect((restoreTransaction as jest.Mock).mock.calls[0][0].cardLast4).toBeNull();
	});

	it('categoria que o aparelho não tem: o lançamento cai em "uncategorized"', async () => {
		await importing({
			...BACKUP,
			categories: [],
			transactions: [{ ...BACKUP.transactions[0], category: 'inventada' }],
		});

		expect((restoreTransaction as jest.Mock).mock.calls[0][0].category).toBe('uncategorized');
	});

	it('arquivo que não é backup do Spendr não apaga nada', async () => {
		const result = await importing({ foo: 'bar' });

		expect(result.success).toBe(false);
		expect(restoreTransaction).not.toHaveBeenCalled();
	});

	it('backup v2 traz `dirty` e `deletedAt: null` nas categorias; nada disso vira lápide', async () => {
		// A forma do arquivo de 12/10/2026: a leitura das categorias era um `SELECT *`
		// cru, então o `dirty` de cada aparelho vazava para o arquivo e `deletedAt` vinha
		// explicitamente nulo. Nenhum dos dois pode virar coluna gravada.
		const result = await importing({
			...BACKUP,
			formatVersion: 2,
			categories: [{ ...BACKUP.categories[0], deletedAt: null, dirty: true }],
			budgets: [{ year: 2026, month: 10, amountCents: 500_000 }],
		});

		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
		const [draft, id] = (restoreCategory as jest.Mock).mock.calls[0];
		expect(id).toBe('food');
		expect(draft.deletedAt).toBeNull();
		expect(draft.nature).toBe('essential');
	});

	it('backup v3 não tem caixa de entrada nem preferências, e isso não quebra a importação', async () => {
		const result = await importing(BACKUP);

		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(restoreCapture).not.toHaveBeenCalled();
		expect(restoreMerchantRule).not.toHaveBeenCalled();
		expect(AsyncStorage.multiSet).not.toHaveBeenCalled();
	});
});

/**
 * O caso real de 12/10/2026: as compras de outubro estavam pendentes na caixa de
 * entrada, que não sincroniza e não saía no arquivo. Elas foram embora com a
 * desinstalação. No v4 a caixa de entrada, as regras aprendidas e as preferências
 * viajam — e voltam com a decisão de cada item intacta.
 */
const CAPTURE = {
	id: 'cap-1',
	fingerprint: 'nubank:1234:5000:2026-10-06T12:00:00.000Z',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 50,00 em PADARIA',
	postedAt: '2026-10-06T12:00:00.000Z',
	amountCents: 5_000,
	direction: 'out' as const,
	kind: 'purchase',
	counterparty: 'PADARIA',
	merchantKey: 'padaria',
	cardLast4: '1234',
	status: 'pending' as const,
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: 'conta-inter',
	transferId: null,
	installments: null,
	createdAt: '2026-10-06T12:00:01.000Z',
	updatedAt: '2026-10-06T12:00:01.000Z',
};

const V4_BACKUP = {
	...BACKUP,
	formatVersion: 4,
	captures: [CAPTURE],
	merchantRules: [
		{
			merchantKey: 'padaria',
			categoryId: 'food',
			treatAs: 'transaction',
			confirmations: 4,
			updatedAt: '2026-10-05T00:00:00.000Z',
		},
	],
	preferences: {
		selectedCurrency: '{"code":"BRL"}',
		'@spendr_language': '{"code":"pt"}',
		'@spendr_biometric_enabled': 'true',
	},
};

describe('o backup v4 traz de volta o que ficava no aparelho', () => {
	it('a caixa de entrada volta inteira, com o item pendente e o texto cru', async () => {
		const result = await importing(V4_BACKUP);

		expect(result.success).toBe(true);
		expect(result.stats?.captures).toBe(1);
		expect(restoreCapture).toHaveBeenCalledTimes(1);
		expect((restoreCapture as jest.Mock).mock.calls[0][0]).toMatchObject({
			id: 'cap-1',
			status: 'pending',
			amountCents: 5_000,
			text: 'Compra de R$ 50,00 em PADARIA',
			fingerprint: 'nubank:1234:5000:2026-10-06T12:00:00.000Z',
		});
	});

	it('a regra aprendida volta com as confirmações e o carimbo do arquivo', async () => {
		await importing(V4_BACKUP);

		expect((restoreMerchantRule as jest.Mock).mock.calls[0][0]).toEqual({
			merchantKey: 'padaria',
			categoryId: 'food',
			treatAs: 'transaction',
			confirmations: 4,
			updatedAt: '2026-10-05T00:00:00.000Z',
		});
	});

	it('as preferências conhecidas entram; a biometria do arquivo é ignorada', async () => {
		await importing(V4_BACKUP);

		const written = (AsyncStorage.multiSet as jest.Mock).mock.calls[0][0] as string[][];
		expect(written).toEqual(
			expect.arrayContaining([
				['selectedCurrency', '{"code":"BRL"}'],
				['@spendr_language', '{"code":"pt"}'],
			])
		);
		// Segurança deste aparelho: nenhum arquivo liga biometria.
		expect(written.map(([key]) => key)).not.toContain('@spendr_biometric_enabled');
	});

	it('a categoria apagada volta apagada, em vez de reaparecer nos seletores', async () => {
		await importing({
			...V4_BACKUP,
			categories: [
				...BACKUP.categories,
				{
					id: 'entertainment',
					name: 'Lazer',
					color: '#f00',
					icon: 'film',
					type: 'expense',
					nature: 'discretionary',
					updatedAt: '2026-09-01T00:00:00.000Z',
					deletedAt: '2026-09-02T00:00:00.000Z',
				},
			],
		});

		const calls = (restoreCategory as jest.Mock).mock.calls;
		expect(calls.find(([, id]) => id === 'food')?.[0].deletedAt).toBeUndefined();
		expect(calls.find(([, id]) => id === 'entertainment')?.[0].deletedAt).toBe(
			'2026-09-02T00:00:00.000Z'
		);
	});
});

describe('uma parte que falha não leva o resto', () => {
	it('lançamento que não entra é contado no aviso, e os outros entram', async () => {
		(restoreTransaction as jest.Mock).mockImplementationOnce(async () => {
			throw new Error('disco cheio');
		});

		const result = await importing({
			...V4_BACKUP,
			transactions: [BACKUP.transactions[0], { ...BACKUP.transactions[0], id: 'tx-2' }],
		});

		// O banco já tinha sido apagado quando a linha falhou: desistir aqui deixaria o
		// usuário sem o backup e sem o que ele tinha.
		expect(result.success).toBe(true);
		expect(restoreTransaction).toHaveBeenCalledTimes(2);
		expect(result.stats?.transactions).toBe(1);
		expect(result.warnings?.join(' ')).toContain('1 transactions');
	});

	it('arquivo que já veio marcado como incompleto é anunciado como tal', async () => {
		const result = await importing({ ...V4_BACKUP, incomplete: ['captures'] });

		expect(result.success).toBe(true);
		expect(result.warnings?.join(' ')).toContain('backup file itself was incomplete');
		expect(result.message).toContain('warnings');
	});
});
