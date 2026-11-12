/**
 * O contador da trilha (SPD-151): "Passo N de T". No celular, a trilha "Este mês" mostrou
 * "4 de 8" e no passo seguinte "5 de 7": o passo dos envelopes (sem envelope, o alvo não
 * existe) era pulado só quando o guia chegava nele, e o total mudava no meio da trilha.
 *
 * A regra: os passos que a trilha mostra são decididos antes do primeiro balão — pelos dados
 * (`planTrail`) e, na tela onde ela abre, pelos alvos que existem. Dali em diante o total não
 * muda e o número anda de um em um, para a frente e para trás. Um alvo que some numa tela
 * aberta depois não pula mais o passo: ele mostra o texto sem apontar.
 *
 * A camada da trilha de verdade, com a navegação e a medida de mentira: os alvos de `present`
 * estão no meio da tela; os outros não existem. As chaves de tradução aparecem cruas.
 */

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { planTrail, TRAILS, type TrailLocation, type TrailRecords } from '../../../utils/trails';
import TrailOverlay from '../TrailOverlay';

jest.setTimeout(30_000);

let renderer: ReactTestRenderer | null = null;

const wait = (ms: number) =>
	act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const texts = (): string[] =>
	(
		renderer?.root.findAll(
			(node) => (node.type as unknown) === Text || (node.type as unknown) === 'Text'
		) ?? []
	).map((node) => [node.props.children].flat().join(''));

const COUNTER = /^tutorial\.counter(\{.*\})$/;

/** O contador do balão na tela agora, ou `null` sem balão. */
const counter = (): { current: number; total: number } | null => {
	const found = texts()
		.map((text) => COUNTER.exec(text))
		.find((match) => match !== null);
	return found ? JSON.parse(found[1]) : null;
};

/** O título do passo na tela agora (`trails.<trilha>.steps.<id>.title`). */
const title = (): string | undefined => texts().find((text) => text.endsWith('.title'));

const waitFor = async (check: () => boolean, timeout = 5_000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < timeout) await wait(10);
};

const pressLabel = async (label: string) => {
	const node = renderer?.root.find(
		(candidate: ReactTestInstance) =>
			candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	);
	await act(async () => {
		node?.props.onPress();
	});
};

/** Anda pela trilha com "Próximo" e anota o título e o contador de cada balão. */
const walk = async (steps: number) => {
	const seen: { title: string | undefined; current: number; total: number; pointing: boolean }[] = [];
	for (let item = 0; item < steps; item += 1) {
		await waitFor(() => counter() !== null && !seen.some((entry) => entry.title === title()));
		const shown = counter();
		if (!shown) break;
		const pointing = (renderer?.root.findAll((node) => node.props.testID === 'trail-outline').length ?? 0) > 0;
		seen.push({ title: title(), ...shown, pointing });
		const last = texts().includes('tutorial.done');
		await pressLabel(last ? 'tutorial.done' : 'tutorial.next');
		if (last) break;
	}
	return seen;
};

const mount = async (
	trail: keyof typeof TRAILS,
	records: TrailRecords,
	origin: TrailLocation,
	present: ReadonlySet<string>,
	onEnd = jest.fn()
) => {
	const plan = planTrail(TRAILS[trail], records, origin);
	await act(async () => {
		renderer = create(
			<TrailOverlay
				plan={plan}
				start={0}
				origin={origin}
				navigator={{ run: () => undefined }}
				isReady={() => true}
				onEnd={onEnd}
				measure={async (id) => (present.has(id) ? { x: 16, y: 200, width: 300, height: 50 } : null)}
				scrollTo={async () => false}
				settleMs={0}
				readyTimeoutMs={0}
			/>
		);
	});
	return { plan, onEnd };
};

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
});

/** Todos os alvos da trilha "Este mês", menos os de `without`. */
const monthTargets = (without: readonly string[]) =>
	new Set(
		TRAILS.month.steps
			.flatMap((step) => (step.targets ?? []).flat())
			.filter((id) => !without.includes(id))
	);

