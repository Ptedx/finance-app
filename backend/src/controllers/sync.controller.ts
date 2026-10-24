import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import type { z } from 'zod';
import { resolveBudgetPeriod } from '../domain/budgetConflict.js';
import {
	captureColumns,
	captureToWire,
	merchantRuleColumns,
	merchantRuleToWire,
} from '../domain/captureWire.js';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
	accountSchema,
	budgetSchema,
	captureSchema,
	categorySchema,
	debtSchema,
	merchantRuleSchema,
	pullQuerySchema,
	pushBodySchema,
	recurringTransactionSchema,
	reserveGoalSchema,
	retirementGoalSchema,
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
 *
 * O v19 acrescentou outras duas, `captures` e `merchantRules`, pela mesma regra: toda
 * coleção é opcional nas duas direções, então um app que não as conhece não quebra e um
 * push sem elas é aceito.
 */

type Collection =
	| 'categories'
	| 'accounts'
	| 'transactions'
	| 'recurringTransactions'
	| 'budgets'
	| 'transfers'
	| 'retirementGoals'
	| 'debts'
	| 'reserveGoals'
	| 'captures'
	| 'merchantRules';

const DEFAULT_CATEGORY_IDS = DEFAULT_CATEGORIES.map((category) => category.id);

/**
 * Por que uma linha não foi gravada. Espelha `RejectedRow` em `app/sync/types.ts`.
 *
 * - `stale`: o servidor já tem uma versão mais nova.
 * - `unknown_category`: o lançamento aponta para uma categoria que este perfil não
 *   conhece. Nada é gravado; `category` diz qual faltou, e quem enviou a reenvia junto.
 * - `invalid`: a linha não passou na validação da sua coleção, ou o banco a recusou na
 *   gravação; `message` diz por quê. A remessa segue sem ela — ver `writeRowIsolated`.
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

	const [
		categories,
		accounts,
		transactions,
		recurringTransactions,
		budgets,
		transfers,
		retirementGoals,
		debts,
		reserveGoals,
		captures,
		merchantRules,
	] = await Promise.all([
		prisma.category.findMany(page(cursor.categories)),
		prisma.account.findMany(page(cursor.accounts)),
		prisma.transaction.findMany(page(cursor.transactions)),
		prisma.recurringTransaction.findMany(page(cursor.recurringTransactions)),
		prisma.budget.findMany(page(cursor.budgets)),
		prisma.transfer.findMany(page(cursor.transfers)),
		prisma.retirementGoal.findMany(page(cursor.retirementGoals)),
		prisma.debt.findMany(page(cursor.debts)),
		prisma.reserveGoal.findMany(page(cursor.reserveGoals)),
		prisma.capture.findMany(page(cursor.captures)),
		prisma.merchantRule.findMany(page(cursor.merchantRules)),
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
			yieldCdiBp: row.yieldCdiBp,
			reservePurpose: row.reservePurpose === 'investment' ? 'investment' : null,
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
		reserveGoals: reserveGoals.map((row) => ({
			id: row.id,
			targetMonths: row.targetMonths,
			customMonthlyCostCents: row.customMonthlyCostCents === null ? null : Number(row.customMonthlyCostCents),
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		retirementGoals: retirementGoals.map((row) => ({
			id: row.id,
			targetMonthlyCents: Number(row.targetMonthlyCents),
			reinvestBp: row.reinvestBp,
			expectedYieldBp: row.expectedYieldBp,
			outsideCapitalCents: Number(row.outsideCapitalCents),
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		debts: debts.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			system: row.system,
			openingBalanceCents: Number(row.openingBalanceCents),
			openingBalanceDate: row.openingBalanceDate,
			installmentCents: Number(row.installmentCents),
			remainingAtOpening: row.remainingAtOpening,
			installmentsTotal: row.installmentsTotal,
			dueDay: row.dueDay,
			rateBp: row.rateBp,
			feeCents: Number(row.feeCents),
			adminFeeBp: row.adminFeeBp,
			accountId: row.accountId,
			category: row.category,
			archived: row.archived,
			sortOrder: row.sortOrder,
			updatedAt: row.updatedAt.toISOString(),
			deletedAt: iso(row.deletedAt),
		})),
		/**
		 * Capturas e regras aprendidas (v19). A tradução mora em `domain/captureWire.ts`:
		 * o `id` que viaja é o fingerprint, `postedAt`/`createdAt` vão verbatim e o
		 * `amountCents` sai de bigint para number — ver os comentários de lá.
		 */
		captures: captures.map(captureToWire),
		merchantRules: merchantRules.map(merchantRuleToWire),
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
		retirementGoals: advance(retirementGoals, cursor.retirementGoals),
		debts: advance(debts, cursor.debts),
		reserveGoals: advance(reserveGoals, cursor.reserveGoals),
		/**
		 * As duas chaves do v19 precisam sair aqui mesmo quando não houve nada para
		 * entregar: é por elas que o app sabe que este servidor conhece as capturas
		 * (`onlyKnownCollections`, em app/sync/types.ts). Faltando a chave, o app segura as
		 * linhas em vez de marcá-las como enviadas — que é o certo, mas a caixa de entrada
		 * ficaria sem sincronizar.
		 */
		captures: advance(captures, cursor.captures),
		merchantRules: advance(merchantRules, cursor.merchantRules),
	};

	res.json({
		serverTime: new Date().toISOString(),
		/** O cliente guarda isto e devolve no próximo pull. */
		cursor: nextCursor,
		/** Verdadeiro enquanto houver mais para buscar: o cliente repete o pull. */
		hasMore: [
			categories,
			accounts,
			transactions,
			recurringTransactions,
			budgets,
			transfers,
			retirementGoals,
			debts,
			reserveGoals,
			captures,
			merchantRules,
		].some((rows) => rows.length === env.syncPageSize),
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

/**
 * O que dizer ao aparelho quando o banco recusa uma linha. Só o código do Prisma, nunca
 * a mensagem: ela traz nome de índice, de tabela e às vezes um trecho do dado.
 */
const databaseRefusal = (error: unknown): string => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string'
		? `o banco recusou a linha (${code})`
		: 'o banco recusou a linha';
};

/**
 * Grava uma linha isolada por um SAVEPOINT, e devolve o motivo quando o banco recusa.
 *
 * No Postgres, um comando que falha aborta a **transação inteira**: um `try/catch` comum
 * não salvaria nada, porque todo comando seguinte morreria com "current transaction is
 * aborted". O SAVEPOINT é o que permite desfazer uma linha e seguir com as outras — é
 * ele que impede um único registro problemático de derrubar a remessa com 500 e travar o
 * sync daquele aparelho para sempre. O nome é fixo e o RELEASE é imediato: a remessa tem
 * milhares de linhas e savepoints acumulados custam memória na sessão.
 */
const writeRowIsolated = async (
	tx: Prisma.TransactionClient,
	write: () => Promise<void>
): Promise<string | null> => {
	await tx.$executeRawUnsafe('SAVEPOINT sync_row');
	try {
		await write();
		await tx.$executeRawUnsafe('RELEASE SAVEPOINT sync_row');
		return null;
	} catch (error) {
		await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sync_row');
		await tx.$executeRawUnsafe('RELEASE SAVEPOINT sync_row');
		console.warn('Sync: linha recusada pelo banco:', error);
		return databaseRefusal(error);
	}
};

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
	const retirementGoals = partitionRows('retirementGoals', changes.retirementGoals, retirementGoalSchema, rejected);
	const debts = partitionRows('debts', changes.debts, debtSchema, rejected);
	const reserveGoals = partitionRows('reserveGoals', changes.reserveGoals, reserveGoalSchema, rejected);
	const captures = partitionRows('captures', changes.captures, captureSchema, rejected);
	const merchantRules = partitionRows('merchantRules', changes.merchantRules, merchantRuleSchema, rejected);

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
					yieldCdiBp: row.yieldCdiBp ?? null,
					reservePurpose: row.reservePurpose ?? null,
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
			// Um orçamento vivo por mês é regra do banco, não do código: o índice parcial
			// `budgets_userId_year_month_live_key`. Dois ids para o mesmo mês chegam de
			// verdade — aparelho anônimo que depois entra numa conta que já tinha aquele
			// mês, ou dois aparelhos offline. O conflito é resolvido antes de gravar
			// (`resolveBudgetPeriod`), pelo mesmo last-write-wins do resto; o SAVEPOINT é
			// a rede embaixo, para uma corrida que escape disso não derrubar a remessa.
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

				// A outra linha viva daquele mês, se existir. Uma lápide que chega não
				// disputa nada, e nem vale a consulta.
				const live = data.deletedAt
					? null
					: await tx.budget.findFirst({
							where: { userId, year: row.year, month: row.month, deletedAt: null, id: { not: row.id } },
							select: { id: true, updatedAt: true },
						});

				const resolution = resolveBudgetPeriod(
					{ id: row.id, updatedAt: data.updatedAt, deletedAt: data.deletedAt },
					live
				);

				const refusal = await writeRowIsolated(tx, async () => {
					if (resolution.kind === 'tombstone_existing') {
						// A linha de lá é mais antiga: ela sai, e a lápide sobe para os
						// aparelhos que tinham aquele id.
						await tx.budget.update({
							where: { userId_id: { userId, id: resolution.id } },
							data: { deletedAt: resolution.at, updatedAt: resolution.at },
						});
					}

					// Quando é a linha que chegou que perde, ela entra **apagada**, com o
					// carimbo de quem venceu: o aparelho que a enviou recebe a lápide no
					// pull seguinte e os dois lados ficam com o mesmo orçamento vivo.
					const resolved =
						resolution.kind === 'tombstone_incoming'
							? { ...data, deletedAt: resolution.at, updatedAt: resolution.at }
							: data;

					await tx.budget.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...resolved },
						update: resolved,
					});
				});

				// Contado depois do SAVEPOINT: o que o rollback desfez não foi aplicado.
				if (refusal !== null) {
					rejected.push({ collection: 'budgets', id: row.id, reason: 'invalid', message: refusal });
					continue;
				}

				applied += resolution.kind === 'tombstone_existing' ? 2 : 1;
			}

			// --- Meta de aposentadoria -------------------------------------------
			for (const row of retirementGoals) {
				const current = await tx.retirementGoal.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'retirementGoals', id: row.id, reason: 'stale' });
					continue;
				}

				const data = {
					targetMonthlyCents: BigInt(row.targetMonthlyCents),
					reinvestBp: row.reinvestBp,
					expectedYieldBp: row.expectedYieldBp,
					outsideCapitalCents: BigInt(row.outsideCapitalCents),
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.retirementGoal.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// --- Meta da reserva de emergência -------------------------------------
			for (const row of reserveGoals) {
				const current = await tx.reserveGoal.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'reserveGoals', id: row.id, reason: 'stale' });
					continue;
				}

				const data = {
					targetMonths: row.targetMonths,
					customMonthlyCostCents: row.customMonthlyCostCents == null ? null : BigInt(row.customMonthlyCostCents),
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.reserveGoal.upsert({
					where: { userId_id: { userId, id: row.id } },
					create: { id: row.id, userId, ...data },
					update: data,
				});
				applied += 1;
			}

			// --- Dívidas ----------------------------------------------------------
			for (const row of debts) {
				const current = await tx.debt.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'debts', id: row.id, reason: 'stale' });
					continue;
				}

				const data = {
					name: row.name,
					kind: row.kind,
					system: row.system,
					openingBalanceCents: BigInt(row.openingBalanceCents),
					openingBalanceDate: row.openingBalanceDate,
					installmentCents: BigInt(row.installmentCents),
					remainingAtOpening: row.remainingAtOpening,
					installmentsTotal: row.installmentsTotal,
					dueDay: row.dueDay,
					rateBp: row.rateBp,
					feeCents: BigInt(row.feeCents ?? 0),
					adminFeeBp: row.adminFeeBp ?? null,
					accountId: row.accountId ?? null,
					category: row.category ?? null,
					archived: row.archived,
					sortOrder: row.sortOrder,
					updatedAt: new Date(row.updatedAt),
					deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
				};

				await tx.debt.upsert({
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

			// --- Capturas ---------------------------------------------------------
			// A caixa de entrada. O `id` que chega é o fingerprint da notificação, então
			// o mesmo aviso capturado em dois aparelhos cai na mesma linha e o
			// last-write-wins resolve: quem revisou por último manda. Uma lápide que
			// chega não é ressuscitada — `isStale` compara `updatedAt`, e apagar aqui é
			// escrever `deletedAt`, nunca remover a linha.
			//
			// `suggestedCategory` não é verificado contra as categorias conhecidas, ao
			// contrário de `Transaction.category`: é um palpite do parser, e devolver a
			// captura inteira em `rejected` por causa dele seria a perda de dado que esta
			// coleção existe para evitar. O app ignora o palpite enquanto a categoria não
			// chega. O mesmo vale para `accountId`, `transactionId` e `transferId`.
			for (const row of captures) {
				const current = await tx.capture.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'captures', id: row.id, reason: 'stale' });
					continue;
				}

				const data = captureColumns(row);

				// SAVEPOINT aqui, e não só nos orçamentos, por causa do texto cru: `title` e
				// `text` vêm da notificação sem passar por tratamento nenhum, e o Postgres
				// recusa um TEXT com byte NUL. Sem o isolamento, uma única notificação
				// esquisita derrubaria a remessa com 500 e travaria o sync daquele aparelho.
				const refusal = await writeRowIsolated(tx, async () => {
					await tx.capture.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...data },
						update: data,
					});
				});

				if (refusal !== null) {
					rejected.push({ collection: 'captures', id: row.id, reason: 'invalid', message: refusal });
					continue;
				}

				applied += 1;
			}

			// --- Regras aprendidas -------------------------------------------------
			// O `id` é a própria `merchantKey`, derivada do mesmo texto nos dois
			// aparelhos: duas aprendizagens do mesmo lugar convergem sem conflito de id.
			// `categoryId` também não é verificado — ver o comentário das capturas.
			for (const row of merchantRules) {
				const current = await tx.merchantRule.findUnique({
					where: { userId_id: { userId, id: row.id } },
					select: { updatedAt: true },
				});

				if (isStale(current, row)) {
					rejected.push({ collection: 'merchantRules', id: row.id, reason: 'stale' });
					continue;
				}

				const data = merchantRuleColumns(row);

				// A chave vem de texto de notificação normalizado; mesmo isolamento das
				// capturas, pelo mesmo motivo.
				const refusal = await writeRowIsolated(tx, async () => {
					await tx.merchantRule.upsert({
						where: { userId_id: { userId, id: row.id } },
						create: { id: row.id, userId, ...data },
						update: data,
					});
				});

				if (refusal !== null) {
					rejected.push({ collection: 'merchantRules', id: row.id, reason: 'invalid', message: refusal });
					continue;
				}

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
