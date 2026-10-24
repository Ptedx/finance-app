/**
 * A caixa de entrada e as regras aprendidas no sync (v19), lidas pelo SQL que
 * `database.ts` e `captures.ts` mandam para o banco.
 *
 * Não há SQLite no jest: o `expo-sqlite` é substituído por um dublê que anota cada
 * comando e responde o que cada teste programar. É um teste de implementação, de
 * propósito — o que está em jogo são comandos que precisam existir e parâmetros que
 * precisam ser **o id certo**: a identidade de uma captura entre aparelhos é o
 * `fingerprint`, e o id local nunca pode sair daqui.
 *
 * O caso real por trás de tudo: 12/10/2026, o dono desinstalou o app e perdeu duas
 * semanas de compras que estavam pendentes de revisão nesta tabela.
 */

interface Statement {
	sql: string;
	params: unknown[];
}

const mockStatements: Statement[] = [];
/** Resposta programável do `getFirstAsync`, por teste. */
let mockOnFirst: (sql: string, params: unknown[]) => unknown = () => null;
/** Resposta programável do `getAllAsync`, por teste. */
let mockOnAll: (sql: string, params: unknown[]) => unknown[] = () => [];
/** O id local que `generateUniqueId` devolve enquanto o teste roda. */
let mockNextLocalId = 'id-local-novo';

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async (sql: string) => {
			mockStatements.push({ sql, params: [] });
		}),
		runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return { changes: 0, lastInsertRowId: 0 };
		}),
		getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockOnFirst(sql, params);
		}),
		getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockOnAll(sql, params);
		}),
		withTransactionAsync: jest.fn(async (body: () => Promise<void>) => {
			mockStatements.push({ sql: 'BEGIN', params: [] });
			await body();
			mockStatements.push({ sql: 'COMMIT', params: [] });
		}),
	}),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('../../utils/categoryEditUtils', () => ({
	__esModule: true,
	generateUniqueId: () => mockNextLocalId,
	default: () => mockNextLocalId,
}));

import { deleteMerchantRule, pruneResolvedCaptures, updateCapture } from '../captures';
import {
	applyPulledChanges,
	countUnsyncedRows,
	getDirtyChanges,
	markChangesClean,
	migrationLadder,
	repairPhantomAppAccounts,
} from '../database';
import { identityColumnOf, SCHEMA_VERSION, SYNCED_TABLES } from '../schema';
import type { SyncChanges, WireCapture } from '../../sync/types';

const reset = () => {
	mockStatements.length = 0;
	mockOnFirst = () => null;
	mockOnAll = () => [];
	mockNextLocalId = 'id-local-novo';
};

beforeEach(reset);

/** Os comandos de um tipo, pelo que o SQL menciona. */
const matching = (...needles: string[]): Statement[] =>
	mockStatements.filter((statement) => needles.every((needle) => statement.sql.includes(needle)));

const sqlOf = (statements: Statement[]): string[] =>
	statements.map((statement) => statement.sql.replace(/\s+/g, ' ').trim());

/** Uma linha de `captures` como a tabela a guarda. */
const captureRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 'id-local-1',
	fingerprint: 'fp-1',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 52,90 na PADARIA',
	postedAt: '2026-10-05T12:00:00.000Z',
	amountCents: 5_290,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'PADARIA',
	merchantKey: 'padaria',
	cardLast4: '6422',
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: 0,
	reason: null,
	accountId: 'conta-1',
	transferId: null,
	installments: null,
	createdAt: '2026-10-05T12:00:01.000Z',
	updatedAt: '2026-10-05T12:00:01.000Z',
	deletedAt: null,
	dirty: 1,
	...overrides,
});

/** Uma captura como ela chega do servidor: o `id` é o fingerprint. */
const wireCapture = (overrides: Partial<WireCapture> = {}): WireCapture => ({
	id: 'fp-1',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 52,90 na PADARIA',
	postedAt: '2026-10-05T12:00:00.000Z',
	amountCents: 5_290,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'PADARIA',
	merchantKey: 'padaria',
	cardLast4: '6422',
	status: 'pending',
	question: null,
	relatedFingerprint: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: 'conta-1',
	transferId: null,
	installments: null,
	createdAt: '2026-10-05T12:00:01.000Z',
	updatedAt: '2026-10-05T12:00:01.000Z',
	deletedAt: null,
	...overrides,
});

