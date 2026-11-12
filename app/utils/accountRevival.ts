import AsyncStorage from '@react-native-async-storage/async-storage';
import { monthKeyOf, shiftMonthKey } from './dateUtils';
import type { Cents } from './money';
import { buildMonthSeries, type MonthKey, type MonthSeriesInput } from './reportSeries';

/**
 * A conta apagada que volta encerrada no carregamento (SPD-149).
 *
 * O app antigo apagava conta com conteúdo, e depois o "Já paguei" e a captura confirmada ainda
 * gravavam o id da conta morta. Esses lançamentos e transferências vivos não entravam em saldo
 * nem no mês (a conta não está na lista, e a série descarta conta desconhecida), mas entravam
 * nos totais por categoria. O reparo da carga traz a conta de volta **encerrada**, como o pull
 * já faz (SPD-144): o saldo das contas vivas e o patrimônio não mudam — encerrada fica fora
 * dos totais de hoje —, mas o histórico passa a ver o que aconteceu, e um mês passado pode
 * mudar (a despesa de R$ 90 volta a contar em novembro).
 *
 * Por isso o usuário recebe **um aviso único**: qual conta voltou, quantos lançamentos e
 * transferências, e o efeito em R$ por mês — a série com a conta menos a série sem ela, com a
 * mesma função dos Relatórios (`buildMonthSeries`). O cartão também volta, e ele muda o
 * Patrimônio de hoje (a tela soma o devido de todo cartão, inclusive o encerrado): o aviso diz
 * também quanto. O mesmo aviso sai quando a volta vem do pull.
 */

/** Uma conta que o reparo trouxe de volta, com o que apontava para ela. */
export interface RevivedAccount {
	id: string;
	name: string;
	/** Lançamentos vivos na conta. */
	transactions: number;
	/** Transferências vivas com a conta numa das pontas. */
	transfers: number;
	/** A data do primeiro e do último lançamento ou transferência (`YYYY-MM-DD`). */
	firstDate: string;
	lastDate: string;
}

/** O que um mês passou a mostrar com a conta de volta (diferença, com sinal). */
export interface RevivalMonthEffect {
	month: MonthKey;
	incomeCents: Cents;
	spendCents: Cents;
	savedCents: Cents;
}

/** O aviso guardado até a tela de Contas mostrá-lo. */
export interface RevivalNotice {
	accounts: { id: string; name: string; transactions: number; transfers: number }[];
	/** Os meses que mudaram; nulo quando a conta do efeito falhou (o aviso diz só que voltou). */
	months: RevivalMonthEffect[] | null;
	/**
	 * O que o Patrimônio de hoje mudou com a volta (com sinal). Conta encerrada fica fora dos
	 * totais de hoje: zero. Cartão encerrado conta pelo devido mais as parcelas futuras (a tela
	 * de Patrimônio soma todo cartão), então o cartão que voltou tira isso. Nulo quando a conta
	 * do efeito falhou.
	 */
	worthDeltaCents: Cents | null;
}

/** Quanto o Patrimônio de hoje mudou, somando os avisos (o guardado antes do campo conta zero). */
export const revivalWorthDelta = (notices: RevivalNotice[]): Cents =>
	notices.reduce((total, notice) => total + (notice.worthDeltaCents ?? 0), 0);

/** Quantos meses antes de hoje o efeito cobre, no mínimo: a série dos Relatórios (13 meses). */
const MIN_MONTHS_BACK = 12;

/**
 * Os meses em que olhar o efeito: do mais antigo entre o primeiro lançamento e 12 meses antes
 * de hoje, até o mais novo entre hoje e o último lançamento (a parcela futura). Os 12 meses
 * entram sempre porque um envelope encerrado custa o valor combinado em todo mês da série.
 */
export const revivalMonthRange = (firstDate: string, lastDate: string, today: string): MonthKey[] => {
	const todayKey = monthKeyOf(today);
	const windowStart = shiftMonthKey(todayKey, -MIN_MONTHS_BACK);
	const firstKey = monthKeyOf(firstDate);
	const lastKey = monthKeyOf(lastDate);
	const start = firstKey < windowStart ? firstKey : windowStart;
	const end = lastKey > todayKey ? lastKey : todayKey;
	const months: MonthKey[] = [];
	for (let key = start; key <= end; key = shiftMonthKey(key, 1)) months.push(key);
	return months;
};

/**
 * O efeito, mês a mês, de as contas `revivedIds` estarem na lista: a série com elas menos a
 * série sem elas, com os mesmos dados. Só os meses em que receita, gasto ou guardado mudam.
 */
export const revivalMonthEffects = (input: MonthSeriesInput, revivedIds: Iterable<string>): RevivalMonthEffect[] => {
	const revived = new Set(revivedIds);
	const after = buildMonthSeries(input);
	const before = buildMonthSeries({ ...input, accounts: input.accounts.filter((account) => !revived.has(account.id)) });
	const effects: RevivalMonthEffect[] = [];
	after.forEach((point, index) => {
		const old = before[index].overview;
		const effect: RevivalMonthEffect = {
			month: point.month,
			incomeCents: point.overview.incomeCents - old.incomeCents,
			spendCents: point.overview.totalSpendCents - old.totalSpendCents,
			savedCents: point.overview.savedCents - old.savedCents,
		};
		if (effect.incomeCents !== 0 || effect.spendCents !== 0 || effect.savedCents !== 0) effects.push(effect);
	});
	return effects;
};

// ---------------------------------------------------------------------------
// O aviso guardado
// ---------------------------------------------------------------------------

/**
 * Fica **só neste aparelho**, direto no AsyncStorage, como o "Juntamos X em Y"
 * (`autoMergeNotices`): foi a carga deste aparelho que trouxe a conta de volta, e é nele que
 * o aviso faz sentido. Não sobe no sync nem vai no backup.
 */
export const REVIVAL_NOTICES_KEY = '@spendr_revival_notices';

const isNotice = (value: unknown): value is RevivalNotice =>
	typeof value === 'object' &&
	value !== null &&
	Array.isArray((value as RevivalNotice).accounts) &&
	((value as RevivalNotice).months === null || Array.isArray((value as RevivalNotice).months));

export const getRevivalNotices = async (): Promise<RevivalNotice[]> => {
	try {
		const stored = await AsyncStorage.getItem(REVIVAL_NOTICES_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return Array.isArray(parsed) ? parsed.filter(isNotice) : [];
	} catch {
		// Valor estragado vale como nenhum aviso: a conta já voltou, só o aviso se perde.
		return [];
	}
};

/** Guarda um aviso novo e devolve a lista. */
export const addRevivalNotice = async (notice: RevivalNotice): Promise<RevivalNotice[]> => {
	const next = [...(await getRevivalNotices()), notice];
	try {
		await AsyncStorage.setItem(REVIVAL_NOTICES_KEY, JSON.stringify(next));
	} catch (error) {
		console.warn('Não foi possível guardar o aviso da conta que voltou:', error);
	}
	return next;
};

/** A tela mostrou: os avisos saem. */
export const clearRevivalNotices = async (): Promise<void> => {
	try {
		await AsyncStorage.removeItem(REVIVAL_NOTICES_KEY);
	} catch (error) {
		console.warn('Não foi possível apagar o aviso da conta que voltou:', error);
	}
};

export default {
	REVIVAL_NOTICES_KEY,
	revivalMonthRange,
	revivalMonthEffects,
	getRevivalNotices,
	addRevivalNotice,
	clearRevivalNotices,
};
