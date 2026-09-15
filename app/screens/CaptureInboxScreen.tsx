import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import HorizontalCategoryPicker from '../components/HorizontalCategoryPicker';
import { useCaptures } from '../contexts/CapturesContext';
import { useTransactions } from '../contexts/TransactionsContext';
import type { Capture, Category } from '../database/schema';
import { resolveCategoryId } from '../utils/captureActions';
import { formatCents } from '../utils/money';

/**
 * A caixa de entrada: cada notificação capturada vira um cartão para confirmar com
 * um toque, e as dúvidas que o app não resolve sozinho — "é a mesma compra?", "é
 * transferência entre suas contas?" — viram uma pergunta de dois botões dentro do
 * cartão. Nada acontece sem o usuário ver, e tudo que acontece dá para desfazer.
 *
 * Acessibilidade: todo controle tem ao menos 48 pontos de altura, rótulo e dica para
 * leitor de tela; valores são anunciados por extenso pelo `formatCents`; mudanças de
 * estado são anunciadas; nada depende só de cor.
 */

const UNDO_WINDOW_MS = 8000;
const AUTO_APPROVED_DAYS = 7;

const ACCENT = '#15E8FE';

const whenLabel = (iso: string): string => {
	const date = new Date(iso);
	const today = new Date();
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	if (date.toDateString() === today.toDateString()) return time;
	return `${date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${time}`;
};

const FALLBACK_CATEGORY: Pick<Category, 'id' | 'name' | 'color' | 'icon'> = {
	id: 'uncategorized',
	name: 'Uncategorized',
	color: '#9CA3AF',
	icon: 'help-circle',
};

interface ActionButtonProps {
	label: string;
	hint: string;
	icon: React.ComponentProps<typeof Ionicons>['name'];
	onPress: () => void;
	primary?: boolean;
	danger?: boolean;
}

const ActionButton: React.FC<ActionButtonProps> = ({ label, hint, icon, onPress, primary, danger }) => (
	<Pressable
		onPress={onPress}
		accessibilityRole="button"
		accessibilityLabel={label}
		accessibilityHint={hint}
		style={({ pressed }) => [
			styles.button,
			primary && styles.buttonPrimary,
			danger && styles.buttonDanger,
			pressed && styles.buttonPressed,
		]}
	>
		<Ionicons name={icon} size={20} color={primary ? '#000000' : '#FFFFFF'} />
		<Text style={[styles.buttonLabel, primary && styles.buttonLabelPrimary]}>{label}</Text>
	</Pressable>
);

interface CaptureCardProps {
	capture: Capture;
	related: Capture | null;
	categories: Category[];
	onConfirm: (capture: Capture, categoryId: string) => void;
	onDismiss: (capture: Capture) => void;
	onTransfer: (capture: Capture) => void;
	onAnswerDuplicate: (capture: Capture, same: boolean) => void;
	onAnswerTransfer: (capture: Capture, isTransfer: boolean) => void;
}

