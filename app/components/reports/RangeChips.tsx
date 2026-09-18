import type React from 'react';
import { useTranslation } from 'react-i18next';
import { TREND_RANGES, type TrendRange } from '../../hooks/useReportsData';
import { ChipGroup } from '../cards/formParts';

type RangeValue = '3' | '6' | '12';

/** Quantos meses as seções de histórico mostram. Um grupo de rádio, como os outros chips. */
const RangeChips: React.FC<{ value: TrendRange; onChange: (value: TrendRange) => void }> = ({ value, onChange }) => {
	const { t } = useTranslation();
	return (
		<ChipGroup<RangeValue>
			label={t('reports.range.label')}
			options={TREND_RANGES.map((range) => ({ value: String(range) as RangeValue, label: t('reports.range.count', { count: range }) }))}
			selected={String(value) as RangeValue}
			onSelect={(next) => onChange(Number(next) as TrendRange)}
		/>
	);
};

export default RangeChips;
