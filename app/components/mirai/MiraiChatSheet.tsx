import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useRef } from 'react';
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
import MiraiAvatar from './MiraiAvatar';

/** As 3 sugestões da conversa vazia (§7). */
export const SUGGESTIONS = ['1', '2', '3'] as const;

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
 * A conversa com o Mirai (SPD-163, §7): uma folha quase em tela cheia por cima da tela atual,
 * que fecha com o voltar. Fechar apaga a conversa (D5).
 */
const MiraiChatSheet: React.FC = () => {
	const { t } = useTranslation();
	const mirai = useMirai();
	const scroll = useRef<ScrollView>(null);
	if (!mirai) return null;

	const { entries, busy, currentTool, draft } = mirai;
	const canSend = !busy && draft.trim().length > 0;

	const answerText = (entry: Extract<MiraiEntry, { role: 'mirai' }>): string => {
		if (entry.kind === 'refusal') return t('mirai.chat.refusal');
		if (entry.text) return entry.text;
		return t(entry.kind === 'incomplete' ? 'mirai.chat.incomplete' : 'mirai.chat.emptyAnswer');
	};

	const renderEntry = (entry: MiraiEntry) => {
		if (entry.role === 'user')
			return (
				<View key={entry.id} style={[styles.bubble, styles.userBubble]} testID="mirai-entry-user">
					<Text style={styles.userText}>{entry.text}</Text>
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
				</View>
			</View>
		);
	};

	return (
		<Modal
			visible={mirai.sheet === 'chat'}
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
							disabled={entries.length === 0 && !busy}
							hitSlop={8}
						>
							<Text style={[styles.clear, entries.length === 0 && !busy && styles.clearDisabled]}>
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
						{entries.length === 0 && !busy ? (
							<View testID="mirai-chat-empty">
								<Text style={styles.emptyText}>{t('mirai.chat.empty')}</Text>
								{SUGGESTIONS.map((key) => (
									<Pressable
										key={key}
										testID={`mirai-suggestion-${key}`}
										accessibilityRole="button"
										onPress={() => mirai.ask(t(`mirai.suggestions.${key}`))}
										style={styles.suggestion}
									>
										<Text style={styles.suggestionText}>{t(`mirai.suggestions.${key}`)}</Text>
									</Pressable>
								))}
							</View>
						) : null}
						{entries.map(renderEntry)}
						{busy ? (
							<View style={styles.miraiRow} testID="mirai-chat-progress">
								<MiraiAvatar expression="thinking" size={32} />
								<Text style={styles.progress}>
									{currentTool ? t(`mirai.progress.${currentTool}`) : t('mirai.progress.thinking')}
								</Text>
							</View>
						) : null}
					</ScrollView>

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
	progress: {
		color: 'rgba(255, 255, 255, 0.7)',
		fontSize: 14,
		fontStyle: 'italic',
		alignSelf: 'center',
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
