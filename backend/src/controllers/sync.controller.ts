import type { Response } from 'express';
import { DEFAULT_CATEGORIES, FALLBACK_CATEGORY_ID } from '../domain/defaultCategories.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
	type BudgetPayload,
	type CategoryPayload,
	pullQuerySchema,
	pushBodySchema,
	type RecurringTransactionPayload,
	type TransactionPayload,
} from '../schemas/sync.js';

/**
 * Sync incremental, last-write-wins por linha.
 *
 * Os dois lados falam o mesmo formato e nenhum dos dois é "a verdade": o servidor é só
 * o ponto de encontro. Quem tem o `updatedAt` mais recente vence, e apagar é escrever
 * `deletedAt` — nunca remover a linha, senão um aparelho que estava offline reenviaria
 * o registro achando que ele é novo.
 */

type Collection = 'categories' | 'transactions' | 'recurringTransactions' | 'budgets';

const DEFAULT_CATEGORY_IDS = DEFAULT_CATEGORIES.map((category) => category.id);

interface RejectedRow {
	collection: Collection;
	id: string;
	reason: 'stale';
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

	const [categories, transactions, recurringTransactions, budgets] = await Promise.all([
		prisma.category.findMany(page(cursor.categories)),
		prisma.transaction.findMany(page(cursor.transactions)),
		prisma.recurringTransaction.findMany(page(cursor.recurringTransactions)),
		prisma.budget.findMany(page(cursor.budgets)),
	]);

	const changes = {
		categories: categories.map((row) => ({
			id: row.id,
			name: row.name,
			color: row.color,
			icon: row.icon,
			type: row.type,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		transactions: transactions.map((row) => ({
			id: row.id,
			amountCents: row.amountCents,
			category: row.category,
			date: row.date,
			note: row.note,
			isIncome: row.isIncome,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		recurringTransactions: recurringTransactions.map((row) => ({
			id: row.id,
			amountCents: row.amountCents,
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
			amountCents: row.amountCents,
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
		transactions: advance(transactions, cursor.transactions),
		recurringTransactions: advance(recurringTransactions, cursor.recurringTransactions),
		budgets: advance(budgets, cursor.budgets),
	};

	res.json({
		serverTime: new Date().toISOString(),
		/** O cliente guarda isto e devolve no próximo pull. */
		cursor: nextCursor,
		/** Verdadeiro enquanto houver mais para buscar: o cliente repete o pull. */
		hasMore: [categories, transactions, recurringTransactions, budgets].some(
			(rows) => rows.length === env.syncPageSize
		),
		changes,
	});
};

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Aplica uma linha recebida, a menos que a versão do servidor seja mais nova.
 *
 * O empate (`>=`) é resolvido a favor de quem envia: o custo de reaplicar uma escrita
 * idêntica é zero, enquanto recusá-la deixaria o aparelho tentando para sempre.
 */
const applyRow = async <T extends { id: string; updatedAt: string }>(
	row: T,
	current: { updatedAt: Date } | null,
	write: () => Promise<unknown>
): Promise<boolean> => {
	if (current && current.updatedAt > new Date(row.updatedAt)) return false;

	await write();
	return true;
};

export const pushData = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const { changes } = pushBodySchema.parse(req.body);
	const userId = req.userId;

	const rejected: RejectedRow[] = [];
	let applied = 0;

	await prisma.$transaction(
		async (tx) => {
			// --- Categorias primeiro ---------------------------------------------
			// Um lançamento pode vir na mesma remessa que a categoria que ele usa; a
			// validação logo abaixo precisa enxergar essa categoria já gravada.
			for (const row of changes.categories as CategoryPayload[]) {
				const current = await tx.category.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				const data = {
					name: row.name,
					color: row.color,
					icon: row.icon,
					type: row.type,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				const wrote = await applyRow(row, current, () =>
					tx.category.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...data },
						update: data,
					})
				);

				wrote ? (applied += 1) : rejected.push({ collection: 'categories', id: row.id, reason: 'stale' });
			}

			// Quais categorias este perfil conhece, para reancorar o que aponta para o
			// vazio. Inclui as apagadas: um lançamento numa categoria removida vai para
			// 'uncategorized' por decisão do app, não por acidente do sync.
			const knownCategories = new Set(
				(await tx.category.findMany({ where: { userId }, select: { id: true } })).map((c) => c.id)
			);

			/**
			 * Aparelhos não sincronizam em ordem: o celular pode enviar um lançamento
			 * numa categoria que o tablet criou e ainda não subiu. Recusar seria perder
			 * o lançamento; guardá-lo como está deixaria um id órfão. Reancorar em
			 * 'uncategorized' é o que o próprio app faz ao apagar uma categoria.
			 */
			const resolveCategory = (id: string): string =>
				knownCategories.has(id) ? id : FALLBACK_CATEGORY_ID;

			// --- Lançamentos ------------------------------------------------------
			for (const row of changes.transactions as TransactionPayload[]) {
				const current = await tx.transaction.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				const data = {
					amountCents: row.amountCents,
					category: resolveCategory(row.category),
					date: row.date,
					note: row.note ?? null,
					isIncome: row.isIncome,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				const wrote = await applyRow(row, current, () =>
					tx.transaction.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...data },
						update: data,
					})
				);

				wrote
					? (applied += 1)
					: rejected.push({ collection: 'transactions', id: row.id, reason: 'stale' });
			}

			// --- Recorrências -----------------------------------------------------
			for (const row of changes.recurringTransactions as RecurringTransactionPayload[]) {
				const current = await tx.recurringTransaction.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				const data = {
					amountCents: row.amountCents,
					isIncome: row.isIncome,
					note: row.note ?? null,
					category: resolveCategory(row.category),
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

				const wrote = await applyRow(row, current, () =>
					tx.recurringTransaction.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...data },
						update: data,
					})
				);

				wrote
					? (applied += 1)
					: rejected.push({ collection: 'recurringTransactions', id: row.id, reason: 'stale' });
			}

			// --- Orçamentos -------------------------------------------------------
			for (const row of changes.budgets as BudgetPayload[]) {
				const current = await tx.budget.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				const data = {
					year: row.year,
					month: row.month,
					amountCents: row.amountCents,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				const wrote = await applyRow(row, current, () =>
					tx.budget.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...data },
						update: data,
					})
				);

				wrote ? (applied += 1) : rejected.push({ collection: 'budgets', id: row.id, reason: 'stale' });
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
