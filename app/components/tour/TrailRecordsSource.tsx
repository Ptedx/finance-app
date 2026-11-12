import type React from 'react';
import { useEffect, useRef } from 'react';
import { useAccounts } from '../../contexts/AccountsContext';
import { useCaptures } from '../../contexts/CapturesContext';
import { useTransactions } from '../../contexts/TransactionsContext';
import type { Account } from '../../database/schema';
import { feedOwnerOf } from '../../utils/accountBinding';
import { showsBalanceUnset } from '../../utils/balanceUnset';
import { getDismissedBalanceUnset } from '../../utils/balanceUnsetDismissals';
import { planBusinessFeed } from '../../utils/businessFeed';
import type { TrailRecords } from '../../utils/trails';
import { useTour } from './TourContext';

/**
 * O que as trilhas (SPD-131) sabem dos dados do usuário: qual conta, cartão ou lançamento
 * cada tela abre (o primeiro da lista) e o que existe (há o que revisar, a captura existe
 * neste aparelho). Só lê: a trilha nunca cria um registro para ter o que mostrar.
 *
 * Fica separado do `TourProvider` de propósito: o provider não depende dos contextos de dados
 * (nem os testes do guia). Não desenha nada; só se inscreve no guia. Mora no `_layout` raiz,
 * dentro dos providers de dados.
 */

const ids = (accounts: readonly Account[]) => accounts.map((account) => ({ id: account.id }));

const TrailRecordsSource: React.FC = () => {
	const tour = useTour();
	const { accounts, creditCards, debitCards } = useAccounts();
	const { transactions } = useTransactions();
	const { pending, supported } = useCaptures();
	const latest = useRef({ accounts, creditCards, debitCards, transactions, pending, supported });
	latest.current = { accounts, creditCards, debitCards, transactions, pending, supported };

	useEffect(() => {
		if (!tour) return;
		return tour.setTrailRecords(async (): Promise<TrailRecords> => {
			const {
				accounts: all,
				creditCards: cards,
				debitCards: debit,
				transactions: entries,
				pending: queue,
				supported: capture,
			} = latest.current;
			// As contas que a tela de Contas lista (cartão de crédito tem tela própria): as ativas
			// primeiro, na ordem do app.
			const live = all.filter((account) => account.kind !== 'credit_card' && !account.deletedAt);
			const accountList = [
				...live.filter((account) => !account.archived),
				...live.filter((account) => account.archived),
			];
			const dismissed = await getDismissedBalanceUnset().catch(() => new Set<string>());
			return {
				account: ids(accountList),
				capturedAccount: ids(
					accountList.filter((account) => showsBalanceUnset(account, dismissed))
				),
				feedAccount: ids(accountList.filter((account) => feedOwnerOf(all, account) !== null)),
				businessAccount: ids(
					accountList.filter((account) => planBusinessFeed(all, account.id) !== null)
				),
				card: ids(cards),
				cardNoClosing: ids(cards.filter((card) => card.closingDay === null)),
				otherCard: cards.length >= 2 ? ids(cards) : [],
				debitCard: debit.map((card) => ({ accountId: card.account.id, last4: card.last4 })),
				transaction: entries.slice(0, 1).map((entry) => ({ id: entry.id })),
				pending: queue.length > 0 ? [{}] : [],
				capture: capture ? [{}] : [],
			};
		});
	}, [tour]);

	return null;
};

export default TrailRecordsSource;
