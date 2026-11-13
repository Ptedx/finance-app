/**
 * A validação da entrada de uma ferramenta pelo schema do contrato (`MIRAI_TOOLS`).
 *
 * Cobre o pedaço de JSON Schema que o contrato usa: objeto com `properties`, `required` e
 * `additionalProperties: false`; `type` simples ou lista (o opcional é `[..., 'null']`);
 * `pattern`, `enum`, `minimum` e `maximum`. Com `strict: true` o Claude já manda a entrada
 * nesse formato; isto é a segunda trava, no aparelho, e nunca lança: devolve a mensagem.
 */

interface PropertySchema {
	type?: string | readonly string[];
	pattern?: string;
	enum?: readonly unknown[];
	minimum?: number;
	maximum?: number;
}

export interface ObjectSchema {
	type: 'object';
	properties: Readonly<Record<string, PropertySchema>>;
	required: readonly string[];
	additionalProperties?: boolean;
}

const typeOf = (value: unknown): string => {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
};

const matchesType = (value: unknown, expected: string): boolean => {
	const actual = typeOf(value);
	if (expected === 'number') return actual === 'number' || actual === 'integer';
	return actual === expected;
};

/** A mensagem do primeiro problema da entrada, ou nulo quando ela vale. */
export const validateToolInput = (schema: ObjectSchema, input: unknown): string | null => {
	if (typeOf(input) !== 'object') return 'a entrada precisa ser um objeto';
	const record = input as Record<string, unknown>;

	for (const key of schema.required) {
		if (!(key in record)) return `falta o campo "${key}"`;
	}
	if (schema.additionalProperties === false) {
		for (const key of Object.keys(record)) {
			if (!(key in schema.properties)) return `campo desconhecido "${key}"`;
		}
	}

	for (const [key, property] of Object.entries(schema.properties)) {
		if (!(key in record)) continue;
		const value = record[key];
		const types = property.type === undefined ? [] : typeof property.type === 'string' ? [property.type] : property.type;
		if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
			return `"${key}" precisa ser ${types.join(' ou ')}`;
		}
		if (value === null) continue;
		if (property.enum && !property.enum.includes(value)) return `"${key}" fora dos valores aceitos`;
		if (property.pattern && typeof value === 'string' && !new RegExp(property.pattern).test(value)) {
			return `"${key}" fora do formato`;
		}
		if (typeof value === 'number') {
			if (property.minimum !== undefined && value < property.minimum) return `"${key}" abaixo de ${property.minimum}`;
			if (property.maximum !== undefined && value > property.maximum) return `"${key}" acima de ${property.maximum}`;
		}
	}
	return null;
};

/**
 * Entrada que passa no schema mas não faz sentido (data que não existe, período invertido).
 * Reconhecida pelo `name` (`isMiraiInputError`): `instanceof` com subclasse de `Error` não é
 * confiável depois de transpilado.
 */
export class MiraiInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MiraiInputError';
	}
}

export const isMiraiInputError = (error: unknown): error is MiraiInputError =>
	error instanceof Error && error.name === 'MiraiInputError';

/** `YYYY-MM-DD` que existe no calendário (o schema só confere o formato: 2026-02-30 passa). */
export const isCalendarDate = (value: string): boolean => {
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** Confere um período `from`–`to` e lança `MiraiInputError` quando ele não vale. */
export const assertPeriod = (from: string, to: string): void => {
	if (!isCalendarDate(from)) throw new MiraiInputError('"from" não é uma data que existe');
	if (!isCalendarDate(to)) throw new MiraiInputError('"to" não é uma data que existe');
	if (from > to) throw new MiraiInputError('"from" depois de "to"');
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { validateToolInput, isCalendarDate, assertPeriod, isMiraiInputError };
