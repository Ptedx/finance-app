/**
 * O Mirai daruma (SPD-163, §7.1): as 7 expressões do contrato desenham, cada uma com o rosto
 * dela, e o traço engrossa abaixo de 64 dp.
 *
 * O `react-native-svg` vira componentes de mentira que só repassam as props: o teste lê o
 * desenho pela árvore, sem depender do nativo.
 */

jest.mock('react-native-svg', () => {
	const React = require('react');
	const make = (name: string) => {
		const Part = (props: Record<string, unknown>) =>
			React.createElement(name, props, props.children);
		Part.displayName = name;
		return Part;
	};
	return {
		__esModule: true,
		default: make('Svg'),
		Svg: make('Svg'),
		Circle: make('Circle'),
		Ellipse: make('Ellipse'),
		G: make('G'),
		Path: make('Path'),
	};
});

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { MiraiExpression } from '../../../utils/mirai/contract';
import MiraiAvatar, { MIRAI_COLORS } from '../MiraiAvatar';

const EXPRESSIONS: MiraiExpression[] = [
	'normal',
	'thinking',
	'happy',
	'worried',
	'sad',
	'sorry',
	'goal',
];

const render = (expression: MiraiExpression, size?: number): ReactTestRenderer => {
	let renderer: ReactTestRenderer | null = null;
	act(() => {
		renderer = create(<MiraiAvatar expression={expression} size={size} />);
	});
	if (!renderer) throw new Error('não renderizou');
	return renderer;
};

const parts = (renderer: ReactTestRenderer, testID: string) =>
	renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);

const fills = (renderer: ReactTestRenderer): Set<string> =>
	new Set(
		renderer.root
			.findAll((node) => typeof node.type === 'string' && typeof node.props.fill === 'string')
			.map((node) => node.props.fill as string)
			.filter((fill) => fill !== 'none')
	);

describe('MiraiAvatar', () => {
	it.each(EXPRESSIONS)('desenha %s, com corpo ciano, rosto claro e a seta branca', (expression) => {
		const renderer = render(expression);
		expect(parts(renderer, `mirai-avatar-${expression}`)).toHaveLength(1);
		const colors = fills(renderer);
		expect(colors.has(MIRAI_COLORS.body)).toBe(true);
		expect(colors.has(MIRAI_COLORS.face)).toBe(true);
		expect(parts(renderer, 'mirai-mouth')).toHaveLength(1);
		expect(parts(renderer, 'mirai-brows')).toHaveLength(1);
	});

	it('as 7 expressões são 7 desenhos diferentes', () => {
		const drawings = EXPRESSIONS.map((expression) => JSON.stringify(render(expression).toJSON()));
		expect(new Set(drawings).size).toBe(EXPRESSIONS.length);
	});

	it('um olho pintado no dia a dia; os dois só no goal, com os brilhos dourados', () => {
		for (const expression of EXPRESSIONS.filter((e) => e !== 'goal' && e !== 'happy')) {
			const renderer = render(expression);
			expect(parts(renderer, 'mirai-pupil-left')).toHaveLength(1);
			expect(parts(renderer, 'mirai-pupil-right')).toHaveLength(0);
		}
		const goal = render('goal');
		expect(parts(goal, 'mirai-pupil-left')).toHaveLength(1);
		expect(parts(goal, 'mirai-pupil-right')).toHaveLength(1);
		expect(parts(goal, 'mirai-sparkles')).toHaveLength(1);
		expect(fills(goal).has(MIRAI_COLORS.sparkle)).toBe(true);
	});

	it('cada expressão traz o próprio enfeite', () => {
		expect(parts(render('thinking'), 'mirai-dots')).toHaveLength(1);
		expect(parts(render('happy'), 'mirai-cheeks')).toHaveLength(1);
		expect(parts(render('happy'), 'mirai-eyes-closed')).toHaveLength(1);
		expect(parts(render('sorry'), 'mirai-sweat')).toHaveLength(1);
		const sad = render('sad');
		expect(parts(sad, 'mirai-tear')).toHaveLength(1);
		expect(fills(sad).has(MIRAI_COLORS.tear)).toBe(true);
		// Preocupado e triste não carregam o enfeite um do outro.
		expect(parts(render('worried'), 'mirai-tear')).toHaveLength(0);
		expect(parts(render('normal'), 'mirai-sparkles')).toHaveLength(0);
	});

	it('abaixo de 64 dp o traço engrossa, para ficar legível no botão de 52', () => {
		const strokeOf = (renderer: ReactTestRenderer) =>
			parts(renderer, 'mirai-brows')[0].props.strokeWidth as number;
		const small = render('normal', 52);
		const large = render('normal', 96);
		expect(strokeOf(small)).toBeGreaterThan(strokeOf(large));
		expect(parts(small, 'mirai-avatar-normal')[0].props.width).toBe(52);
	});
});
