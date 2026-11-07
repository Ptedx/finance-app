import type { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { deleteAccount } from '../domain/accountDeletion.js';
import {
	WIPED_PREFERENCE_KEYS,
	WIPED_USER_RELATIONS,
	type WipedUserRelation,
} from '../domain/dataWipe.js';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { forbidden, unauthorized } from '../middleware/error.js';
import { deleteAccountSchema, updateProfileSchema } from '../schemas/auth.js';

const SELECT_PUBLIC = {
	id: true,
	email: true,
	name: true,
	baseCurrency: true,
	language: true,
	createdAt: true,
} as const;

export const getMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const user = await prisma.user.findUnique({
		where: { id: req.userId },
		select: SELECT_PUBLIC,
	});

	// O token é válido mas a conta sumiu (apagada em outro aparelho, por exemplo).
	// 401 e não 404: o cliente precisa derrubar a sessão, não mostrar "não encontrado".
	if (!user) {
		throw unauthorized('Conta não encontrada.', 'account_gone');
	}

	res.json({ user });
};

/**
 * Atualiza moeda, idioma e nome do perfil.
 *
 * Essas três não passam pelo delta sync das tabelas: são campos únicos do usuário, sem
 * histórico nem conflito de linha, e o último a escrever ganha por definição.
 */
export const updateMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const body = updateProfileSchema.parse(req.body);

	// Só as chaves realmente enviadas chegam ao update: passar `name: undefined` seria
	// interpretado pelo Prisma como "não mexa", mas o tipo o rejeita, e montar o objeto
	// explicitamente deixa a intenção — atualização parcial — visível.
	const user = await prisma.user.update({
		where: { id: req.userId },
		data: {
			...(body.name !== undefined ? { name: body.name } : {}),
			...(body.baseCurrency !== undefined ? { baseCurrency: body.baseCurrency } : {}),
			...(body.language !== undefined ? { language: body.language } : {}),
		},
		select: SELECT_PUBLIC,
	});

	res.json({ user });
};

/**
 * Como apagar cada tabela que sai inteira no "apagar meus dados".
 *
 * O tipo exige uma entrada para cada relação `wipe` de `USER_RELATION_FATE`
 * (`domain/dataWipe.ts`), e o teste de lá exige que toda relação do `User` tenha destino:
 * uma tabela nova não compila até alguém decidir se ela sai ou fica.
 *
 * Nenhuma dessas tabelas tem FK para outra — `accountId`, `transactionId`, `category`
 * não são chaves estrangeiras, só a de `userId` é —, então a ordem não importa.
 */
const WIPE_RELATION: Record<
	WipedUserRelation,
	(tx: Prisma.TransactionClient, userId: string) => Promise<unknown>
> = {
	transactions: (tx, userId) => tx.transaction.deleteMany({ where: { userId } }),
	recurringTransactions: (tx, userId) => tx.recurringTransaction.deleteMany({ where: { userId } }),
	budgets: (tx, userId) => tx.budget.deleteMany({ where: { userId } }),
	transfers: (tx, userId) => tx.transfer.deleteMany({ where: { userId } }),
	accounts: (tx, userId) => tx.account.deleteMany({ where: { userId } }),
	retirementGoals: (tx, userId) => tx.retirementGoal.deleteMany({ where: { userId } }),
	debts: (tx, userId) => tx.debt.deleteMany({ where: { userId } }),
	reserveGoals: (tx, userId) => tx.reserveGoal.deleteMany({ where: { userId } }),
	bills: (tx, userId) => tx.bill.deleteMany({ where: { userId } }),
	captures: (tx, userId) => tx.capture.deleteMany({ where: { userId } }),
	diagnosticEvents: (tx, userId) => tx.diagnosticEvent.deleteMany({ where: { userId } }),
	assets: (tx, userId) => tx.asset.deleteMany({ where: { userId } }),
	liabilities: (tx, userId) => tx.liability.deleteMany({ where: { userId } }),
	netWorthSnapshots: (tx, userId) => tx.netWorthSnapshot.deleteMany({ where: { userId } }),
	goals: (tx, userId) => tx.goal.deleteMany({ where: { userId } }),
	portfolioAllocations: (tx, userId) => tx.portfolioAllocation.deleteMany({ where: { userId } }),
	passiveIncomes: (tx, userId) => tx.passiveIncome.deleteMany({ where: { userId } }),
};

