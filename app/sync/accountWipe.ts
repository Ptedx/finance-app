/**
 * O "Apagar todos os dados" feito em outro aparelho (SPD-083, DEC-35): a regra de quem
 * apaga aqui. Só a regra — pura, sem banco nem rede; quem a aplica é o motor do sync
 * (`applyWipeMark` em `sync/engine.ts`).
 *
 * O apagar vale para todos os aparelhos da conta. O servidor diz quando foi o último
 * (`dataWipedAt`, no pull, no `/sync/status` e no 409 do push), e este aparelho guarda o
 * último que já aplicou (`KNOWN_WIPE_AT_KEY`). Um `dataWipedAt` mais novo que o daqui quer
 * dizer que a conta foi esvaziada depois do que este aparelho sabe — e aí:
 *
 *  - **o aparelho que já sincronizava com a conta apaga a sua cópia.** O que ele tem veio
 *    da conta ou foi para ela; a conta não tem mais, e ficar com isso seria o apagar não
 *    chegar a "todos os aparelhos";
 *  - **o aparelho que está entrando na conta agora só passa a conhecer o apagar.** O que
 *    ele tem foi criado aqui, antes do login, e nunca esteve na conta: o apagar não é
 *    dele. Apagar aqui faria o login num celular novo levar embora o que o usuário criou
 *    nele.
 *
 * "Já sincronizava" é decidido pelo motor (`hasSyncedWithAccount`), com o estado de sync
 * que é desta conta e sai junto com ela (`sync/claim.ts`).
 */

export type WipeDecision = 'none' | 'adopt' | 'wipe';

const instantOf = (value: string): number | null => {
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
};

/**
 * Se o servidor sabe de um apagar que este aparelho ainda não aplicou.
 *
 * `undefined` é o servidor que está em produção, que não manda o campo; `null` é a conta
 * que nunca apagou. Nos dois casos, nada: o sync segue exatamente como antes. Um instante
 * ilegível do servidor também não apaga nada — apagar é irreversível, e na dúvida não se
 * apaga. Já a marca **daqui** ilegível perde para a do servidor: ela só nasce de um valor
 * dele, e ficar com ela faria todo push ser recusado para sempre.
 *
 * Compara instantes, não texto: o mesmo apagar escrito com outro fuso não é outro apagar.
 */
export const isNewerWipe = (
	knownWipeAt: string | null,
	dataWipedAt: string | null | undefined
): dataWipedAt is string => {
	if (typeof dataWipedAt !== 'string') return false;
	const server = instantOf(dataWipedAt);
	if (server === null) return false;
	if (knownWipeAt === null) return true;
	const known = instantOf(knownWipeAt);
	return known === null || server > known;
};

/**
 * Apagar aqui, só conhecer o apagar, ou nada. Ver o comentário do arquivo.
 *
 * `syncedBefore`: este aparelho já tem dados que vieram desta conta ou foram para ela.
 */
export const decideAccountWipe = ({
	knownWipeAt,
	dataWipedAt,
	syncedBefore,
}: {
	knownWipeAt: string | null;
	dataWipedAt: string | null | undefined;
	syncedBefore: boolean;
}): WipeDecision => {
	if (!isNewerWipe(knownWipeAt, dataWipedAt)) return 'none';
	return syncedBefore ? 'wipe' : 'adopt';
};

export type AccountGoneDecision = 'wipe' | 'sign_out';

/**
 * A conta não existe mais (401 `account_gone`, SPD-084): foi apagada noutro aparelho, ou
 * neste com o app fechado antes de ele terminar. A mesma regra do apagar de outro aparelho,
 * pelo mesmo motivo: o aparelho que já sincronizava com ela apaga os dados — o que ele tem
 * veio da conta ou foi para ela —; o que estava entrando nela só sai, porque o que tem aqui
 * nunca esteve na conta. Quem aplica é `leaveDeletedAccount` (`utils/accountDeletion.ts`).
 */
export const decideAccountGone = ({
	syncedBefore,
}: {
	syncedBefore: boolean;
}): AccountGoneDecision => (syncedBefore ? 'wipe' : 'sign_out');

/**
 * O push recusado porque a conta foi apagada (409 `data_wiped`): devolve o instante que o
 * servidor mandou junto (`null` se não veio), ou `null` se a falha é outra.
 *
 * Lê a forma do erro em vez de `instanceof ApiError`, como `errorData` faz: o que importa
 * é o status e o código que o servidor mandou.
 */
export const dataWipedRefusal = (error: unknown): { dataWipedAt: string | null } | null => {
	if (!error || typeof error !== 'object') return null;
	const shape = error as { status?: unknown; code?: unknown; details?: { dataWipedAt?: unknown } };
	if (shape.status !== 409 || shape.code !== 'data_wiped') return null;
	const dataWipedAt = shape.details?.dataWipedAt;
	return { dataWipedAt: typeof dataWipedAt === 'string' ? dataWipedAt : null };
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { isNewerWipe, decideAccountWipe, decideAccountGone, dataWipedRefusal };
