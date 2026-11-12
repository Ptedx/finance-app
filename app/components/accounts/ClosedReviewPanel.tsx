import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAccounts } from '../../contexts/AccountsContext';
import { useDebts } from '../../contexts/DebtsContext';
import type { Account } from '../../database/schema';
import { useRetirementGoal } from '../../hooks/useRetirementGoal';
import { closeTargets } from '../../utils/accountClosing';
import { netWorth } from '../../utils/accountMath';
import { type RevivalNotice, revivalWorthDelta } from '../../utils/accountRevival';
import { type ClosedDecision, type ClosedReviewItem, type ClosedSettlement, type ClosedTotals, closedDecisionEffect } from '../../utils/closedReview';
import { formatMonthYear } from '../../utils/dateUtils';
import { closeBlockedMessage } from '../../utils/deletionNotice';
import { formatCents } from '../../utils/money';
import MergeTargetSheet from '../MergeTargetSheet';

/**
 * Na tela de Contas (Ajustes): o aviso único da conta apagada que voltou encerrada (SPD-149)
 * e a lista "Encerradas com saldo" (SPD-150).
 *
 * O aviso diz qual conta voltou, quantos lançamentos e transferências, o que cada mês do
 * histórico passou a mostrar e, quando um cartão voltou, o Patrimônio de hoje antes e depois.
 * Aparece uma vez: sai no "Entendi" ou ao deixar a tela.
 *
 * A lista fica aqui enquanto houver encerrada com saldo. Nada muda sem o toque do usuário, e
 * cada decisão mostra antes o efeito em R$ ("Patrimônio: R$ X → R$ Y"), com a mesma conta da
 * tela de Patrimônio. O aviso curto da tela inicial traz até aqui uma vez.
 */

const ACCENT = '#15E8FE';

