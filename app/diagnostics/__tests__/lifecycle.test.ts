/**
 * Os dois eventos que fazem o diário não nascer vazio: `app_start` ao abrir e
 * `app_foreground` ao voltar ao primeiro plano; nas duas vezes o diário do serviço nativo
 * é drenado. Ao ir para o fundo a fila é descarregada, antes que o sistema mate o app.
 */

const mockAppState: { handler: ((state: string) => void) | null; removed: number } = {
	handler: null,
	removed: 0,
};

jest.mock('react-native', () => ({
	Platform: { OS: 'android', Version: 34 },
	AppState: {
		currentState: 'active',
		addEventListener: (_event: string, handler: (state: string) => void) => {
			mockAppState.handler = handler;
			return {
				remove: () => {
					mockAppState.removed += 1;
				},
			};
		},
	},
}));

jest.mock('../diary', () => ({
	logEvent: jest.fn(),
	flushDiary: jest.fn(async () => {}),
}));

jest.mock('../native', () => ({
	ingestNativeDiagnostics: jest.fn(async () => 0),
}));

import { flushDiary, logEvent } from '../diary';
import { resetLifecycleForTests, startDiagnostics } from '../lifecycle';
import { ingestNativeDiagnostics } from '../native';

beforeEach(() => {
	jest.clearAllMocks();
	mockAppState.handler = null;
	mockAppState.removed = 0;
	resetLifecycleForTests();
});

describe('startDiagnostics', () => {
	it('registra app_start e drena o nativo', () => {
		startDiagnostics();
		expect(logEvent).toHaveBeenCalledWith('app', 'app_start', { data: { osVersion: '34' } });
		expect(ingestNativeDiagnostics).toHaveBeenCalledTimes(1);
	});

	it('fundo descarrega a fila; volta ao primeiro plano registra app_foreground e drena', () => {
		startDiagnostics();
		jest.clearAllMocks();

		mockAppState.handler?.('background');
		expect(flushDiary).toHaveBeenCalledTimes(1);
		expect(logEvent).not.toHaveBeenCalled();

		mockAppState.handler?.('active');
		expect(logEvent).toHaveBeenCalledWith('app', 'app_foreground', {
			data: { from: 'background' },
		});
		expect(ingestNativeDiagnostics).toHaveBeenCalledTimes(1);
	});

	it('"active" repetido não conta duas vezes', () => {
		startDiagnostics();
		jest.clearAllMocks();
		mockAppState.handler?.('active');
		expect(logEvent).not.toHaveBeenCalled();
	});

	it('montar de novo (modo estrito, recarga) não repete o app_start', () => {
		const stop = startDiagnostics();
		stop();
		expect(mockAppState.removed).toBe(1);

		startDiagnostics();
		const starts = (logEvent as jest.Mock).mock.calls.filter(([, event]) => event === 'app_start');
		expect(starts).toHaveLength(1);
	});
});