const CaptureCard: React.FC<CaptureCardProps> = ({
	capture,
	related,
	categories,
	onConfirm,
	onDismiss,
	onTransfer,
	onAnswerDuplicate,
	onAnswerTransfer,
}) => {
	const { t } = useTranslation();
	const isIncome = capture.direction === 'in';
	const [categoryId, setCategoryId] = useState(() =>
		resolveCategoryId(capture.suggestedCategory, capture.direction, categories)
	);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [rawOpen, setRawOpen] = useState(false);

	const category = categories.find((c) => c.id === categoryId) ?? FALLBACK_CATEGORY;
	const amount = formatCents(capture.amountCents);
	const kindLabel = t(`captures.kind.${capture.kind}`, { defaultValue: t('captures.kind.unknown') });
	const summary = `${isIncome ? t('captures.income') : t('captures.expense')}, ${amount}, ${
		capture.counterparty ?? kindLabel
	}, ${t('captures.from', { app: capture.appLabel, time: whenLabel(capture.postedAt) })}`;

	return (
		<View style={styles.card}>
			<View accessible accessibilityLabel={summary}>
				<View style={styles.cardHeader}>
					<Text style={[styles.amount, isIncome ? styles.income : styles.expense]}>
						{isIncome ? '+' : '−'} {amount}
					</Text>
					<Text style={styles.meta}>
						{t('captures.from', { app: capture.appLabel, time: whenLabel(capture.postedAt) })}
					</Text>
				</View>
				<Text style={styles.counterparty}>{capture.counterparty ?? kindLabel}</Text>
				<Text style={styles.kind}>
					{kindLabel}
					{capture.cardLast4 ? ` · ${t('captures.cardEnding', { last4: capture.cardLast4 })}` : ''}
				</Text>
			</View>

			{capture.question === 'duplicate' && (
				<View style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('captures.questionDuplicateTitle')}</Text>
					<Text style={styles.questionBody}>
						{t('captures.questionDuplicateBody', {
							app: related?.appLabel ?? '?',
							time: related ? whenLabel(related.postedAt) : '?',
						})}
					</Text>
					<View style={styles.questionActions}>
						<ActionButton
							label={t('captures.sameEntry')}
							hint={t('captures.sameEntryHint')}
							icon="copy-outline"
							onPress={() => onAnswerDuplicate(capture, true)}
							primary
						/>
						<ActionButton
							label={t('captures.differentEntries')}
							hint={t('captures.differentEntriesHint')}
							icon="git-branch-outline"
							onPress={() => onAnswerDuplicate(capture, false)}
						/>
					</View>
				</View>
			)}

			{capture.question === 'transfer' && (
				<View style={styles.question} accessibilityLiveRegion="polite">
					<Text style={styles.questionTitle}>{t('captures.questionTransferTitle')}</Text>
					<Text style={styles.questionBody}>
						{t('captures.questionTransferBody', {
							app: related?.appLabel ?? '?',
							time: related ? whenLabel(related.postedAt) : '?',
						})}
					</Text>
					<View style={styles.questionActions}>
						<ActionButton
							label={t('captures.yesTransfer')}
							hint={t('captures.yesTransferHint')}
							icon="swap-horizontal"
							onPress={() => onAnswerTransfer(capture, true)}
							primary
						/>
						<ActionButton
							label={t('captures.noTransfer')}
							hint={t('captures.noTransferHint')}
							icon="git-branch-outline"
							onPress={() => onAnswerTransfer(capture, false)}
						/>
					</View>
				</View>
			)}

			<Pressable
				onPress={() => setPickerOpen((open) => !open)}
				accessibilityRole="button"
				accessibilityLabel={t('captures.categoryLabel', { category: category.name })}
				accessibilityHint={t('captures.changeCategoryHint')}
				accessibilityState={{ expanded: pickerOpen }}
				style={({ pressed }) => [styles.categoryChip, pressed && styles.buttonPressed]}
			>
				<View style={[styles.categoryDot, { backgroundColor: category.color }]}>
					{/* biome-ignore lint/suspicious/noExplicitAny: external API shape unknown */}
					<Ionicons name={category.icon as any} size={14} color="#000000" />
				</View>
				<Text style={styles.categoryName}>{category.name}</Text>
				<Ionicons name={pickerOpen ? 'chevron-up' : 'chevron-down'} size={18} color="rgba(255,255,255,0.7)" />
			</Pressable>

			{pickerOpen && (
				<View style={styles.pickerWrap}>
					<HorizontalCategoryPicker
						categories={categories}
						selectedCategoryId={categoryId}
						onSelectCategory={(id) => {
							setCategoryId(id);
							setPickerOpen(false);
						}}
						isIncome={isIncome}
					/>
				</View>
			)}

			<View style={styles.actions}>
				<ActionButton
					label={t('captures.confirm')}
					hint={t('captures.confirmHint', { category: category.name })}
					icon="checkmark"
					onPress={() => onConfirm(capture, categoryId)}
					primary
				/>
				<ActionButton
					label={t('captures.transfer')}
					hint={t('captures.transferHint')}
					icon="swap-horizontal"
					onPress={() => onTransfer(capture)}
				/>
				<ActionButton
					label={t('captures.dismiss')}
					hint={t('captures.dismissHint')}
					icon="close"
					onPress={() => onDismiss(capture)}
				/>
			</View>

			<Pressable
				onPress={() => setRawOpen((open) => !open)}
				accessibilityRole="button"
				accessibilityLabel={t('captures.originalNotification')}
				accessibilityState={{ expanded: rawOpen }}
				style={styles.rawToggle}
			>
				<Text style={styles.rawToggleText}>{t('captures.originalNotification')}</Text>
			</Pressable>
			{rawOpen && (
				<Text style={styles.raw} selectable>
					{capture.title ? `${capture.title}\n` : ''}
					{capture.text}
				</Text>
			)}
		</View>
	);
};

interface ResolvedRowProps {
	capture: Capture;
	categories: Category[];
	onRevert: (capture: Capture) => void;
	revertLabel: string;
}

