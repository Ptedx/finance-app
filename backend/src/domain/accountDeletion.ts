/**
 * Apagar a conta (DEC-35): a Google Play exige que dê para apagar a conta de dentro do app.
 *
 * Diferente do "apagar meus dados" (`dataWipe.ts`), aqui sai tudo, a conta inclusive, e o
 * mecanismo é o próprio banco: toda tabela com `userId` tem FK para `users` com
 * `ON DELETE CASCADE`, e um único `DELETE` da linha do usuário apaga o resto no mesmo
 * comando — portanto na mesma transação. O teste (`__tests__/accountDeletion.test.ts`) lê
 * o schema.prisma e as migrações e falha se uma relação do `User` não tiver cascata: uma
 * tabela nova sem ela deixaria linhas órfãs, ou travaria o apagamento de quem a usou.
 *
 * O banco e a comparação de senha chegam por parâmetro, e não pelo `lib/prisma.js` nem pelo
 * bcrypt: assim os testes passam um falso. O `PrismaClient` satisfaz `AccountDeletionDb`.
 */

/** O `code` da senha errada. O app o reconhece por aqui, não pela mensagem. */
export const WRONG_PASSWORD_CODE = 'wrong_password';

/**
 * O `code` do token válido de uma conta que não existe mais. Vai num 401, para o app
 * derrubar a sessão; o `requireAuth` e o `getMe` usam o mesmo.
 */
export const ACCOUNT_GONE_CODE = 'account_gone';

export interface AccountDeletionDb {
	user: {
		findUnique(args: {
			where: { id: string };
			select: { passwordHash: true };
		}): PromiseLike<{ passwordHash: string } | null>;
		deleteMany(args: { where: { id: string } }): PromiseLike<{ count: number }>;
	};
}

export type AccountDeletionOutcome =
	| 'deleted'
	| typeof WRONG_PASSWORD_CODE
	| typeof ACCOUNT_GONE_CODE;

/**
 * Confere a senha e, se ela bate, apaga a conta de `userId` (o do token, nunca o do corpo).
 *
 * `deleteMany` e não `delete`: dois pedidos simultâneos (um toque duplo, dois aparelhos)
 * passam os dois pela senha, e o segundo `DELETE` não acha a linha. Com `delete` isso seria
 * um P2025 e um 500; aqui vira `account_gone`, que o app já trata.
 */
export const deleteAccount = async (
	db: AccountDeletionDb,
	userId: string,
	password: string,
	passwordMatches: (password: string, passwordHash: string) => Promise<boolean>
): Promise<AccountDeletionOutcome> => {
	const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
	if (user === null) return ACCOUNT_GONE_CODE;

	if (!(await passwordMatches(password, user.passwordHash))) return WRONG_PASSWORD_CODE;

	const { count } = await db.user.deleteMany({ where: { id: userId } });
	return count === 0 ? ACCOUNT_GONE_CODE : 'deleted';
};
