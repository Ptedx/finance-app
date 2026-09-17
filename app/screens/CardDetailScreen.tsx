import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CardFace from '../components/cards/CardFace';
import { ACCENT, Button, ChipGroup, type ChipOption, Field } from '../components/cards/formParts';
import Sheet from '../components/cards/Sheet';
import HorizontalCategoryPicker from '../components/HorizontalCategoryPicker';
import TransactionItem from '../components/TransactionItem';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Account } from '../database/schema';
import { cycleRuleOf, existingInstallmentDates, type InvoiceView } from '../utils/cardMath';
import { formatDayMonth, formatMonthLong, formatMonthShort, todayISO } from '../utils/dateUtils';
import { centsToDisplayInput, formatCents, parseAmountToCents } from '../utils/money';

/**
 * Um cartão por inteiro.
 *
 * De cima para baixo: o cartão (o que já se vê na tela inicial), as três coisas que se
 * faz com ele (pagar a fatura, acertar o valor com o banco, cadastrar uma parcela antiga),
 * as faturas mês a mês com os lançamentos de cada uma, o limite explicado, as parcelas
 * que ainda vão cair, e as datas que decidem quando comprar.
 *
 * As faturas são abas horizontais, uma por mês, com o valor na própria aba: dá para
 * comparar meses sem abrir nenhum. A aba aberta vem selecionada.
 */

const ROW_GAP = 12;

/** A fatura leva o nome do mês em que vence, que é a chave dela. */
const invoiceMonth = (invoice: InvoiceView): string => `${invoice.cycle.key}-01`;

interface CardDetailScreenProps {
	cardId: string;
}

type SheetKind = 'pay' | 'adjust' | 'installments' | null;

