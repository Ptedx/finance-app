/**
 * O SQL de `database.ts`, lido pelo que ele manda para o banco.
 *
 * Não há SQLite no jest: o `expo-sqlite` é substituído por um dublê que anota cada
 * comando e cada parâmetro. É um teste de implementação, e de propósito — os três
 * defeitos que ele cobre são **comandos que faltavam**: a lápide das transferências ao
 * apagar uma conta, a contagem do que some atrás da âncora e o conserto das capturas no
 * reset. A álgebra em si (saldo, âncora) é testada em `utils/accountMath`.
 */

interface Statement {
	sql: string;
	params: unknown[];
}

const mockStatements: Statement[] = [];
/** Resposta programável do `getFirstAsync`, por teste. */
let mockFirstRow: unknown = null;
/** Quantas linhas o próximo `runAsync` diz ter mudado. */
let mockChanges = 0;

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async (sql: string) => {
			mockStatements.push({ sql, params: [] });
		}),
		runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return { changes: mockChanges, lastInsertRowId: 0 };
		}),
		getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockFirstRow;
		}),
		getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return [];
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

import {
	applyMigrations,
	assignUnassignedToAccount,
	deleteAccount,
	deleteTransfersOf,
	migrationLadder,
	type MigrationStep,
	resetDatabase,
	restoreTransaction,
} from '../database';
import { SCHEMA_VERSION } from '../schema';

const reset = () => {
	mockStatements.length = 0;
	mockFirstRow = null;
	mockChanges = 0;
};

/** Os comandos de um tipo, pelo que o SQL menciona. */
const matching = (...needles: string[]): Statement[] =>
	mockStatements.filter((statement) => needles.every((needle) => statement.sql.includes(needle)));

const sqlOf = (statements: Statement[]): string[] =>
	statements.map((statement) => statement.sql.replace(/\s+/g, ' ').trim());

beforeEach(reset);

describe('apagar uma conta', () => {
	it('põe lápide nas transferências da conta, na mesma transação', async () => {
		await deleteAccount('reserva');

		const begin = mockStatements.findIndex((s) => s.sql === 'BEGIN');
		const commit = mockStatements.findIndex((s) => s.sql === 'COMMIT');
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(commit).toBeGreaterThan(begin);

		const transfers = matching('UPDATE transfers', 'deletedAt = ?');
		expect(transfers).toHaveLength(1);

		// Dentro da transação, não depois dela: ou a conta e as transferências somem
		// juntas, ou nada some.
		const index = mockStatements.indexOf(transfers[0]);
		expect(index).toBeGreaterThan(begin);
		expect(index).toBeLessThan(commit);

		// Os dois lados: a reserva que recebeu os R$ 40.000 e a principal que os mandou.
		expect(transfers[0].sql).toContain('fromAccountId = ? OR toAccountId = ?');
		expect(transfers[0].params.slice(2)).toEqual(['reserva', 'reserva']);
		// Só as vivas, para não reescrever o carimbo de uma lápide antiga.
		expect(transfers[0].sql).toContain('deletedAt IS NULL');

		// Mesmo instante da lápide da conta: o sync vê uma única mudança coerente.
		const account = matching('UPDATE accounts', 'deletedAt = ?')[0];
		expect(transfers[0].params[0]).toBe(account.params[0]);
	});

	it('os lançamentos ficam sem conta em vez de sumir — eles são dinheiro que andou', async () => {
		await deleteAccount('reserva');

		const transactions = matching('UPDATE transactions', 'accountId = NULL');
		expect(transactions).toHaveLength(1);
		expect(sqlOf(matching('UPDATE transactions', 'deletedAt = ?'))).toEqual([]);
	});

	it('usa o mesmo comando da conversão de cartão (`deleteTransfersOf`)', async () => {
		await deleteAccount('conta');
		const fromDelete = sqlOf(matching('UPDATE transfers', 'deletedAt = ?'));
		reset();
		await deleteTransfersOf('conta');
		expect(sqlOf(matching('UPDATE transfers', 'deletedAt = ?'))).toEqual(fromDelete);
	});
});

describe('atribuir os lançamentos sem conta', () => {
	it('conta quantos caem antes ou na âncora do destino, e não mexe na âncora', async () => {
		mockFirstRow = { count: 40 };
		mockChanges = 40;

		const result = await assignUnassignedToAccount('conta-de-hoje');

		expect(result).toEqual({ moved: 40, beforeAnchor: 40 });

		// A contagem compara com a âncora do destino, não com hoje.
		const counted = matching('COUNT(*)', 'openingBalanceDate');
		expect(counted).toHaveLength(1);
		expect(counted[0].params).toEqual(['conta-de-hoje']);
		expect(counted[0].sql).toContain('t.accountId IS NULL');
		expect(counted[0].sql).toContain('t.deletedAt IS NULL');
		// "antes ou na" âncora: `<=`, não `<`.
		expect(counted[0].sql).toContain('t.date <= a.openingBalanceDate');

		// Nada de âncora nem de saldo é reescrito: mover lançamento não é motivo para
		// mexer no saldo que o usuário informou.
		expect(sqlOf(matching('UPDATE accounts'))).toEqual([]);
	});

	it('conta nova e lançamentos todos antigos: avisa que os 40 somem do total', async () => {
		mockFirstRow = { count: 40 };
		mockChanges = 40;
		const result = await assignUnassignedToAccount('conta-de-hoje');
		expect(result.beforeAnchor).toBe(result.moved);
	});

	it('âncora antiga: nada some, e o aviso não aparece', async () => {
		mockFirstRow = { count: 0 };
		mockChanges = 12;
		expect(await assignUnassignedToAccount('conta-antiga')).toEqual({ moved: 12, beforeAnchor: 0 });
	});
});

