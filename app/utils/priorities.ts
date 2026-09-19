/**
 * "Por onde começar": a ordem do que fazer com o próximo real que sobrar.
 *
 *  1. Reserva mínima — três meses de custo essencial. Sem ela, um imprevisto vira dívida
 *     cara, e todo o resto desanda.
 *  2. Dívida cara — a que custa mais do que o investimento renderia (o veredito "amortize"
 *     de `worthPayingOff`). Amortizar é um rendimento garantido e sem IR.
 *  3. Reserva cheia — a meta de meses escolhida.
 *  4. Aposentadoria — daqui em diante, cada real é capital.
 *
 * O primeiro degrau não cumprido é o de agora (`doing`); os de baixo esperam (`next`). Um
 * degrau que depende de algo que o usuário ainda não informou fica `setup`.
 *
 * Puro: nada de React Native, nada de banco.
 */

import type { Cents } from './money';
import type { ReserveReadModel } from './emergencyReserve';

export type PriorityId = 'reserve-minimum' | 'expensive-debt' | 'reserve-full' | 'retirement';

export type PriorityStatus = 'done' | 'doing' | 'next' | 'setup';

export interface PriorityItem {
	id: PriorityId;
	status: PriorityStatus;
	/** Quanto falta para cumprir o degrau; 0 cumprido; nulo sem como saber. */
	missingCents: Cents | null;
}

export interface PrioritiesInput {
	reserve: ReserveReadModel;
	/** Saldo somado das dívidas com veredito "amortize". */
	expensiveDebtCents: Cents;
	/** Se há alguma dívida cadastrada (sem nenhuma, o degrau some). */
	hasDebts: boolean;
	/** Nulo sem meta de aposentadoria. */
	retirement: { capitalCents: Cents; requiredCapitalCents: Cents | null } | null;
}

export const buildPriorities = (input: PrioritiesInput): PriorityItem[] => {
	const { reserve } = input;
	const known = reserve.status !== 'unknown';

	const steps: Array<{ id: PriorityId; missingCents: Cents | null; ready: boolean }> = [];
	steps.push({ id: 'reserve-minimum', missingCents: known ? reserve.minimumGapCents : null, ready: known });
	if (input.hasDebts) {
		steps.push({ id: 'expensive-debt', missingCents: Math.max(0, input.expensiveDebtCents), ready: true });
	}
	steps.push({ id: 'reserve-full', missingCents: known ? reserve.gapCents : null, ready: known });

	const required = input.retirement?.requiredCapitalCents ?? null;
	steps.push({
		id: 'retirement',
		missingCents: input.retirement && required !== null ? Math.max(0, required - input.retirement.capitalCents) : null,
		ready: input.retirement !== null && required !== null,
	});

	let current = false;
	return steps.map((step): PriorityItem => {
		if (!step.ready) {
			// Sem custo ou sem meta não dá para dizer que está cumprido: o degrau pede um
			// dado, e os de baixo esperam por ele.
			current = true;
			return { id: step.id, status: 'setup', missingCents: null };
		}
		if (step.missingCents === 0) return { id: step.id, status: 'done', missingCents: 0 };
		const status: PriorityStatus = current ? 'next' : 'doing';
		current = true;
		return { id: step.id, status, missingCents: step.missingCents };
	});
};

/** O degrau de agora: o primeiro que não está cumprido. Nulo com tudo cumprido. */
export const currentPriority = (items: PriorityItem[]): PriorityItem | null => items.find((item) => item.status !== 'done') ?? null;

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { buildPriorities, currentPriority };