const CardDetailScreen: React.FC<CardDetailScreenProps> = ({ cardId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, bankAccounts, cardSummaries, recordCardPayment, setCardOwedToday, addExistingInstallments } = useAccounts();
	const { transactions, categories } = useTransactions();

	const card: Account | undefined = accounts.find((account) => account.id === cardId && account.kind === 'credit_card');
	const summary = card ? cardSummaries.get(card.id) : undefined;

	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [sheet, setSheet] = useState<SheetKind>(null);

	useEffect(() => {
		if (!selectedKey && summary?.openCycle) setSelectedKey(summary.openCycle.key);
	}, [selectedKey, summary]);

	const cardTransactions = useMemo(
		() => transactions.filter((tx) => tx.accountId === cardId),
		[transactions, cardId]
	);

	if (!card) {
		return (
			<SafeAreaView style={styles.container}>
				<Stack.Screen options={{ headerShown: false }} />
				<Text style={styles.missing}>{t('cards.notFound')}</Text>
			</SafeAreaView>
		);
	}

	const selected: InvoiceView | undefined = summary?.invoices.find((invoice) => invoice.cycle.key === selectedKey);
	const selectedTransactions = selected
		? cardTransactions
				.filter((tx) => tx.date >= selected.cycle.start && tx.date <= selected.cycle.end)
				.sort((a, b) => b.date.localeCompare(a.date))
		: [];
	const anchorInSelected =
		selected &&
		card.openingBalanceCents !== 0 &&
		card.openingBalanceDate >= selected.cycle.start &&
		card.openingBalanceDate <= selected.cycle.end;

	const invoiceStatus = (invoice: InvoiceView): string => {
		const due = formatDayMonth(invoice.cycle.dueDate);
		if (invoice.offset === 0) return t('cards.invoice.open', { closing: formatDayMonth(invoice.cycle.closingDate), due });
		if (invoice.offset > 0) return t('cards.invoice.future', { due });
		if (invoice.offset === -1 && summary) {
			if (summary.closedStatus === 'overdue') return t('cards.invoice.overdue', { due, amount: formatCents(summary.toPayCents) });
			if (summary.toPayCents > 0) return t('cards.invoice.closedToPay', { due, amount: formatCents(summary.toPayCents) });
			if (invoice.amountCents > 0) return t('cards.invoice.paid');
		}
		return t('cards.invoice.closed', { due });
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('cards.back')} style={styles.iconButton}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
					{card.name}
				</Text>
				<Pressable
					onPress={() => router.push({ pathname: '/cards/edit/[id]', params: { id: card.id } })}
					accessibilityRole="button"
					accessibilityLabel={t('cards.editCard')}
					style={styles.iconButton}
				>
					<Ionicons name="create-outline" size={24} color="#FFFFFF" />
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<CardFace card={card} summary={summary} />

				<View style={styles.actions}>
					<ActionTile icon="cash-outline" label={t('cards.actions.pay')} onPress={() => setSheet('pay')} />
					<ActionTile icon="scale-outline" label={t('cards.actions.adjust')} onPress={() => setSheet('adjust')} />
					<ActionTile icon="layers-outline" label={t('cards.actions.installments')} onPress={() => setSheet('installments')} />
				</View>

				{summary && !summary.configured ? (
					<Pressable
						onPress={() => router.push({ pathname: '/cards/edit/[id]', params: { id: card.id } })}
						accessibilityRole="button"
						accessibilityLabel={`${t('cards.setupTitle')}. ${t('cards.setupBody')}`}
						style={({ pressed }) => [styles.notice, pressed && styles.pressed]}
					>
						<Ionicons name="calendar-outline" size={22} color={ACCENT} />
						<View style={styles.flex}>
							<Text style={styles.noticeTitle}>{t('cards.setupTitle')}</Text>
							<Text style={styles.noticeBody}>{t('cards.setupBody')}</Text>
						</View>
						<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.6)" />
					</Pressable>
				) : null}

				{summary?.configured && summary.invoices.length > 0 ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.invoice.title')}
						</Text>
						<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
							{summary.invoices.map((invoice) => {
								const isSelected = invoice.cycle.key === selectedKey;
								const month = formatMonthShort(invoiceMonth(invoice));
								return (
									<Pressable
										key={invoice.cycle.key}
										onPress={() => setSelectedKey(invoice.cycle.key)}
										accessibilityRole="tab"
										accessibilityState={{ selected: isSelected }}
										accessibilityLabel={`${t('cards.invoice.of', { month: formatMonthLong(invoiceMonth(invoice)) })}, ${formatCents(invoice.amountCents)}. ${invoiceStatus(invoice)}`}
										style={({ pressed }) => [styles.tab, isSelected && styles.tabSelected, pressed && styles.pressed]}
									>
										<Text style={[styles.tabMonth, isSelected && styles.tabTextSelected]}>
											{month}
											{invoice.offset === 0 ? ` · ${t('cards.invoice.current')}` : ''}
										</Text>
										<Text style={[styles.tabAmount, isSelected && styles.tabTextSelected]}>{formatCents(invoice.amountCents)}</Text>
									</Pressable>
								);
							})}
						</ScrollView>

						{selected ? (
							<View style={styles.panel}>
								<Text style={styles.panelTitle}>{t('cards.invoice.of', { month: formatMonthLong(invoiceMonth(selected)) })}</Text>
								<Text style={styles.panelAmount}>{formatCents(selected.amountCents)}</Text>
								<Text style={styles.panelStatus}>{invoiceStatus(selected)}</Text>
								<Text style={styles.panelMeta}>
									{t('cards.invoice.period', { start: formatDayMonth(selected.cycle.start), end: formatDayMonth(selected.cycle.end) })}
								</Text>

								{anchorInSelected ? (
									<View style={styles.anchorRow} accessible accessibilityLabel={`${t('cards.invoice.informed', { date: formatDayMonth(card.openingBalanceDate) })}, ${formatCents(-card.openingBalanceCents)}`}>
										<Ionicons name="scale-outline" size={18} color="rgba(255,255,255,0.8)" />
										<Text style={styles.anchorText}>{t('cards.invoice.informed', { date: formatDayMonth(card.openingBalanceDate) })}</Text>
										<Text style={styles.anchorAmount}>{formatCents(-card.openingBalanceCents)}</Text>
									</View>
								) : null}

								{selectedTransactions.length === 0 && !anchorInSelected ? (
									<Text style={styles.empty}>{t('cards.invoice.empty')}</Text>
								) : (
									selectedTransactions.map((transaction) => (
										<TransactionItem
											key={transaction.id}
											transaction={transaction}
											onPress={(tx) => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } })}
										/>
									))
								)}
							</View>
						) : null}
					</View>
				) : null}

				{summary ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.limit.title')}
						</Text>
						<View style={styles.panel}>
							{summary.limitCents !== null ? (
								<>
									<View
										style={styles.track}
										accessible
										accessibilityLabel={t('cards.limit.usage', { percent: summary.limitUsagePercent ?? 0 })}
									>
										<View
											style={[
												styles.fill,
												{ width: `${Math.min(100, summary.limitUsagePercent ?? 0)}%` },
												(summary.limitUsagePercent ?? 0) >= 90 && styles.fillDanger,
											]}
										/>
									</View>
									<View style={styles.limitNumbers}>
										<Stat label={t('cards.limit.used')} value={formatCents(summary.limitUsedCents)} />
										<Stat
											label={t('cards.limit.available')}
											value={formatCents(summary.limitAvailableCents ?? 0)}
											tone={(summary.limitAvailableCents ?? 0) < 0 ? 'danger' : 'default'}
										/>
										<Stat label={t('cards.limit.total')} value={formatCents(summary.limitCents)} />
									</View>
								</>
							) : (
								<Text style={styles.empty}>{t('cards.limit.noLimit')}</Text>
							)}
							<Line label={t('cards.limit.owed')} value={formatCents(summary.owedCents)} />
							<Line label={t('cards.limit.future')} value={formatCents(summary.futureCommittedCents)} />
							{summary.creditCents > 0 ? <Line label={t('cards.limit.credit')} value={formatCents(summary.creditCents)} /> : null}
						</View>
					</View>
				) : null}

				{summary && summary.installmentPlans.length > 0 ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.plans.title')}
						</Text>
						<View style={styles.panel}>
							{summary.installmentPlans.map((plan, index) => {
								const done = plan.totalCount - plan.remainingCount;
								const text = t('cards.plans.line', {
									parcel: formatCents(plan.parcelCents),
									remaining: plan.remainingCount,
									total: plan.totalCount,
									last: formatMonthShort(plan.lastDate),
								});
								return (
									<View
										key={plan.group}
										style={[styles.plan, index > 0 && styles.planBorder]}
										accessible
										accessibilityLabel={`${plan.note}. ${text}. ${t('cards.plans.remainingTotal', { amount: formatCents(plan.remainingCents) })}`}
									>
										<View style={styles.flex}>
											<Text style={styles.planName} numberOfLines={1}>
												{plan.note}
											</Text>
											<Text style={styles.planMeta}>{text}</Text>
											<View style={styles.planTrack}>
												<View style={[styles.planFill, { width: `${Math.round((done / Math.max(1, plan.totalCount)) * 100)}%` }]} />
											</View>
										</View>
										<Text style={styles.planAmount}>{formatCents(plan.remainingCents)}</Text>
									</View>
								);
							})}
						</View>
					</View>
				) : null}

				{summary?.configured && summary.openCycle && card.dueDay ? (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('cards.dates.title')}
						</Text>
						<View style={styles.panel}>
							<Line label={t('cards.dates.best')} value={formatDayMonth(summary.openCycle.closingDate)} />
							<Line label={t('cards.dates.closing')} value={formatDayMonth(summary.openCycle.closingDate)} />
							<Line label={t('cards.dates.due')} value={formatDayMonth(summary.openCycle.dueDate)} />
							<Text style={styles.explain}>
								{t('cards.dates.explain', {
									count: cycleRuleOf(card)?.closingDaysBefore ?? 7,
									day: card.dueDay,
									best: formatDayMonth(summary.openCycle.closingDate),
								})}
							</Text>
						</View>
					</View>
				) : null}
			</ScrollView>

			{summary ? (
				<>
					<PaySheet
						visible={sheet === 'pay'}
						onClose={() => setSheet(null)}
						suggestedCents={summary.toPayCents > 0 ? summary.toPayCents : summary.owedCents}
						accounts={bankAccounts}
						onConfirm={async (fromId, cents) => {
							await recordCardPayment(card.id, fromId, cents, todayISO());
							setSheet(null);
							AccessibilityInfo.announceForAccessibility(t('cards.pay.done', { amount: formatCents(cents) }));
						}}
					/>
					<AdjustSheet
						visible={sheet === 'adjust'}
						onClose={() => setSheet(null)}
						onConfirm={async (cents) => {
							await setCardOwedToday(card.id, cents);
							setSheet(null);
							AccessibilityInfo.announceForAccessibility(t('cards.adjust.done', { amount: formatCents(cents) }));
						}}
					/>
					<InstallmentsSheet
						visible={sheet === 'installments'}
						onClose={() => setSheet(null)}
						card={card}
						categories={categories}
						onConfirm={async (input) => {
							const created = await addExistingInstallments({ ...input, cardId: card.id });
							setSheet(null);
							AccessibilityInfo.announceForAccessibility(t('cards.installments.done', { count: created }));
						}}
					/>
				</>
			) : null}
		</SafeAreaView>
	);
};

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