describe('apagar tudo (reset e primeiro passo da importação)', () => {
	it('as capturas param de apontar para lançamento com lápide', async () => {
		await resetDatabase();

		const repaired = matching('UPDATE captures', 'transactionId = NULL');
		expect(repaired).toHaveLength(1);
		expect(repaired[0].sql).toContain('transferId = NULL');
		// Sai do jogo com o motivo registrado, para o histórico não prometer dinheiro
		// que o app não tem mais nem o "reverter" tentar apagar o que não existe.
		expect(repaired[0].sql).toContain("status = 'ignored'");
		expect(repaired[0].sql).toContain("reason = 'data_reset'");
		expect(repaired[0].sql).toContain('WHERE transactionId IS NOT NULL OR transferId IS NOT NULL');

		// Dentro da mesma transação das lápides.
		const begin = mockStatements.findIndex((s) => s.sql === 'BEGIN');
		const commit = mockStatements.findIndex((s) => s.sql === 'COMMIT');
		const index = mockStatements.indexOf(repaired[0]);
		expect(index).toBeGreaterThan(begin);
		expect(index).toBeLessThan(commit);
	});

	it('as capturas não são apagadas: o fingerprint é o que impede o aviso de virar dinheiro duas vezes', async () => {
		await resetDatabase();
		expect(sqlOf(matching('DELETE FROM captures'))).toEqual([]);
	});

	it('as categorias do usuário ficam — o backup que vem a seguir aponta para elas', async () => {
		await resetDatabase();
		expect(sqlOf(matching('categories'))).toEqual([]);
	});

	it('todo o livro ganha lápide, e só o que estava vivo', async () => {
		await resetDatabase();

		const tombstoned = matching('deletedAt = ?', 'WHERE deletedAt IS NULL').map((statement) =>
			/UPDATE (\w+)/.exec(statement.sql)?.[1]
		);
		expect(tombstoned).toEqual([
			'transactions',
			'recurring_transactions',
			'budgets',
			'transfers',
			'accounts',
			'retirement_goals',
			'debts',
			'reserve_goals',
		]);
	});
});

describe('importar backup: o id do arquivo', () => {
	it('ressuscita a lápide e grava com o id original', async () => {
		await restoreTransaction(
			{
				amountCents: 1234,
				category: 'food',
				date: '2026-09-01',
				note: '',
				isIncome: false,
				accountId: null,
				installmentGroup: null,
				installmentIndex: null,
				installmentCount: null,
				cardLast4: '1534',
			},
			'tx-do-arquivo'
		);

		const removed = matching('DELETE FROM transactions');
		expect(removed).toHaveLength(1);
		// Só a lápide: um lançamento vivo com aquele id não é apagado por uma importação.
		expect(removed[0].sql).toContain('deletedAt IS NOT NULL');
		expect(removed[0].params).toEqual(['tx-do-arquivo']);

		const inserted = matching('INSERT INTO transactions');
		expect(inserted).toHaveLength(1);
		expect(inserted[0].params[0]).toBe('tx-do-arquivo');
		// E com o cartão de onde a compra saiu, que a importação perdia.
		expect(inserted[0].params).toContain('1534');
	});
});

describe('escada de migrações', () => {
	it('grava a versão a cada passo concluído', async () => {
		const done: string[] = [];
		const steps: MigrationStep[] = [
			[1, async () => { done.push('passo 1'); }],
			[2, async () => { done.push('passo 2'); }],
			[3, async () => { done.push('passo 3'); }],
		];

		const versions: number[] = [];
		const reached = await applyMigrations(0, steps, async (version) => {
			versions.push(version);
		});

		expect(done).toEqual(['passo 1', 'passo 2', 'passo 3']);
		// A versão sobe junto com os passos, não só no fim.
		expect(versions).toEqual([1, 2, 3]);
		expect(reached).toBe(3);
	});

	it('um crash no meio deixa gravado só o que terminou', async () => {
		const steps: MigrationStep[] = [
			[1, async () => undefined],
			[
				2,
				async () => {
					throw new Error('o Android matou o processo aqui');
				},
			],
			[3, async () => undefined],
		];

		const versions: number[] = [];
		await expect(
			applyMigrations(0, steps, async (version) => {
				versions.push(version);
			})
		).rejects.toThrow('o Android matou o processo');

		// Antes, nada era gravado: a abertura seguinte refazia o passo 1 — que reconstrói
		// a tabela de lançamentos — e morria com "table already exists".
		expect(versions).toEqual([1]);
	});

	it('a abertura seguinte retoma do passo que faltou, sem repetir os anteriores', async () => {
		const done: number[] = [];
		const steps: MigrationStep[] = [1, 2, 3].map(
			(version) => [version, async () => { done.push(version); }] as MigrationStep
		);

		await applyMigrations(1, steps, async () => undefined);

		expect(done).toEqual([2, 3]);
	});

	it('nada a fazer num banco que já está na última versão', async () => {
		const done: number[] = [];
		const steps: MigrationStep[] = [[1, async () => { done.push(1); }]];
		const versions: number[] = [];

		expect(await applyMigrations(1, steps, async (v) => { versions.push(v); })).toBe(1);
		expect(done).toEqual([]);
		expect(versions).toEqual([]);
	});

	it('a escada é 1..SCHEMA_VERSION, em ordem e sem buraco', async () => {
		const ladder = migrationLadder();
		expect(ladder.map(([version]) => version)).toEqual(
			Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1)
		);
	});
});
