import { clearSyncState, getSyncState, type LocalDataCounts, setSyncState } from '../database/database';
import type { SyncStatusResponse } from './types';

/**
 * De quem são os dados deste aparelho.
 *
 * Duas perguntas que pareciam separadas e são a mesma:
 *
 *  - **o claim pendente**: a conta recém-conectada já tinha dados, e o usuário ainda não
 *    disse se quer puxar da conta, subir do aparelho ou juntar. Enquanto não disser, a
 *    fila de sync não pode ligar.
 *  - **a conta dona do estado de sync**: o cursor do pull, o `lastSyncedAt` e o próprio
 *    claim descrevem o progresso **naquela** conta. Entrar em outra conta sem limpá-los
 *    faz o cursor antigo esconder tudo o que a conta nova gravou antes dele — a
 *    `serverSeq` é global por tabela, não por usuário.
 *
 * As duas moram em `sync_state`, a mesma tabela do cursor, e não no estado do React:
 * era justamente por existirem só na memória que fechar o app no meio da escolha fazia
 * a abertura seguinte **juntar** em silêncio.
 */

/** A chave do claim pendente em `sync_state`. */
const PENDING_CLAIM_KEY = 'pendingClaim';

/** A chave da conta a que o estado de sync guardado pertence. */
const SYNC_ACCOUNT_KEY = 'syncAccountId';

/** Os dois lados, para a tela mostrar o que está em jogo antes da escolha. */
export interface ClaimCounts {
	account: SyncStatusResponse['counts'];
	device: LocalDataCounts;
}

/** O que um lado tem, nos nomes do resumo que a tela mostra (`settings.exportSummary`). */
export type ClaimSummaryParams = {
	transactions: number;
	categories: number;
	accounts: number;
	transfers: number;
	recurring: number;
	budgets: number;
	debts: number;
	captures: number;
	rules: number;
};

/**
 * Os números de um lado da pergunta, prontos para a tela.
 *
 * Os dois lados no mesmo formato: antes a conta mostrava só lançamentos e recorrências, e
 * uma conta cuja diferença estava nas contas, na caixa de entrada ou nas dívidas aparecia
 * como "0 lançamentos" — a pergunta parecia sem motivo. O que falta vira zero, nunca
 * `undefined` na tela: um servidor anterior manda só as quatro contagens de sempre, e uma
 * pergunta gravada por uma versão anterior do app tem a forma de antes.
 */
export const claimSummaryParams = (counts: Partial<Record<keyof LocalDataCounts, number>>): ClaimSummaryParams => ({
	transactions: counts.transactions ?? 0,
	categories: counts.customCategories ?? 0,
	accounts: counts.accounts ?? 0,
	transfers: counts.transfers ?? 0,
	recurring: counts.recurringTransactions ?? 0,
	budgets: counts.budgets ?? 0,
	debts: counts.debts ?? 0,
	captures: counts.captures ?? 0,
	rules: counts.merchantRules ?? 0,
});

/** A escolha que falta, e de qual conta ela é. */
export interface PendingClaim {
	/** A conta conectada quando a pergunta nasceu. */
	accountId: string;
	counts: ClaimCounts;
}

/**
 * Grava a escolha pendente. Chamado **antes** de a pergunta aparecer na tela: o aparelho
 * pode morrer entre as duas coisas, e sobrar a pergunta sem a gravação é o caso ruim.
 */
export const savePendingClaim = async (claim: PendingClaim): Promise<void> => {
	await setSyncState(PENDING_CLAIM_KEY, JSON.stringify(claim));
};

/**
 * A escolha pendente, se houver.
 *
 * JSON ilegível (um aparelho que gravou outra forma, um backup restaurado pela metade)
 * conta como "não há": a pergunta nasce de novo do zero no login seguinte, o que é
 * seguro, enquanto travar a abertura do app por causa disto não é.
 */
export const readPendingClaim = async (): Promise<PendingClaim | null> => {
	const stored = await getSyncState(PENDING_CLAIM_KEY);
	if (!stored) return null;

	try {
		const parsed = JSON.parse(stored) as Partial<PendingClaim>;
		if (typeof parsed?.accountId !== 'string' || !parsed.accountId || !parsed.counts) return null;
		return { accountId: parsed.accountId, counts: parsed.counts };
	} catch {
		console.warn('Claim pendente ilegível, descartado');
		return null;
	}
};

export const clearPendingClaim = async (): Promise<void> => {
	await setSyncState(PENDING_CLAIM_KEY, null);
};

/**
 * Prepara o estado de sync para uma sessão nesta conta, e diz se ele foi zerado.
 *
 * Entrar numa conta diferente da anterior limpa tudo: cursor, último sync e qualquer
 * claim que tenha sobrado. Só o "sair" explícito fazia isso antes — com o refresh
 * recusado e um login em outra conta, o cursor antigo continuava valendo e a conta nova
 * abria sem nada do que ela já tinha gravado.
 *
 * A mesma conta de novo não limpa nada: o cursor dela é bom e refazer o pull inteiro
 * seria lento sem motivo.
 */
export const beginSessionFor = async (accountId: string): Promise<boolean> => {
	const previous = await getSyncState(SYNC_ACCOUNT_KEY);
	const changed = previous !== accountId;

	// Primeiro limpa, depois marca: `clearSyncState` apaga a tabela inteira, inclusive
	// esta chave.
	if (changed) await clearSyncState();
	await setSyncState(SYNC_ACCOUNT_KEY, accountId);

	return changed;
};

/**
 * Encerra a sessão do ponto de vista do sync: o estado guardado descreve o progresso
 * numa conta que não está mais aqui, e reaproveitá-lo num login seguinte faria o app
 * achar que já tem o que nunca baixou. Vale para o "sair" e para a sessão que cai
 * sozinha (refresh recusado), que antes não limpava nada.
 */
export const endSyncSession = async (): Promise<void> => {
	await clearSyncState();
};

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { readPendingClaim, savePendingClaim, clearPendingClaim, beginSessionFor, endSyncSession, claimSummaryParams };