const ActionTile: React.FC<{ icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void }> = ({
	icon,
	label,
	onPress,
}) => (
	<Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
		<View style={styles.actionIcon}>
			<Ionicons name={icon} size={22} color={ACCENT} />
		</View>
		<Text style={styles.actionLabel}>{label}</Text>
	</Pressable>
);

const Stat: React.FC<{ label: string; value: string; tone?: 'default' | 'danger' }> = ({ label, value, tone = 'default' }) => (
	<View style={styles.stat} accessible accessibilityLabel={`${label}, ${value}`}>
		<Text style={styles.statLabel}>{label}</Text>
		<Text style={[styles.statValue, tone === 'danger' && styles.danger]}>{value}</Text>
	</View>
);

const Line: React.FC<{ label: string; value: string }> = ({ label, value }) => (
	<View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
		<Text style={styles.lineLabel}>{label}</Text>
		<Text style={styles.lineValue}>{value}</Text>
	</View>
);

const PaySheet: React.FC<{
	visible: boolean;
	onClose: () => void;
	suggestedCents: number;
	accounts: Account[];
	onConfirm: (fromAccountId: string | null, cents: number) => Promise<void>;
}> = ({ visible, onClose, suggestedCents, accounts, onConfirm }) => {
	const { t } = useTranslation();
	const main = accounts.find((account) => account.role === 'main') ?? accounts[0];
	const [amount, setAmount] = useState('');
	const [from, setFrom] = useState<string>(main?.id ?? 'outside');
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!visible) return;
		setAmount(suggestedCents > 0 ? centsToDisplayInput(suggestedCents) : '');
		setFrom(main?.id ?? 'outside');
		setError(undefined);
	}, [visible, suggestedCents, main?.id]);

	const options: ChipOption<string>[] = [
		...accounts.map((account) => ({ value: account.id, label: account.name, color: account.color })),
		{ value: 'outside', label: t('cards.pay.outside') },
	];

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.pay.title')} subtitle={t('cards.pay.subtitle')}>
			<Field label={t('cards.pay.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={error} />
			<ChipGroup label={t('cards.pay.from')} options={options} selected={from} onSelect={setFrom} hint={t('cards.pay.fromHint')} />
			<Button
				label={t('cards.pay.confirm')}
				icon="checkmark"
				onPress={async () => {
					const cents = parseAmountToCents(amount);
					if (cents === null || cents <= 0) {
						setError(t('cards.edit.invalidAmount'));
						AccessibilityInfo.announceForAccessibility(t('cards.edit.invalidAmount'));
						return;
					}
					await onConfirm(from === 'outside' ? null : from, cents);
				}}
			/>
		</Sheet>
	);
};

