jest.mock('../engine', () => ({ syncNow: jest.fn() }));
jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

import { getState, notifyDataChanged, subscribe } from '../queue';

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