const changesWith = (overrides: Partial<SyncChanges>): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

/** Uma conta como a tabela a guarda, no formato que o reparo das fantasmas lê. */
const accountRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 'conta-fantasma',
	name: 'WhatsApp',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'WhatsApp',
	color: '#15E8FE',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: 'com.whatsapp',
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-10-01',
	sortOrder: 0,
	archived: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	deletedAt: null,
	dirty: 0,
	...overrides,
});

// ---------------------------------------------------------------------------
// Subir: id local -> fingerprint
// ---------------------------------------------------------------------------

describe('subir a caixa de entrada', () => {
	it('a captura sobe com o fingerprint como id, e o relacionado traduzido', async () => {
		mockOnAll = (sql) => {
			if (sql.includes('FROM captures WHERE dirty = 1')) {
				return [captureRow({ relatedId: 'id-local-2', question: 'duplicate' })];
			}
			if (sql.includes('SELECT id, fingerprint FROM captures WHERE id IN')) {
				return [{ id: 'id-local-2', fingerprint: 'fp-2' }];
			}
			return [];
		};

		const changes = await getDirtyChanges(500);

		expect(changes.captures).toHaveLength(1);
		expect(changes.captures?.[0]).toMatchObject({
			// A identidade no servidor é o fingerprint, nunca o id local.
			id: 'fp-1',
			relatedFingerprint: 'fp-2',
			question: 'duplicate',
			amountCents: 5_290,
			autoConfirmed: false,
		});
		// O id local não vaza em nenhum campo da linha que viaja.
		expect(JSON.stringify(changes.captures)).not.toContain('id-local');
	});

	it('o relacionado que não existe mais aqui sobe como nulo, em vez de um ponteiro para o nada', async () => {
		mockOnAll = (sql) => {
			if (sql.includes('FROM captures WHERE dirty = 1')) return [captureRow({ relatedId: 'id-podado' })];
			return [];
		};

		const changes = await getDirtyChanges(500);
		expect(changes.captures?.[0].relatedFingerprint).toBeNull();
	});

	it('sem relacionado nenhum, nem consulta a tradução', async () => {
		mockOnAll = (sql) => (sql.includes('FROM captures WHERE dirty = 1') ? [captureRow()] : []);

		await getDirtyChanges(500);
		expect(sqlOf(matching('SELECT id, fingerprint FROM captures'))).toEqual([]);
	});

	it('a regra aprendida sobe pela própria chave do estabelecimento', async () => {
		mockOnAll = (sql) => {
			if (sql.includes('FROM merchant_rules WHERE dirty = 1')) {
				return [
					{
						merchantKey: 'ifood',
						categoryId: 'food',
						treatAs: 'transaction',
						confirmations: 4,
						updatedAt: '2026-10-05T12:00:00.000Z',
						deletedAt: null,
						dirty: 1,
					},
				];
			}
			return [];
		};

		const changes = await getDirtyChanges(500);
		expect(changes.merchantRules).toEqual([
			{
				id: 'ifood',
				categoryId: 'food',
				treatAs: 'transaction',
				confirmations: 4,
				updatedAt: '2026-10-05T12:00:00.000Z',
				deletedAt: null,
			},
		]);
	});

	it('a lápide da captura sobe como qualquer mudança: é a remoção que precisa propagar', async () => {
		mockOnAll = (sql) =>
			sql.includes('FROM captures WHERE dirty = 1')
				? [captureRow({ deletedAt: '2026-10-06T00:00:00.000Z' })]
				: [];

		const changes = await getDirtyChanges(500);
		expect(changes.captures?.[0].deletedAt).toBe('2026-10-06T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// Aplicar: fingerprint -> id local
// ---------------------------------------------------------------------------

describe('aplicar a caixa de entrada que vem do servidor', () => {
	it('casa pelo fingerprint e mantém o id local — o mesmo aviso nos dois aparelhos', async () => {
		// O aparelho já capturou a mesma notificação, com outro id aleatório.
		mockOnFirst = (sql, params) => {
			if (sql.includes('SELECT id, updatedAt FROM captures WHERE fingerprint = ?') && params[0] === 'fp-1') {
				return { id: 'id-deste-aparelho', updatedAt: '2026-10-05T12:00:00.000Z' };
			}
			return null;
		};

		await applyPulledChanges(changesWith({ captures: [wireCapture()] }));

		const inserted = matching('INSERT INTO captures');
		expect(inserted).toHaveLength(1);
		// O id da linha continua sendo o daqui: é por ele que o histórico, o "reverter" e
		// o `relatedId` das outras capturas apontam.
		expect(inserted[0].params[0]).toBe('id-deste-aparelho');
		expect(inserted[0].params[1]).toBe('fp-1');
		// E o conflito é resolvido pelo fingerprint, que é a coluna UNIQUE.
		expect(inserted[0].sql).toContain('ON CONFLICT (fingerprint) DO UPDATE');
		// Chegou do servidor: não está pendente de subida.
		expect(inserted[0].sql).toContain('dirty = 0');
		// E nenhum id novo foi inventado para uma linha que já existia.
		expect(inserted[0].params).not.toContain('id-local-novo');
	});

	it('fingerprint que este aparelho nunca viu entra com um id local novo', async () => {
		mockNextLocalId = 'id-local-fresco';

		await applyPulledChanges(changesWith({ captures: [wireCapture({ id: 'fp-de-outro-aparelho' })] }));

		const inserted = matching('INSERT INTO captures');
		expect(inserted).toHaveLength(1);
		expect(inserted[0].params[0]).toBe('id-local-fresco');
		expect(inserted[0].params[1]).toBe('fp-de-outro-aparelho');
	});

	it('a versão local que vence também mantém o ponteiro dela: nada é regravado', async () => {
		mockOnFirst = (sql) =>
			sql.includes('SELECT id, updatedAt FROM captures WHERE fingerprint = ?')
				? { id: 'id-deste-aparelho', updatedAt: '2026-10-09T00:00:00.000Z' }
				: null;

		await applyPulledChanges(
			changesWith({ captures: [wireCapture({ relatedFingerprint: 'fp-2', question: 'duplicate' })] })
		);

		expect(sqlOf(matching('INSERT INTO captures'))).toEqual([]);
		expect(sqlOf(matching('UPDATE captures SET relatedId = ?'))).toEqual([]);
	});

	it('a versão local mais nova vence, e o empate também fica com ela', async () => {
		mockOnFirst = (sql) =>
			sql.includes('SELECT id, updatedAt FROM captures WHERE fingerprint = ?')
				? { id: 'id-deste-aparelho', updatedAt: '2026-10-05T12:00:01.000Z' }
				: null;

		// Mesmo `updatedAt` do dublê: empate.
		await applyPulledChanges(changesWith({ captures: [wireCapture()] }));
		expect(sqlOf(matching('INSERT INTO captures'))).toEqual([]);

		reset();
		mockOnFirst = (sql) =>
			sql.includes('SELECT id, updatedAt FROM captures WHERE fingerprint = ?')
				? { id: 'id-deste-aparelho', updatedAt: '2026-10-09T00:00:00.000Z' }
				: null;
		await applyPulledChanges(changesWith({ captures: [wireCapture()] }));
		expect(sqlOf(matching('INSERT INTO captures'))).toEqual([]);
	});

	it('traduz o fingerprint do relacionado para o id local, numa segunda passada', async () => {
		// A duplicata chega **depois** do item que a referencia, de propósito: resolver na
		// mesma passada daria resultado diferente conforme a ordem do servidor.
		const first = wireCapture({ id: 'fp-1', relatedFingerprint: 'fp-2', question: 'duplicate' });
		const second = wireCapture({ id: 'fp-2' });
		mockNextLocalId = 'id-novo';

		await applyPulledChanges(changesWith({ captures: [first, second] }));

		const pointers = matching('UPDATE captures SET relatedId = ?');
		expect(pointers).toHaveLength(1);
		// Os dois caíram no mesmo id novo porque o dublê devolve um id fixo; o que importa
		// é que o ponteiro foi resolvido pelo mapa da passada anterior, sem ir ao banco.
		expect(pointers[0].params[0]).toBe('id-novo');
		expect(pointers[0].params[2]).toBe('id-novo');
	});

	it('relacionado que não existe deste lado: ponteiro nulo e a pergunta cai', async () => {
		mockOnFirst = () => null;

		await applyPulledChanges(
			changesWith({
				captures: [wireCapture({ relatedFingerprint: 'fp-de-um-app-que-este-aparelho-nao-tem', question: 'duplicate' })],
			})
		);

		const pointers = matching('UPDATE captures SET relatedId = ?');
		expect(pointers).toHaveLength(1);
		expect(pointers[0].params[0]).toBeNull();
		// "É duplicata daquela?" sem a "daquela" é pergunta impossível de responder.
		expect(pointers[0].sql).toContain('question = CASE WHEN ? IS NULL THEN NULL ELSE question END');
	});

	it('a regra aprendida entra pela merchantKey, e o upsert é o merge inteiro', async () => {
		await applyPulledChanges(
			changesWith({
				merchantRules: [
					{
						id: 'ifood',
						categoryId: 'food',
						treatAs: 'transaction',
						confirmations: 4,
						updatedAt: '2026-10-05T12:00:00.000Z',
						deletedAt: null,
					},
				],
			})
		);

		const inserted = matching('INSERT INTO merchant_rules');
		expect(inserted).toHaveLength(1);
		expect(inserted[0].params[0]).toBe('ifood');
		expect(inserted[0].sql).toContain('ON CONFLICT (merchantKey) DO UPDATE');
		expect(inserted[0].sql).toContain('dirty = 0');

		// E a comparação de quem é mais novo também é pela chave, não por um `id` que a
		// tabela não tem.
		const staleCheck = matching('SELECT updatedAt FROM merchant_rules');
		expect(staleCheck[0].sql).toContain('WHERE merchantKey = ?');
	});

	it('tudo numa transação só: ou a página entra inteira, ou nada entra', async () => {
		await applyPulledChanges(changesWith({ captures: [wireCapture()] }));

		const begin = mockStatements.findIndex((s) => s.sql === 'BEGIN');
		const commit = mockStatements.findIndex((s) => s.sql === 'COMMIT');
		const inserted = mockStatements.indexOf(matching('INSERT INTO captures')[0]);
		expect(inserted).toBeGreaterThan(begin);
		expect(inserted).toBeLessThan(commit);
	});
});

// ---------------------------------------------------------------------------
// Limpar a marca depois do push
// ---------------------------------------------------------------------------

describe('marcar como enviado', () => {
	it('encontra a captura pelo fingerprint e a regra pela merchantKey', async () => {
		await markChangesClean(
			changesWith({
				captures: [wireCapture({ id: 'fp-1' })],
				merchantRules: [
					{ id: 'ifood', categoryId: null, treatAs: 'ignore', confirmations: 1, updatedAt: '2026-10-05T12:00:00.000Z', deletedAt: null },
				],
			})
		);

		const captures = matching('UPDATE captures SET dirty = 0');
		expect(captures).toHaveLength(1);
		expect(captures[0].sql).toContain('WHERE fingerprint = ?');
		expect(captures[0].params).toEqual(['fp-1', '2026-10-05T12:00:01.000Z']);

		const rules = matching('UPDATE merchant_rules SET dirty = 0');
		expect(rules).toHaveLength(1);
		expect(rules[0].sql).toContain('WHERE merchantKey = ?');
	});
});

// ---------------------------------------------------------------------------
// A poda
// ---------------------------------------------------------------------------

describe('a poda do histórico', () => {
	it('vira lápide suja, e não apaga mais nada de verdade', async () => {
		await pruneResolvedCaptures('2026-07-01T00:00:00.000Z');

		// Um DELETE faria a linha voltar inteira no próximo pull: o servidor ainda a tem.
		expect(sqlOf(matching('DELETE FROM captures'))).toEqual([]);

		const pruned = matching('UPDATE captures', 'deletedAt = ?');
		expect(pruned).toHaveLength(1);
		expect(pruned[0].sql).toContain("status <> 'pending'");
		expect(pruned[0].sql).toContain('updatedAt < ?');
		// Suja, para a poda deste aparelho chegar aos outros.
		expect(pruned[0].sql).toContain('dirty = 1');
		// E só o que ainda está vivo, para não reescrever o carimbo de uma lápide antiga:
		// é isso que torna a poda repetível a cada abertura do app.
		expect(pruned[0].sql).toContain('deletedAt IS NULL');
		expect(pruned[0].params[2]).toBe('2026-07-01T00:00:00.000Z');
	});

	it('pendente nunca é podada: ninguém perde revisão por tempo', async () => {
		await pruneResolvedCaptures('2026-07-01T00:00:00.000Z');
		expect(matching('UPDATE captures', 'deletedAt = ?')[0].sql).toContain("status <> 'pending'");
	});

	it('esquecer uma regra também é lápide', async () => {
		await deleteMerchantRule('ifood');
		expect(sqlOf(matching('DELETE FROM merchant_rules'))).toEqual([]);
		const forgotten = matching('UPDATE merchant_rules', 'deletedAt = ?');
		expect(forgotten).toHaveLength(1);
		expect(forgotten[0].sql).toContain('dirty = 1');
	});

	it('responder uma captura a deixa suja: a decisão tem de subir', async () => {
		await updateCapture('id-local-1', { status: 'confirmed', transactionId: 'tx-1' });
		const updated = matching('UPDATE captures SET');
		expect(updated).toHaveLength(1);
		expect(updated[0].sql).toContain('dirty = 1');
	});
});

// ---------------------------------------------------------------------------
// O reparo das contas fantasma
// ---------------------------------------------------------------------------

describe('reparo das contas fantasma', () => {
	/** O dublê padrão: uma conta "WhatsApp" vazia e o Nubank de verdade. */
	const withPhantom = () => {
		mockOnFirst = (sql) => {
			if (sql.includes('sqlite_master')) return { name: 'accounts' };
			if (sql.includes('COUNT(*) FROM transactions WHERE accountId = ?')) return { total: 0 };
			return null;
		};
		mockOnAll = (sql) =>
			sql.includes('FROM accounts')
				? [accountRow(), accountRow({ id: 'conta-nubank', name: 'Nubank', bankName: 'Nubank', packageName: 'com.nu.production' })]
				: [];
	};

	it('apaga a conta vazia que nasceu de um app que não é banco, e deixa a do banco', async () => {
		withPhantom();

		expect(await repairPhantomAppAccounts()).toBe(1);

		const tombstoned = matching('UPDATE accounts', 'deletedAt = ?');
		expect(tombstoned).toHaveLength(1);
		expect(tombstoned[0].params[2]).toBe('conta-fantasma');
		// Suja: a limpeza tem de subir, senão o próximo pull traz a conta de volta.
		expect(tombstoned[0].sql).toContain('dirty = 1');
	});

	it('a conta com lançamento, transferência ou captura fica — pode ser um banco que a lista não conhece', async () => {
		withPhantom();
		mockOnFirst = (sql) => {
			if (sql.includes('sqlite_master')) return { name: 'accounts' };
			if (sql.includes('COUNT(*) FROM transactions WHERE accountId = ?')) return { total: 1 };
			return null;
		};

		expect(await repairPhantomAppAccounts()).toBe(0);
		expect(sqlOf(matching('UPDATE accounts', 'deletedAt = ?'))).toEqual([]);
	});

	it('na dúvida (consulta sem resposta) a conta fica', async () => {
		withPhantom();
		mockOnFirst = (sql) => (sql.includes('sqlite_master') ? { name: 'accounts' } : null);

		expect(await repairPhantomAppAccounts()).toBe(0);
		expect(sqlOf(matching('UPDATE accounts', 'deletedAt = ?'))).toEqual([]);
	});

	it('rodar de novo não faz nada: é idempotente, e é por isso que pode rodar depois de cada pull', async () => {
		withPhantom();
		await repairPhantomAppAccounts();

		// Segunda volta: a conta fantasma já tem lápide, e a consulta só lê as vivas.
		reset();
		mockOnFirst = (sql) => (sql.includes('sqlite_master') ? { name: 'accounts' } : null);
		mockOnAll = (sql) => (sql.includes('FROM accounts') ? [accountRow({ id: 'conta-nubank', name: 'Nubank', bankName: 'Nubank' })] : []);

		expect(await repairPhantomAppAccounts()).toBe(0);
		expect(sqlOf(matching('UPDATE accounts', 'deletedAt = ?'))).toEqual([]);
	});

	it('só olha para as contas vivas e atreladas a um app', async () => {
		withPhantom();
		await repairPhantomAppAccounts();

		const read = matching('SELECT * FROM accounts');
		expect(read).toHaveLength(1);
		expect(read[0].sql).toContain('deletedAt IS NULL');
		expect(read[0].sql).toContain('packageName IS NOT NULL');
	});

	it('as capturas contam na conferência de "conta vazia"', async () => {
		withPhantom();
		await repairPhantomAppAccounts();

		const inUse = matching('COUNT(*) FROM transactions WHERE accountId = ?');
		expect(inUse).toHaveLength(1);
		expect(inUse[0].sql).toContain('COUNT(*) FROM captures WHERE accountId = ?');
		expect(inUse[0].sql).toContain('FROM transfers');
	});

	it('conta de nome ajustado pelo usuário não é fantasma: o nome deixou de ser o do banco', async () => {
		mockOnFirst = (sql) => (sql.includes('sqlite_master') ? { name: 'accounts' } : { total: 0 });
		mockOnAll = (sql) => (sql.includes('FROM accounts') ? [accountRow({ name: 'Conta do Zap' })] : []);

		expect(await repairPhantomAppAccounts()).toBe(0);
	});

	it('conta com saldo informado não é fantasma, mesmo com nome de app', async () => {
		mockOnFirst = (sql) => (sql.includes('sqlite_master') ? { name: 'accounts' } : { total: 0 });
		mockOnAll = (sql) => (sql.includes('FROM accounts') ? [accountRow({ openingBalanceCents: 120_00 })] : []);

		expect(await repairPhantomAppAccounts()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// O contador para a tela
// ---------------------------------------------------------------------------

describe('quantas linhas ainda não subiram', () => {
	it('conta as linhas vivas sujas de todas as tabelas sincronizadas', async () => {
		mockOnFirst = () => ({ count: 32 });

		expect(await countUnsyncedRows()).toBe(32);

		const counted = matching('dirty = 1 AND deletedAt IS NULL');
		expect(counted).toHaveLength(1);
		for (const table of SYNCED_TABLES) {
			expect(counted[0].sql).toContain(`FROM ${table} WHERE dirty = 1 AND deletedAt IS NULL`);
		}
	});

	it('sem resposta do banco, zero — nunca `undefined` numa tela', async () => {
		mockOnFirst = () => null;
		expect(await countUnsyncedRows()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// A migração v19
// ---------------------------------------------------------------------------

describe('migração v19', () => {
	it('a escada chega ao v19 e a última versão é a do schema', () => {
		const ladder = migrationLadder();
		// O v20 (contas a pagar) veio depois; o passo 19 continua no lugar dele.
		expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
		expect(ladder[18][0]).toBe(19);
		expect(ladder.map(([version]) => version)).toEqual(
			Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1)
		);
	});

	it('acrescenta `deletedAt` e `dirty` nas duas tabelas, sem tocar no resto', async () => {
		mockOnFirst = (sql) => (sql.includes('sqlite_master') ? { name: 'captures' } : null);
		mockOnAll = () => []; // nenhuma das colunas existe ainda

		const [version, run] = migrationLadder()[18];
		expect(version).toBe(19);
		await run();

		expect(sqlOf(matching('ALTER TABLE'))).toEqual([
			'ALTER TABLE captures ADD COLUMN deletedAt TEXT',
			'ALTER TABLE captures ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1',
			'ALTER TABLE merchant_rules ADD COLUMN deletedAt TEXT',
			'ALTER TABLE merchant_rules ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1',
		]);
		// Aditiva: nada é reconstruído nem apagado.
		expect(sqlOf(matching('DROP'))).toEqual([]);
		expect(sqlOf(matching('DELETE FROM'))).toEqual([]);
		// E `dirty` entra com DEFAULT 1: as compras que já esperavam revisão sobem no
		// primeiro sync depois da atualização, em vez de ficarem para trás.
		expect(matching('ADD COLUMN dirty')[0].sql).toContain('DEFAULT 1');
	});

	it('não repete a coluna que já existe — reabrir o banco no meio do caminho é seguro', async () => {
		mockOnFirst = (sql) => (sql.includes('sqlite_master') ? { name: 'captures' } : null);
		mockOnAll = (sql) => (sql.includes('table_info') ? [{ name: 'deletedAt' }, { name: 'dirty' }] : []);

		await migrationLadder()[18][1]();
		expect(sqlOf(matching('ALTER TABLE'))).toEqual([]);
	});

	it('as duas tabelas entram no sync, com a identidade que viaja', () => {
		expect(SYNCED_TABLES).toContain('captures');
		expect(SYNCED_TABLES).toContain('merchant_rules');
		expect(identityColumnOf('captures')).toBe('fingerprint');
		expect(identityColumnOf('merchant_rules')).toBe('merchantKey');
		expect(identityColumnOf('transactions')).toBe('id');
	});
});
