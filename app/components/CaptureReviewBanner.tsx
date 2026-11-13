import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { requestCaptureRebind } from '../../modules/spendr-captures';
import { useAccounts } from '../contexts/AccountsContext';
import { useCaptures } from '../contexts/CapturesContext';
import {
	CAPTURE_STALLED_DISMISSED_KEY,
	captureWarning,
	parseStalledDismissedAt,
} from '../utils/captureHealth';
import { STORAGE_KEYS } from '../utils/storageUtils';
import HelpButton from './tour/HelpButton';
import { TourTarget, useTourTarget } from './tour/TourContext';
import { SampleTag, useSampleHome } from './tour/TrailSample';

/**
 * "3 lançamentos para revisar" no topo da tela inicial.
 *
 * Só aparece quando há algo a fazer: sem pendência, sem faixa. Não insiste, não
 * vibra, não manda notificação — o selo na aba e esta faixa são o único aviso, e os
 * itens esperam o tempo que for preciso.
 *
 * E o contrário: quando o Android não está entregando notificações a este app, a faixa
 * avisa. O acesso se perde a cada reinstalação, e o app de desenvolvimento aparece ao lado
 * na lista do sistema — sem aviso, a captura parava em silêncio. Dá para dispensar.
 *
 * Com o acesso ligado a captura ainda pode parar: o Android desvincula o serviço e não
 * conta a ninguém. Quem tem conta ligada a app de banco e passa 3 dias sem aviso vê "Não
 * recebemos avisos do seu banco há N dias" (`utils/captureHealth.ts`, SPD-021). Essa
 * dispensa vale 7 dias: o silêncio pode ser só uma semana sem gastar.
 *
 * Na Trilha 21 sem nada para revisar (SPD-160), a faixa aparece de exemplo, com 1 aviso e o selo
 * "Exemplo", para o passo dela apontar. Tocar nela não abre nada, e a contagem de verdade (a da
 * aba e a da revisão) continua a do `CapturesContext`.
 */

interface Dismissals {
	off: boolean;
	stalledAt: number | null;
}

