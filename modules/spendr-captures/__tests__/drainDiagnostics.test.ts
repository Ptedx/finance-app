/**
 * A ponte do diário nativo (SPD-015): o serviço guarda cada evento como uma linha JSON, e
 * `drainDiagnostics` devolve as linhas já lidas. Sem o módulo (iOS, web, Expo Go) ou com
 * um binário antigo que ainda não tem a função (JS novo por OTA), devolve vazio.
 */

const mockNative: { module: Record<string, unknown> | null } = { module: null };

jest.mock('expo-modules-core', () => ({
	requireOptionalNativeModule: () => mockNative.module,
}));

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const load = (): typeof import('../index') => {
	let loaded: typeof import('../index') | undefined;
	jest.isolateModules(() => {
		loaded = require('../index');
	});
	return loaded as typeof import('../index');
};

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

beforeEach(() => {
	mockNative.module = null;
	jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe('drainDiagnostics', () => {
	it('lê as linhas do serviço como eventos', () => {
		mockNative.module = {
			drainDiagnostics: jest.fn(() => [
				line({
					id: 'a1',
					at: '2026-10-24T10:00:00.000Z',
					level: 'info',
					event: 'listener_connected',
					data: { sdk: 34 },
				}),
				line({
					id: 'a2',
					at: '2026-10-24T10:01:00.000Z',
					level: 'info',
					event: 'capture_dropped_by_filter',
					data: { package: 'com.nu.production', reason: 'no_amount' },
					rawText: 'Seu código é ######',
				}),
			]),
		};

		expect(load().drainDiagnostics()).toEqual([
			{
				id: 'a1',
				at: '2026-10-24T10:00:00.000Z',
				level: 'info',
				event: 'listener_connected',
				data: { sdk: 34 },
				rawText: null,
			},
			{
				id: 'a2',
				at: '2026-10-24T10:01:00.000Z',
				level: 'info',
				event: 'capture_dropped_by_filter',
				data: { package: 'com.nu.production', reason: 'no_amount' },
				rawText: 'Seu código é ######',
			},
		]);
	});

	it('linha corrompida ou sem nome de evento fica de fora, as outras passam', () => {
		mockNative.module = {
			drainDiagnostics: () => [
				'{meia linha',
				line({ id: 'x', at: '2026-10-24T10:00:00.000Z', level: 'info' }),
				'null',
				line({
					id: 'b',
					at: '2026-10-24T10:00:00.000Z',
					event: 'rebind_requested',
					data: 'não é objeto',
				}),
			],
		};

		expect(load().drainDiagnostics()).toEqual([
			{
				id: 'b',
				at: '2026-10-24T10:00:00.000Z',
				level: 'info',
				event: 'rebind_requested',
				data: {},
				rawText: null,
			},
		]);
	});

	it('sem módulo nativo: vazio', () => {
		mockNative.module = null;
		expect(load().drainDiagnostics()).toEqual([]);
	});

	it('binário antigo, sem a função: vazio, sem lançar', () => {
		mockNative.module = { drain: () => [] };
		expect(load().drainDiagnostics()).toEqual([]);
	});

	it('o nativo lança: vazio, sem lançar', () => {
		mockNative.module = {
			drainDiagnostics: () => {
				throw new Error('ReactContextLost');
			},
		};
		expect(load().drainDiagnostics()).toEqual([]);
	});
});
