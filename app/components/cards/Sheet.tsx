import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Alert,
	Keyboard,
	KeyboardAvoidingView,
	type LayoutChangeEvent,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import HelpTip from '../tour/HelpTip';

/**
 * Folha que sobe do rodapé, para ações curtas sobre um cartão.
 *
 * Por que folha e não tela: pagar ou ajustar uma fatura é uma pergunta com um ou dois
 * campos, e o contexto (o cartão) continua visível atrás. Fechar é tocar fora, no X ou
 * usar o voltar do Android.
 *
 * O voltar do Android com o teclado aberto fecha só o teclado (E2E-05). O Modal entrega o
 * voltar à folha mesmo quando o teclado também o trata, e a folha fechava levando o que
 * estava digitado. O teclado conta como aberto pelos eventos do `Keyboard` ou enquanto um
 * campo tem o foco: no Android o teclado pode se fechar com o mesmo voltar antes de ele
 * chegar aqui, e o campo continua focado. Tirar o foco deixa o próximo voltar fechar.
 *
 * O foco só conta se mudou depois que a folha abriu (E2E-44). Um campo da tela de trás (o
 * Valor do novo lançamento) pode seguir focado sem teclado na tela, e o `Keyboard.dismiss()`
 * não tira esse foco: o 1º voltar era engolido. A folha guarda o campo que tinha o foco ao
 * abrir e não conta esse; um campo da própria folha é outro. Não há jeito público de saber
 * se um campo está dentro da folha, e olhar só os eventos do teclado perderia o caso de cima
 * (o teclado já se fechou quando o voltar chega). O campo é guardado no render que abre a
 * folha, antes de um campo dela pegar o foco sozinho (`autoFocus`).
 *
 * Com `confirmDiscard`, fechar (voltar, X ou toque fora) pergunta antes de descartar o que
 * foi digitado.
 *
 * O "?" (`help`): sem `tip`, faz `onPress` direto. Com `tip` (SPD-135), mostra a dica rápida
 * (`HelpTip`) logo abaixo do título, e o `onPress` passa a ser o link "Ver o guia completo",
 * que pergunta antes de sair quando há algo digitado (`confirmDiscard`). Tocar de novo no "?"
 * ou fora da dica (no fundo, sobre os campos, ou o voltar) fecha só a dica: a folha fica.
 *
 * Acessibilidade: `accessibilityViewIsModal` prende o leitor de tela dentro da folha; o
 * título é o primeiro elemento e é cabeçalho; o X tem 48 pontos e rótulo; o fundo que
 * fecha ao toque é escondido do leitor de tela para não virar um botão sem nome.
 */

interface SheetProps {
	visible: boolean;
	title: string;
	subtitle?: string;
	onClose: () => void;
	/** Há algo digitado e não salvo: fechar pergunta antes de descartar. */
	confirmDiscard?: boolean;
	/**
	 * Um "?" ao lado do X (SPD-129): o rótulo e o que ele abre. Com `tip` (SPD-135), o "?"
	 * mostra a dica e o `onPress` é o link dela para o guia completo.
	 */
	help?: { label: string; onPress: () => void; tip?: string };
	children: React.ReactNode;
}

// `State?.`: no jest o TextInput é um mock sem `State`.
const focusedInput = (): unknown => TextInput.State?.currentlyFocusedInput() ?? null;

/**
 * O teclado está aberto, ou acabou de se fechar e o campo segue com o foco. Não conta o
 * campo que já tinha o foco quando a folha abriu (`focusedAtOpen`, o da tela de trás).
 */
const keyboardOpen = (focusedAtOpen: unknown): boolean => {
	if (Keyboard.isVisible()) return true;
	const focused = focusedInput();
	return focused != null && focused !== focusedAtOpen;
};

