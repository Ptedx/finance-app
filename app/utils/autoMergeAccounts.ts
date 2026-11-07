import { type Account, defaultRoleFor } from '../database/schema';
import { accountPairKey, duplicateAccountPairs } from './accountBinding';
import { isBalanceNeverInformed } from './balanceUnset';

/**
 * Juntar sozinho a ficha duplicada vazia (SPD-116, DEC-36 Q4).
 *
 * O aviso "Duas contas do mesmo banco" (`duplicateAccountPairs`) pede ao usuário que escolha
 * qual ficha fica. Quando uma das duas está **totalmente vazia e nunca foi editada**, não há o
 * que escolher: ela vai para a outra pelo `mergeAccounts` de sempre, e a tela só avisa
 * "Juntamos X em Y". Nos outros casos o aviso continua como está. Puro e testado.
 *
 * Sem coluna nova, "nunca editada" se lê pela assinatura que a captura grava ao criar a conta
 * (`newAccountDraft` em `accountResolver`, a mesma do selo "Saldo não informado",
 * `isBalanceNeverInformed`), mais o que o formulário mudaria:
 *
 * - ligada a um app e sem extrato, saldo de abertura 0, nome igual ao do banco, `sortOrder` 0;
 * - conta corrente no papel padrão, sem final, sem cartões nomeados, sem envelope, sem
 *   rendimento e sem finalidade de reserva;
 * - o selo "Saldo não informado" não foi dispensado neste aparelho (dispensar é dizer "o
 *   saldo é esse mesmo").
 *
 * "Totalmente vazia" é nada ligado a ela: nenhum lançamento (parcela é lançamento), nenhuma
 * transferência, nenhuma captura viva (pendente, confirmada ou descartada, tanto faz), nenhuma
 * conta a pagar e nenhuma dívida. A ligação com o extrato já ficou de fora pela assinatura.
 *
 * A ficha cadastrada à mão nunca junta sozinha: o nome foi o usuário que deu, e uma PJ recém
 * cadastrada com o saldo em branco seria engolida pela PF. Como a ficha solta do par
 * (`loose`) é sempre a sem app, na prática quem junta sozinha é a ficha que a captura criou e
 * que ficou sem nada — a compra que a criou foi para a outra conta na revisão, ou a captura foi
 * podada. Ela vai para a outra, que ganha o app (`mergeAccounts` leva `packageName`), e o
 * que o banco avisar passa a cair lá.
 */

/** O que está ligado a uma conta, contado no banco. */
export interface AccountLinks {
	transactions: number;
	transfers: number;
	captures: number;
	bills: number;
	debts: number;
}

/** A ficha tem a cara de quando a captura a criou: ninguém mexeu nela. */
export const looksUntouched = (account: Account): boolean =>
	!account.deletedAt &&
	!account.archived &&
	isBalanceNeverInformed(account) &&
	account.kind === 'checking' &&
	account.role === defaultRoleFor('checking') &&
	account.last4 === null &&
	account.cardNames === null &&
	account.envelopeMonthlyCents === null &&
	(account.yieldCdiBp ?? null) === null &&
	(account.reservePurpose ?? null) === null;

/**
 * Totalmente vazia e nunca editada. `links` nulo é "não deu para contar": na dúvida, não é
 * vazia.
 */
export const isEmptyUntouched = (account: Account, links: AccountLinks | null, balanceUnsetDismissed: boolean): boolean =>
	looksUntouched(account) &&
	!balanceUnsetDismissed &&
	links !== null &&
	links.transactions === 0 &&
	links.transfers === 0 &&
	links.captures === 0 &&
	links.bills === 0 &&
	links.debts === 0;

/** Uma junção a fazer sozinha: `from` (a vazia) vai para `into`. */
export interface AutoMerge {
	from: Account;
	into: Account;
}

/**
 * As fichas que vale contar no banco: as que têm a assinatura e estão num par de duplicadas.
 * Sem nenhuma, quem dispara não precisa ler mais nada.
 */
export const autoMergeCandidates = (accounts: Account[]): Account[] => {
	const paired = new Set(duplicateAccountPairs(accounts).flatMap((pair) => [pair.fed.id, pair.loose.id]));
	return accounts.filter((account) => paired.has(account.id) && looksUntouched(account));
};

/**
 * Os pares do aviso de duplicadas em que **exatamente uma** ficha está vazia (`emptyIds`,
 * decidido por `isEmptyUntouched`). Ficam de fora, sempre:
 *
 * - o par que o usuário disse serem contas diferentes (`distinct`, SPD-072);
 * - o par com a conta que recebe os avisos da PJ (`businessFed`, SPD-074);
 * - cartão de crédito: os cartões duplicados têm o fluxo próprio (SPD-097);
 * - as duas vazias: não há critério para dizer qual fica, e o aviso pergunta. Com a
 *   assinatura de hoje isso nem acontece (a ficha solta não tem app), mas a regra não depende
 *   disso.
 */
export const planAutoMerges = (
	accounts: Account[],
	emptyIds: ReadonlySet<string>,
	distinct: readonly string[] = [],
	businessFed: readonly string[] = []
): AutoMerge[] =>
	duplicateAccountPairs(accounts, distinct, businessFed).flatMap((pair): AutoMerge[] => {
		const { fed, loose } = pair;
		if (fed.kind === 'credit_card' || loose.kind === 'credit_card') return [];
		if (businessFed.includes(fed.id) || businessFed.includes(loose.id)) return [];
		if (distinct.includes(accountPairKey(fed.id, loose.id))) return [];
		const fedEmpty = emptyIds.has(fed.id);
		const looseEmpty = emptyIds.has(loose.id);
		if (fedEmpty === looseEmpty) return [];
		return [fedEmpty ? { from: fed, into: loose } : { from: loose, into: fed }];
	});

export default { looksUntouched, isEmptyUntouched, autoMergeCandidates, planAutoMerges };
