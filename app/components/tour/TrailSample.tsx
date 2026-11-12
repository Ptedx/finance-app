import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { Account, Debt, Transaction } from '../../database/schema';
import { todayISO } from '../../utils/dateUtils';
import {
	isSampleForm,
	isSampleId,
	type SampleNames,
	sampleAccount,
	sampleDebt,
	sampleTransaction,
} from '../../utils/trailSample';

/**
 * O exemplo das trilhas na tela (SPD-147). O `TourProvider` liga este contexto enquanto uma
 * trilha com passo de exemplo está aberta (e um instante depois, enquanto a tela de exemplo
 * sai da pilha); as telas que a trilha abre com um id de exemplo (`isSampleId`) leem o registro
 * daqui, e não dos contextos de dados — que são os que gravam, somam e sincronizam.
 *
 * Fora da trilha, ou sem o `TourProvider` (os testes das telas), os ganchos devolvem nada e a
 * tela é a de sempre. Nada aqui grava: o exemplo é montado na hora, só em memória.
 */

export const TrailSampleContext = createContext(false);

/** Há uma trilha mostrando exemplo agora. */
export const useTrailSampleOn = (): boolean => useContext(TrailSampleContext);

/**
 * Os nomes no idioma do app. O memo vai pelos textos, não pelo `t`: um `t` novo a cada desenho
 * faria um exemplo novo a cada desenho, e os efeitos das telas que dependem do registro
 * rodariam sem parar.
 */
const useSampleNames = (): SampleNames => {
	const { t } = useTranslation();
	const account = t('trails.sample.account');
	const bank = t('trails.sample.bank');
	const card = t('trails.sample.card');
	const debt = t('trails.sample.debt');
	const transaction = t('trails.sample.transaction');
	return useMemo(
		() => ({ account, bank, card, debt, transaction }),
		[account, bank, card, debt, transaction]
	);
};

/** A conta ou o cartão de exemplo deste id, enquanto a trilha o mostra. */
export const useSampleAccount = (id: string | undefined): Account | undefined => {
	const on = useTrailSampleOn();
	const names = useSampleNames();
	const today = todayISO();
	return useMemo(
		() => (on && isSampleId(id) ? (sampleAccount(id, names, today) ?? undefined) : undefined),
		[on, id, names, today]
	);
};

/** A dívida de exemplo deste id, enquanto a trilha a mostra. */
export const useSampleDebt = (id: string | undefined): Debt | undefined => {
	const on = useTrailSampleOn();
	const names = useSampleNames();
	const today = todayISO();
	return useMemo(
		() => (on && isSampleId(id) ? (sampleDebt(id, names, today) ?? undefined) : undefined),
		[on, id, names, today]
	);
};

/** O lançamento de exemplo deste id, enquanto a trilha o mostra. */
export const useSampleTransaction = (id: string | undefined): Transaction | undefined => {
	const on = useTrailSampleOn();
	const names = useSampleNames();
	const today = todayISO();
	return useMemo(
		() => (on && isSampleId(id) ? (sampleTransaction(id, names, today) ?? undefined) : undefined),
		[on, id, names, today]
	);
};

/** O formulário de cadastro foi aberto pela trilha com o exemplo (`exemplo=1`) e ela segue aberta. */
export const useSampleForm = (param: unknown): boolean => {
	const on = useTrailSampleOn();
	return on && isSampleForm(param);
};

/** A faixa "Exemplo" no topo da tela de exemplo: nada aqui é do usuário, e nada é salvo. */
export const SampleBanner: React.FC = () => {
	const { t } = useTranslation();
	return (
		<View
			testID="trail-sample-banner"
			style={styles.banner}
			accessible
			accessibilityLabel={t('trails.sample.banner')}
		>
			<Ionicons name="eye-outline" size={18} color={SAMPLE_COLOR} />
			<Text style={styles.text}>{t('trails.sample.banner')}</Text>
		</View>
	);
};

const SAMPLE_COLOR = '#FFB020';

const styles = StyleSheet.create({
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginHorizontal: 16,
		marginBottom: 8,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: 'rgba(255,176,32,0.5)',
		backgroundColor: 'rgba(255,176,32,0.12)',
	},
	text: {
		flex: 1,
		fontSize: 14,
		fontWeight: '600',
		color: SAMPLE_COLOR,
	},
});
