import { capitalizeFirst } from '../capitalize';

describe('capitalizeFirst (E2E-46)', () => {
	it.each([
		['17 de novembro de 2026', '17 de novembro de 2026'],
		['novembro 2026', 'Novembro 2026'],
		['nov · atual', 'Nov · atual'],
		['março de 2026', 'Março de 2026'],
		['Hoje', 'Hoje'],
		['', ''],
	])('%j → %j', (text, expected) => {
		expect(capitalizeFirst(text)).toBe(expected);
	});
});
