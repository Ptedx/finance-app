import type React from 'react';
import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';
import type { MiraiExpression } from '../../utils/mirai/contract';

/**
 * O Mirai daruma (SPD-163, §7.1).
 *
 * O daruma é o boneco japonês dos objetivos: vem sem olhos, pinta-se um ao definir a meta e o
 * outro ao alcançá-la. O Mirai tem um olho pintado e o outro vazio, esperando você chegar lá;
 * só no `goal` os dois estão pintados.
 *
 * Desenhado em SVG, sem arquivo de imagem, nas coordenadas do rascunho de 12/11
 * (`cards/SPD-163-mirai-rascunho.svg`): centro em (0,0), e as expressões trocam só
 * sobrancelhas, olhos e boca (mais os enfeites: bolinhas, bochechas, gota, lágrima, brilhos).
 *
 * Abaixo de 64 dp o traço engrossa, para continuar legível no botão de 52.
 */

export const MIRAI_COLORS = {
	body: '#26C6DA',
	face: '#F5F7FA',
	stroke: '#0E2A33',
	arrow: '#FFFFFF',
	eyeWhite: '#FFFFFF',
	sparkle: '#FFD54F',
	tear: '#80DEEA',
	sweat: '#E0F7FA',
	cheek: '#FFCDD2',
	dots: '#FFFFFF',
} as const;

/** Abaixo deste tamanho, o traço fica mais grosso. */
export const THICK_STROKE_BELOW = 64;

const BROWS: Record<MiraiExpression, string> = {
	normal: 'M-26 -25 Q-16 -31 -6 -26 M6 -26 Q16 -31 26 -25',
	happy: 'M-26 -25 Q-16 -31 -6 -26 M6 -26 Q16 -31 26 -25',
	goal: 'M-26 -25 Q-16 -31 -6 -26 M6 -26 Q16 -31 26 -25',
	thinking: 'M-26 -28 Q-16 -34 -6 -29 M6 -27 Q16 -31 26 -27',
	sorry: 'M-26 -24 L-7 -30 M7 -30 L26 -24',
	worried: 'M-26 -23 L-7 -31 M7 -31 L26 -23',
	sad: 'M-26 -25 Q-17 -27 -7 -31 M7 -31 Q17 -27 26 -25',
};

/** A pupila do olho pintado (o esquerdo). */
const PUPIL: Record<Exclude<MiraiExpression, 'happy'>, { cx: number; cy: number; r: number }> = {
	normal: { cx: -14, cy: -12, r: 6 },
	goal: { cx: -14, cy: -12, r: 6 },
	thinking: { cx: -11, cy: -16, r: 5 },
	sorry: { cx: -14, cy: -9, r: 5 },
	worried: { cx: -14, cy: -12, r: 6 },
	sad: { cx: -14, cy: -9, r: 5 },
};

const HAPPY_MOUTH = 'M-10 3 Q0 18 10 3 Z';

/** Um brilho de quatro pontas. */
const sparkle = (cx: number, cy: number, s: number) =>
	`M${cx} ${cy - s} Q${cx} ${cy} ${cx + s} ${cy} Q${cx} ${cy} ${cx} ${cy + s} Q${cx} ${cy} ${cx - s} ${cy} Q${cx} ${cy} ${cx} ${cy - s} Z`;

export interface MiraiAvatarProps {
	expression?: MiraiExpression;
	/** Em dp. Padrão: o tamanho do botão. */
	size?: number;
	testID?: string;
}

