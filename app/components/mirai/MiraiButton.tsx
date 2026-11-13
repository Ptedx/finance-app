import { usePathname } from 'expo-router';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable, StyleSheet } from 'react-native';
import { useMirai } from '../../contexts/MiraiContext';
import { todayISO } from '../../utils/dateUtils';
import {
	buttonExpression,
	MIRAI_BUTTON_BOTTOM,
	MIRAI_BUTTON_RIGHT,
	MIRAI_BUTTON_SIZE,
	miraiScreenOf,
	shouldShowMiraiButton,
} from '../../utils/mirai/button';
import { useGuideOpen } from '../tour/TourContext';
import MiraiAvatar from './MiraiAvatar';

/** O teclado está aberto: o botão sai da frente do campo. */
const useKeyboardOpen = (): boolean => {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const shown = Keyboard.addListener('keyboardDidShow', () => setOpen(true));
		const hidden = Keyboard.addListener('keyboardDidHide', () => setOpen(false));
		return () => {
			shown.remove();
			hidden.remove();
		};
	}, []);
	return open;
};

/**
 * O botão flutuante do Mirai (SPD-163, §7 e D8): redondo, 52 dp, no canto inferior direito,
 * acima da barra de abas e longe do "+". Quando aparece e com que cara está em
 * `utils/mirai/button.ts`.
 */
const MiraiButton: React.FC<{ locked?: boolean }> = ({ locked = false }) => {
	const { t } = useTranslation();
	const mirai = useMirai();
	const guideOpen = useGuideOpen();
	const pathname = usePathname();
	const keyboardOpen = useKeyboardOpen();

	if (!mirai) return null;
	const visible = shouldShowMiraiButton({
		enabled: mirai.enabled,
		turnedOff: mirai.choice === 'off',
		pathname,
		keyboardOpen,
		guideOpen,
		sheetOpen: mirai.sheet !== 'none',
		locked,
	});
	if (!visible) return null;

	const expression = buttonExpression({
		busy: mirai.busy,
		goalDay: mirai.goalDay,
		today: todayISO(),
	});

	return (
		<Pressable
			testID="mirai-button"
			accessibilityRole="button"
			accessibilityLabel={t('mirai.buttonLabel')}
			onPress={() => mirai.openFromButton(miraiScreenOf(pathname))}
			style={({ pressed }) => [styles.button, pressed && styles.pressed]}
			hitSlop={6}
		>
			<MiraiAvatar expression={expression} size={MIRAI_BUTTON_SIZE - 6} />
		</Pressable>
	);
};

const styles = StyleSheet.create({
	button: {
		position: 'absolute',
		right: MIRAI_BUTTON_RIGHT,
		bottom: MIRAI_BUTTON_BOTTOM,
		width: MIRAI_BUTTON_SIZE,
		height: MIRAI_BUTTON_SIZE,
		borderRadius: MIRAI_BUTTON_SIZE / 2,
		backgroundColor: '#1B1F24',
		borderWidth: 1,
		borderColor: '#2E3440',
		alignItems: 'center',
		justifyContent: 'center',
		// Um pouco translúcido e com sombra leve, para não esconder valor por baixo.
		opacity: 0.92,
		elevation: 4,
		shadowColor: '#000000',
		shadowOpacity: 0.3,
		shadowRadius: 4,
		shadowOffset: { width: 0, height: 2 },
		overflow: 'hidden',
	},
	pressed: {
		opacity: 1,
	},
});

export default MiraiButton;
