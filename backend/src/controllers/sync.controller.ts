import type { Response } from 'express';
import type { z } from 'zod';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
	accountSchema,
	budgetSchema,
	categorySchema,
	pullQuerySchema,
	pushBodySchema,
	recurringTransactionSchema,
	transactionSchema,
	transferSchema,
} from '../schemas/sync.js';

/**
 * Sync incremental, last-write-wins por linha.
 *
 * Os dois lados falam o mesmo formato e nenhum dos dois é "a verdade": o servidor é só
 * o ponto de encontro. Quem tem o `updatedAt` mais recente vence, e apagar é escrever
 * `deletedAt` — nunca remover a linha, senão um aparelho que estava offline reenviaria
 * o registro achando que ele é novo.
 *
 * Seis coleções: categorias, contas, lançamentos, recorrências, orçamentos e
 * transferências. Contas e transferências chegaram no v7 do app; um aparelho anterior
 * simplesmente não as manda nem as lê.
 */

type Collection =
	| 'categories'
	| 'accounts'
	| 'transactions'
	| 'recurringTransactions'
	| 'budgets'
	| 'transfers';

const DEFAULT_CATEGORY_IDS = DEFAULT_CATEGORIES.map((category) => category.id);

/**
 * Por que uma linha não foi gravada. Espelha `RejectedRow` em `app/sync/types.ts`.
 *
 * - `stale`: o servidor já tem uma versão mais nova.
 * - `unknown_category`: o lançamento aponta para uma categoria que este perfil não
 *   conhece. Nada é gravado; `category` diz qual faltou, e quem enviou a reenvia junto.
 * - `invalid`: a linha não passou na validação da sua coleção; `message` diz por quê.
 */
interface RejectedRow {
	collection: Collection;
	id: string;
	reason: 'stale' | 'unknown_category' | 'invalid';
	category?: string;
	message?: string;
}

