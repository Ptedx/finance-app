import type { Account } from '../database/schema';

/**
 * "Saldo não informado" (SPD-114).
 *
 * Quando a captura cria a conta sozinha, ela nasce com saldo 0 e âncora na véspera da
 * compra (`newAccountDraft` em `accountResolver`): o app não tem como saber quanto havia
 * no banco. Sem aviso, o usuário só descobria que o saldo estava errado depois. O selo fica
 * na conta até ele definir o saldo ou dispensar. Puro e testado.
 *
 * Sem coluna nova, a conta se reconhece pelo que a captura grava ao criá-la — a mesma
 * assinatura do reparo das contas fantasma (`repairPhantomAppAccounts`), mais a posição:
 *
 * - ligada a um app (`packageName`) e sem extrato (`accountKey`): o extrato traz o saldo;
 * - âncora zerada: definir o saldo põe ali o valor de ontem (`setAccountBalanceToday`), e o
 *   selo some sozinho, em qualquer aparelho, assim que o sync traz a âncora nova;
 * - nome igual ao do banco: é o nome que a captura dá. Renomeada, o usuário já mexeu nela;
 * - `sortOrder` 0: a captura cria sempre em 0, e o formulário cria na posição das contas
 *   que já havia (`accounts.length`).
 *
 * A conta cadastrada à mão com saldo zero nasce sem app e não ganha selo. Se a captura a
 * adotar depois (`resolveAccountForNotification`, "adopted"), ela ganha o app, mas para
 * bater com o resto precisaria ter o nome igual ao do banco **e** ter sido a primeira conta
 * do app — o caso raro em que o selo aparece por engano, e o "Dispensar" resolve.
 *
 * Só contas: o cartão tem o "valor a pagar agora" na tela dele, e a fatura é outra conta.
 */
export const isBalanceNeverInformed = (
	account: Pick<Account, 'kind' | 'packageName' | 'accountKey' | 'openingBalanceCents' | 'bankName' | 'name' | 'sortOrder'>
): boolean =>
	account.kind !== 'credit_card' &&
	account.packageName !== null &&
	account.accountKey === null &&
	account.openingBalanceCents === 0 &&
	account.bankName !== null &&
	account.name === account.bankName &&
	account.sortOrder === 0;

/**
 * Se a linha da conta mostra o selo: nunca informado, viva, não arquivada e não dispensada
 * neste aparelho (`balanceUnsetDismissals`).
 */
export const showsBalanceUnset = (account: Account, dismissed: ReadonlySet<string>): boolean =>
	!account.archived && !account.deletedAt && !dismissed.has(account.id) && isBalanceNeverInformed(account);

export default { isBalanceNeverInformed, showsBalanceUnset };
