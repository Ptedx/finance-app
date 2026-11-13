import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native';
import { type MiraiEntry, useMirai } from '../../contexts/MiraiContext';
import type { MiraiExpression } from '../../utils/mirai/contract';
import { MIRAI_NAME_LIMIT } from '../../utils/mirai/preferences';
import MiraiAvatar from './MiraiAvatar';

/** As 3 sugestões da conversa vazia (§7), em cada grupo de telas. */
export const SUGGESTIONS = ['1', '2', '3'] as const;

export type MiraiSuggestionGroup =
	| 'default'
	| 'cards'
	| 'bills'
	| 'debts'
	| 'reports'
	| 'wealth'
	| 'transactions';

/**
 * O grupo de sugestões da tela de onde a conversa foi aberta (SPD-173): no cartão, perguntas de
 * fatura; nas contas a pagar, de contas. As telas sem grupo próprio usam as 3 de sempre.
 */
export const suggestionGroupOf = (screen: string | null): MiraiSuggestionGroup => {
	switch (screen) {
		case 'cards':
		case 'card':
		case 'debit_card':
			return 'cards';
		case 'bills':
			return 'bills';
		case 'debt':
			return 'debts';
		case 'reports':
			return 'reports';
		case 'wealth':
			return 'wealth';
		case 'transactions':
		case 'inbox':
		case 'unassigned':
			return 'transactions';
		default:
			return 'default';
	}
};

/** A partir de quantas perguntas restantes no dia a conversa avisa (SPD-174). */
export const REMAINING_WARNING = 3;

/**
 * A cara do Mirai no topo da conversa: pensando enquanto consulta, sem jeito (`sorry`) depois
 * de um erro dele, e no resto a da última resposta, que veio da marca de tom.
 */
export const chatExpression = (entries: readonly MiraiEntry[], busy: boolean): MiraiExpression => {
	if (busy) return 'thinking';
	const last = entries[entries.length - 1];
	if (!last) return 'normal';
	if (last.role === 'error') return 'sorry';
	if (last.role === 'mirai') return last.expression;
	return 'normal';
};

/**
 * A pergunta do app na primeira conversa (SPD-163e): como a pessoa quer ser chamada, com o
 * primeiro nome da conta já no campo. Não chama a API.
 */
const NamePrompt: React.FC<{ suggested: string; onSave: (name: string | null) => void }> = ({
	suggested,
	onSave,
}) => {
	const { t } = useTranslation();
	const [value, setValue] = useState(suggested);
	const canSave = value.trim().length > 0;
	return (
		<View style={styles.miraiRow} testID="mirai-name-prompt">
			<MiraiAvatar expression="normal" size={32} />
			<View style={[styles.bubble, styles.miraiBubble, styles.namePrompt]}>
				<Text style={styles.miraiText}>{t('mirai.namePrompt.question')}</Text>
				<TextInput
					testID="mirai-name-input"
					style={styles.nameInput}
					value={value}
					onChangeText={setValue}
					placeholder={t('mirai.namePrompt.placeholder')}
					placeholderTextColor="rgba(255, 255, 255, 0.4)"
					maxLength={MIRAI_NAME_LIMIT}
					autoCapitalize="words"
					returnKeyType="done"
					onSubmitEditing={() => canSave && onSave(value)}
				/>
				<Text style={styles.nameHint}>{t('mirai.nameSetting.hint')}</Text>
				<View style={styles.nameButtons}>
					<Pressable
						testID="mirai-name-skip"
						accessibilityRole="button"
						onPress={() => onSave(null)}
						hitSlop={8}
					>
						<Text style={styles.linkText}>{t('mirai.namePrompt.skip')}</Text>
					</Pressable>
					<Pressable
						testID="mirai-name-save"
						accessibilityRole="button"
						onPress={() => onSave(value)}
						disabled={!canSave}
						style={[styles.nameSave, !canSave && styles.sendDisabled]}
					>
						<Text style={styles.nameSaveText}>{t('mirai.namePrompt.save')}</Text>
					</Pressable>
				</View>
			</View>
		</View>
	);
};

/**
 * A conversa com o Mirai (SPD-163, §7): uma folha quase em tela cheia por cima da tela atual,
 * que fecha com o voltar. Fechar só esconde: a conversa dura enquanto o app está aberto na mesma
 * conta (SPD-171), e "Nova conversa" começa outra.
 */