const AdjustSheet: React.FC<{ visible: boolean; onClose: () => void; onConfirm: (cents: number) => Promise<void> }> = ({
	visible,
	onClose,
	onConfirm,
}) => {
	const { t } = useTranslation();
	const [open, setOpen] = useState('');
	const [closed, setClosed] = useState('');
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!visible) return;
		setOpen('');
		setClosed('');
		setError(undefined);
	}, [visible]);

	const openCents = open.trim() ? parseAmountToCents(open) : 0;
	const closedCents = closed.trim() ? parseAmountToCents(closed) : 0;
	const total = openCents !== null && closedCents !== null ? openCents + closedCents : null;

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.adjust.title')} subtitle={t('cards.adjust.subtitle')}>
			<Field label={t('cards.adjust.open')} value={open} onChangeText={setOpen} keyboardType="decimal-pad" hint={t('cards.adjust.openHint')} />
			<Field
				label={t('cards.adjust.closed')}
				optionalLabel={t('cards.edit.optional')}
				value={closed}
				onChangeText={setClosed}
				keyboardType="decimal-pad"
				hint={t('cards.adjust.closedHint')}
				error={error}
			/>
			{total !== null && total > 0 ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{t('cards.adjust.preview', { amount: formatCents(total) })}
				</Text>
			) : null}
			<Button
				label={t('cards.adjust.confirm')}
				icon="checkmark"
				onPress={async () => {
					if (total === null || total < 0 || (!open.trim() && !closed.trim())) {
						setError(t('cards.edit.invalidAmount'));
						AccessibilityInfo.announceForAccessibility(t('cards.edit.invalidAmount'));
						return;
					}
					await onConfirm(total);
				}}
			/>
		</Sheet>
	);
};

