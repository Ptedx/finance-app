/**
 * O separador decimal nos relatórios (E2E-45): a Saúde financeira mostrava "0.3" meses de
 * reserva em português, e os anos até a meta saíam "12.5". O Patrimônio já mostrava "0,3"
 * (`formatMonthsCovered`). Em português e italiano é vírgula; em inglês, ponto.
 */

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// As chaves aparecem cruas, com os parâmetros ao lado, para ver o número que vai na frase.
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string, options?: object) => (options ? `${key} ${JSON.stringify(options)}` : key) }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { HealthIndicator } from '../../../utils/healthScore';
import { yearsText } from '../../../utils/insights';
import { configureMoney } from '../../../utils/money';
import { buildRetirementReadModel } from '../../../utils/retirement';
import FreedomHero from '../FreedomHero';
import HealthGrid from '../HealthGrid';

let renderer: ReactTestRenderer | null = null;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const texts = (): string[] => (renderer as ReactTestRenderer).root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

const portugues = () => configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
const italiano = () => configureMoney({ locale: 'it-IT', currencyCode: 'EUR', currencySymbol: '€' });
const ingles = () => configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });

afterEach(() => {
	if (renderer) act(() => (renderer as ReactTestRenderer).unmount());
	renderer = null;
	ingles();
});

describe('HealthGrid — meses de reserva', () => {
	// Valor do achado: 0,3 mês de reserva, alvo de 6 meses.
	const reserve: HealthIndicator = {
		id: 'emergency-reserve',
		status: 'bad',
		unit: 'months',
		value: 0.3,
		target: 6,
		direction: 'atLeast',
		params: {},
	};

	const show = () => {
		act(() => {
			renderer = create(<HealthGrid indicators={[reserve]} />);
		});
	};

	it('em português, "0,3"', () => {
		portugues();
		show();
		expect(texts()).toContain('0,3');
		expect(texts()).not.toContain('0.3');
	});

	it('em italiano, "0,3"', () => {
		italiano();
		show();
		expect(texts()).toContain('0,3');
	});

	it('em inglês, "0.3"', () => {
		ingles();
		show();
		expect(texts()).toContain('0.3');
	});
});

describe('yearsText — anos até a meta', () => {
	it('com uma casa, o separador do idioma', () => {
		portugues();
		expect(yearsText(12.5)).toBe('12,5');
		italiano();
		expect(yearsText(12.5)).toBe('12,5');
		ingles();
		expect(yearsText(12.5)).toBe('12.5');
	});

	it('ano inteiro sai sem casa decimal', () => {
		portugues();
		expect(yearsText(20)).toBe('20');
	});
});

describe('FreedomHero — anos até a meta', () => {
	const R = (reais: number) => reais * 100;
	const goal = { targetMonthlyCents: R(10_000), reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 0 };
	const base = buildRetirementReadModel({
		goal,
		trackedCapitalCents: R(20_000),
		monthlyContributionCents: R(3_000),
		realizedYield12mCents: null,
		averageCapital12mCents: null,
		asOfMonth: '2026-09',
	});
	const model = { ...base, reach: { kind: 'eta' as const, years: 12.5, months: 150, month: '2039-03' } };
	const income = { grossCents: R(14_000), passThroughCents: 0, netCents: R(14_000), incomeCount: 1, passThroughCount: 0 };

	const show = () => {
		act(() => {
			renderer = create(
				<FreedomHero model={model} goal={goal} income={income} scenario={{ month: '2037-09', monthsEarlier: 18 }} onEditGoal={() => undefined} />
			);
		});
	};

	const line = (key: string): string => texts().find((text) => text.startsWith(key)) ?? '';

	it('em português, "12,5 anos" e "1,5 ano antes"', () => {
		portugues();
		show();
		expect(line('reports.freedom.reachEta')).toContain('"years":"12,5"');
		expect(line('reports.freedom.debtScenario')).toContain('"years":"1,5"');
	});

	it('em inglês, "12.5" e "1.5"', () => {
		ingles();
		show();
		expect(line('reports.freedom.reachEta')).toContain('"years":"12.5"');
		expect(line('reports.freedom.debtScenario')).toContain('"years":"1.5"');
	});
});
