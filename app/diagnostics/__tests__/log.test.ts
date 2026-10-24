/**
 * O `log` de quem decide (SPD-014): sem o diário ligado não faz nada, nunca lança, e o
 * diário se liga sozinho ao ser carregado. `errorData` tira de uma falha só o que não é
 * do usuário.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
}));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.2.9' } }));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 34 } }));

import { attachDiary, errorData, log } from '../log';

afterEach(() => attachDiary(null));

describe('log', () => {
	it('sem o diário ligado, não faz nada', () => {
		expect(() => log('capture', 'capture_decision', { data: { pkg: 'x' } })).not.toThrow();
	});

	it('repassa ao diário ligado', () => {
		const writer = jest.fn();
		attachDiary(writer);
		log('sync', 'sync_pull_done', { data: { pages: 1 } });

		expect(writer).toHaveBeenCalledWith('sync', 'sync_pull_done', { data: { pages: 1 } });
	});

	it('o diário que lança não derruba quem registra', () => {
		attachDiary(() => {
			throw new Error('disco');
		});

		expect(() => log('session', 'session_login')).not.toThrow();
	});

	it('o diário se liga ao ser carregado', () => {
		jest.isolateModules(() => {
			const isolatedLog = require('../log') as typeof import('../log');
			const diary = require('../diary') as typeof import('../diary');
			diary.resetDiaryForTests();

			isolatedLog.log('reminders', 'bill_reminders_rescheduled', { data: { scheduled: 2 } });

			expect(diary.pendingInQueue()).toBe(1);
			diary.resetDiaryForTests();
		});
	});
});

describe('errorData', () => {
	it('status, código e nome; nunca a mensagem', () => {
		const error = Object.assign(new Error('E-mail eu@exemplo.com já existe'), {
			name: 'ApiError',
			status: 409,
			code: 'email_taken',
		});

		expect(errorData(error)).toEqual({ error: 'ApiError', status: 409, offline: false, code: 'email_taken' });
	});

	it('sem rede e gateway contam como offline', () => {
		expect(errorData(Object.assign(new Error(), { status: 0 })).offline).toBe(true);
		expect(errorData(Object.assign(new Error(), { status: 502 })).offline).toBe(true);
	});

	it('erro comum e coisa que nem é erro', () => {
		expect(errorData(new RangeError('PADARIA'))).toEqual({ error: 'RangeError' });
		expect(errorData('texto solto')).toEqual({ error: 'string' });
		expect(errorData(null)).toEqual({ error: 'object' });
	});
});
