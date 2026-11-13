/**
 * A fila parada enquanto o "Apagar todos os dados" roda (SPD-082).
 *
 * Um pull que saiu antes do apagar e chegou depois gravaria de volta, neste aparelho, o
 * que o servidor acabou de apagar; um push no meio subiria o que estava sujo. Por isso o
 * apagar espera a rodada em curso terminar e nenhuma começa até ele acabar.
 */

jest.mock('../engine', () => ({ syncNow: jest.fn() }));
jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

import { syncNow } from '../engine';
import { runExclusive, start, stop, syncImmediately } from '../queue';

const flush = async () => {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
	jest.clearAllMocks();
	stop();
});

afterEach(() => stop());

describe('runExclusive', () => {
	it('espera a rodada em curso terminar antes de começar', async () => {
		let finishRound: () => void = () => {};
		(syncNow as jest.Mock).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRound = () => resolve({ pulled: 0, pushed: 0, pendingAfter: 0 });
				})
		);
		(syncNow as jest.Mock).mockResolvedValue({ pulled: 0, pushed: 0, pendingAfter: 0 });
		start();
		await flush();
		expect(syncNow).toHaveBeenCalledTimes(1);

		const order: string[] = [];
		const exclusive = runExclusive(async () => {
			order.push('work');
		});
		await flush();
		expect(order).toEqual([]);

		finishRound();
		await exclusive;
		expect(order).toEqual(['work']);
	});

	it('nenhuma rodada começa durante o trabalho; uma pedida no meio roda depois, uma vez', async () => {
		(syncNow as jest.Mock).mockResolvedValue({ pulled: 0, pushed: 0, pendingAfter: 0 });
		start();
		await flush();
		(syncNow as jest.Mock).mockClear();

		await runExclusive(async () => {
			syncImmediately();
			syncImmediately();
			await flush();
			expect(syncNow).not.toHaveBeenCalled();
		});
		await flush();

		expect(syncNow).toHaveBeenCalledTimes(1);
	});

	it('devolve o resultado do trabalho; um erro chega a quem chamou e a fila volta a andar', async () => {
		(syncNow as jest.Mock).mockResolvedValue({ pulled: 0, pushed: 0, pendingAfter: 0 });
		start();
		await flush();

		expect(await runExclusive(async () => 42)).toBe(42);

		(syncNow as jest.Mock).mockClear();
		await expect(
			runExclusive(async () => {
				throw new Error('falhou');
			})
		).rejects.toThrow('falhou');
		syncImmediately();
		await flush();
		expect(syncNow).toHaveBeenCalled();
	});

	it('sem sessão (fila desligada): o trabalho roda e nenhuma rodada nasce dele', async () => {
		const result = await runExclusive(async () => 'ok');
		await flush();

		expect(result).toBe('ok');
		expect(syncNow).not.toHaveBeenCalled();
	});
});

describe('dois trabalhos exclusivos', () => {
	// O "Apagar a conta" e o 401 `account_gone` de um pedido que saiu no meio dele (SPD-084):
	// os dois apagam o aparelho e encerram a sessão. Um espera o outro — o segundo já
	// encontra a sessão encerrada e não apaga de novo.
	it('não correm juntos: o segundo começa quando o primeiro acaba', async () => {
		const order: string[] = [];
		let finishFirst: () => void = () => {};

		const first = runExclusive(async () => {
			order.push('primeiro:começa');
			await new Promise<void>((resolve) => {
				finishFirst = resolve;
			});
			order.push('primeiro:acaba');
		});
		const second = runExclusive(async () => {
			order.push('segundo');
		});
		await flush();
		expect(order).toEqual(['primeiro:começa']);

		finishFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(['primeiro:começa', 'primeiro:acaba', 'segundo']);
	});

	it('o primeiro falhar não prende o segundo', async () => {
		const first = runExclusive(async () => {
			throw new Error('falhou');
		});
		const second = runExclusive(async () => 'ok');

		await expect(first).rejects.toThrow('falhou');
		await expect(second).resolves.toBe('ok');
	});
});
