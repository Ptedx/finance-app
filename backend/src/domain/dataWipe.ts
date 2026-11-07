/**
 * "Apagar todos os dados" no servidor (DEC-35): o que sai, o que fica e o que acontece com
 * o aparelho que ainda não sabe.
 *
 * Apagar aqui é `DELETE` de verdade, e não lápide. A lápide existe para um aparelho offline
 * saber que uma linha sumiu — mas ela guarda a linha inteira, com valor, nota e texto de
 * notificação, e quem pede para apagar os dados não quer o conteúdo guardado em lugar
 * nenhum. O que avisa os outros aparelhos é a marca `users.dataWipedAt`: o pull e o status
 * a devolvem, e o push de quem não a conhece volta com 409 sem gravar nada. Sem essa trava,
 * o primeiro aparelho que ainda tinha os dados os subiria de novo e o "apagar" se desfaria
 * sozinho.
 *
 * Nada neste arquivo importa Prisma nem a configuração do servidor — é o que permite
 * testá-lo sem banco e sem variáveis de ambiente.
 */

/**
 * O destino de cada relação do `User` no schema.prisma, uma a uma.
 *
 * - `wipe`: toda linha do usuário sai;
 * - `keep`: nada sai;
 * - `wipe_some`: saem só algumas linhas — ver o comentário de cada uma.
 *
 * A lista é exaustiva de propósito: o teste (`__tests__/dataWipe.test.ts`) lê o model
 * `User` do schema.prisma e falha se uma relação não estiver aqui. Uma tabela nova não pode
 * ficar de fora do "apagar" por esquecimento — quem a cria tem de decidir o destino dela.
 */
export const USER_RELATION_FATE = {
	// --- Ficam: é a conta, não o dado ---------------------------------------
	/** As sessões. Apagar os dados não é sair: todo aparelho continua logado. */
	refreshTokens: 'keep',
	/** Categorias, inclusive as próprias: são configuração, e os lançamentos novos as usam. */
	categories: 'keep',
	/** O que o app aprendeu sobre cada estabelecimento: também configuração (DEC-35). */
	merchantRules: 'keep',

	// --- Saem em parte ------------------------------------------------------
	/**
	 * Preferências de configuração (moeda, idioma, CDI, lembretes) ficam. Saem só as que
	 * apontam para contas que deixam de existir: `WIPED_PREFERENCE_KEYS`.
	 */
	preferences: 'wipe_some',

	// --- Saem inteiras: o dado do usuário ------------------------------------
	transactions: 'wipe',
	recurringTransactions: 'wipe',
	budgets: 'wipe',
	transfers: 'wipe',
	accounts: 'wipe',
	retirementGoals: 'wipe',
	debts: 'wipe',
	reserveGoals: 'wipe',
	bills: 'wipe',
	/** A caixa de entrada: texto cru de aviso de banco. */
	captures: 'wipe',
	/** O diário de diagnóstico também guarda texto de aviso de banco (`rawText`). */
	diagnosticEvents: 'wipe',
	// Tabelas do roadmap, sem tela nem endpoint hoje. Se um dia tiverem linhas, são dado
	// do usuário como as outras.
	assets: 'wipe',
	liabilities: 'wipe',
	netWorthSnapshots: 'wipe',
	goals: 'wipe',
	portfolioAllocations: 'wipe',
	passiveIncomes: 'wipe',
} as const;

type Fate = (typeof USER_RELATION_FATE)[keyof typeof USER_RELATION_FATE];
type RelationsWith<F extends Fate> = {
	[K in keyof typeof USER_RELATION_FATE]: (typeof USER_RELATION_FATE)[K] extends F ? K : never;
}[keyof typeof USER_RELATION_FATE];

/** As relações apagadas por inteiro. O controller tem de saber apagar cada uma. */
export type WipedUserRelation = RelationsWith<'wipe'>;

const relationsWith = <F extends Fate>(fate: F): RelationsWith<F>[] =>
	(Object.keys(USER_RELATION_FATE) as (keyof typeof USER_RELATION_FATE)[]).filter(
		(relation): relation is RelationsWith<F> => USER_RELATION_FATE[relation] === fate
	);

export const WIPED_USER_RELATIONS: readonly WipedUserRelation[] = relationsWith('wipe');
export const PARTLY_WIPED_USER_RELATIONS: readonly RelationsWith<'wipe_some'>[] =
	relationsWith('wipe_some');

/**
 * As preferências que saem junto com as contas — as chaves do AsyncStorage do app, que são
 * o `id` da linha em `preferences` (ver `STORAGE_KEYS` em app/utils/storageUtils.ts).
 *
 * As duas guardam ids de conta: os pares que o usuário disse serem contas diferentes do
 * mesmo banco, e qual conta recebe os avisos da PJ de cada app. Com as contas apagadas,
 * apontariam para o nada — e uma conta recriada depois herdaria uma escolha que não fez.
 */
export const WIPED_PREFERENCE_KEYS: readonly string[] = [
	'@spendr_distinct_account_pairs',
	'@spendr_business_feeds',
];

/** O `code` do 409. O app o reconhece por aqui, não pela mensagem. */
export const DATA_WIPED_CODE = 'data_wiped';

/** O corpo do 409 de um push que não sabe do apagamento. */
export interface WipeConflict {
	error: string;
	code: typeof DATA_WIPED_CODE;
	dataWipedAt: string;
}

/** `users.dataWipedAt` no fio: ISO, ou `null` para quem nunca apagou. */
export const wipeMarkToWire = (dataWipedAt: Date | null): string | null =>
	dataWipedAt === null ? null : dataWipedAt.toISOString();

/**
 * Se um push tem de ser recusado por não saber do último apagamento.
 *
 * `knownWipeAt` é o `dataWipedAt` que o aparelho já viu e aplicou. Ausente (app anterior ao
 * campo), nulo ou anterior à marca do servidor quer dizer que o aparelho ainda tem os dados
 * de antes — e a remessa inteira é recusada, não linha a linha: qualquer linha dela pode
 * ser um dado que o usuário mandou apagar. Comparado como instante, não como texto: o mesmo
 * momento escrito noutro fuso é o mesmo apagamento.
 *
 * Quem nunca apagou passa sempre, mande o campo ou não.
 */
export const pushWipeConflict = (
	dataWipedAt: Date | null,
	knownWipeAt: string | null | undefined
): WipeConflict | null => {
	if (dataWipedAt === null) return null;
	if (knownWipeAt != null && Date.parse(knownWipeAt) >= dataWipedAt.getTime()) return null;

	return {
		error: 'Os dados desta conta foram apagados. Nada deste envio foi gravado.',
		code: DATA_WIPED_CODE,
		dataWipedAt: dataWipedAt.toISOString(),
	};
};
