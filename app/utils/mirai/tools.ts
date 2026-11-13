import { initDatabase } from '../../database/database';
import { todayISO } from '../dateUtils';
import { ownNamesOf } from '../ownName';
import { getOwnBankName } from '../ownNamePreference';
import { isMiraiToolName, MIRAI_TOOLS, type MiraiToolName } from './contract';
import { applyPrivacy, type PrivacyContext } from './privacy';
import { getAccountsTool, getCardsTool, getNetWorthTool } from './tools/accounts';
import { getBillsTool, getDebtsTool } from './tools/bills';
import { getMonthOverview } from './tools/month';
import { getHealth, getRates, getReserveAndGoals } from './tools/reserve';
import { loadAccountsToday, loadReportsToday } from './tools/snapshot';
import { getCategoryTotals, type ListTransactionsInput, listTransactions } from './tools/transactions';
import { isMiraiInputError, type ObjectSchema, validateToolInput } from './tools/validate';

/**
 * As ferramentas do Mirai no aparelho (SPD-163b): o app recebe o `tool_use` do Claude (pelo
 * backend), roda aqui e devolve o texto como `tool_result`.
 *
 * - A entrada é conferida pelo schema do contrato; entrada ruim volta como JSON de erro e
 *   nunca lança — o Claude lê o erro e corrige a chamada.
 * - Cada ferramenta lê o SQLite e calcula com as mesmas funções da tela correspondente: o
 *   número que o Mirai fala é o que a tela mostra.
 * - Toda saída passa pelo filtro de privacidade (`privacy.ts`) antes de sair.
 * - Valores em centavos, datas `YYYY-MM-DD`, meses `YYYY-MM`; JSON compacto.
 * - Saída acima de `MIRAI_RESULT_MAX_CHARS` é cortada no fim das listas, com `"truncated": true`.
 */

/** O teto de uma saída de ferramenta, em caracteres do JSON. */
export const MIRAI_RESULT_MAX_CHARS = 8000;

export interface MiraiToolOptions {
	/**
	 * Nomes do usuário além do de Ajustes (o "seu nome como aparece no banco", lido aqui): o
	 * nome da conta logada, que só o `AuthContext` tem. Viram "você" na saída.
	 */
	ownNames?: ReadonlyArray<string | null | undefined>;
}

type ToolError = 'unknown_tool' | 'invalid_input' | 'tool_failed';

const errorResult = (error: ToolError, message?: string): string =>
	JSON.stringify(message === undefined ? { error } : { error, message });

const schemaOf = (name: MiraiToolName): ObjectSchema =>
	MIRAI_TOOLS.find((tool) => tool.name === name)?.input_schema as unknown as ObjectSchema;

/** Roda a ferramenta já validada. Devolve o objeto de saída, antes do filtro. */
const run = async (name: MiraiToolName, input: Record<string, unknown>, today: string, privacy: PrivacyContext): Promise<unknown> => {
	switch (name) {
		case 'get_month_overview':
			return getMonthOverview(input as { month: string }, today);
		case 'get_accounts':
			return getAccountsTool(await loadAccountsToday(today));
		case 'get_cards':
			return getCardsTool(await loadAccountsToday(today));
		case 'list_transactions':
			return listTransactions(input as unknown as ListTransactionsInput, privacy);
		case 'get_category_totals': {
			const accounts = await loadAccountsToday(today);
			return getCategoryTotals(input as { month: string; compareWith: string | null }, accounts.accounts, today);
		}
		case 'get_bills':
			return getBillsTool(input as { from: string; to: string }, today, privacy);
		case 'get_debts':
			return getDebtsTool(today);
		case 'get_reserve_and_goals':
			return getReserveAndGoals(await loadReportsToday(await loadAccountsToday(today)));
		case 'get_net_worth':
			return getNetWorthTool(input as { months: number | null }, await loadReportsToday(await loadAccountsToday(today)));
		case 'get_health':
			return getHealth(await loadReportsToday(await loadAccountsToday(today)));
		case 'get_rates':
			return getRates();
	}
};

/** A maior lista (pelo tamanho do JSON) em qualquer profundidade, com algum item. */
const largestArray = (value: unknown): unknown[] | null => {
	let best: unknown[] | null = null;
	let bestSize = -1;
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			if (node.length > 0) {
				const size = JSON.stringify(node).length;
				if (size > bestSize) {
					best = node;
					bestSize = size;
				}
			}
			for (const item of node) walk(item);
			return;
		}
		if (node !== null && typeof node === 'object') {
			for (const entry of Object.values(node)) walk(entry);
		}
	};
	walk(value);
	return best;
};

/**
 * O JSON da saída dentro do teto: tira o último item da maior lista até caber e marca
 * `"truncated": true`. As listas vêm em ordem de importância (a mais nova, a maior), então o
 * que sai é o fim delas. Os totais e as contagens (`matched`) continuam sendo do todo.
 */
export const fitResult = (value: unknown, maxChars = MIRAI_RESULT_MAX_CHARS): string => {
	let text = JSON.stringify(value);
	if (text.length <= maxChars) return text;
	const root: Record<string, unknown> =
		value !== null && typeof value === 'object' && !Array.isArray(value)
			? { ...(value as Record<string, unknown>) }
			: { items: value };
	const copy = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
	copy.truncated = true;
	text = JSON.stringify(copy);
	while (text.length > maxChars) {
		const list = largestArray(copy);
		if (!list) break;
		list.pop();
		text = JSON.stringify(copy);
	}
	return text;
};

/**
 * Executa uma ferramenta do Mirai e devolve o JSON do resultado (ou do erro).
 * Nunca lança: erro de entrada é `invalid_input`; falha ao ler ou calcular é `tool_failed`,
 * sem a mensagem interna (que poderia levar dado para fora).
 */
export const executeMiraiTool = async (name: string, input: unknown, options: MiraiToolOptions = {}): Promise<string> => {
	if (!isMiraiToolName(name)) return errorResult('unknown_tool', `ferramenta desconhecida: ${String(name).slice(0, 64)}`);
	const problem = validateToolInput(schemaOf(name), input);
	if (problem !== null) return errorResult('invalid_input', problem);

	try {
		await initDatabase();
		const ownBankName = await getOwnBankName();
		const privacy: PrivacyContext = { ownNames: ownNamesOf([...(options.ownNames ?? []), ownBankName]) };
		const output = await run(name, input as Record<string, unknown>, todayISO(), privacy);
		return fitResult(applyPrivacy(output, privacy));
	} catch (error) {
		if (isMiraiInputError(error)) return errorResult('invalid_input', error.message);
		console.error(`Mirai: a ferramenta ${name} falhou`, error);
		return errorResult('tool_failed');
	}
};

export default { executeMiraiTool };
