/**
 * O "Reconectar" do aviso de captura parada (SPD-021) pede ao Android para religar o
 * serviço. Sem o módulo (iOS, web, Expo Go) ou num binário anterior à função (JS novo por
 * OTA sobre build velha), não há a quem pedir: devolve falso e não lança.
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

beforeEach(() => {
	mockNative.module = null;
	jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe('requestCaptureRebind', () => {
	it('pede ao serviço nativo e devolve verdadeiro', () => {
		const requestRebind = jest.fn();
		mockNative.module = { requestRebind };

		expect(load().requestCaptureRebind()).toBe(true);
		expect(requestRebind).toHaveBeenCalledTimes(1);
	});

	it('sem o módulo: falso', () => {
		expect(load().requestCaptureRebind()).toBe(false);
	});

	it('binário anterior à função: falso', () => {
		mockNative.module = { isEnabled: () => true };
		expect(load().requestCaptureRebind()).toBe(false);
	});

	it('o nativo lançou: falso, sem derrubar a tela', () => {
		mockNative.module = {
			requestRebind: () => {
				throw new Error('boom');
			},
		};
		expect(load().requestCaptureRebind()).toBe(false);
	});
});
