/**
 * Uma transação do app por vez (SPD-101, E2E-37): `runInTransaction`.
 *
 * O banco aqui é falso, mas a transação dele é a do `expo-sqlite` linha a linha
 * (`SQLiteDatabase.withTransactionAsync`: BEGIN, tarefa, COMMIT; no erro, ROLLBACK), numa
 * conexão só. Cada comando espera um tique, como a ponte nativa: é o que deixa duas tarefas
 * se entrelaçarem. O BEGIN dentro de uma transação aberta falha, e o COMMIT e o ROLLBACK sem
 * transação também — as três mensagens que o Metro mostrou.
 */

jest.mock('expo-sqlite', () => {
	const state = {
		inTransaction: false,
		/** O que já está gravado de vez. */
		committed: [] as string[],
		/** O que a transação aberta gravou e ainda pode ser desfeito. */
		pending: [] as string[],
		/** BEGIN/COMMIT/ROLLBACK na ordem em que chegaram ao banco. */
		events: [] as string[],
	};
	const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
	const execAsync = async (sql: string) => {
		await tick();
		state.events.push(sql);
		if (sql === 'BEGIN') {
			if (state.inTransaction) throw new Error('cannot start a transaction within a transaction');
			state.inTransaction = true;
			state.pending = [];
		} else if (sql === 'COMMIT') {
			if (!state.inTransaction) throw new Error('cannot commit - no transaction is active');
			state.committed.push(...state.pending);
			state.pending = [];
			state.inTransaction = false;
		} else if (sql === 'ROLLBACK') {
			if (!state.inTransaction) throw new Error('cannot rollback - no transaction is active');
			state.pending = [];
			state.inTransaction = false;
		}
	};
	const runAsync = async (sql: string) => {
		await tick();
		if (state.inTransaction) state.pending.push(sql);
		else state.committed.push(sql);
		return { changes: 1, lastInsertRowId: 0 };
	};
	return {
		mockState: state,
		openDatabaseSync: () => ({
			execAsync,
			runAsync,
			getFirstAsync: async () => null,
			getAllAsync: async () => [],
			// Cópia de `SQLiteDatabase.withTransactionAsync` (expo-sqlite 55).
			withTransactionAsync: async (task: () => Promise<void>) => {
				try {
					await execAsync('BEGIN');
					await task();
					await execAsync('COMMIT');
				} catch (error) {
					await execAsync('ROLLBACK');
					throw error;
				}
			},
		}),
	};
});

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
	multiRemove: jest.fn(async () => undefined),
	multiGet: jest.fn(async () => []),
}));

import { db, runInTransaction } from '../database';

const state = jest.requireMock<{
	mockState: { inTransaction: boolean; committed: string[]; pending: string[]; events: string[] };
}>('expo-sqlite').mockState;

/** Uma tarefa que grava `count` linhas, com espera entre elas como as de verdade. */
const writes = (name: string, count: number) => async () => {
	for (let index = 1; index <= count; index += 1) {
		await db.runAsync(`${name}-${index}`);
	}
};

/**
 * Falha o teste em vez de travar a suíte se a fila nunca soltar. O prazo é folgado de propósito: com a suíte
 * inteira rodando, 2 s já estourou sem a fila estar travada.
 */
const within = <T,>(promise: Promise<T>, ms = 10_000): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`travou: mais de ${ms} ms`)), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
};

