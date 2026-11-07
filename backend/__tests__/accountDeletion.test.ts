/**
 * Apagar a conta (`DELETE /api/me`, DEC-35) e o que acontece com o token de quem não existe
 * mais.
 *
 * A Google Play exige que a conta possa ser apagada de dentro do app. O que estes testes
 * protegem:
 *
 *  - apagar a linha de `users` leva tudo junto: toda relação do `User` no schema.prisma é
 *    `onDelete: Cascade`, e as FKs das migrações — que são o que o Postgres de fato tem —
 *    também. Uma tabela nova sem cascata faz o teste falhar, em vez de deixar linhas órfãs
 *    ou travar o apagamento de quem a usou;
 *  - a senha é conferida antes de apagar, contra o hash guardado. Senha errada não apaga
 *    nada (o controller responde 403 `wrong_password`, e não 401: o app trata 401 como
 *    sessão morta e deslogaria quem só errou a senha);
 *  - o access token vale 15 minutos e continua válido depois que a conta sumiu. O
 *    `requireAuth` responde 401 `account_gone` nesse caso — o app desloga —, em vez de a
 *    rota seguir e dar 500 de FK no push ou uma resposta vazia no pull.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `budgetConflict.test.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
	ACCOUNT_GONE_CODE,
	type AccountDeletionDb,
	deleteAccount,
	WRONG_PASSWORD_CODE,
} from '../src/domain/accountDeletion';
import { type AuthenticatedRequest, requireAuth } from '../src/middleware/auth';
import { deleteAccountSchema } from '../src/schemas/auth';

const JWT_SECRET = 'segredo-so-de-teste';

jest.mock(
	'../src/lib/env.js',
	() => ({ isProduction: true, env: { jwtSecret: 'segredo-so-de-teste', accessTokenTtl: '15m' } }),
	{ virtual: true }
);

// O `requireAuth` importa o `error.js` com a extensão do ESM, que o jest da raiz não resolve
// para o `.ts` (mesmo caso do `diagnostics.test.ts`).
jest.mock('../src/middleware/error.js', () => jest.requireActual('../src/middleware/error'), {
	virtual: true,
});

const mockFindUnique = jest.fn();

jest.mock(
	'../src/lib/prisma.js',
	() => ({ prisma: { user: { findUnique: (...args: unknown[]) => mockFindUnique(...args) } } }),
	{ virtual: true }
);

beforeEach(() => {
	mockFindUnique.mockReset();
});

// ---------------------------------------------------------------------------
// O schema e as migrações
// ---------------------------------------------------------------------------

const PRISMA_DIR = join(__dirname, '..', 'prisma');
const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');
const modelNames = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1] as string));

/** O corpo de um `model X { ... }` do schema.prisma. */
const modelBody = (name: string): string => {
	const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
	if (!match) throw new Error(`model ${name} não encontrado no schema.prisma`);
	return match[1] as string;
};

/** As relações do `User` (campo → model), lidas como em `dataWipe.test.ts`. */
const userRelations = (): Map<string, string> =>
	new Map(
		modelBody('User')
			.split(/\r?\n/)
			.map((line) => /^\s*(\w+)\s+(\w+)(\[\])?\??\s*(?:@.*)?$/.exec(line))
			.filter(
				(match): match is RegExpExecArray => match !== null && modelNames.has(match[2] as string)
			)
			.map((match) => [match[1] as string, match[2] as string])
	);

/** O lado com a FK: em cada model, a linha `campo User @relation(...)`, se houver. */
const userForeignKeys = (): Map<string, string> => {
	const keys = new Map<string, string>();
	for (const model of modelNames) {
		if (model === 'User') continue;
		const line = modelBody(model)
			.split(/\r?\n/)
			.find((text) => /^\s*\w+\s+User\??\s+@relation\(/.test(text));
		if (line !== undefined) keys.set(model, line.trim());
	}
	return keys;
};

/**
 * As FKs que o banco tem depois de todas as migrações, na ordem em que rodam: nome da
 * constraint → tabela referenciada e o que vem depois (`ON DELETE ...`). Um `DROP
 * CONSTRAINT` posterior tira a FK da conta.
 */
const migratedForeignKeys = (): Map<string, { references: string; tail: string }> => {
	const keys = new Map<string, { references: string; tail: string }>();
	const dirs = readdirSync(join(PRISMA_DIR, 'migrations'))
		.filter((dir) => !dir.endsWith('.toml'))
		.sort();
	for (const dir of dirs) {
		const sql = readFileSync(join(PRISMA_DIR, 'migrations', dir, 'migration.sql'), 'utf8');
		for (const statement of sql.split(';')) {
			const dropped = /DROP CONSTRAINT (?:IF EXISTS )?"(\w+)"/.exec(statement);
			if (dropped) keys.delete(dropped[1] as string);
			const added =
				/ADD CONSTRAINT "(\w+)" FOREIGN KEY \([^)]*\) REFERENCES "(\w+)"\([^)]*\)(.*)$/s.exec(
					statement
				);
			if (added) {
				keys.set(added[1] as string, {
					references: added[2] as string,
					tail: (added[3] as string).trim(),
				});
			}
		}
	}
	return keys;
};

