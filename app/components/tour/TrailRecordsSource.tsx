import type React from 'react';
import { useContext, useEffect, useRef } from 'react';
import { useAccounts } from '../../contexts/AccountsContext';
import BillsContext from '../../contexts/BillsContext';
import { useCaptures } from '../../contexts/CapturesContext';
import DebtsContext from '../../contexts/DebtsContext';
import { useTransactions } from '../../contexts/TransactionsContext';
import type { Account, Bill, Debt } from '../../database/schema';
import { feedOwnerOf } from '../../utils/accountBinding';
import { showsBalanceUnset } from '../../utils/balanceUnset';
import { getDismissedBalanceUnset } from '../../utils/balanceUnsetDismissals';
import { canToggleActive } from '../../utils/billRules';
import { planBusinessFeed } from '../../utils/businessFeed';
import { todayISO } from '../../utils/dateUtils';
import { debtStateOn, termsOf } from '../../utils/debt';
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

/**
 * As dívidas na ordem do Patrimônio (SPD-131b): as que ainda estão sendo pagas primeiro, as
 * quitadas depois — a tela de uma quitada não tem veredito nem "Simular" para mostrar.
 */
export const debtRecords = (debts: readonly Debt[], today: string) => {
	const paidOff = (debt: Debt) => debt.archived || debtStateOn(termsOf(debt), today).settled;
	return [...debts.filter((debt) => !paidOff(debt)), ...debts.filter(paidOff)].map((debt) => ({ id: debt.id }));
};

/**
 * As contas a pagar que a edição abre (SPD-131c): primeiro as ativas cadastradas à mão, que têm
 * "Desativar" e "Apagar" para mostrar; depois as de dívida e as desativadas. Só lê a lista.
 */
export const billRecords = (bills: readonly Bill[]) => {
	const live = bills.filter((bill) => !bill.deletedAt);
	const manual = live.filter((bill) => bill.active && canToggleActive(bill));
	return [...manual, ...live.filter((bill) => !manual.includes(bill))].map((bill) => ({ id: bill.id }));
};

const TrailRecordsSource: React.FC = () => {
	const tour = useTour();
	const { accounts, bankAccounts = [], creditCards, debitCards, unassignedNetCents = 0 } = useAccounts();
	const { transactions } = useTransactions();
	const { pending, supported } = useCaptures();
	// Lido sem exigir o provider: fora dele (num teste do guia), não há dívida.
	const debts = useContext(DebtsContext)?.debts ?? [];
	// As contas a pagar, do mesmo jeito (SPD-131c): fora do provider, nenhuma.
	const bills = useContext(BillsContext)?.bills ?? [];
	const current = {
		accounts,
		bankAccounts,
		creditCards,
		debitCards,
		unassignedNetCents,
		transactions,
		pending,
		supported,
		debts,
		bills,
	};
	const latest = useRef(current);
	latest.current = current;

	useEffect(() => {
		if (!tour) return;
		return tour.setTrailRecords(async (): Promise<TrailRecords> => {
			const {
				accounts: all,
				bankAccounts: banks,
				creditCards: cards,
				debitCards: debit,
				unassignedNetCents: unassigned,
				transactions: entries,
				pending: queue,
				supported: capture,
				debts: owed,
				bills: payable,
			} = latest.current;
			// As condições da tela inicial e de Contas a pagar (SPD-160): o mesmo que cada bloco
			// olha para decidir se desenha o de verdade ou o de exemplo.
			const has = (yes: boolean) => (yes ? [{}] : []);
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
				debt: debtRecords(owed, todayISO()),
				bill: billRecords(payable),
				anyBill: has(payable.some((bill) => !bill.deletedAt)),
				anyCard: has(cards.length + debit.length > 0),
				anyAccount: has(banks.length > 0),
				unassigned: has(unassigned !== 0),
			};
		});
	}, [tour]);

	return null;
};

export default TrailRecordsSource;