const ResolvedRow: React.FC<ResolvedRowProps> = ({ capture, categories, onRevert, revertLabel }) => {
	const { t } = useTranslation();
	const isIncome = capture.direction === 'in';
	const category = categories.find((c) => c.id === capture.suggestedCategory);
	const status = t(`captures.status.${capture.status}`, { defaultValue: capture.status });
	const reason = capture.reason
		? t(`captures.reason.${capture.reason}`, { defaultValue: '', app: capture.appLabel })
		: '';
	const detail = capture.status === 'confirmed' && category ? category.name : reason;
	const summary = `${status}. ${isIncome ? '+' : '−'} ${formatCents(capture.amountCents)}, ${
		capture.counterparty ?? capture.appLabel
	}. ${detail}`;

	return (
		<View style={styles.resolvedRow}>
			<View style={styles.resolvedInfo} accessible accessibilityLabel={summary}>
				<Text style={styles.resolvedTitle}>
					<Text style={isIncome ? styles.income : styles.expense}>
						{isIncome ? '+' : '−'} {formatCents(capture.amountCents)}
					</Text>
					{'  '}
					{capture.counterparty ?? capture.appLabel}
				</Text>
				<Text style={styles.resolvedMeta}>
					{status}
					{detail ? ` · ${detail}` : ''} · {whenLabel(capture.postedAt)}
				</Text>
			</View>
			<Pressable
				onPress={() => onRevert(capture)}
				accessibilityRole="button"
				accessibilityLabel={`${revertLabel}: ${capture.counterparty ?? capture.appLabel}`}
				accessibilityHint={t('captures.revertHint')}
				style={({ pressed }) => [styles.revertButton, pressed && styles.buttonPressed]}
			>
				<Ionicons name="arrow-undo-outline" size={18} color={ACCENT} />
				<Text style={styles.revertLabel}>{revertLabel}</Text>
			</Pressable>
		</View>
	);
};

const CaptureInboxScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { categories } = useTransactions();
	const {
		supported,
		enabled,
		pending,
		resolved,
		isLoading,
		lastAction,
		refresh,
		openSettings,
		confirm,
		dismiss,
		markTransfer,
		answerDuplicate,
		answerTransfer,
		revert,
		undo,
		clearUndo,
	} = useCaptures();

	const [refreshing, setRefreshing] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [undoVisible, setUndoVisible] = useState(false);

	// A barra de desfazer some sozinha, mas sem pressa: oito segundos dá tempo de ler.
	useEffect(() => {
		if (!lastAction) {
			setUndoVisible(false);
			return;
		}
		setUndoVisible(true);
		const timer = setTimeout(() => {
			setUndoVisible(false);
			clearUndo();
		}, UNDO_WINDOW_MS);
		return () => clearTimeout(timer);
	}, [lastAction, clearUndo]);

	const byId = useMemo(() => {
		const map = new Map<string, Capture>();
		for (const capture of [...pending, ...resolved]) map.set(capture.id, capture);
		return map;
	}, [pending, resolved]);

	const autoApproved = useMemo(() => {
		const cutoff = Date.now() - AUTO_APPROVED_DAYS * 24 * 60 * 60 * 1000;
		return resolved.filter(
			(c) => c.autoConfirmed && c.status === 'confirmed' && new Date(c.updatedAt).getTime() >= cutoff
		);
	}, [resolved]);

	const announce = useCallback((message: string) => {
		AccessibilityInfo.announceForAccessibility(message);
	}, []);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refresh();
		} finally {
			setRefreshing(false);
		}
	}, [refresh]);

	const handleConfirm = useCallback(
		async (capture: Capture, categoryId: string) => {
			await confirm(capture.id, categoryId);
			const category = categories.find((c) => c.id === categoryId);
			announce(
				t('captures.announceConfirmed', {
					amount: formatCents(capture.amountCents),
					category: category?.name ?? '',
				})
			);
		},
		[confirm, categories, announce, t]
	);

	const handleDismiss = useCallback(
		async (capture: Capture) => {
			await dismiss(capture.id);
			announce(t('captures.announceDismissed'));
		},
		[dismiss, announce, t]
	);

	const handleTransfer = useCallback(
		async (capture: Capture) => {
			await markTransfer(capture.id);
			announce(t('captures.announceTransfer'));
		},
		[markTransfer, announce, t]
	);

	const handleAnswerDuplicate = useCallback(
		async (capture: Capture, same: boolean) => {
			await answerDuplicate(capture.id, same);
			announce(same ? t('captures.announceDuplicate') : t('captures.announceKeptBoth'));
		},
		[answerDuplicate, announce, t]
	);

	const handleAnswerTransfer = useCallback(
		async (capture: Capture, isTransfer: boolean) => {
			await answerTransfer(capture.id, isTransfer);
			announce(isTransfer ? t('captures.announceTransfer') : t('captures.announceKeptBoth'));
		},
		[answerTransfer, announce, t]
	);

	const handleRevert = useCallback(
		async (capture: Capture) => {
			await revert(capture.id);
			announce(t('captures.announceReverted'));
		},
		[revert, announce, t]
	);

	const handleUndo = useCallback(async () => {
		await undo();
		announce(t('captures.announceReverted'));
	}, [undo, announce, t]);

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />

			<View style={styles.header}>
				<Pressable
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('captures.back')}
					hitSlop={12}
					style={styles.backButton}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('captures.headerTitle')}
				</Text>
				<Text style={styles.headerCount} accessibilityLabel={t('captures.pendingCount', { count: pending.length })}>
					{pending.length > 0 ? pending.length : ''}
				</Text>
			</View>

			<ScrollView
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} colors={[ACCENT]} />
				}
			>
				{!supported && (
					<View style={styles.notice}>
						<Ionicons name="information-circle-outline" size={22} color={ACCENT} />
						<Text style={styles.noticeText}>{t('captures.notSupported')}</Text>
					</View>
				)}

				{supported && !enabled && (
					<View style={styles.setupCard}>
						<Text style={styles.setupTitle} accessibilityRole="header">
							{t('captures.setupTitle')}
						</Text>
						<Text style={styles.setupBody}>{t('captures.setupBody')}</Text>
						<ActionButton
							label={t('captures.setupButton')}
							hint={t('captures.setupHint')}
							icon="settings-outline"
							onPress={openSettings}
							primary
						/>
						<Text style={styles.setupHint}>{t('captures.setupHint')}</Text>
					</View>
				)}

				{pending.length === 0 && !isLoading && (supported ? enabled : false) && (
					<View style={styles.empty}>
						<Ionicons name="checkmark-done-circle-outline" size={40} color={ACCENT} />
						<Text style={styles.emptyText}>{t('captures.empty')}</Text>
					</View>
				)}

				{pending.map((capture) => (
					<CaptureCard
						key={capture.id}
						capture={capture}
						related={capture.relatedId ? (byId.get(capture.relatedId) ?? null) : null}
						categories={categories}
						onConfirm={handleConfirm}
						onDismiss={handleDismiss}
						onTransfer={handleTransfer}
						onAnswerDuplicate={handleAnswerDuplicate}
						onAnswerTransfer={handleAnswerTransfer}
					/>
				))}

				{pending.length > 0 && <Text style={styles.learned}>{t('captures.learned')}</Text>}

				{autoApproved.length > 0 && (
					<View style={styles.section}>
						<Text style={styles.sectionTitle} accessibilityRole="header">
							{t('captures.autoApprovedTitle')}
						</Text>
						<Text style={styles.sectionBody}>{t('captures.autoApprovedBody')}</Text>
						{autoApproved.map((capture) => (
							<ResolvedRow
								key={capture.id}
								capture={capture}
								categories={categories}
								onRevert={handleRevert}
								revertLabel={t('captures.undo')}
							/>
						))}
					</View>
				)}

				{resolved.length > 0 && (
					<View style={styles.section}>
						<Pressable
							onPress={() => setHistoryOpen((open) => !open)}
							accessibilityRole="button"
							accessibilityLabel={historyOpen ? t('captures.hideHistory') : t('captures.showHistory')}
							accessibilityState={{ expanded: historyOpen }}
							style={styles.historyToggle}
						>
							<Text style={styles.sectionTitle}>{t('captures.historyTitle')}</Text>
							<Ionicons name={historyOpen ? 'chevron-up' : 'chevron-down'} size={20} color="rgba(255,255,255,0.7)" />
						</Pressable>
						{historyOpen &&
							resolved.map((capture) => (
								<ResolvedRow
									key={capture.id}
									capture={capture}
									categories={categories}
									onRevert={handleRevert}
									revertLabel={t('captures.revert')}
								/>
							))}
					</View>
				)}
			</ScrollView>

			{undoVisible && lastAction && (
				<View style={styles.undoBar} accessibilityLiveRegion="polite">
					<Text style={styles.undoText}>{t(`captures.done.${lastAction.kind}`)}</Text>
					<Pressable
						onPress={handleUndo}
						accessibilityRole="button"
						accessibilityLabel={t('captures.undo')}
						style={({ pressed }) => [styles.undoButton, pressed && styles.buttonPressed]}
					>
						<Text style={styles.undoButtonText}>{t('captures.undo')}</Text>
					</Pressable>
				</View>
			)}
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 24,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	headerCount: {
		fontSize: 18,
		fontWeight: '600',
		color: ACCENT,
		minWidth: 32,
		textAlign: 'right',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	notice: {
		flexDirection: 'row',
		gap: 12,
		alignItems: 'center',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
	},
	noticeText: {
		flex: 1,
		color: 'rgba(255,255,255,0.85)',
		fontSize: 15,
		lineHeight: 21,
	},
	setupCard: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 12,
	},
	setupTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	setupBody: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.85)',
	},
	setupHint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
	},
	empty: {
		alignItems: 'center',
		gap: 12,
		paddingVertical: 40,
	},
	emptyText: {
		textAlign: 'center',
		color: 'rgba(255,255,255,0.75)',
		fontSize: 16,
		lineHeight: 22,
		paddingHorizontal: 16,
	},
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 12,
	},
	cardHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'flex-end',
		marginBottom: 6,
	},
	amount: {
		fontSize: 26,
		fontWeight: '700',
	},
	income: {
		color: '#4CAF50',
	},
	expense: {
		color: '#FF6B6B',
	},
	meta: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	counterparty: {
		fontSize: 17,
		fontWeight: '500',
		color: '#FFFFFF',
	},
	kind: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
		marginBottom: 12,
	},
	question: {
		backgroundColor: 'rgba(21, 232, 254, 0.08)',
		borderColor: 'rgba(21, 232, 254, 0.5)',
		borderWidth: 1,
		borderRadius: 10,
		padding: 12,
		marginBottom: 12,
		gap: 8,
	},
	questionTitle: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	questionBody: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.85)',
	},
	questionActions: {
		gap: 8,
		marginTop: 4,
	},
	categoryChip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 12,
		borderRadius: 10,
		backgroundColor: 'rgba(255,255,255,0.06)',
		marginBottom: 12,
	},
	categoryDot: {
		width: 26,
		height: 26,
		borderRadius: 13,
		alignItems: 'center',
		justifyContent: 'center',
	},
	categoryName: {
		flex: 1,
		fontSize: 16,
		color: '#FFFFFF',
	},
	pickerWrap: {
		marginBottom: 12,
	},
	actions: {
		gap: 8,
	},
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 16,
		borderRadius: 10,
		backgroundColor: 'rgba(255,255,255,0.08)',
	},
	buttonPrimary: {
		backgroundColor: ACCENT,
	},
	buttonDanger: {
		backgroundColor: 'rgba(255,107,107,0.15)',
	},
	buttonPressed: {
		opacity: 0.7,
	},
	buttonLabel: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	buttonLabelPrimary: {
		color: '#000000',
	},
	rawToggle: {
		minHeight: 44,
		justifyContent: 'center',
		marginTop: 4,
	},
	rawToggleText: {
		fontSize: 14,
		color: ACCENT,
	},
	raw: {
		fontSize: 13,
		lineHeight: 19,
		color: 'rgba(255,255,255,0.75)',
		backgroundColor: 'rgba(0,0,0,0.3)',
		borderRadius: 8,
		padding: 10,
	},
	learned: {
		fontSize: 13,
		lineHeight: 19,
		color: 'rgba(255,255,255,0.6)',
		marginVertical: 8,
		paddingHorizontal: 4,
	},
	section: {
		marginTop: 20,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	sectionBody: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 4,
		marginBottom: 8,
	},
	historyToggle: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		minHeight: 48,
	},
	resolvedRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		paddingVertical: 10,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.1)',
	},
	resolvedInfo: {
		flex: 1,
	},
	resolvedTitle: {
		fontSize: 15,
		color: '#FFFFFF',
	},
	resolvedMeta: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	revertButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 48,
		paddingHorizontal: 10,
	},
	revertLabel: {
		fontSize: 14,
		color: ACCENT,
	},
	undoBar: {
		position: 'absolute',
		left: 16,
		right: 16,
		bottom: 24,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		backgroundColor: '#2A2A2A',
		borderRadius: 12,
		paddingVertical: 8,
		paddingLeft: 16,
		paddingRight: 8,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	undoText: {
		flex: 1,
		fontSize: 15,
		color: '#FFFFFF',
	},
	undoButton: {
		minHeight: 44,
		paddingHorizontal: 16,
		justifyContent: 'center',
	},
	undoButtonText: {
		fontSize: 16,
		fontWeight: '700',
		color: ACCENT,
	},
});

export default CaptureInboxScreen;
