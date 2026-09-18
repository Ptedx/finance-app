import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import { areaPath, yOf } from '../../utils/chartPaths';
import { formatCents } from '../../utils/money';
import type { ProjectionPoint } from '../../utils/retirement';
import { ACCENT, INCOME_COLOR, reportStyles } from './reportStyles';

const HEIGHT = 170;
const PADDING_TOP = 18;
const PADDING_BOTTOM = 22;

/**
 * A curva do capital até a meta: a área clara é o que sai do bolso, a área por cima é o
 * que os juros fazem sozinhos. A linha tracejada é o capital necessário.
 *
 * Um só gráfico em SVG na tela, e com um rótulo inteiro para o leitor de tela: a
 * imagem é um resumo, não a única forma de saber o que ela diz.
 */
const ProjectionChart: React.FC<{ points: ProjectionPoint[]; goalCents: number | null }> = ({ points, goalCents }) => {
	const { t } = useTranslation();
	const [width, setWidth] = useState(0);

	if (points.length < 2) return null;

	const last = points[points.length - 1];
	const maxValue = Math.max(last.totalCents, goalCents ?? 0, 1);
	const frame = { width, height: HEIGHT, paddingTop: PADDING_TOP, paddingBottom: PADDING_BOTTOM };
	const years = Math.round(last.monthOffset / 12);
	const interestShare = last.totalCents > 0 ? Math.round((last.interestCents / last.totalCents) * 100) : 0;

	const summary = t('reports.projection.summary', {
		years,
		total: formatCents(last.totalCents),
		contributed: formatCents(last.contributedCents),
		interest: formatCents(last.interestCents),
		share: `${interestShare}%`,
	});

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.projection.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>{t('reports.projection.subtitle')}</Text>

			<View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} accessible accessibilityRole="image" accessibilityLabel={summary}>
				{width > 0 ? (
					<Svg width={width} height={HEIGHT}>
						<Path d={areaPath(points.map((p) => p.totalCents), maxValue, frame)} fill={ACCENT} fillOpacity={0.35} />
						<Path d={areaPath(points.map((p) => p.contributedCents), maxValue, frame)} fill={INCOME_COLOR} fillOpacity={0.55} />
						{goalCents !== null ? (
							<>
								<Line x1={0} x2={width} y1={yOf(goalCents, maxValue, frame)} y2={yOf(goalCents, maxValue, frame)} stroke="#FFFFFF" strokeOpacity={0.7} strokeDasharray="6 4" strokeWidth={1} />
								<SvgText x={width} y={yOf(goalCents, maxValue, frame) - 5} fill="#FFFFFF" fontSize={11} textAnchor="end">
									{t('reports.projection.goal')} {formatCents(goalCents)}
								</SvgText>
							</>
						) : null}
						<SvgText x={0} y={HEIGHT - 6} fill="rgba(255,255,255,0.6)" fontSize={11}>
							{t('reports.projection.today')}
						</SvgText>
						<SvgText x={width} y={HEIGHT - 6} fill="rgba(255,255,255,0.6)" fontSize={11} textAnchor="end">
							{t('reports.projection.years', { count: years })}
						</SvgText>
					</Svg>
				) : null}
			</View>

			<View style={styles.legend}>
				<View style={styles.legendItem}>
					<View style={[styles.swatch, { backgroundColor: INCOME_COLOR }]} accessible={false} />
					<Text style={reportStyles.muted}>
						{t('reports.projection.contributed')} · {formatCents(last.contributedCents)}
					</Text>
				</View>
				<View style={styles.legendItem}>
					<View style={[styles.swatch, { backgroundColor: ACCENT }]} accessible={false} />
					<Text style={reportStyles.muted}>
						{t('reports.projection.interest')} · {formatCents(last.interestCents)} ({interestShare}%)
					</Text>
				</View>
			</View>
		</View>
	);
};

const styles = StyleSheet.create({
	legend: {
		marginTop: 8,
		gap: 6,
	},
	legendItem: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	swatch: {
		width: 12,
		height: 12,
		borderRadius: 3,
	},
});

export default ProjectionChart;
