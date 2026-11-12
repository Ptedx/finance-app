import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';
import type { TopicId, TourScreen } from '../../utils/tour';
import type { TrailId, TrailLocation } from '../../utils/trails';
import { useTour } from './TourContext';

/**
 * O "?" no cabeçalho das telas mais confusas (SPD-129): começa o guia da tela, ou abre o
 * tópico de Ajustes › Como usar onde não há guia (e quando o guia não tem o que apontar).
 *
 * Com `trail` (SPD-131), abre a trilha: o guia anda pelas telas a partir daqui (`here`, onde
 * a trilha termina), começando no passo `from` (sem ele, no primeiro).
 */
const HelpButton: React.FC<{
	screen?: TourScreen;
	topic?: TopicId;
	trail?: TrailId;
	here?: TrailLocation;
	from?: string;
	/** A cor do "?": branco nos cabeçalhos; escuro nos avisos claros da tela inicial. */
	color?: string;
	onBeforeOpen?: () => void;
}> = ({ screen, topic, trail, here, from, color = '#FFFFFF', onBeforeOpen }) => {
	const { t } = useTranslation();
	const tour = useTour();

	const onPress = () => {
		if (!tour) return;
		onBeforeOpen?.();
		if (trail && here) tour.startTrail(trail, { here, from });
		else if (screen) tour.startTour(screen, { origin: 'help' });
		else if (topic) tour.openTopic(topic);
	};

	let label = t('tutorial.help');
	let hint = screen ? t('tutorial.helpHint') : t('tutorial.helpTopicHint');
	if (trail) {
		label = t('trails.help');
		hint = t('trails.helpHint', { trail: t(`trails.${trail}.title`) });
	}

	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={hint}
			style={({ pressed }) => [styles.button, pressed && styles.pressed]}
		>
			<Ionicons name="help-circle-outline" size={24} color={color} />
		</Pressable>
	);
};

const styles = StyleSheet.create({
	button: {
		width: 48,
		height: 48,
		borderRadius: 24,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pressed: {
		opacity: 0.6,
	},
});

export default HelpButton;