/** Deixa o banco falso andar `count` tiques (cada comando dele espera um). */
const ticks = async (count: number) => {
	for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Anda tique a tique até a condição valer, sem depender de relógio. */
const until = async (condition: () => boolean, max = 1_000) => {
	for (let index = 0; index < max && !condition(); index += 1) await ticks(1);
	if (!condition()) throw new Error(`não chegou em ${max} tiques`);
};

beforeEach(() => {
	state.inTransaction = false;
	state.committed = [];
	state.pending = [];
	state.events = [];
});

describe('o banco falso se comporta como o expo-sqlite (o E2E-37 sem a fila)', () => {
	it('duas transações juntas na mesma conexão: o BEGIN da segunda falha e o ROLLBACK dela leva a primeira', async () => {
		const [first, second] = await Promise.allSettled([
			db.withTransactionAsync(writes('categorias', 4)),
			db.withTransactionAsync(writes('contas', 2)),
		]);

		expect(second).toMatchObject({ status: 'rejected', reason: { message: 'cannot start a transaction within a transaction' } });
		expect(first).toMatchObject({ status: 'rejected', reason: { message: 'cannot rollback - no transaction is active' } });
		// A primeira ficou pela metade: o que gravou antes do ROLLBACK alheio sumiu, o resto
		// entrou fora de transação.
		expect(state.committed.filter((sql) => sql.startsWith('categorias')).length).toBeGreaterThan(0);
		expect(state.committed.filter((sql) => sql.startsWith('categorias')).length).toBeLessThan(4);
	});
});

describe('runInTransaction (SPD-101)', () => {
	it('duas transações pedidas juntas rodam uma depois da outra, e as duas gravam tudo', async () => {
		const results = await within(
			Promise.allSettled([runInTransaction(writes('categorias', 4)), runInTransaction(writes('contas', 2))])
		);

		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
		expect(state.events).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
		expect(state.committed).toEqual(['categorias-1', 'categorias-2', 'categorias-3', 'categorias-4', 'contas-1', 'contas-2']);
	});

	it('na ordem em que foram pedidas, por mais que sejam', async () => {
		await within(
			Promise.all(['a', 'b', 'c', 'd'].map((name) => runInTransaction(writes(name, 2))))
		);

		expect(state.committed).toEqual(['a-1', 'a-2', 'b-1', 'b-2', 'c-1', 'c-2', 'd-1', 'd-2']);
	});

	it('um erro numa desfaz só ela: a outra grava, e a fila segue para a próxima', async () => {
		const failing = runInTransaction(async () => {
			await db.runAsync('dividas-1');
			throw new Error('falhou no meio');
		});
		const [failed, kept, after] = await within(
			Promise.allSettled([failing, runInTransaction(writes('contas', 2)), runInTransaction(writes('depois', 1))])
		);

		expect(failed).toMatchObject({ status: 'rejected', reason: { message: 'falhou no meio' } });
		expect(kept.status).toBe('fulfilled');
		expect(after.status).toBe('fulfilled');
		expect(state.committed).toEqual(['contas-1', 'contas-2', 'depois-1']);
		expect(state.events).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
	});

	it('aninhada com o escopo de fora não trava: entra na mesma transação, sem BEGIN próprio', async () => {
		await within(
			runInTransaction(async (scope) => {
				await db.runAsync('fora-1');
				await runInTransaction(writes('dentro', 2), scope);
				await db.runAsync('fora-2');
			})
		);

		expect(state.events).toEqual(['BEGIN', 'COMMIT']);
		expect(state.committed).toEqual(['fora-1', 'dentro-1', 'dentro-2', 'fora-2']);
	});

	it('um erro na aninhada desfaz a de fora inteira', async () => {
		const outcome = within(
			runInTransaction(async (scope) => {
				await db.runAsync('fora-1');
				await runInTransaction(async () => {
					await db.runAsync('dentro-1');
					throw new Error('dentro falhou');
				}, scope);
			})
		);

		await expect(outcome).rejects.toThrow('dentro falhou');
		expect(state.committed).toEqual([]);
		expect(state.events).toEqual(['BEGIN', 'ROLLBACK']);
	});

	it('o escopo de uma transação que já terminou é recusado, sem abrir nada', async () => {
		let leaked: Parameters<Parameters<typeof runInTransaction>[0]>[0] | null = null;
		await runInTransaction(async (scope) => {
			leaked = scope;
		});
		state.events = [];

		await expect(within(runInTransaction(writes('tarde', 1), leaked ?? undefined))).rejects.toThrow();
		expect(state.events).toEqual([]);
		expect(state.committed).toEqual([]);
	});

	it('enquanto uma espera um await longo, a outra não entra nela: espera o COMMIT', async () => {
		let releaseFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = runInTransaction(async () => {
			await db.runAsync('primeira-1');
			await gate;
			await db.runAsync('primeira-2');
		});
		const second = runInTransaction(writes('segunda', 1));
		// Espera a primeira chegar ao portão e dá folga para a segunda tentar entrar. Um prazo fixo
		// (20 ms) oscilava com a máquina carregada: o timer vencia antes dos tiques do banco falso.
		await until(() => state.pending.includes('primeira-1'));
		await ticks(20);
		expect(state.events).toEqual(['BEGIN']);
		expect(state.pending).toEqual(['primeira-1']);
		releaseFirst();
		await within(Promise.all([first, second]));

		expect(state.events).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
		expect(state.committed).toEqual(['primeira-1', 'primeira-2', 'segunda-1']);
	});
});