const WarningBanner: React.FC<{
	icon: React.ComponentProps<typeof Ionicons>['name'];
	text: string;
	action: string;
	hint: string;
	dismissLabel: string;
	onPress: () => void;
	onDismiss: () => void;
	/** O alvo da trilha da captura (SPD-131) e o "?" dela. */
	tourId?: string;
	help?: React.ReactNode;
}> = ({ icon, text, action, hint, dismissLabel, onPress, onDismiss, tourId, help }) => (
	<TourTarget id={tourId} style={[styles.banner, styles.warning]}>
		<Ionicons name={icon} size={22} color="#000000" />
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${text}. ${action}`}
			accessibilityHint={hint}
			style={({ pressed }) => [styles.warningBody, pressed && styles.pressed]}
		>
			<Text style={styles.text}>{text}</Text>
			<Text style={styles.action}>{action}</Text>
		</Pressable>
		{help}
		<Pressable
			onPress={onDismiss}
			accessibilityRole="button"
			accessibilityLabel={dismissLabel}
			hitSlop={12}
			style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
		>
			<Ionicons name="close" size={20} color="#000000" />
		</Pressable>
	</TourTarget>
);

const CaptureReviewBanner: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { pendingCount, supported, enabled, openSettings, pending, resolved, lastNotificationAt } = useCaptures();
	const { activeAccounts } = useAccounts();
	// Nulo até a primeira leitura: nenhum aviso pisca antes de saber se foi dispensado.
	const [dismissals, setDismissals] = useState<Dismissals | null>(null);
	// O "Revisar" é um passo do guia da tela inicial (SPD-129), quando aparece.
	const reviewTarget = useTourTarget('home.review');
	const { reviewCount: sampleCount } = useSampleHome({ review: pendingCount > 0 });

	// A dispensa é relida ao ganhar foco e ao voltar ao primeiro plano, não só ao montar:
	// o primeiro login num aparelho a apaga (`AuthContext`) com a Home montada por baixo, e
	// o aviso só voltava quando o app era reaberto. A releitura também recalcula os dias
	// sem aviso, que andam com o relógio.
	const readDismissed = useCallback(() => {
		Promise.all([
			AsyncStorage.getItem(STORAGE_KEYS.captureAccessDismissed),
			AsyncStorage.getItem(CAPTURE_STALLED_DISMISSED_KEY),
		])
			.then(([off, stalled]) =>
				setDismissals({ off: off === '1', stalledAt: parseStalledDismissedAt(stalled) })
			)
			.catch(() => setDismissals({ off: false, stalledAt: null }));
	}, []);

	useFocusEffect(readDismissed);

	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') readDismissed();
		});
		return () => subscription.remove();
	}, [readDismissed]);

	const captures = useMemo(() => [...pending, ...resolved], [pending, resolved]);

	const warning = dismissals
		? captureWarning({
				supported,
				enabled,
				offDismissed: dismissals.off,
				stalledDismissedAt: dismissals.stalledAt,
				accounts: activeAccounts,
				captures,
				// O histórico à mão pode ser só extrato; o último aviso real vem do banco (SPD-112).
				lastNotificationAt,
				now: Date.now(),
			})
		: null;

	// A faixa de exemplo: só o texto e o selo, sem o "?" (a trilha já está aberta) e sem abrir nada.
	const sampleLabel = sampleCount ? t('captures.homeBanner', { count: sampleCount }) : null;
	const sample = sampleLabel ? (
		<View
			{...reviewTarget}
			testID="home-sample-review"
			accessible
			accessibilityLabel={`${t('trails.sample.tag')}. ${sampleLabel}`}
			style={styles.banner}
		>
			<Ionicons name="notifications-outline" size={22} color="#000000" />
			<Text style={styles.text} numberOfLines={2}>
				{sampleLabel}
			</Text>
			<SampleTag />
		</View>
	) : null;

	if (warning?.kind === 'off') {
		return (
			<>
				<WarningBanner
					icon="notifications-off-outline"
					text={t('captures.accessOff')}
					action={t('captures.accessOffAction')}
					hint={t('captures.accessOffHint')}
					dismissLabel={t('captures.accessOffDismiss')}
					tourId="home.captureOff"
					help={<HelpButton trail="capture" here={{ screen: 'home' }} from="11" color="#000000" />}
					onPress={openSettings}
					onDismiss={() => {
						setDismissals((current) => ({ off: true, stalledAt: current?.stalledAt ?? null }));
						AsyncStorage.setItem(STORAGE_KEYS.captureAccessDismissed, '1').catch(() => {});
					}}
				/>
				{sample}
			</>
		);
	}

	if (warning?.kind === 'stalled') {
		return (
			<>
				<WarningBanner
					icon="cloud-offline-outline"
					text={t('captures.stalled', { count: warning.days })}
					action={t('captures.stalledAction')}
					hint={t('captures.stalledHint')}
					dismissLabel={t('captures.stalledDismiss')}
					tourId="home.captureStalled"
					help={<HelpButton trail="capture" here={{ screen: 'home' }} from="12" color="#000000" />}
					// O pedido de religar é silencioso e o Android pode ignorá-lo; a tela do sistema
					// fica aberta para o usuário desligar e ligar o acesso, que sempre funciona.
					onPress={() => {
						requestCaptureRebind();
						openSettings();
					}}
					onDismiss={() => {
						const at = Date.now();
						setDismissals((current) => ({ off: current?.off ?? false, stalledAt: at }));
						AsyncStorage.setItem(CAPTURE_STALLED_DISMISSED_KEY, String(at)).catch(() => {});
					}}
				/>
				{sample}
			</>
		);
	}

	if (pendingCount === 0) return sample;

	const label = t('captures.homeBanner', { count: pendingCount });

	return (
		<Pressable
			{...reviewTarget}
			onPress={() => router.push('/inbox')}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={t('captures.homeReviewHint')}
			style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
		>
			<Ionicons name="notifications-outline" size={22} color="#000000" />
			{/* Sem o rótulo "Revisar" ao lado: ele tirava espaço do texto, que saía da linha do ícone
			    (SPD-161). A faixa inteira já abre a revisão, e a seta diz isso. */}
			<Text style={styles.text} numberOfLines={2}>
				{label}
			</Text>
			{/* O "?" da trilha da revisão (SPD-131). */}
			<HelpButton trail="review" here={{ screen: 'home' }} color="#000000" />
			<Ionicons name="chevron-forward" size={20} color="#000000" />
		</Pressable>
	);
};

const styles = StyleSheet.create({
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		minHeight: 52,
		paddingHorizontal: 14,
		paddingVertical: 10,
		borderRadius: 12,
		backgroundColor: '#15E8FE',
		marginBottom: 16,
	},
	warning: {
		backgroundColor: '#FFB74D',
	},
	warningBody: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
	},
	dismiss: {
		minWidth: 32,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pressed: {
		opacity: 0.8,
	},
	text: {
		flex: 1,
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	action: {
		fontSize: 15,
		fontWeight: '700',
		color: '#000000',
	},
});

export default CaptureReviewBanner;
