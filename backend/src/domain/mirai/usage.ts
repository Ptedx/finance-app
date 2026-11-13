import type { MiraiTokens } from './pricing.js';

/**
 * Os contadores do Mirai: perguntas do dia, tokens e custo (`assistant_usage`), e as
 * rodadas de cada pergunta (em memória).
 *
 * Só contadores. Pergunta, resultado de ferramenta e resposta não são gravados em lugar
 * nenhum (D5): a tabela tem número e data, e o id da pergunta é um uuid do aparelho.
 */

/** O fuso do dia e do mês: o limite diário vira à meia-noite de Brasília, não à das 21 h. */
export const MIRAI_TIME_ZONE = 'America/Sao_Paulo';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: MIRAI_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/** O dia de `now` em Brasília, `YYYY-MM-DD`. */
export const miraiDay = (now: Date): string => {
	const parts = Object.fromEntries(
		dayFormat.formatToParts(now).map((part) => [part.type, part.value])
	);
	return `${parts['year']}-${parts['month']}-${parts['day']}`;
};

/** O primeiro e o último dia possível do mês de `day` (comparação de texto, `YYYY-MM-DD`). */
export const monthRange = (day: string): { gte: string; lte: string } => ({
	gte: `${day.slice(0, 7)}-01`,
	lte: `${day.slice(0, 7)}-31`,
});

/** A linha de `assistant_usage`: um usuário num dia. */
export interface MiraiUsageRow extends MiraiTokens {
	userId: string;
	day: string;
	questions: number;
	costMicros: number;
}

type UserDay = { userId_day: { userId: string; day: string } };

/** A forma do banco que o Mirai usa. O `PrismaClient` a satisfaz; os testes passam um falso. */
export interface MiraiUsageDb {
	assistantUsage: {
		findUnique(args: {
			where: UserDay;
			select: { questions: true };
		}): PromiseLike<{ questions: number } | null>;
		aggregate(args: {
			where: { day: { gte: string; lte: string } };
			_sum: { costMicros: true };
		}): PromiseLike<{ _sum: { costMicros: number | null } }>;
		upsert(args: {
			where: UserDay;
			create: MiraiUsageRow;
			update: { [K in keyof MiraiTokens | 'questions' | 'costMicros']: { increment: number } };
		}): PromiseLike<unknown>;
	};
}

/** Perguntas que o usuário já fez no dia. */
export const questionsToday = async (
	db: MiraiUsageDb,
	userId: string,
	day: string
): Promise<number> => {
	const row = await db.assistantUsage.findUnique({
		where: { userId_day: { userId, day } },
		select: { questions: true },
	});
	return row?.questions ?? 0;
};

/** O que todos os usuários juntos gastaram no mês de `day`, em micro-US$ (o teto é geral). */
export const spentThisMonth = async (db: MiraiUsageDb, day: string): Promise<number> => {
	const result = await db.assistantUsage.aggregate({
		where: { day: monthRange(day) },
		_sum: { costMicros: true },
	});
	return result._sum.costMicros ?? 0;
};

/** Soma uma chamada ao dia do usuário: a pergunta (se for nova), os tokens e o custo. */
export const recordUsage = async (
	db: MiraiUsageDb,
	row: {
		userId: string;
		day: string;
		newQuestion: boolean;
		tokens: MiraiTokens;
		costMicros: number;
	}
): Promise<void> => {
	const questions = row.newQuestion ? 1 : 0;
	await db.assistantUsage.upsert({
		where: { userId_day: { userId: row.userId, day: row.day } },
		create: {
			userId: row.userId,
			day: row.day,
			questions,
			costMicros: row.costMicros,
			...row.tokens,
		},
		update: {
			questions: { increment: questions },
			inputTokens: { increment: row.tokens.inputTokens },
			outputTokens: { increment: row.tokens.outputTokens },
			cacheReadTokens: { increment: row.tokens.cacheReadTokens },
			cacheWriteTokens: { increment: row.tokens.cacheWriteTokens },
			costMicros: { increment: row.costMicros },
		},
	});
};

/**
 * Quantas chamadas cada pergunta já fez, por usuário e `questionId`.
 *
 * Fica em memória, não no banco: é só o freio de rodadas de uma pergunta, que dura
 * segundos. Se a API reiniciar no meio de uma pergunta, ela recomeça a contagem — e conta
 * como pergunta nova no dia, o lado seguro do limite. Entradas mais velhas que `ttlMs` saem.
 */
export interface QuestionTracker {
	/** Chamadas já feitas com este `questionId` (0 = pergunta nova). */
	rounds(userId: string, questionId: string): number;
	/** Conta mais uma chamada. */
	start(userId: string, questionId: string): void;
	/** Desfaz a última chamada (a API falhou: nada foi gasto). */
	undo(userId: string, questionId: string): void;
}

export const createQuestionTracker = (
	now: () => number = Date.now,
	ttlMs = 6 * 60 * 60 * 1000
): QuestionTracker => {
	const entries = new Map<string, { rounds: number; at: number }>();
	const key = (userId: string, questionId: string) => `${userId}\u0000${questionId}`;

	const prune = (): void => {
		const cutoff = now() - ttlMs;
		for (const [id, entry] of entries) {
			if (entry.at < cutoff) entries.delete(id);
		}
	};

	return {
		rounds: (userId, questionId) => entries.get(key(userId, questionId))?.rounds ?? 0,
		start: (userId, questionId) => {
			prune();
			const id = key(userId, questionId);
			entries.set(id, { rounds: (entries.get(id)?.rounds ?? 0) + 1, at: now() });
		},
		undo: (userId, questionId) => {
			const id = key(userId, questionId);
			const entry = entries.get(id);
			if (!entry) return;
			if (entry.rounds <= 1) entries.delete(id);
			else entries.set(id, { rounds: entry.rounds - 1, at: entry.at });
		},
	};
};
