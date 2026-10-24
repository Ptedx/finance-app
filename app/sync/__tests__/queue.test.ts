jest.mock('../engine', () => ({ syncNow: jest.fn() }));
jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

import { syncNow } from '../engine';
import { getState, isEnabled, notifyDataChanged, start, stop, subscribe } from '../queue';

describe('mudança de dados por fora da fila', () => {
	it('sobe o pulledVersion e avisa quem escuta — é o que faz as telas relerem o banco', () => {
		const seen: number[] = [];
		const unsubscribe = subscribe((state) => seen.push(state.pulledVersion));
		const before = getState().pulledVersion;

		notifyDataChanged();
		notifyDataChanged();

		expect(getState().pulledVersion).toBe(before + 2);
		expect(seen).toEqual([before, before + 1, before + 2]);
		unsubscribe();
	});
});

describe('isEnabled', () => {
	it('liga com start e desliga com stop — o envio do diário só roda com sessão', async () => {
		(syncNow as jest.Mock).mockResolvedValue({ pulled: 0, pushed: 0, pendingAfter: 0 });

		expect(isEnabled()).toBe(false);
		start();
		expect(isEnabled()).toBe(true);
		stop();
		expect(isEnabled()).toBe(false);
		await Promise.resolve();
	});
});