describe('o contador da trilha (SPD-151)', () => {
	it('"Este mês" sem envelope: 7 passos do primeiro ao último, sem "4 de 8" → "5 de 7"', async () => {
		// Com cartão o plano tem 8 passos; o 5 (envelopes) não tem alvo na tela inicial.
		const { plan, onEnd } = await mount(
			'month',
			{ card: [{ id: 'cartao' }] },
			{ screen: 'home' },
			monthTargets(['month.envelope'])
		);
		expect(plan).toHaveLength(8);

		const seen = await walk(8);
		expect(seen.map((entry) => entry.title)).toEqual(
			['1', '2', '3', '4', '6', '7', '8'].map((id) => `trails.month.steps.${id}.title`)
		);
		expect(seen.map((entry) => `${entry.current} de ${entry.total}`)).toEqual([
			'1 de 7',
			'2 de 7',
			'3 de 7',
			'4 de 7',
			'5 de 7',
			'6 de 7',
			'7 de 7',
		]);
		await waitFor(() => onEnd.mock.calls.length > 0);
		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	it('"Este mês" com tudo na tela: 8 de 8, e o último é "Entendi"', async () => {
		await mount('month', { card: [{ id: 'cartao' }] }, { screen: 'home' }, monthTargets([]));
		const seen = await walk(8);
		expect(seen.map((entry) => `${entry.current} de ${entry.total}`)).toEqual(
			[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n} de 8`)
		);
	});

	it('cartão sem compra no mês e sem envelope: os dois saem antes do primeiro balão, 6 de 6', async () => {
		// O usuário tem cartão (o plano mantém o passo 4), mas a linha dele não está na tela.
		await mount('month', { card: [{ id: 'cartao' }] }, { screen: 'home' }, monthTargets(['month.card', 'month.envelope']));
		const seen = await walk(8);
		expect(seen.map((entry) => `${entry.current} de ${entry.total}`)).toEqual(
			[1, 2, 3, 4, 5, 6].map((n) => `${n} de 6`)
		);
	});

	it('"Voltar" passa por cima do passo que saiu, sem o número pular nem o total mudar', async () => {
		await mount('month', { card: [{ id: 'cartao' }] }, { screen: 'home' }, monthTargets(['month.envelope']));
		const forward = await walk(5);
		expect(forward.map((entry) => entry.current)).toEqual([1, 2, 3, 4, 5]);
		// `walk` já apertou "Próximo" no 5: está no 6 de 7 (o passo 7 do texto).
		await waitFor(() => counter()?.current === 6);
		expect(counter()).toEqual({ current: 6, total: 7 });

		const back: { title: string | undefined; current: number; total: number }[] = [];
		for (const expected of [5, 4, 3]) {
			await pressLabel('trails.back');
			await waitFor(() => counter()?.current === expected);
			const shown = counter();
			if (shown) back.push({ title: title(), ...shown });
		}
		expect(back).toEqual([
			{ title: 'trails.month.steps.6.title', current: 5, total: 7 },
			{ title: 'trails.month.steps.4.title', current: 4, total: 7 },
			{ title: 'trails.month.steps.3.title', current: 3, total: 7 },
		]);
	});

	it('alvo que falta numa tela aberta depois do início: mostra o texto sem apontar, e o total fica', async () => {
		// Trilha 4 com dois cartões: o passo 7 ("Juntar dois cartões", na edição do cartão) entra
		// no plano, mas o botão não está lá. Antes ele era pulado ao chegar e o total caía de 9
		// para 8 no meio da trilha.
		const everything = new Set(TRAILS.cardExtras.steps.flatMap((step) => (step.targets ?? []).flat()));
		everything.delete('cardEdit.merge');
		const { plan } = await mount(
			'cardExtras',
			{
				card: [{ id: 'c1' }, { id: 'c2' }],
				otherCard: [{ id: 'c1' }, { id: 'c2' }],
				debitCard: [{ accountId: 'a1', last4: '1234' }],
			},
			{ screen: 'card', params: { id: 'c1' } },
			everything
		);
		expect(plan).toHaveLength(9);

		const seen = await walk(9);
		expect(seen.map((entry) => `${entry.current} de ${entry.total}`)).toEqual(
			[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${n} de 9`)
		);
		expect(seen[6].title).toBe('trails.cardExtras.steps.7.title');
		// O passo 7 sem o botão: só o texto, sem o contorno; o 6, com o alvo na tela, aponta.
		expect(seen[6].pointing).toBe(false);
		expect(seen[5].pointing).toBe(true);
	});
});