/** Valor com sinal: "+R$ 90,00" ou "−R$ 90,00". */
const signed = (cents: number): string => `${cents > 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;

type Translate = ReturnType<typeof useTranslation>['t'];

/** As linhas do aviso de uma conta que voltou: o que ela trouxe e o efeito de cada mês. */
export const revivalNoticeLines = (notice: RevivalNotice, t: Translate): { accounts: string[]; months: string[] | null } => {
	const accounts = notice.accounts.map((account) => {
		const parts = [
			account.transactions > 0 ? t('accounts.closedReview.revivedTransactions', { count: account.transactions }) : null,
			account.transfers > 0 ? t('accounts.closedReview.revivedTransfers', { count: account.transfers }) : null,
		].filter((part): part is string => part !== null);
		const entries = parts.length === 2 ? t('accounts.closedReview.revivedAnd', { first: parts[0], second: parts[1] }) : (parts[0] ?? '');
		return t('accounts.closedReview.revivedAccount', { name: account.name, entries });
	});
	const months =
		notice.months === null
			? null
			: notice.months.map((month) => {
					const changes = [
						month.incomeCents !== 0 ? t('accounts.closedReview.revivedIncome', { amount: signed(month.incomeCents) }) : null,
						month.spendCents !== 0 ? t('accounts.closedReview.revivedSpend', { amount: signed(month.spendCents) }) : null,
						month.savedCents !== 0 ? t('accounts.closedReview.revivedSaved', { amount: signed(month.savedCents) }) : null,
					].filter((part): part is string => part !== null);
					return t('accounts.closedReview.revivedMonth', { month: formatMonthYear(`${month.month}-01`), changes: changes.join(', ') });
				});
	return { accounts, months };
};

const isOwingCard = (item: ClosedReviewItem): boolean => item.account.kind === 'credit_card' && item.balanceCents < 0;

const ClosedReviewPanel: React.FC = () => {
	const { closedReview = [], revivalNotices = [], dismissRevivalNotices, markClosedReviewShown, closedReviewUnseen } = useAccounts();

	// O aviso sai ao deixar a tela, como o "Juntamos X em Y": foi mostrado.
	const noticesShown = useRef(false);
	noticesShown.current = revivalNotices.length > 0;
	const dismissRef = useRef(dismissRevivalNotices);
	dismissRef.current = dismissRevivalNotices;
	useEffect(
		() => () => {
			if (noticesShown.current) dismissRef.current?.();
		},
		[]
	);

	// A lista apareceu: as encerradas de agora contam como vistas, e o aviso da tela inicial some.
	useEffect(() => {
		if (closedReviewUnseen) markClosedReviewShown?.();
	}, [closedReviewUnseen, markClosedReviewShown]);

	if (closedReview.length === 0 && revivalNotices.length === 0) return null;
	return (
		<>
			{revivalNotices.length > 0 ? <RevivalNotices notices={revivalNotices} onDismiss={dismissRevivalNotices} /> : null}
			{closedReview.length > 0 ? <ClosedReviewList items={closedReview} /> : null}
		</>
	);
};

const RevivalNotices: React.FC<{ notices: RevivalNotice[]; onDismiss: () => void }> = ({ notices, onDismiss }) => {
	const { t } = useTranslation();
	const count = notices.reduce((total, notice) => total + notice.accounts.length, 0);
	// Sem o efeito de algum aviso (a conta falhou), não se afirma nada sobre o Patrimônio.
	const worthKnown = notices.every((notice) => notice.worthDeltaCents !== null);
	const worthDelta = revivalWorthDelta(notices);
	return (
		<View style={styles.notice} accessibilityLiveRegion="polite">
			<Text style={styles.title} accessibilityRole="header">
				{t('accounts.closedReview.revivedTitle', { count })}
			</Text>
			<Text style={styles.body}>{t('accounts.closedReview.revivedBody', { count })}</Text>
			{worthKnown && worthDelta !== 0 ? <RevivalWorthLine deltaCents={worthDelta} /> : null}
			{worthKnown && worthDelta === 0 ? <Text style={styles.body}>{t('accounts.closedReview.revivedWorthSame')}</Text> : null}
			{notices.map((notice) => {
				const lines = revivalNoticeLines(notice, t);
				return (
					<View key={notice.accounts.map((account) => account.id).join('|')} style={styles.noticeGroup}>
						{lines.accounts.map((line) => (
							<Text key={line} style={styles.strong}>
								{line}
							</Text>
						))}
						{lines.months === null ? (
							<Text style={styles.body}>{t('accounts.closedReview.revivedUnknown')}</Text>
						) : lines.months.length === 0 ? (
							<Text style={styles.body}>{t('accounts.closedReview.revivedNoMonths')}</Text>
						) : (
							<>
								<Text style={styles.body}>{t('accounts.closedReview.revivedMonths')}</Text>
								{lines.months.map((line) => (
									<Text key={line} style={styles.body}>
										{`• ${line}`}
									</Text>
								))}
							</>
						)}
					</View>
				);
			})}
			<Pressable
				onPress={onDismiss}
				accessibilityRole="button"
				accessibilityLabel={t('accounts.closedReview.revivedOk')}
				style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
			>
				<Text style={styles.primaryButtonText}>{t('accounts.closedReview.revivedOk')}</Text>
			</Pressable>
		</View>
	);
};

/** O que o botão principal faz: transferir o saldo, cobrir o negativo ou pagar a fatura. */
const primaryActionOf = (item: ClosedReviewItem): 'transfer' | 'cover' | 'pay' =>
	isOwingCard(item) ? 'pay' : item.balanceCents < 0 ? 'cover' : 'transfer';

/** Os totais de hoje como a tela de Patrimônio os soma (`netWorth`). */
const useTodayTotals = (): ClosedTotals => {
	const { overview, cardSummaries } = useAccounts();
	const { summary: debtsSummary } = useDebts();
	const { goal } = useRetirementGoal();
	return useMemo<ClosedTotals>(() => {
		let cardsCents = 0;
		for (const summary of cardSummaries.values()) cardsCents += summary.owedCents + summary.futureCommittedCents;
		return {
			cashCents: overview.cashCents,
			savedCents: overview.savedCents,
			outsideCents: goal?.outsideCapitalCents ?? 0,
			cardsCents,
			debtsCents: debtsSummary.balanceCents,
			netCents: overview.netCents,
		};
	}, [overview, cardSummaries, goal, debtsSummary]);
};

/**
 * O Patrimônio de hoje com o cartão que voltou (SPD-149): "Patrimônio: R$ X → R$ Y", em que Y
 * é o de agora e X o de antes da volta. Só aparece quando muda.
 */
const RevivalWorthLine: React.FC<{ deltaCents: number }> = ({ deltaCents }) => {
	const { t } = useTranslation();
	const after = netWorth(useTodayTotals()).netCents;
	return (
		<>
			<Text style={styles.strong}>
				{t('accounts.closedReview.effectWorth', { before: formatCents(after - deltaCents), after: formatCents(after) })}
			</Text>
			<Text style={styles.body}>{t('accounts.closedReview.revivedWorthCard')}</Text>
		</>
	);
};

const ClosedReviewList: React.FC<{ items: ClosedReviewItem[] }> = ({ items }) => {
	const { t } = useTranslation();
	const { accounts, planClose, settleClosedAccount } = useAccounts();
	// A folha de "para qual conta" aberta, com a encerrada que a abriu.
	const [picking, setPicking] = useState<ClosedReviewItem | null>(null);
	const [busy, setBusy] = useState(false);

	const totals = useTodayTotals();

	const scopeOf = (item: ClosedReviewItem) => (item.account.kind === 'credit_card' ? 'cards.edit' : 'accounts.edit');

	const amountLine = (item: ClosedReviewItem): string => {
		const amount = formatCents(Math.abs(item.balanceCents));
		if (isOwingCard(item)) return t('accounts.closedReview.owes', { amount: formatCents(item.owedCents) });
		if (item.account.kind === 'credit_card') return t('accounts.closedReview.credit', { amount });
		return t('accounts.closedReview.balance', { amount: formatCents(item.balanceCents) });
	};

	/** O texto da confirmação: o que acontece, e o efeito nos totais antes de confirmar. */
	const confirmText = (item: ClosedReviewItem, decision: ClosedDecision, target: Account | null): string => {
		const name = item.account.name;
		const amount = formatCents(isOwingCard(item) ? item.owedCents : Math.abs(item.balanceCents));
		let what: string;
		if (decision.kind === 'transfer') {
			const action = primaryActionOf(item);
			what = t(action === 'pay' ? 'accounts.closedReview.confirmPay' : action === 'cover' ? 'accounts.closedReview.confirmCover' : 'accounts.closedReview.confirmTransfer', {
				amount,
				name,
				target: target?.name ?? '',
			});
		} else if (decision.kind === 'reopen') {
			what = t('accounts.closedReview.confirmReopen', { name, amount: formatCents(item.balanceCents) });
		} else {
			what = t(item.account.kind === 'credit_card' ? 'accounts.closedReview.confirmZeroCard' : 'accounts.closedReview.confirmZero', { name });
		}
		const effect = closedDecisionEffect(item, decision, totals);
		const lines = [t('accounts.closedReview.effectWorth', { before: formatCents(effect.worth.beforeCents), after: formatCents(effect.worth.afterCents) })];
		if (effect.net.afterCents !== effect.net.beforeCents) {
			lines.push(t('accounts.closedReview.effectNet', { before: formatCents(effect.net.beforeCents), after: formatCents(effect.net.afterCents) }));
		}
		if (effect.savedThisMonthCents !== 0) lines.push(t('accounts.closedReview.effectSaved', { amount: signed(effect.savedThisMonthCents) }));
		return `${what}\n\n${lines.join('\n')}`;
	};

	const confirm = (item: ClosedReviewItem, decision: ClosedDecision, target: Account | null) => {
		// Transferir sem destino não existe: sem conta escolhida, nada acontece.
		if (decision.kind === 'transfer' && !target) return;
		const settlement: ClosedSettlement = decision.kind === 'transfer' ? { kind: 'transfer', targetId: target?.id ?? '' } : decision;
		const title =
			decision.kind === 'transfer'
				? t(`accounts.closedReview.${primaryActionOf(item)}`)
				: decision.kind === 'reopen'
					? t('accounts.closedReview.reopen')
					: t('accounts.closedReview.zero');
		Alert.alert(title, confirmText(item, decision, target), [
			{ text: t('accounts.closedReview.cancel'), style: 'cancel' },
			{
				text: t('accounts.closedReview.confirmAction'),
				onPress: async () => {
					setBusy(true);
					try {
						await settleClosedAccount(item.account.id, settlement);
					} catch (error) {
						console.error('Error settling a closed account:', error);
						Alert.alert(title, t('accounts.closedReview.failed'));
					} finally {
						setBusy(false);
					}
				},
			},
		]);
	};

	/** Compra a revisar ou lançamento futuro: o saldo ainda vai mudar, e a decisão espera. */
	const blocked = async (item: ClosedReviewItem): Promise<boolean> => {
		try {
			const plan = await planClose(item.account.id);
			if (plan.kind === 'blocked' && plan.reason !== 'cardOwes') {
				Alert.alert(item.account.name, closeBlockedMessage(scopeOf(item), item.account.name, plan, t));
				return true;
			}
			return false;
		} catch (error) {
			console.error('Error planning the closed account decision:', error);
			return true;
		}
	};

	const startTransfer = async (item: ClosedReviewItem) => {
		if (await blocked(item)) return;
		if (closeTargets(accounts, item.account).length === 0) {
			Alert.alert(t(`accounts.closedReview.${primaryActionOf(item)}`), t('accounts.closedReview.noTarget', { name: item.account.name }));
			return;
		}
		// O destino se escolhe na folha do "Juntar": o Alert do Android mostra no máximo três botões.
		setPicking(item);
	};

	const startZero = async (item: ClosedReviewItem) => {
		if (await blocked(item)) return;
		confirm(item, { kind: 'zero' }, null);
	};

	const pickSubtitle = (item: ClosedReviewItem): string => {
		const action = primaryActionOf(item);
		const amount = formatCents(isOwingCard(item) ? item.owedCents : Math.abs(item.balanceCents));
		const key = action === 'pay' ? 'pickPay' : action === 'cover' ? 'pickIn' : 'pickOut';
		return t(`accounts.closedReview.${key}`, { amount, name: item.account.name });
	};

	return (
		<View style={styles.list}>
			<Text style={styles.title} accessibilityRole="header">
				{t('accounts.closedReview.title')}
			</Text>
			<Text style={styles.body}>{t('accounts.closedReview.body')}</Text>
			{items.map((item) => {
				const action = primaryActionOf(item);
				return (
					<View key={item.account.id} style={styles.item}>
						<View style={styles.itemHeader}>
							<Ionicons name={item.account.kind === 'credit_card' ? 'card-outline' : 'wallet-outline'} size={18} color={item.account.color} />
							<Text style={styles.strong} numberOfLines={2}>
								{item.account.name}
							</Text>
						</View>
						<Text style={styles.body}>{amountLine(item)}</Text>
						<View style={styles.actions}>
							<Pressable
								disabled={busy}
								onPress={() => void startTransfer(item)}
								accessibilityRole="button"
								accessibilityLabel={t(`accounts.closedReview.${action}`)}
								accessibilityHint={t(`accounts.closedReview.${action === 'transfer' ? 'transferHint' : action === 'cover' ? 'coverHint' : 'payHint'}`)}
								style={({ pressed }) => [styles.actionButton, styles.actionPrimary, pressed && styles.pressed]}
							>
								<Text style={styles.primaryButtonText}>{t(`accounts.closedReview.${action}`)}</Text>
							</Pressable>
							<Pressable
								disabled={busy}
								onPress={() => confirm(item, { kind: 'reopen' }, null)}
								accessibilityRole="button"
								accessibilityLabel={t('accounts.closedReview.reopen')}
								accessibilityHint={t('accounts.closedReview.reopenHint')}
								style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
							>
								<Text style={styles.actionText}>{t('accounts.closedReview.reopen')}</Text>
							</Pressable>
							<Pressable
								disabled={busy}
								onPress={() => void startZero(item)}
								accessibilityRole="button"
								accessibilityLabel={t('accounts.closedReview.zero')}
								accessibilityHint={t('accounts.closedReview.zeroHint')}
								style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
							>
								<Text style={styles.actionText}>{t('accounts.closedReview.zero')}</Text>
							</Pressable>
						</View>
					</View>
				);
			})}
			{picking ? (
				<MergeTargetSheet
					visible
					title={t('accounts.closedReview.pickTitle')}
					subtitle={pickSubtitle(picking)}
					targets={closeTargets(accounts, picking.account)}
					onPick={(target) => {
						const item = picking;
						setPicking(null);
						confirm(item, { kind: 'transfer', target }, target);
					}}
					onClose={() => setPicking(null)}
				/>
			) : null}
		</View>
	);
};

const styles = StyleSheet.create({
	notice: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		borderWidth: 1,
		borderColor: ACCENT,
		padding: 16,
		marginBottom: 12,
		gap: 8,
	},
	noticeGroup: {
		gap: 4,
	},
	list: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		borderWidth: 1,
		borderColor: '#FFB74D',
		padding: 16,
		marginBottom: 12,
		gap: 8,
	},
	title: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	body: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.85)',
	},
	strong: {
		flexShrink: 1,
		fontSize: 14,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	item: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: 'rgba(255,255,255,0.15)',
		paddingTop: 10,
		gap: 6,
	},
	itemHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	actions: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
	},
	actionButton: {
		minHeight: 48,
		paddingHorizontal: 14,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.4)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	actionPrimary: {
		backgroundColor: ACCENT,
		borderColor: ACCENT,
	},
	actionText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	primaryButton: {
		alignItems: 'center',
		justifyContent: 'center',
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
	},
	primaryButtonText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
});

export default ClosedReviewPanel;
