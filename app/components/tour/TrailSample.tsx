import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { Account, Bill, Capture, Category, Debt, Transaction } from '../../database/schema';
import { buildCardSummary, type CardSummary } from '../../utils/cardMath';
import { todayISO } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import {
	isSampleForm,
	isSampleId,
	SAMPLE_CAPTURE_VALUES,
	SAMPLE_IDS,
	SAMPLE_VALUES,
	type SampleBillNames,
	type SampleNames,
	sampleAccount,
	sampleBills,
	sampleCaptures,
	sampleDebt,
	sampleTransaction,
} from '../../utils/trailSample';
import type { TrailId } from '../../utils/trails';

/**
 * O exemplo das trilhas na tela (SPD-147). O `TourProvider` liga este contexto enquanto uma
 * trilha com passo de exemplo está aberta (e um instante depois, enquanto a tela de exemplo
 * sai da pilha); as telas que a trilha abre com um id de exemplo (`isSampleId`) leem o registro
 * daqui, e não dos contextos de dados — que são os que gravam, somam e sincronizam. A revisão
 * da captura (SPD-159) não abre por id: com o exemplo ligado e a fila vazia, ela lê daqui os
 * avisos de exemplo (`useSampleReview`).
 *
 * As contas a pagar e a tela inicial (SPD-160) também não abrem por id: com a Trilha 8 ou a 21
 * aberta e sem conta a pagar, a lista e o card "Contas do mês" leem daqui as contas de exemplo
 * (`useSampleBills`); com a 21, cada bloco da tela inicial que falta lê daqui o seu exemplo. Por
 * isso o contexto guarda qual trilha está aberta, e não só que há uma: o "+" (Trilha 5) e a
 * revisão (Trilha 7) passam pela tela inicial e não a enchem de exemplo.
 *
 * Fora da trilha, ou sem o `TourProvider` (os testes das telas), os ganchos devolvem nada e a
 * tela é a de sempre. Nada aqui grava: o exemplo é montado na hora, só em memória.
 */

/** A trilha aberta que mostra exemplo agora; nula sem nenhuma. */
export const TrailSampleContext = createContext<TrailId | null>(null);

/** Há uma trilha mostrando exemplo agora. */
export const useTrailSampleOn = (): boolean => useContext(TrailSampleContext) !== null;

/** A trilha aberta com exemplo é uma destas (SPD-160). */
export const useTrailSampleFor = (trails: readonly TrailId[]): boolean => {
	const open = useContext(TrailSampleContext);
	return open !== null && trails.includes(open);
};

/** As trilhas que mostram as contas a pagar de exemplo: a 8 e a 21, que passa pelo card. */
const BILL_TRAILS: readonly TrailId[] = ['bills', 'home'];
/** A trilha que mostra os blocos de exemplo da tela inicial: a 21. */
const HOME_TRAILS: readonly TrailId[] = ['home'];

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

const useSampleBillNames = (): SampleBillNames => {
	const { t } = useTranslation();
	const bill = t('trails.sample.bill');
	const billPaid = t('trails.sample.billPaid');
	return useMemo(() => ({ bill, billPaid }), [bill, billPaid]);
};

/**
 * As contas a pagar de exemplo (SPD-160), enquanto a Trilha 8 ou a 21 está aberta e o usuário
 * não tem nenhuma (`hasOwn`: tem alguma, ou a lista ainda está carregando). O "Falta pagar" e os
 * status que a tela mostra com elas saem só delas: o `BillsContext`, que soma, grava e agenda os
 * lembretes, nunca as vê.
 */
export const useSampleBills = (hasOwn: boolean, today: string): Bill[] | undefined => {
	const show = useTrailSampleFor(BILL_TRAILS) && !hasOwn;
	const names = useSampleBillNames();
	return useMemo(() => (show ? sampleBills(names, today) : undefined), [show, names, today]);
};

/** A conta a pagar de exemplo deste id (a edição que a trilha abre), enquanto a trilha a mostra. */
export const useSampleBill = (id: string | undefined): Bill | undefined => {
	const on = useTrailSampleOn();
	const names = useSampleBillNames();
	const today = todayISO();
	return useMemo(
		() =>
			on && isSampleId(id) ? sampleBills(names, today).find((bill) => bill.id === id) : undefined,
		[on, id, names, today]
	);
};

/** O cartão de exemplo da tela inicial e a fatura dele, como a tela do cartão de exemplo mostra. */
export interface SampleHomeCard {
	card: Account;
	summary: CardSummary;
}

/**
 * O que a tela inicial da Trilha 21 desenha no lugar de cada bloco que falta (SPD-160). Cada
 * campo existe só com a trilha aberta e sem o dado de verdade daquele bloco (`own` falso):
 * - `reviewCount`: a faixa "Revisar", com 1 aviso;
 * - `card`: o cartão de exemplo do SPD-147, com a fatura dele;
 * - `account`: a conta de exemplo;
 * - `unassignedCents`: a linha "Sem conta", com o lançamento de exemplo (uma despesa).
 *
 * Nenhum entra em "Este mês", Patrimônio, Relatórios, nos totais de cartões e contas de verdade,
 * nos contadores nem nos selos: esses vêm dos contextos de dados, onde o exemplo nunca entra.
 */
export interface SampleHome {
	reviewCount?: number;
	card?: SampleHomeCard;
	account?: Account;
	unassignedCents?: number;
}

export const useSampleHome = (own: {
	review?: boolean;
	card?: boolean;
	account?: boolean;
	unassigned?: boolean;
}): SampleHome => {
	const show = useTrailSampleFor(HOME_TRAILS);
	const names = useSampleNames();
	const today = todayISO();
	const missing = (has: boolean | undefined) => show && has === false;
	const review = missing(own.review);
	const card = missing(own.card);
	const account = missing(own.account);
	const unassigned = missing(own.unassigned);
	return useMemo(() => {
		const cardAccount = card ? sampleAccount(SAMPLE_IDS.card, names, today) : null;
		return {
			reviewCount: review ? 1 : undefined,
			card: cardAccount
				? { card: cardAccount, summary: buildCardSummary(cardAccount, [], [], today) }
				: undefined,
			account: account ? (sampleAccount(SAMPLE_IDS.account, names, today) ?? undefined) : undefined,
			unassignedCents: unassigned ? -SAMPLE_VALUES.transactionCents : undefined,
		};
	}, [review, card, account, unassigned, names, today]);
};

/** O selo "Exemplo" de um bloco de exemplo (SPD-160): a tela inicial e a lista de Contas a pagar. */
export const SampleTag: React.FC = () => {
	const { t } = useTranslation();
	return (
		<View testID="trail-sample-block-tag" style={styles.tag}>
			<Text style={styles.tagText}>{t('trails.sample.tag')}</Text>
		</View>
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
	tag: {
		alignSelf: 'center',
		paddingHorizontal: 8,
		paddingVertical: 2,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: 'rgba(255,176,32,0.5)',
		backgroundColor: 'rgba(255,176,32,0.12)',
	},
	tagText: {
		fontSize: 12,
		fontWeight: '700',
		color: SAMPLE_COLOR,
	},
});
