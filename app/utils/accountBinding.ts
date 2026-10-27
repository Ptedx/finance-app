/**
 * Qual ficha do app é a conta de verdade do banco.
 *
 * Uma conta do banco pode acabar com duas fichas aqui: a que o usuário cadastrou à mão e
 * a que a primeira notificação criou. As duas mostram metade do dinheiro, e as compras
 * novas caem só numa delas — a que está ligada ao app do banco (`packageName`) ou ao
 * extrato (`accountKey`). O vínculo é invisível na tela, então o usuário vê a compra
 * "indo para a conta errada" sem ter como mudar.
 *
 * Aqui ficam as duas respostas que as telas precisam: quem recebe as compras do app
 * daquele banco, e quais fichas parecem ser a mesma conta. Puro e testado.
 */

import type { Account } from '../database/schema';
import { sameBank } from './notificationTarget';

/** Contas vivas do mesmo lado (conta corrente x cartão) e do mesmo banco. */
const siblingsOf = (accounts: Account[], account: Account): Account[] =>
	account.bankName === null
		? []
		: accounts.filter(
				(other) =>
					other.id !== account.id &&
					!other.deletedAt &&
					!other.archived &&
					(other.kind === 'credit_card') === (account.kind === 'credit_card') &&
					sameBank(other.bankName, account.bankName)
			);

/** Ligada a uma origem: o app do banco ou o extrato. É ela que recebe o que vem. */
export const isFed = (account: Account): boolean =>
	account.packageName !== null || account.accountKey !== null;

/**
 * Quem recebe hoje as compras do app deste banco: a própria conta, outra ficha do mesmo
 * banco, ou `null` quando nenhuma está ligada ao app (nada foi capturado ainda) ou
 * quando há mais de uma ligada — aí não existe "a" conta do banco.
 */
export const feedOwnerOf = (accounts: Account[], account: Account): Account | null => {
	if (account.packageName !== null) return account;
	const bound = siblingsOf(accounts, account).filter((other) => other.packageName !== null);
	return bound.length === 1 ? bound[0] : null;
};

/**
 * A chave de um par de fichas, igual nas duas ordens. Guarda a resposta "são contas
 * diferentes" do aviso de duplicadas (SPD-072).
 */
export const accountPairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface DuplicateAccounts {
	/** A ficha que recebe o que o banco avisa. */
	fed: Account;
	/** A outra ficha do mesmo banco, cadastrada à mão e sem origem ligada. */
	loose: Account;
}

/**
 * Fichas que parecem ser a mesma conta do banco: duas, do mesmo banco e do mesmo lado,
 * uma ligada a uma origem e a outra não.
 *
 * Com três ou mais fichas do banco a dúvida é real — PF, PJ e conjunta existem — e o app
 * não chuta: não sugere nada. Só o par exato vira sugestão de juntar, porque aí as duas
 * metades do mesmo dinheiro estão à vista.
 *
 * O par que o usuário já disse serem contas diferentes (`distinct`, chaves de
 * `accountPairKey`) não volta: PF e PJ do mesmo banco, uma só ligada ao app, é o caso comum.
 */
export const duplicateAccountPairs = (
	accounts: Account[],
	distinct: readonly string[] = []
): DuplicateAccounts[] => {
	const live = accounts.filter((account) => !account.deletedAt && !account.archived);
	const pairs: DuplicateAccounts[] = [];
	const seen = new Set<string>();

	for (const account of live) {
		if (seen.has(account.id)) continue;
		const group = [account, ...siblingsOf(live, account)];
		for (const member of group) seen.add(member.id);
		if (group.length !== 2) continue;

		const fed = group.filter(isFed);
		const loose = group.filter((member) => !isFed(member));
		if (fed.length !== 1 || loose.length !== 1) continue;
		if (distinct.includes(accountPairKey(fed[0].id, loose[0].id))) continue;
		pairs.push({ fed: fed[0], loose: loose[0] });
	}

	return pairs;
};

export default { isFed, feedOwnerOf, accountPairKey, duplicateAccountPairs };