const MiraiChatSheet: React.FC = () => {
	const { t } = useTranslation();
	const mirai = useMirai();
	const scroll = useRef<ScrollView>(null);
	const visible = mirai?.sheet === 'chat';

	// Ao reabrir uma conversa longa, ela abre no fim, como estava.
	useEffect(() => {
		if (visible) setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 0);
	}, [visible]);

	if (!mirai) return null;

	const { entries, busy, currentTool, draft, conversationSize, remainingToday } = mirai;
	const full = conversationSize === 'full';
	const canSend = !busy && !full && draft.trim().length > 0;
	const empty = entries.length === 0 && !busy;
	const group = suggestionGroupOf(mirai.screen);

	const answerText = (entry: Extract<MiraiEntry, { role: 'mirai' }>): string => {
		if (entry.kind === 'refusal') return t('mirai.chat.refusal');
		if (entry.text) return entry.text;
		if (entry.kind === 'cut') return '…';
		return t(entry.kind === 'incomplete' ? 'mirai.chat.incomplete' : 'mirai.chat.emptyAnswer');
	};

	const renderEntry = (entry: MiraiEntry) => {
		if (entry.role === 'user')
			return (
				<View key={entry.id} style={[styles.bubble, styles.userBubble]} testID="mirai-entry-user">
					<Text style={styles.userText} selectable>
						{entry.text}
					</Text>
				</View>
			);
		const expression = entry.role === 'error' ? 'sorry' : entry.expression;
		return (
			<View key={entry.id} style={styles.miraiRow} testID={`mirai-entry-${entry.role}`}>
				<MiraiAvatar
					expression={expression}
					size={32}
					testID={`mirai-entry-avatar-${expression}`}
				/>
				<View
					style={[styles.bubble, styles.miraiBubble, entry.role === 'error' && styles.errorBubble]}
				>
					<Text style={styles.miraiText} selectable>
						{entry.role === 'error' ? t(`mirai.errors.${entry.failure}`) : answerText(entry)}
					</Text>
					{entry.role === 'mirai' && entry.kind === 'cut' ? (
						<Text style={styles.cutNotice} testID="mirai-entry-cut">
							{t('mirai.chat.cut')}
						</Text>
					) : null}
					{entry.role === 'error' && entry.question && !busy ? (
						<Pressable
							testID="mirai-entry-retry"
							accessibilityRole="button"
							onPress={() => mirai.retry(entry.id)}
							hitSlop={8}
							style={styles.retry}
						>
							<Ionicons name="refresh" size={16} color="#15E8FE" />
							<Text style={styles.linkText}>{t('mirai.chat.retry')}</Text>
						</Pressable>
					) : null}
				</View>
			</View>
		);
	};

	const renderEmpty = () => {
		if (!empty) return null;
		// Ainda lendo o nome do aparelho: nada, para não piscar a pergunta.
		if (mirai.nameAsked === null) return null;
		if (!mirai.nameAsked)
			return <NamePrompt suggested={mirai.suggestedName} onSave={mirai.saveName} />;
		return (
			<View testID="mirai-chat-empty">
				<Text style={styles.greeting} testID="mirai-chat-greeting">
					{mirai.name
						? t('mirai.chat.greetingNamed', { name: mirai.name })
						: t('mirai.chat.greeting')}
				</Text>
				<Text style={styles.emptyText}>{t('mirai.chat.empty')}</Text>
				{SUGGESTIONS.map((key) => {
					const text = t(`mirai.suggestions.${group}.${key}`);
					return (
						<Pressable
							key={key}
							testID={`mirai-suggestion-${key}`}
							accessibilityRole="button"
							onPress={() => mirai.ask(text)}
							style={styles.suggestion}
						>
							<Text style={styles.suggestionText}>{text}</Text>
						</Pressable>
					);
				})}
			</View>
		);
	};

	return (
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={mirai.close}
			statusBarTranslucent
		>
			<KeyboardAvoidingView
				style={styles.backdrop}
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
			>
				<View style={styles.sheet} testID="mirai-chat">
					<View style={styles.header}>
						<MiraiAvatar
							expression={chatExpression(entries, busy)}
							size={40}
							testID="mirai-chat-avatar"
						/>
						<Text style={styles.title} accessibilityRole="header">
							{t('mirai.name')}
						</Text>
						<Pressable
							testID="mirai-chat-clear"
							accessibilityRole="button"
							onPress={mirai.clear}
							disabled={empty}
							hitSlop={8}
						>
							<Text style={[styles.clear, empty && styles.clearDisabled]}>
								{t('mirai.chat.clear')}
							</Text>
						</Pressable>
						<Pressable
							testID="mirai-chat-close"
							accessibilityRole="button"
							accessibilityLabel={t('mirai.chat.close')}
							onPress={mirai.close}
							hitSlop={12}
							style={styles.closeButton}
						>
							<Ionicons name="close" size={24} color="#FFFFFF" />
						</Pressable>
					</View>
					<Text style={styles.disclaimer}>{t('mirai.chat.disclaimer')}</Text>

					<ScrollView
						ref={scroll}
						style={styles.list}
						contentContainerStyle={styles.listContent}
						onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
						keyboardShouldPersistTaps="handled"
					>
						{renderEmpty()}
						{entries.map(renderEntry)}
						{busy ? (
							<View style={styles.miraiRow} testID="mirai-chat-progress">
								<MiraiAvatar expression="thinking" size={32} />
								<Text style={styles.progress}>
									{currentTool ? t(`mirai.progress.${currentTool}`) : t('mirai.progress.thinking')}
								</Text>
								<Pressable
									testID="mirai-chat-stop"
									accessibilityRole="button"
									onPress={mirai.stop}
									hitSlop={8}
									style={styles.stop}
								>
									<Ionicons name="stop-circle-outline" size={18} color="#15E8FE" />
									<Text style={styles.linkText}>{t('mirai.chat.stop')}</Text>
								</Pressable>
							</View>
						) : null}
					</ScrollView>

					{conversationSize === 'long' ? (
						<Text style={styles.footNote} testID="mirai-chat-long">
							{t('mirai.chat.long')}
						</Text>
					) : null}
					{remainingToday !== null && remainingToday <= REMAINING_WARNING && !full ? (
						<Text style={styles.footNote} testID="mirai-chat-remaining">
							{t('mirai.chat.remaining', { count: remainingToday })}
						</Text>
					) : null}

					{full ? (
						<View style={styles.fullRow} testID="mirai-chat-full">
							<Text style={styles.fullText}>{t('mirai.chat.full')}</Text>
							<Pressable
								testID="mirai-chat-new"
								accessibilityRole="button"
								onPress={mirai.clear}
								style={styles.nameSave}
							>
								<Text style={styles.nameSaveText}>{t('mirai.chat.clear')}</Text>
							</Pressable>
						</View>
					) : (
						<View style={styles.inputRow}>
							<TextInput
								testID="mirai-chat-input"
								style={styles.input}
								value={draft}
								onChangeText={mirai.setDraft}
								placeholder={t('mirai.chat.placeholder')}
								placeholderTextColor="rgba(255, 255, 255, 0.4)"
								multiline
								maxLength={1000}
								editable={!busy}
							/>
							<Pressable
								testID="mirai-chat-send"
								accessibilityRole="button"
								accessibilityLabel={t('mirai.chat.send')}
								onPress={() => mirai.ask()}
								disabled={!canSend}
								style={[styles.send, !canSend && styles.sendDisabled]}
							>
								<Ionicons name="arrow-up" size={22} color="#000000" />
							</Pressable>
						</View>
					)}
				</View>
			</KeyboardAvoidingView>
		</Modal>
	);
};