/**
 * "Apagar todos os dados" (DEC-35): apaga de verdade, no servidor, o dado do usuário — e
 * por isso em todos os aparelhos.
 *
 * Ficam a conta, as sessões, as categorias, as regras aprendidas e as preferências de
 * configuração; o porquê de cada tabela está em `domain/dataWipe.ts`. Tudo numa transação:
 * um apagamento pela metade deixaria lançamentos sem conta e a marca dizendo que nada
 * existe.
 *
 * A marca `dataWipedAt` é gravada **antes** de apagar, e não depois: o UPDATE trava a
 * linha do usuário, e o push trava a mesma linha (FOR SHARE) antes de olhar a marca. Assim
 * uma remessa em andamento termina antes de o apagamento começar — e o que ela gravou é
 * apagado junto —, e uma que chega no meio espera e volta com 409.
 */
export const wipeMyData = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const userId = req.userId;
	// Relógio do servidor, não do aparelho: é contra esta marca que todo push é comparado.
	const dataWipedAt = new Date();

	await prisma.$transaction(
		async (tx) => {
			const marked = await tx.user.updateMany({ where: { id: userId }, data: { dataWipedAt } });
			// Mesmo caso do `getMe`: token válido, conta que não existe mais.
			if (marked.count === 0) throw unauthorized('Conta não encontrada.', 'account_gone');

			for (const relation of WIPED_USER_RELATIONS) {
				await WIPE_RELATION[relation](tx, userId);
			}

			// Das preferências, só as que apontam para contas (`WIPED_PREFERENCE_KEYS`). A
			// linha sai inteira, sem lápide: a lápide guardaria o último valor.
			await tx.preference.deleteMany({
				where: { userId, id: { in: [...WIPED_PREFERENCE_KEYS] } },
			});
		},
		// Uma conta com anos de lançamentos e capturas é muita linha para os 5 s padrão.
		{ timeout: 30_000 }
	);

	res.json({ dataWipedAt: dataWipedAt.toISOString() });
};

/**
 * Apaga a conta e tudo dela (DEC-35; a Google Play exige que dê para fazer isso no app).
 *
 * Pede a senha atual: um aparelho esquecido desbloqueado não pode apagar anos de dados com
 * um toque. O resto — a cascata, a corrida com outro pedido — está em
 * `domain/accountDeletion.ts`.
 *
 * Senha errada é 403, e não 401: o app trata todo 401 (fora o `token_expired`) como sessão
 * morta e sairia da conta de quem só digitou errado. A comparação é o `bcrypt.compare` do
 * login: o custo vem do próprio hash guardado, não há número de rounds a repetir aqui.
 *
 * Um push em andamento trava a linha do usuário (FOR SHARE, ver `pushData`); o DELETE
 * espera ele terminar e apaga o que ele gravou. Um que chega depois leva 401
 * `account_gone`.
 */
export const deleteMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const { password } = deleteAccountSchema.parse(req.body);

	const outcome = await deleteAccount(prisma, req.userId, password, bcrypt.compare);

	if (outcome === 'wrong_password') {
		throw forbidden('Senha incorreta.', 'wrong_password');
	}
	// Mesmo caso do `getMe`: token válido, conta que não existe mais.
	if (outcome === 'account_gone') {
		throw unauthorized('Conta não encontrada.', 'account_gone');
	}

	res.status(204).send();
};