const Sheet: React.FC<SheetProps> = ({ visible, title, subtitle, onClose, confirmDiscard = false, help, children }) => {
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();
	// O campo com o foco quando a folha abre, olhado de novo a cada abertura.
	const wasVisible = useRef(false);
	const focusedAtOpen = useRef<unknown>(null);
	if (visible && !wasVisible.current) focusedAtOpen.current = focusedInput();
	wasVisible.current = visible;
	// A dica do "?" e onde a área dos campos começa (abaixo do título e da dica), para o toque
	// sobre os campos fechar a dica.
	const [tipOpen, setTipOpen] = useState(false);
	const [tipBottom, setTipBottom] = useState(0);
	const tipText = help?.tip;

	useEffect(() => {
		if (!visible) setTipOpen(false);
	}, [visible]);

	const closeTip = () => setTipOpen(false);

	const onHeaderLayout = (event: LayoutChangeEvent) => {
		const { y, height } = event.nativeEvent.layout;
		setTipBottom(y + height);
	};

	const requestClose = () => {
		if (!confirmDiscard) {
			onClose();
			return;
		}
		Alert.alert(
			t('cards.discard.title'),
			t('cards.discard.body'),
			[
				{ text: t('cards.discard.keep'), style: 'cancel' },
				{ text: t('cards.discard.confirm'), style: 'destructive', onPress: onClose },
			],
			{ cancelable: true }
		);
	};

	const onBack = () => {
		if (keyboardOpen(focusedAtOpen.current)) {
			Keyboard.dismiss();
			return;
		}
		if (tipOpen) {
			closeTip();
			return;
		}
		requestClose();
	};

	return (
		<Modal visible={visible} transparent animationType="slide" onRequestClose={onBack} statusBarTranslucent>
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
				<Pressable
					style={styles.backdrop}
					onPress={tipOpen ? closeTip : requestClose}
					accessible={false}
					importantForAccessibility="no-hide-descendants"
				/>
				<View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityViewIsModal>
					<View style={styles.handle} accessible={false} />
					<View onLayout={onHeaderLayout}>
						<View style={styles.header}>
							<View style={styles.titles}>
								<Text style={styles.title} accessibilityRole="header">
									{title}
								</Text>
								{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
							</View>
							{help ? (
								<Pressable
									onPress={tipText ? () => setTipOpen((open) => !open) : help.onPress}
									accessibilityRole="button"
									accessibilityLabel={help.label}
									accessibilityHint={tipText ? t('tutorial.tip.toggleHint') : undefined}
									accessibilityState={tipText ? { expanded: tipOpen } : undefined}
									style={({ pressed }) => [styles.close, pressed && styles.pressed]}
								>
									<Ionicons name="help-circle-outline" size={24} color="#FFFFFF" />
								</Pressable>
							) : null}
							<Pressable
								onPress={requestClose}
								accessibilityRole="button"
								accessibilityLabel={t('cards.close')}
								style={({ pressed }) => [styles.close, pressed && styles.pressed]}
							>
								<Ionicons name="close" size={24} color="#FFFFFF" />
							</Pressable>
						</View>
						{help && tipText && tipOpen ? (
							<HelpTip text={tipText} onOpenGuide={help.onPress} confirmLeave={confirmDiscard} />
						) : null}
					</View>
					<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
						{children}
					</ScrollView>
					{tipOpen ? (
						// Por cima dos campos enquanto a dica está aberta: o toque fecha a dica e não
						// chega ao campo (a dica some e os campos sobem, o toque cairia em outro lugar).
						<Pressable
							testID="sheet-tip-dismiss"
							style={[styles.tipDismiss, { top: tipBottom }]}
							onPress={closeTip}
							accessible={false}
							importantForAccessibility="no"
						/>
					) : null}
				</View>
			</KeyboardAvoidingView>
		</Modal>
	);
};

const styles = StyleSheet.create({
	flex: {
		flex: 1,
		justifyContent: 'flex-end',
	},
	backdrop: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: 'rgba(0,0,0,0.6)',
	},
	sheet: {
		backgroundColor: '#1C1C1E',
		borderTopLeftRadius: 20,
		borderTopRightRadius: 20,
		paddingHorizontal: 16,
		paddingTop: 8,
		maxHeight: '90%',
	},
	handle: {
		alignSelf: 'center',
		width: 40,
		height: 4,
		borderRadius: 2,
		backgroundColor: 'rgba(255,255,255,0.3)',
		marginBottom: 8,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 8,
		marginBottom: 8,
	},
	titles: {
		flex: 1,
		paddingTop: 10,
	},
	title: {
		fontSize: 20,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	subtitle: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.75)',
		marginTop: 4,
	},
	close: {
		width: 48,
		height: 48,
		borderRadius: 24,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pressed: {
		opacity: 0.6,
	},
	body: {
		gap: 14,
		paddingBottom: 8,
	},
	tipDismiss: {
		position: 'absolute',
		left: 0,
		right: 0,
		bottom: 0,
	},
});

export default Sheet;
