import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenTopBar from '../components/ScreenTopBar';
import { useTour } from '../components/tour/TourContext';
import { useAccounts } from '../contexts/AccountsContext';
import { useCaptures } from '../contexts/CapturesContext';
import { isTopicId, TOPICS, type TopicDef, type TourScreen } from '../utils/tour';

/**
 * Ajustes › Como usar (SPD-129): um tópico por função, com o texto inteiro para ler e, onde a
 * função tem tela com guia, "Mostrar na tela" — abre a tela e o guia aponta os botões dela.
 * No topo, "Rever as boas-vindas".
 *
 * Aberta com `?topic=` (o "?" de uma tela sem guia, ou com o guia sem nada para apontar), a
 * lista já vem rolada até o tópico, que fica destacado.
 *
 * "Mostrar na tela" some quando a tela não tem como mostrar: a captura num aparelho sem ela,
 * a fatura sem nenhum cartão cadastrado.
 */

const ACCENT = '#15E8FE';

const HowToScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const params = useLocalSearchParams<{ topic?: string }>();
	const focus = isTopicId(params.topic) ? params.topic : null;
	const tour = useTour();
	const { supported: captureSupported } = useCaptures();
	const { creditCards } = useAccounts();
	const scrollRef = useRef<ScrollView>(null);
	const scrolled = useRef(false);

	// Volta até a tela, se ela está embaixo na pilha (os Ajustes, as abas); senão, abre.
	const open = (screen: TourScreen) => {
		switch (screen) {
			case 'home':
				router.dismissTo('/(tabs)');
				return;
			case 'add':
				router.dismissTo('/(tabs)/add-transaction');
				return;
			case 'wealth':
				router.dismissTo('/(tabs)/wealth');
				return;
			case 'reports':
				router.dismissTo('/(tabs)/reports');
				return;
			case 'settings':
				router.dismissTo('/settings');
				return;
			case 'card':
				if (creditCards[0])
					router.push({ pathname: '/cards/[id]', params: { id: creditCards[0].id } });
				return;
			case 'cardEdit':
				router.push('/cards/new');
				return;
			case 'inbox':
				router.push('/inbox');
				return;
		}
	};

	const canShow = (topic: TopicDef): boolean =>
		Boolean(
			tour &&
				topic.link &&
				(!topic.needsCapture || captureSupported) &&
				(!topic.needsCard || creditCards.length > 0)
		);

	const show = (topic: TopicDef) => {
		if (!tour || !topic.link) return;
		tour.startTour(topic.link.screen, { only: topic.link.only, origin: 'howto' });
		open(topic.link.screen);
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<ScreenTopBar
				title={t('tutorial.howTo.title')}
				backLabel={t('tutorial.howTo.back')}
				onBack={() => router.back()}
			/>

			<ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
				<Pressable
					onPress={() => router.push({ pathname: '/onboarding', params: { review: '1' } })}
					accessibilityRole="button"
					accessibilityLabel={t('tutorial.howTo.reviewWelcome')}
					style={({ pressed }) => [styles.welcome, pressed && styles.pressed]}
				>
					<Ionicons name="sparkles-outline" size={22} color={ACCENT} />
					<Text style={styles.welcomeText}>{t('tutorial.howTo.reviewWelcome')}</Text>
					<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.5)" />
				</Pressable>

				{TOPICS.map((topic) => {
					const focused = topic.id === focus;
					return (
						<View
							key={topic.id}
							style={[styles.topic, focused && styles.topicFocused]}
							onLayout={(event) => {
								if (!focused || scrolled.current) return;
								scrolled.current = true;
								scrollRef.current?.scrollTo({
									y: Math.max(0, event.nativeEvent.layout.y - 8),
									animated: false,
								});
							}}
						>
							<Text style={styles.title} accessibilityRole="header">
								{t(`tutorial.topics.${topic.id}.title`)}
							</Text>
							<Text style={styles.body}>{t(`tutorial.topics.${topic.id}.body`)}</Text>
							{canShow(topic) ? (
								<Pressable
									onPress={() => show(topic)}
									accessibilityRole="button"
									accessibilityLabel={`${t('tutorial.howTo.showOnScreen')}: ${t(`tutorial.topics.${topic.id}.title`)}`}
									accessibilityHint={t('tutorial.howTo.showOnScreenHint')}
									style={({ pressed }) => [styles.show, pressed && styles.pressed]}
								>
									<Ionicons name="eye-outline" size={18} color="#000000" />
									<Text style={styles.showText}>{t('tutorial.howTo.showOnScreen')}</Text>
								</Pressable>
							) : null}
						</View>
					);
				})}
			</ScrollView>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 48,
		gap: 12,
	},
	welcome: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		minHeight: 56,
		paddingHorizontal: 16,
		borderRadius: 16,
		backgroundColor: '#1E1E1E',
	},
	welcomeText: {
		flex: 1,
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	topic: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
		gap: 8,
		borderWidth: 1,
		borderColor: 'transparent',
	},
	topicFocused: {
		borderColor: ACCENT,
	},
	title: {
		fontSize: 17,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	body: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.85)',
	},
	show: {
		alignSelf: 'flex-start',
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 48,
		paddingHorizontal: 16,
		marginTop: 4,
		borderRadius: 12,
		backgroundColor: ACCENT,
	},
	showText: {
		fontSize: 15,
		fontWeight: '700',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
});

export default HowToScreen;