describe('apagar a linha de users leva tudo junto', () => {
	it('lê o schema e as migrações (o teste não passa por não achar nada)', () => {
		expect(userRelations().size).toBeGreaterThan(15);
		expect(userForeignKeys().size).toBeGreaterThan(15);
		expect(migratedForeignKeys().size).toBeGreaterThan(15);
	});

	it('toda relação do User tem, do outro lado, a FK com onDelete: Cascade', () => {
		const foreignKeys = userForeignKeys();
		const withoutCascade = [...userRelations()]
			.filter(([, model]) => !/onDelete:\s*Cascade\b/.test(foreignKeys.get(model) ?? ''))
			.map(([field, model]) => `${field} (${model})`);
		expect(withoutCascade).toEqual([]);
	});

	it('nenhum model aponta para o User fora das relações que o User declara', () => {
		const declared = new Set(userRelations().values());
		expect([...userForeignKeys().keys()].filter((model) => !declared.has(model))).toEqual([]);
	});

	it('no banco, cada relação do User é uma FK para users com ON DELETE CASCADE', () => {
		const toUsers = [...migratedForeignKeys()].filter(([, key]) => key.references === 'users');
		expect(toUsers.filter(([, key]) => !/^ON DELETE CASCADE\b/.test(key.tail))).toEqual([]);
		expect(toUsers).toHaveLength(userRelations().size);
	});

	it('nenhuma outra FK do banco pode barrar a cascata no meio do caminho', () => {
		// Uma FK RESTRICT entre duas tabelas do usuário (um lançamento → uma conta, por
		// exemplo) faria o DELETE da conta falhar. Hoje não existe nenhuma; quem criar uma
		// tem de decidir o que acontece com ela quando a conta sai.
		const blocking = [...migratedForeignKeys()].filter(
			([, key]) => !/^ON DELETE (CASCADE|SET NULL)\b/.test(key.tail)
		);
		expect(blocking).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// O corpo do DELETE /me
// ---------------------------------------------------------------------------

describe('corpo do DELETE /me', () => {
	it('aceita a senha', () => {
		expect(deleteAccountSchema.parse({ password: 'qualquer coisa' })).toEqual({
			password: 'qualquer coisa',
		});
	});

	it.each([
		['sem corpo', undefined],
		['corpo vazio', {}],
		['senha vazia', { password: '' }],
		['senha que não é texto', { password: 12345678 }],
		['senha longa demais', { password: 'x'.repeat(201) }],
	])('recusa %s (400 no handler central)', (_label, body) => {
		expect(deleteAccountSchema.safeParse(body).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Apagar
// ---------------------------------------------------------------------------

const PASSWORD = 'senha-certa-123';
// Custo 4 só para o teste ser rápido: o bcrypt lê o custo do próprio hash.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

/** Um banco falso com a forma que o domínio pede; o `PrismaClient` satisfaz a mesma. */
const fakeDb = (user: { passwordHash: string } | null, deleted = 1) => {
	const db = {
		user: {
			findUnique: jest.fn(async () => user),
			deleteMany: jest.fn(async () => ({ count: deleted })),
		},
	};
	return db satisfies AccountDeletionDb;
};

describe('apagar a conta', () => {
	it('senha certa: apaga a linha do usuário (o resto vai em cascata)', async () => {
		const db = fakeDb({ passwordHash: PASSWORD_HASH });

		expect(await deleteAccount(db, 'u1', PASSWORD, bcrypt.compare)).toBe('deleted');
		expect(db.user.findUnique).toHaveBeenCalledWith({
			where: { id: 'u1' },
			select: { passwordHash: true },
		});
		// Um DELETE só, da linha de users: as outras tabelas saem pela cascata do Postgres,
		// no mesmo comando — e por isso na mesma transação.
		expect(db.user.deleteMany).toHaveBeenCalledTimes(1);
		expect(db.user.deleteMany).toHaveBeenCalledWith({ where: { id: 'u1' } });
	});

	it('senha errada: wrong_password, e nada é apagado', async () => {
		const db = fakeDb({ passwordHash: PASSWORD_HASH });

		expect(await deleteAccount(db, 'u1', 'senha-errada', bcrypt.compare)).toBe('wrong_password');
		expect(db.user.deleteMany).not.toHaveBeenCalled();
	});

	it('confere a senha enviada com o hash guardado', async () => {
		const db = fakeDb({ passwordHash: PASSWORD_HASH });
		const passwordMatches = jest.fn(async () => false);

		await deleteAccount(db, 'u1', PASSWORD, passwordMatches);

		expect(passwordMatches).toHaveBeenCalledWith(PASSWORD, PASSWORD_HASH);
	});

	it('conta que já não existe: account_gone, sem conferir senha', async () => {
		const db = fakeDb(null);
		const passwordMatches = jest.fn(async () => true);

		expect(await deleteAccount(db, 'u1', PASSWORD, passwordMatches)).toBe('account_gone');
		expect(passwordMatches).not.toHaveBeenCalled();
		expect(db.user.deleteMany).not.toHaveBeenCalled();
	});

	it('apagada por outro pedido entre a senha e o DELETE: account_gone', async () => {
		const db = fakeDb({ passwordHash: PASSWORD_HASH }, 0);

		expect(await deleteAccount(db, 'u1', PASSWORD, bcrypt.compare)).toBe('account_gone');
	});

	it('os códigos são os que o app espera', () => {
		expect(WRONG_PASSWORD_CODE).toBe('wrong_password');
		expect(ACCOUNT_GONE_CODE).toBe('account_gone');
	});
});

// ---------------------------------------------------------------------------
// requireAuth: o token de uma conta que não existe mais
// ---------------------------------------------------------------------------

/** Roda o `requireAuth` até ele chamar o `next`, e devolve o erro (se houve) e o userId. */
const authenticate = (authorization: string | undefined) =>
	new Promise<{ error: unknown; userId: string | undefined }>((resolve) => {
		const req = {
			header: (name: string) =>
				name.toLowerCase() === 'authorization' ? authorization : undefined,
		} as unknown as Request;
		requireAuth(req, {} as Response, (error?: unknown) =>
			resolve({ error, userId: (req as Partial<AuthenticatedRequest>).userId })
		);
	});

const bearer = (token: string) => `Bearer ${token}`;
const tokenFor = (sub: string) => jwt.sign({ sub }, JWT_SECRET, { expiresIn: '15m' });

describe('requireAuth', () => {
	it('token válido de conta que existe: segue com o userId do token', async () => {
		mockFindUnique.mockResolvedValue({ id: 'u1' });

		const { error, userId } = await authenticate(bearer(tokenFor('u1')));

		expect(error).toBeUndefined();
		expect(userId).toBe('u1');
		// Uma busca pela chave primária, só o id.
		expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { id: true } });
	});

	it('token válido de conta apagada: 401 account_gone, e a rota não roda', async () => {
		mockFindUnique.mockResolvedValue(null);

		const { error, userId } = await authenticate(bearer(tokenFor('u1')));

		expect(error).toMatchObject({ status: 401, code: 'account_gone' });
		expect(userId).toBeUndefined();
	});

	it('token expirado de conta que existe: token_expired (o app renova)', async () => {
		mockFindUnique.mockResolvedValue({ id: 'u1' });
		const expired = jwt.sign({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);

		const { error, userId } = await authenticate(bearer(expired));

		expect(error).toMatchObject({ status: 401, code: 'token_expired' });
		expect(userId).toBeUndefined();
	});

	it('token expirado de conta apagada: account_gone, e não token_expired', async () => {
		// A renovação não salvaria: os refresh tokens saíram em cascata com a conta, e o
		// aparelho só sairia, com os dados dela. Com o account_gone ele apaga e sai (DEC-35).
		mockFindUnique.mockResolvedValue(null);
		const expired = jwt.sign({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);

		const { error, userId } = await authenticate(bearer(expired));

		expect(error).toMatchObject({ status: 401, code: 'account_gone' });
		expect(userId).toBeUndefined();
		expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { id: true } });
	});

	it('token expirado com outra chave: invalid_token, sem ir ao banco', async () => {
		const forged = jwt.sign({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 }, 'outra-chave');

		const { error } = await authenticate(bearer(forged));

		expect(error).toMatchObject({ status: 401, code: 'invalid_token' });
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it.each([
		['assinado com outra chave', bearer(jwt.sign({ sub: 'u1' }, 'outra-chave'))],
		['sem sub', bearer(jwt.sign({ foo: 'bar' }, JWT_SECRET))],
		['lixo', bearer('nao-e-um-jwt')],
	])('token inválido (%s): invalid_token, sem ir ao banco', async (_label, header) => {
		const { error } = await authenticate(header);

		expect(error).toMatchObject({ status: 401, code: 'invalid_token' });
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it('sem token: missing_token', async () => {
		const { error } = await authenticate(undefined);

		expect(error).toMatchObject({ status: 401, code: 'missing_token' });
	});

	it('banco fora do ar: o erro segue para o handler central (500), não vira 401', async () => {
		// Um 401 aqui deslogaria todo mundo num soluço do Postgres.
		const down = new Error('connection refused');
		mockFindUnique.mockRejectedValue(down);

		const { error } = await authenticate(bearer(tokenFor('u1')));

		expect(error).toBe(down);
	});
});