export const MiraiAvatar: React.FC<MiraiAvatarProps> = ({
	expression = 'normal',
	size = 52,
	testID,
}) => {
	const k = size < THICK_STROKE_BELOW ? 1.5 : 1;
	const c = MIRAI_COLORS;
	const line = {
		stroke: c.stroke,
		fill: 'none',
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
	};

	const eyes =
		expression === 'happy' ? (
			<Path
				testID="mirai-eyes-closed"
				d="M-22 -10 Q-14 -19 -6 -10 M6 -10 Q14 -19 22 -10"
				strokeWidth={3.5 * k}
				{...line}
			/>
		) : (
			<G>
				<Circle cx={-14} cy={-12} r={9} fill={c.eyeWhite} stroke={c.stroke} strokeWidth={2.5 * k} />
				<Circle testID="mirai-pupil-left" {...PUPIL[expression]} fill={c.stroke} />
				<Circle cx={14} cy={-12} r={9} fill={c.eyeWhite} stroke={c.stroke} strokeWidth={2.5 * k} />
				{expression === 'goal' ? (
					<Circle testID="mirai-pupil-right" cx={14} cy={-12} r={6} fill={c.stroke} />
				) : null}
			</G>
		);

	let mouth: React.ReactNode;
	switch (expression) {
		case 'thinking':
			mouth = <Path testID="mirai-mouth" d="M-5 7 L5 5" strokeWidth={3 * k} {...line} />;
			break;
		case 'happy':
		case 'goal':
			mouth = (
				<Path
					testID="mirai-mouth"
					d={HAPPY_MOUTH}
					fill={c.stroke}
					stroke={c.stroke}
					strokeWidth={1.5 * k}
					strokeLinejoin="round"
				/>
			);
			break;
		case 'sorry':
			mouth = (
				<Path
					testID="mirai-mouth"
					d="M-9 7 Q-4.5 3 0 7 Q4.5 11 9 7"
					strokeWidth={3 * k}
					{...line}
				/>
			);
			break;
		case 'worried':
			mouth = <Ellipse testID="mirai-mouth" cx={0} cy={8} rx={4} ry={5} fill={c.stroke} />;
			break;
		case 'sad':
			mouth = <Path testID="mirai-mouth" d="M-8 10 Q0 3 8 10" strokeWidth={3 * k} {...line} />;
			break;
		default:
			mouth = <Path testID="mirai-mouth" d="M-7 5 Q0 11 7 5" strokeWidth={3 * k} {...line} />;
	}

	return (
		<Svg
			testID={testID ?? `mirai-avatar-${expression}`}
			width={size}
			height={size}
			viewBox="-68 -60 136 136"
		>
			{/* Corpo, rosto e a seta de crescimento na barriga. */}
			<Ellipse cx={0} cy={10} rx={54} ry={60} fill={c.body} />
			<Ellipse cx={0} cy={-8} rx={36} ry={29} fill={c.face} />
			<Path
				d="M-12 52 L0 40 L12 52"
				stroke={c.arrow}
				strokeWidth={5 * k}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>

			<Path testID="mirai-brows" d={BROWS[expression]} strokeWidth={3.5 * k} {...line} />
			{eyes}
			{mouth}

			{expression === 'thinking' ? (
				<G testID="mirai-dots">
					<Circle cx={28} cy={-42} r={3 * k} fill={c.dots} />
					<Circle cx={35} cy={-47} r={3.2 * k} fill={c.dots} />
					<Circle cx={42} cy={-52} r={3.5 * k} fill={c.dots} />
				</G>
			) : null}
			{expression === 'happy' ? (
				<G testID="mirai-cheeks">
					<Circle cx={-25} cy={3} r={5} fill={c.cheek} />
					<Circle cx={25} cy={3} r={5} fill={c.cheek} />
				</G>
			) : null}
			{expression === 'sorry' ? (
				<Path testID="mirai-sweat" d="M31 -38 Q38 -27 31 -22 Q24 -27 31 -38 Z" fill={c.sweat} />
			) : null}
			{expression === 'sad' ? (
				<Path testID="mirai-tear" d="M-14 0 Q-10 7 -14 10 Q-18 7 -14 0 Z" fill={c.tear} />
			) : null}
			{expression === 'goal' ? (
				<G testID="mirai-sparkles">
					<Path d={sparkle(-44, -44, 8)} fill={c.sparkle} />
					<Path d={sparkle(44, -40, 8)} fill={c.sparkle} />
				</G>
			) : null}
		</Svg>
	);
};

export default MiraiAvatar;
