/**
 * O carimbo (`updatedAt`) de uma gravação numa linha que **já existe** (SPD-107).
 *
 * O sync é "último que escreveu vence" pelo `updatedAt` que o aparelho carimba, e o
 * servidor recusa como `stale` a linha que chega mais velha que a guardada lá. Uma linha
 * gravada com o relógio adiantado (deste aparelho ou de outro) fica com o carimbo no
 * futuro; a edição de hoje, carimbada com agora, perdia para ela: o push voltava `stale`
 * e o pull seguinte desfazia a edição, sem aviso. O caso visto: uma transação com
 * `updatedAt` 2026-11-12T03:20:05 editada em 07/11 de R$ 200 para R$ 250 voltou a R$ 200.
 *
 * Por isso toda edição, lápide ou operação em lote carimba `max(agora, anterior + 1 ms)`:
 * sempre mais nova que a versão que a linha tinha — que é a do servidor quando ela
 * acabou de descer. Linha nova continua com agora. As preferências (`sync/preferences.ts`)
 * usam esta mesma função desde o SPD-127; o carimbo da substituição (`sync/replace.ts`)
 * segue a mesma ideia.
 *
 * **Carimbo no futuro** (SPD-127). Quando a linha chega com o `updatedAt` adiantado (um
 * aparelho com o relógio 2 dias à frente), as edições seguintes saem do carimbo dela + 1 ms
 * e a linha fica "no futuro" até o relógio alcançá-lo. Isso não faz ninguém perder: o
 * servidor só recusa (`stale`) o que chega mais velho que o que ele guarda, e quem editou
 * depois de puxar a versão de lá sempre carimba acima dela — com o relógio certo ou não. O
 * que perde é a edição feita em cima de uma versão velha (um aparelho offline) enquanto o
 * carimbo adiantado ainda está à frente do relógio dele; mas isso vem do carimbo adiantado,
 * não daqui: sem o +1 ms ela perderia igual, e a edição de quem puxou também. Limitar o
 * anterior (ex.: a agora + 1 dia) só traria de volta o `stale` silencioso do SPD-107,
 * porque o servidor continuaria com o carimbo adiantado. Impedir o carimbo adiantado de
 * entrar é coisa do servidor (que tem o relógio de referência), não do aparelho.
 */

/**
 * Agora, ou 1 ms depois do carimbo anterior se ele for igual ou posterior a agora.
 *
 * Compara pelo instante, não pelo texto: um carimbo sem milissegundos ("…05Z") é maior
 * que "…05.500Z" na ordem do texto. Anterior nulo, vazio ou ilegível vale como ausente.
 */
export const nextStamp = (previous: string | null | undefined, now: string): string => {
	const before = previous ? Date.parse(previous) : Number.NaN;
	if (!Number.isFinite(before) || before < Date.parse(now)) return now;
	return new Date(before + 1).toISOString();
};

/**
 * A mesma conta de `nextStamp`, em SQL, para o `SET updatedAt = …` de um UPDATE (ou do
 * `DO UPDATE` de um upsert) que grava em muitas linhas de uma vez, cada uma com o seu
 * anterior. `now` é o valor de agora — um `?` ligado, ou `excluded.updatedAt` no upsert;
 * `previous`, a coluna da própria linha (no `DO UPDATE`, `updatedAt` sem prefixo é a
 * linha que já existe).
 *
 * O `strftime` devolve exatamente o formato de `toISOString()` ("2026-11-12T03:20:05.124Z"),
 * e só por isso o `MAX` de texto ordena como o tempo. Anterior nulo ou ilegível sai nulo
 * do `strftime` e vira '' (que perde para qualquer agora): o `MAX` do SQLite com um nulo
 * daria nulo.
 */
export const nextStampSql = (now = '?', previous = 'updatedAt'): string =>
	`MAX(${now}, COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${previous}, '+0.001 seconds'), ''))`;

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router; este export existe só para
 * satisfazer essa exigência, como nos demais utilitários.
 */
export default { nextStamp, nextStampSql };
