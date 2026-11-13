jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isMirroredPreference } from '../../sync/preferences';
import {
	BALANCE_UNSET_DISMISSED_KEY,
	dismissBalanceUnset,
	getDismissedBalanceUnset,
} from '../balanceUnsetDismissals';
import { BACKED_UP_PREFERENCE_KEYS, SYNCED_PREFERENCE_KEYS } from '../storageUtils';

/**
 * A dispensa do "Saldo não informado" (SPD-114) fica só neste aparelho: não sobe no sync nem
 * vai nas preferências sincronizadas, para o servidor não mudar. Por id de conta.
 */

beforeEach(async () => {
	await AsyncStorage.clear();
});

describe('contas com o selo dispensado', () => {
	it('começa sem nenhuma', async () => {
		expect([...(await getDismissedBalanceUnset())]).toEqual([]);
	});

	it('guarda por id de conta, sem repetir', async () => {
		await dismissBalanceUnset('conta-a');
		await dismissBalanceUnset('conta-b');
		await dismissBalanceUnset('conta-a');
		expect([...(await getDismissedBalanceUnset())].sort()).toEqual(['conta-a', 'conta-b']);
	});

	it('valor estragado vale como nenhuma dispensa: o selo volta, o que é barato', async () => {
		await AsyncStorage.setItem(BALANCE_UNSET_DISMISSED_KEY, '{quebrado');
		expect([...(await getDismissedBalanceUnset())]).toEqual([]);
		await AsyncStorage.setItem(BALANCE_UNSET_DISMISSED_KEY, JSON.stringify(['ok', 3, null]));
		expect([...(await getDismissedBalanceUnset())]).toEqual(['ok']);
	});

	it('fica só no aparelho: fora do sync e do backup', () => {
		expect(isMirroredPreference(BALANCE_UNSET_DISMISSED_KEY)).toBe(false);
		expect(SYNCED_PREFERENCE_KEYS).not.toContain(BALANCE_UNSET_DISMISSED_KEY);
		expect(BACKED_UP_PREFERENCE_KEYS).not.toContain(BALANCE_UNSET_DISMISSED_KEY);
	});
});
