/**
 * A ponte da fila de avisos: `drainCaptures` devolve o que o serviço anotou. Desde o SPD-041
 * o serviço manda também a chave da notificação do Android e o `when` dela, em campos
 * opcionais: binário antigo não os manda, e o aviso segue igual ao de sempre.
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

const entry = (extra: Record<string, unknown> = {}) => ({
	id: 'e1',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 5,00 APROVADA em CAFE.',
	postedAt: '2026-10-24T10:05:00.000Z',
	...extra,
});

beforeEach(() => {
	mockNative.module = null;
	jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe('drainCaptures', () => {
	it('repassa a chave e o `when` da notificação', () => {
		mockNative.module = {
			drain: () => [
				entry({ notificationKey: '0|com.nu.production|7|null|10123', notificationWhen: '2026-10-24T10:00:00.000Z' }),
			],
		};

		expect(load().drainCaptures()).toEqual([
			entry({ notificationKey: '0|com.nu.production|7|null|10123', notificationWhen: '2026-10-24T10:00:00.000Z' }),
		]);
	});

	it('binário antigo, sem os campos: o aviso de sempre, sem campo a mais', () => {
		mockNative.module = { drain: () => [entry()] };

		const [raw] = load().drainCaptures();
		expect(raw).toEqual(entry());
		expect('notificationKey' in raw).toBe(false);
		expect('notificationWhen' in raw).toBe(false);
	});

	it('chave ou `when` vazios ou de outro tipo ficam de fora', () => {
		mockNative.module = {
			drain: () => [entry({ notificationKey: '', notificationWhen: 0 }), entry({ notificationKey: 7, notificationWhen: '' })],
		};

		expect(load().drainCaptures()).toEqual([entry(), entry()]);
	});

	it('sem módulo nativo: vazio', () => {
		expect(load().drainCaptures()).toEqual([]);
	});

	it('o nativo lança: vazio, sem lançar', () => {
		mockNative.module = {
			drain: () => {
				throw new Error('ReactContextLost');
			},
		};
		expect(load().drainCaptures()).toEqual([]);
	});
});