const styles = StyleSheet.create({
	backdrop: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.6)',
		justifyContent: 'flex-end',
	},
	sheet: {
		height: '94%',
		backgroundColor: '#1A1A1A',
		borderTopLeftRadius: 20,
		borderTopRightRadius: 20,
		paddingBottom: 16,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingTop: 14,
		gap: 10,
	},
	title: {
		flex: 1,
		color: '#FFFFFF',
		fontSize: 20,
		fontWeight: '700',
	},
	clear: {
		color: '#15E8FE',
		fontSize: 14,
	},
	clearDisabled: {
		color: 'rgba(255, 255, 255, 0.3)',
	},
	closeButton: {
		marginLeft: 6,
	},
	disclaimer: {
		color: 'rgba(255, 255, 255, 0.5)',
		fontSize: 12,
		paddingHorizontal: 16,
		paddingTop: 6,
		paddingBottom: 8,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: 'rgba(255, 255, 255, 0.15)',
	},
	list: {
		flex: 1,
	},
	listContent: {
		padding: 16,
		gap: 12,
	},
	greeting: {
		color: '#FFFFFF',
		fontSize: 18,
		fontWeight: '600',
		marginBottom: 6,
	},
	emptyText: {
		color: 'rgba(255, 255, 255, 0.8)',
		fontSize: 15,
		lineHeight: 21,
		marginBottom: 12,
	},
	suggestion: {
		borderWidth: 1,
		borderColor: 'rgba(38, 198, 218, 0.5)',
		borderRadius: 14,
		paddingVertical: 10,
		paddingHorizontal: 14,
		marginBottom: 8,
	},
	suggestionText: {
		color: '#FFFFFF',
		fontSize: 14,
	},
	bubble: {
		borderRadius: 14,
		paddingVertical: 10,
		paddingHorizontal: 14,
		maxWidth: '85%',
	},
	userBubble: {
		alignSelf: 'flex-end',
		backgroundColor: 'rgba(21, 232, 254, 0.18)',
	},
	userText: {
		color: '#FFFFFF',
		fontSize: 15,
		lineHeight: 21,
	},
	miraiRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 8,
	},
	miraiBubble: {
		flexShrink: 1,
		backgroundColor: '#252A31',
	},
	errorBubble: {
		backgroundColor: 'rgba(255, 213, 79, 0.12)',
	},
	miraiText: {
		color: '#FFFFFF',
		fontSize: 15,
		lineHeight: 21,
	},
	cutNotice: {
		color: 'rgba(255, 255, 255, 0.6)',
		fontSize: 13,
		fontStyle: 'italic',
		marginTop: 8,
	},
	retry: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		marginTop: 8,
	},
	linkText: {
		color: '#15E8FE',
		fontSize: 14,
	},
	progress: {
		flex: 1,
		color: 'rgba(255, 255, 255, 0.7)',
		fontSize: 14,
		fontStyle: 'italic',
		alignSelf: 'center',
	},
	stop: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
		alignSelf: 'center',
	},
	namePrompt: {
		flex: 1,
		maxWidth: undefined,
		gap: 10,
	},
	nameHint: {
		color: 'rgba(255, 255, 255, 0.55)',
		fontSize: 12,
		lineHeight: 16,
	},
	nameInput: {
		minHeight: 44,
		backgroundColor: '#1A1A1A',
		borderRadius: 10,
		paddingHorizontal: 12,
		color: '#FFFFFF',
		fontSize: 15,
	},
	nameButtons: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 16,
	},
	nameSave: {
		backgroundColor: '#15E8FE',
		borderRadius: 18,
		paddingVertical: 8,
		paddingHorizontal: 16,
	},
	nameSaveText: {
		color: '#000000',
		fontSize: 14,
		fontWeight: '600',
	},
	footNote: {
		color: 'rgba(255, 255, 255, 0.6)',
		fontSize: 12,
		textAlign: 'center',
		paddingHorizontal: 16,
		paddingTop: 6,
	},
	fullRow: {
		alignItems: 'center',
		gap: 10,
		paddingHorizontal: 16,
		paddingTop: 10,
	},
	fullText: {
		color: 'rgba(255, 255, 255, 0.8)',
		fontSize: 14,
		textAlign: 'center',
	},
	inputRow: {
		flexDirection: 'row',
		alignItems: 'flex-end',
		paddingHorizontal: 12,
		paddingTop: 8,
		gap: 8,
	},
	input: {
		flex: 1,
		minHeight: 44,
		maxHeight: 120,
		backgroundColor: '#252A31',
		borderRadius: 14,
		paddingHorizontal: 14,
		paddingVertical: 10,
		color: '#FFFFFF',
		fontSize: 15,
	},
	send: {
		width: 44,
		height: 44,
		borderRadius: 22,
		backgroundColor: '#15E8FE',
		alignItems: 'center',
		justifyContent: 'center',
	},
	sendDisabled: {
		opacity: 0.4,
	},
});

export default MiraiChatSheet;