/** `Date | null` do banco vira o `string | null` que o app entende. */
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export const pullData = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const { cursor } = pullQuerySchema.parse(req.query);
	const userId = req.userId;

	/**
	 * Cada coleção avança pela sua própria sequência. `serverSeq` é atribuída pelo
	 * Postgres no momento da gravação, então uma linha que chegou hoje com `updatedAt`
	 * da semana passada — o caso de um aparelho que estava offline — ainda assim recebe
	 * uma sequência maior que a do último pull e não escapa de ninguém.
	 */
	const page = (lastSeq: number) => ({
		where: { userId, serverSeq: { gt: lastSeq } },
		orderBy: { serverSeq: 'asc' } as const,
		take: env.syncPageSize,
	});

	const [categories, accounts, transactions, recurringTransactions, budgets, transfers] =
		await Promise.all([
			prisma.category.findMany(page(cursor.categories)),
			prisma.account.findMany(page(cursor.accounts)),
			prisma.transaction.findMany(page(cursor.transactions)),
			prisma.recurringTransaction.findMany(page(cursor.recurringTransactions)),
			prisma.budget.findMany(page(cursor.budgets)),
			prisma.transfer.findMany(page(cursor.transfers)),
		]);

	// `amountCents` é BigInt no Postgres e chega como `bigint`, que o JSON não serializa.
	// Cabe num `number` sem perda: o teto de MAX_AMOUNT_CENTS fica bem abaixo de 2^53.
	const changes = {
		categories: categories.map((row) => ({
			id: row.id,
			name: row.name,
			color: row.color,
			icon: row.icon,
			type: row.type,
			nature: row.nature,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		accounts: accounts.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			role: row.role,
			envelopeMonthlyCents: row.envelopeMonthlyCents === null ? null : Number(row.envelopeMonthlyCents),
			network: row.network,
			bankName: row.bankName,
			color: row.color,
			last4: row.last4,
			closingDay: row.closingDay,
			dueDay: row.dueDay,
			closingDaysBefore: row.closingDaysBefore,
			cardNames: row.cardNames,
			creditLimitCents: row.creditLimitCents === null ? null : Number(row.creditLimitCents),
			packageName: row.packageName,
			accountKey: row.accountKey,
			openingBalanceCents: Number(row.openingBalanceCents),
			openingBalanceDate: row.openingBalanceDate,
			sortOrder: row.sortOrder,
			archived: row.archived,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		transactions: transactions.map((row) => ({
			id: row.id,
			amountCents: Number(row.amountCents),
			category: row.category,
			date: row.date,
			note: row.note,
			isIncome: row.isIncome,
			accountId: row.accountId,
			installmentGroup: row.installmentGroup,
			installmentIndex: row.installmentIndex,
			installmentCount: row.installmentCount,
			cardLast4: row.cardLast4,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		recurringTransactions: recurringTransactions.map((row) => ({
			id: row.id,
			amountCents: Number(row.amountCents),
			isIncome: row.isIncome,
			note: row.note,
			category: row.category,
			recurrenceType: row.recurrenceType,
			day: row.day,
			month: row.month,
			weekday: row.weekday,
			lastProcessed: row.lastProcessed,
			nextDue: row.nextDue,
			active: row.active,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		budgets: budgets.map((row) => ({
			id: row.id,
			year: row.year,
			month: row.month,
			amountCents: Number(row.amountCents),
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		transfers: transfers.map((row) => ({
			id: row.id,
			fromAccountId: row.fromAccountId,
			toAccountId: row.toAccountId,
			amountCents: Number(row.amountCents),
			date: row.date,
			note: row.note,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
	};

	/**
	 * O novo cursor é a última `serverSeq` **efetivamente entregue** — nunca o máximo
	 * da tabela. Numa página truncada, avançar além do que foi entregue apagaria da
	 * vista para sempre as linhas que não couberam.
	 */
	const advance = (rows: { serverSeq: number }[], current: number): number =>
		rows.length > 0 ? (rows[rows.length - 1] as { serverSeq: number }).serverSeq : current;

	const nextCursor = {
		categories: advance(categories, cursor.categories),
		accounts: advance(accounts, cursor.accounts),
		transactions: advance(transactions, cursor.transactions),
		recurringTransactions: advance(recurringTransactions, cursor.recurringTransactions),
		budgets: advance(budgets, cursor.budgets),
		transfers: advance(transfers, cursor.transfers),
	};

	res.json({
		serverTime: new Date().toISOString(),
		/** O cliente guarda isto e devolve no próximo pull. */
		cursor: nextCursor,
		/** Verdadeiro enquanto houver mais para buscar: o cliente repete o pull. */
		hasMore: [categories, accounts, transactions, recurringTransactions, budgets, transfers].some(
			(rows) => rows.length === env.syncPageSize
		),
		changes,
	});
};

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** O `id` de uma linha crua, para nomeá-la em `rejected` mesmo quando ela é inválida. */
const rowId = (raw: unknown): string => {
	if (typeof raw !== 'object' || raw === null) return '';
	const id = (raw as { id?: unknown }).id;
	return typeof id === 'string' ? id : '';
};

/**
 * Separa as linhas válidas das que a validação recusa.
 *
 * Validar linha a linha, e não a remessa inteira de uma vez, é o que impede um único
 * valor fora do teto de derrubar a página com 400. Como a linha ruim continuava suja no
 * aparelho, ela entrava em toda página seguinte e o sync daquele aparelho parava para
 * sempre — sem que nada mais dele subisse e sem que nada aparecesse na tela. Agora ela
 * volta em `rejected` com o motivo, e as outras seguem.
 */
const partitionRows = <T>(
	collection: Collection,
	rows: unknown[],
	schema: z.ZodType<T>,
	rejected: RejectedRow[]
): T[] => {
	const valid: T[] = [];

	for (const raw of rows) {
		const result = schema.safeParse(raw);

		if (result.success) {
			valid.push(result.data);
			continue;
		}

		rejected.push({
			collection,
			id: rowId(raw),
			reason: 'invalid',
			message: result.error.issues
				.map((issue) => `${issue.path.join('.') || '(linha)'}: ${issue.message}`)
				.join('; '),
		});
	}

	return valid;
};

/**
 * Se a versão do servidor é mais nova que a recebida.
 *
 * O empate é resolvido a favor de quem envia: o custo de reaplicar uma escrita idêntica
 * é zero, enquanto recusá-la deixaria o aparelho tentando para sempre.
 */
const isStale = (current: { updatedAt: Date } | null, row: { updatedAt: string }): boolean =>
	current !== null && current.updatedAt > new Date(row.updatedAt);

export const pushData = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const { changes } = pushBodySchema.parse(req.body);
	const userId = req.userId;

	const rejected: RejectedRow[] = [];

	const categories = partitionRows('categories', changes.categories, categorySchema, rejected);
	const accounts = partitionRows('accounts', changes.accounts, accountSchema, rejected);
	const transactions = partitionRows(
		'transactions',
		changes.transactions,
		transactionSchema,
		rejected
	);
	const recurringTransactions = partitionRows(
		'recurringTransactions',
		changes.recurringTransactions,
		recurringTransactionSchema,
		rejected
	);
	const budgets = partitionRows('budgets', changes.budgets, budgetSchema, rejected);
	const transfers = partitionRows('transfers', changes.transfers, transferSchema, rejected);

	let applied = 0;

	await prisma.$transaction(
		async (tx) => {
			// --- Categorias primeiro ---------------------------------------------
			// Um lançamento pode vir na mesma remessa que a categoria que ele usa; a
			// verificação logo abaixo precisa enxergar essa categoria já gravada.
			for (const row of categories) {
				const current = await tx.category.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'categories', id: row.id, reason: 'stale' });
					continue;
				}

				const data = {
					name: row.name,
					color: row.color,
					icon: row.icon,
					type: row.type,
					// Aparelho anterior à coluna: o padrão do app é o padrão aqui, para que
					// os dois lados classifiquem a mesma linha do mesmo jeito.
					nature: row.nature ?? 'discretionary',
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.category.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// --- Contas -------------------------------------------------------------
			// `accountId` nos lançamentos não é FK nem é verificado: a conta é criada
			// pelo app na primeira notificação e vem na mesma remessa ou antes; e um
			// lançamento com conta que o servidor não conhece continua válido — a tela
			// mostra "sem conta" até ela chegar.
			for (const row of accounts) {
				const current = await tx.account.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'accounts', id: row.id, reason: 'stale' });
					continue;
				}

				// Aparelho anterior ao papel: o padrão pelo tipo, o mesmo que o app aplica.
				const defaultRole =
					row.kind === 'credit_card' ? 'card' : row.kind === 'savings' || row.kind === 'investment' ? 'reserve' : 'main';
				const data = {
					name: row.name,
					kind: row.kind,
					role: row.role ?? defaultRole,
					envelopeMonthlyCents: row.envelopeMonthlyCents == null ? null : BigInt(row.envelopeMonthlyCents),
					network: row.network ?? null,
					bankName: row.bankName ?? null,
					color: row.color,
					last4: row.last4 ?? null,
					closingDay: row.closingDay ?? null,
					dueDay: row.dueDay ?? null,
					closingDaysBefore: row.closingDaysBefore ?? null,
					cardNames: row.cardNames ?? null,
					creditLimitCents: row.creditLimitCents == null ? null : BigInt(row.creditLimitCents),
					packageName: row.packageName ?? null,
					accountKey: row.accountKey ?? null,
					openingBalanceCents: BigInt(row.openingBalanceCents),
					openingBalanceDate: row.openingBalanceDate,
					sortOrder: row.sortOrder,
					archived: row.archived,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.account.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// Quais categorias este perfil conhece. Inclui as apagadas: um lançamento numa
			// categoria removida é legítimo — o app o move para 'uncategorized' ao apagar,
			// e essa versão chega por conta própria.
			const knownCategories = new Set(
				(await tx.category.findMany({ where: { userId }, select: { id: true } })).map((c) => c.id)
			);

			/**
			 * Aparelhos não sincronizam em ordem: o celular pode enviar um lançamento numa
			 * categoria que ainda não subiu. Gravar reancorado em 'uncategorized', como era
			 * feito, resolvia o órfão aqui mas criava outro problema: o aparelho de origem
			 * continuava com a categoria certa, o empate no last-write-wins deixava cada
			 * lado como estava, e os dois divergiam para sempre sem ninguém saber.
			 *
			 * Agora a linha volta com `unknown_category` e nada é gravado. Quem enviou tem a
			 * categoria — o lançamento é dele — e a reenvia junto na próxima remessa; se
			 * nem ele a tem mais, é ele quem move o lançamento para 'uncategorized'. A
			 * decisão fica no aparelho dono do dado, e as duas cópias convergem.
			 */
			const rejectUnknownCategory = (collection: Collection, row: { id: string; category: string }) => {
				if (knownCategories.has(row.category)) return false;
				rejected.push({
					collection,
					id: row.id,
					reason: 'unknown_category',
					category: row.category,
				});
				return true;
			};

			// --- Lançamentos ------------------------------------------------------
			for (const row of transactions) {
				const current = await tx.transaction.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'transactions', id: row.id, reason: 'stale' });
					continue;
				}
				if (rejectUnknownCategory('transactions', row)) continue;

				const data = {
					amountCents: BigInt(row.amountCents),
					category: row.category,
					date: row.date,
					note: row.note ?? null,
					isIncome: row.isIncome,
					accountId: row.accountId ?? null,
					installmentGroup: row.installmentGroup ?? null,
					installmentIndex: row.installmentIndex ?? null,
					installmentCount: row.installmentCount ?? null,
					cardLast4: row.cardLast4 ?? null,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.transaction.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// --- Recorrências -----------------------------------------------------
			for (const row of recurringTransactions) {
				const current = await tx.recurringTransaction.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'recurringTransactions', id: row.id, reason: 'stale' });
					continue;
				}
				if (rejectUnknownCategory('recurringTransactions', row)) continue;

				const data = {
					amountCents: BigInt(row.amountCents),
					isIncome: row.isIncome,
					note: row.note ?? null,
					category: row.category,
					recurrenceType: row.recurrenceType,
					day: row.day ?? null,
					month: row.month ?? null,
					weekday: row.weekday ?? null,
					lastProcessed: row.lastProcessed ?? null,
					nextDue: row.nextDue ?? null,
					active: row.active,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.recurringTransaction.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// --- Orçamentos -------------------------------------------------------
			for (const row of budgets) {
				const current = await tx.budget.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'budgets', id: row.id, reason: 'stale' });
					continue;
				}

				const data = {
					year: row.year,
					month: row.month,
					amountCents: BigInt(row.amountCents),
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.budget.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// --- Transferências ---------------------------------------------------
			for (const row of transfers) {
				const current = await tx.transfer.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'transfers', id: row.id, reason: 'stale' });
					continue;
				}

				const data = {
					fromAccountId: row.fromAccountId ?? null,
					toAccountId: row.toAccountId ?? null,
					amountCents: BigInt(row.amountCents),
					date: row.date,
					note: row.note ?? null,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.transfer.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}
		},
		// Uma remessa cheia são milhares de idas ao banco; o padrão de 5s do Prisma
		// estoura num primeiro sync grande.
		{ timeout: 30_000 }
	);

	res.json({ serverTime: new Date().toISOString(), applied, rejected });
};

/**
 * Diz se a conta já tem qualquer dado do usuário.
 *
 * É o que decide o primeiro login: conta vazia recebe os dados locais direto, conta com
 * histórico faz o app perguntar antes de mesclar ou descartar. As categorias padrão não
 * contam — toda conta nasce com elas.
 */
export const getSyncStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const userId = req.userId;

	const [transactions, recurringTransactions, budgets, customCategories] = await Promise.all([
		prisma.transaction.count({ where: { userId, deletedAt: null } }),
		prisma.recurringTransaction.count({ where: { userId, deletedAt: null } }),
		prisma.budget.count({ where: { userId, deletedAt: null } }),
		prisma.category.count({
			where: { userId, deletedAt: null, id: { notIn: [...DEFAULT_CATEGORY_IDS] } },
		}),
	]);

	res.json({
		hasData: transactions + recurringTransactions + budgets + customCategories > 0,
		counts: { transactions, recurringTransactions, budgets, customCategories },
	});
};
