/**
 * O que o serviço nativo anotou entra no diário com `area: 'native'`, guardando o id e o
 * instante de lá (o evento aconteceu quando o app talvez nem estivesse aberto). Texto cru
 * só de app de banco conhecido (DEC-11 b): o nativo já filtra, e aqui se confere de novo.
 */

const mockDrain = jest.fn((): unknown[] => []);

jest.mock('../../../modules/spendr-captures', () => ({
	drainDiagnostics: () => mockDrain(),
}));

jest.mock('../diary', () => ({
	recordEvent: jest.fn(),
	flushDiary: jest.fn(async () => {}),
}));

import { flushDiary, recordEvent } from '../diary';
import { ingestNativeDiagnostics } from '../native';

beforeEach(() => {
	jest.clearAllMocks();
	mockDrain.mockReturnValue([]);
});

describe('ingestNativeDiagnostics', () => {
	it('passa cada evento ao diário como nativo, com id e instante do serviço', async () => {
		mockDrain.mockReturnValue([
			{
				id: 'n1',
				at: '2026-10-24T03:00:00.000Z',
				level: 'warn',
				event: 'listener_disconnected',
				data: { reason: 'system_unbound' },
				rawText: null,
			},
		]);

		expect(await ingestNativeDiagnostics()).toBe(1);
		expect(recordEvent).toHaveBeenCalledWith({
			id: 'n1',
			at: '2026-10-24T03:00:00.000Z',
			area: 'native',
			level: 'warn',
			event: 'listener_disconnected',
			data: { reason: 'system_unbound' },
			rawText: null,
		});
		expect(flushDiary).toHaveBeenCalled();
	});

	it('texto cru fica só para pacote de banco conhecido', async () => {
		mockDrain.mockReturnValue([
			{
				id: 'b',
				at: '2026-10-24T03:00:00.000Z',
				level: 'info',
				event: 'capture_dropped_by_filter',
				data: { package: 'com.nu.production', reason: 'no_amount' },
				rawText: 'Fatura fechada',
			},
			{
				id: 'w',
				at: '2026-10-24T03:00:00.000Z',
				level: 'info',
				event: 'capture_dropped_by_filter',
				data: { package: 'com.whatsapp', reason: 'no_amount' },
				rawText: 'mensagem pessoal',
			},
			{
				id: 's',
				at: '2026-10-24T03:00:00.000Z',
				level: 'info',
				event: 'listener_connected',
				data: {},
				rawText: 'qualquer coisa',
			},
		]);

		await ingestNativeDiagnostics();
		const raws = (recordEvent as jest.Mock).mock.calls.map(([event]) => [event.id, event.rawText]);
		expect(raws).toEqual([
			['b', 'Fatura fechada'],
			['w', null],
			['s', null],
		]);
	});

	it('nada no nativo: não grava nem descarrega', async () => {
		expect(await ingestNativeDiagnostics()).toBe(0);
		expect(recordEvent).not.toHaveBeenCalled();
		expect(flushDiary).not.toHaveBeenCalled();
	});

	it('a ponte lança: zero, sem lançar', async () => {
		mockDrain.mockImplementation(() => {
			throw new Error('ponte quebrada');
		});
		await expect(ingestNativeDiagnostics()).resolves.toBe(0);
	});
});