const InstallmentsSheet: React.FC<{
	visible: boolean;
	onClose: () => void;
	card: Account;
	categories: ReturnType<typeof useTransactions>['categories'];
	onConfirm: (input: { note: string; category: string; parcelCents: number; currentIndex: number; totalCount: number }) => Promise<void>;
}> = ({ visible, onClose, card, categories, onConfirm }) => {
	const { t } = useTranslation();
	const [note, setNote] = useState('');
	const [parcel, setParcel] = useState('');
	const [current, setCurrent] = useState('');
	const [total, setTotal] = useState('');
	const [category, setCategory] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});

	useEffect(() => {
		if (!visible) return;
		setNote('');
		setParcel('');
		setCurrent('');
		setTotal('');
		setCategory(null);
		setErrors({});
	}, [visible]);

	const parcelCents = parseAmountToCents(parcel);
	const currentIndex = Number(current);
	const totalCount = Number(total);
	const valid =
		Number.isInteger(currentIndex) && Number.isInteger(totalCount) && currentIndex >= 1 && totalCount >= 2 && totalCount <= 48 && currentIndex <= totalCount;
	const dates = valid ? existingInstallmentDates(currentIndex, totalCount, cycleRuleOf(card), todayISO()) : [];

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.installments.title')} subtitle={t('cards.installments.subtitle')}>
			<Field label={t('cards.installments.note')} value={note} onChangeText={setNote} placeholder={t('cards.installments.notePlaceholder')} error={errors.note} />
			<Field label={t('cards.installments.parcel')} value={parcel} onChangeText={setParcel} keyboardType="decimal-pad" error={errors.parcel} />
			<View style={styles.twoColumns}>
				<View style={styles.flex}>
					<Field
						label={t('cards.installments.current')}
						value={current}
						onChangeText={(text) => setCurrent(text.replace(/\D/g, '').slice(0, 2))}
						keyboardType="number-pad"
						hint={t('cards.installments.currentHint')}
					/>
				</View>
				<View style={styles.flex}>
					<Field
						label={t('cards.installments.total')}
						value={total}
						onChangeText={(text) => setTotal(text.replace(/\D/g, '').slice(0, 2))}
						keyboardType="number-pad"
						error={errors.count}
					/>
				</View>
			</View>
			<View style={{ gap: 6 }}>
				<Text style={styles.fieldLabel}>{t('cards.installments.category')}</Text>
				<HorizontalCategoryPicker categories={categories} selectedCategoryId={category} onSelectCategory={setCategory} isIncome={false} />
				{errors.category ? (
					<Text style={styles.errorText} accessibilityLiveRegion="polite">
						{errors.category}
					</Text>
				) : null}
			</View>
			{dates.length > 0 && parcelCents ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{t('cards.installments.preview', {
						count: dates.length,
						amount: formatCents(parcelCents),
						first: formatMonthShort(dates[0].date),
						last: formatMonthShort(dates[dates.length - 1].date),
					})}
				</Text>
			) : null}
			<Button
				label={t('cards.installments.confirm')}
				icon="checkmark"
				onPress={async () => {
					const next: Record<string, string | undefined> = {};
					if (!note.trim()) next.note = t('cards.installments.noteRequired');
					if (parcelCents === null || parcelCents <= 0) next.parcel = t('cards.edit.invalidAmount');
					if (!valid) next.count = t('cards.installments.invalidCount');
					if (!category) next.category = t('cards.installments.categoryRequired');
					setErrors(next);
					const messages = Object.values(next).filter(Boolean);
					if (messages.length > 0 || parcelCents === null || !category) {
						AccessibilityInfo.announceForAccessibility(messages.join('. '));
						return;
					}
					await onConfirm({ note: note.trim(), category, parcelCents, currentIndex, totalCount });
				}}
			/>
		</Sheet>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	flex: {
		flex: 1,
	},
	missing: {
		color: '#FFFFFF',
		padding: 24,
		fontSize: 16,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 8,
		paddingVertical: 4,
		gap: 4,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 60,
		gap: 20,
	},
	pressed: {
		opacity: 0.7,
	},
	actions: {
		flexDirection: 'row',
		gap: ROW_GAP,
	},
	action: {
		flex: 1,
		alignItems: 'center',
		gap: 6,
		minHeight: 84,
		paddingVertical: 12,
		paddingHorizontal: 4,
		borderRadius: 16,
		backgroundColor: '#1E1E1E',
	},
	actionIcon: {
		width: 40,
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	actionLabel: {
		fontSize: 13,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
	},
	notice: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		padding: 14,
		borderRadius: 14,
		backgroundColor: 'rgba(21,232,254,0.08)',
		borderWidth: 1,
		borderColor: 'rgba(21,232,254,0.4)',
	},
	noticeTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	noticeBody: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.8)',
		marginTop: 2,
	},
	section: {
		gap: 10,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	tabs: {
		gap: 8,
	},
	tab: {
		minHeight: 56,
		minWidth: 92,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 12,
		borderWidth: 1.5,
		borderColor: 'rgba(255,255,255,0.15)',
		justifyContent: 'center',
	},
	tabSelected: {
		borderColor: ACCENT,
		backgroundColor: 'rgba(21,232,254,0.1)',
	},
	tabMonth: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.8)',
		textTransform: 'capitalize',
	},
	tabAmount: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
		marginTop: 2,
	},
	tabTextSelected: {
		color: ACCENT,
	},
	panel: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
		gap: 4,
	},
	panelTitle: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.75)',
	},
	panelAmount: {
		fontSize: 28,
		fontWeight: '800',
		color: '#FFFFFF',
	},
	panelStatus: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	panelMeta: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
		marginBottom: 6,
	},
	anchorRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		paddingVertical: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
	},
	anchorText: {
		flex: 1,
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	anchorAmount: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	empty: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.65)',
		paddingVertical: 8,
	},
	track: {
		height: 10,
		borderRadius: 5,
		backgroundColor: 'rgba(255,255,255,0.12)',
		overflow: 'hidden',
		marginBottom: 12,
	},
	fill: {
		height: 10,
		borderRadius: 5,
		backgroundColor: ACCENT,
	},
	fillDanger: {
		backgroundColor: '#FF8A80',
	},
	limitNumbers: {
		flexDirection: 'row',
		gap: 8,
		marginBottom: 8,
	},
	stat: {
		flex: 1,
	},
	statLabel: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.7)',
	},
	statValue: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
		marginTop: 2,
	},
	danger: {
		color: '#FF8A80',
	},
	line: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		minHeight: 40,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
		gap: 12,
	},
	lineLabel: {
		flex: 1,
		fontSize: 14,
		color: 'rgba(255,255,255,0.85)',
	},
	lineValue: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	plan: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		paddingVertical: 10,
	},
	planBorder: {
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.08)',
	},
	planName: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	planMeta: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	planTrack: {
		height: 4,
		borderRadius: 2,
		backgroundColor: 'rgba(255,255,255,0.12)',
		marginTop: 8,
		overflow: 'hidden',
	},
	planFill: {
		height: 4,
		borderRadius: 2,
		backgroundColor: ACCENT,
	},
	planAmount: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	explain: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 8,
	},
	preview: {
		fontSize: 14,
		lineHeight: 20,
		color: ACCENT,
	},
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	fieldLabel: {
		fontSize: 14,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
	},
	errorText: {
		fontSize: 13,
		color: '#FF8A80',
	},
});

export default CardDetailScreen;
