import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { Account, Capture, Category, Debt, Transaction } from '../../database/schema';
import { todayISO } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import {
	isSampleForm,
	isSampleId,
	SAMPLE_CAPTURE_VALUES,
	SAMPLE_IDS,
	type SampleNames,
	sampleAccount,
	sampleCaptures,
	sampleDebt,
	sampleTransaction,
} from '../../utils/trailSample';

/**
 * O exemplo das trilhas na tela (SPD-147). O `TourProvider` liga este contexto enquanto uma
 * trilha com passo de exemplo está aberta (e um instante depois, enquanto a tela de exemplo
 * sai da pilha); as telas que a trilha abre com um id de exemplo (`isSampleId`) leem o registro
 * daqui, e não dos contextos de dados — que são os que gravam, somam e sincronizam. A revisão
 * da captura (SPD-159) não abre por id: com o exemplo ligado e a fila vazia, ela lê daqui os
 * avisos de exemplo (`useSampleReview`).
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

/**
 * A revisão de exemplo (SPD-159): os avisos, o nome da conta deles e a categoria sugerida, que
 * não existem nos contextos de dados — a tela usa estes no lugar de procurar lá.
 */
export interface SampleReview {
	captures: Capture[];
	accountName: string;
	category: Pick<Category, 'id' | 'name' | 'color' | 'icon'>;
}

/** A cor e o ícone da categoria de exemplo: uma bolinha verde com o carrinho. */
const SAMPLE_CATEGORY_COLOR = '#4CAF50';
const SAMPLE_CATEGORY_ICON = 'cart';

/**
 * Os avisos de exemplo da revisão, enquanto a trilha os mostra e a fila de verdade está vazia
 * (`hasOwn`: há pendente de verdade, ou a fila ainda está carregando). Chegou um aviso de
 * verdade no meio da trilha, ele toma o lugar do exemplo. A contagem de "para revisar" da tela
 * inicial e dos selos vem da fila do `CapturesContext`, onde o exemplo nunca entra.
 */
export const useSampleReview = (hasOwn: boolean): SampleReview | undefined => {
	const on = useTrailSampleOn();
	const { t } = useTranslation();
	const show = on && !hasOwn;
	const amount = formatCents(SAMPLE_CAPTURE_VALUES.purchaseCents);
	const creditAmount = formatCents(SAMPLE_CAPTURE_VALUES.creditCents);
	const accountName = t('trails.sample.account');
	const bank = t('trails.sample.bank');
	const wallet = t('trails.sample.wallet');
	const merchant = t('trails.sample.transaction');
	const store = t('trails.sample.store');
	const categoryName = t('trails.sample.category');
	const purchaseTitle = t('trails.sample.purchaseTitle');
	const purchaseText = t('trails.sample.purchaseText', { amount, merchant });
	const walletTitle = t('trails.sample.walletTitle');
	const walletText = t('trails.sample.walletText', { amount, merchant });
	const creditTitle = t('trails.sample.creditTitle');
	const creditText = t('trails.sample.creditText', { amount: creditAmount, store });
	return useMemo(
		() =>
			show
				? {
						captures: sampleCaptures(
							{
								bank,
								wallet,
								merchant,
								store,
								purchaseTitle,
								purchaseText,
								walletTitle,
								walletText,
								creditTitle,
								creditText,
							},
							new Date()
						),
						accountName,
						category: {
							id: SAMPLE_IDS.category,
							name: categoryName,
							color: SAMPLE_CATEGORY_COLOR,
							icon: SAMPLE_CATEGORY_ICON,
						},
					}
				: undefined,
		[
			show,
			accountName,
			bank,
			wallet,
			merchant,
			store,
			categoryName,
			purchaseTitle,
			purchaseText,
			walletTitle,
			walletText,
			creditTitle,
			creditText,
		]
	);
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
