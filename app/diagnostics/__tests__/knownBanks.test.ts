import fs from 'node:fs';
import path from 'node:path';
import { isKnownBankPackage, KNOWN_BANK_PACKAGES } from '../knownBanks';

/**
 * Os apps de banco cujo texto cru pode entrar no diário (DEC-11 b). O serviço nativo tem a
 * mesma lista em Kotlin; o teste lê de lá para as duas não divergirem.
 */
describe('bancos conhecidos', () => {
	const KOTLIN = path.join(
		__dirname,
		'../../../modules/spendr-captures/android/src/main/java/expo/modules/spendrcaptures/KnownBanks.kt'
	);

	const kotlinList = (): string[] => {
		const match = /val PACKAGES\s*=\s*setOf\(([\s\S]+?)\)/.exec(fs.readFileSync(KOTLIN, 'utf8'));
		if (!match) throw new Error('lista do serviço nativo não encontrada');
		return [...match[1].matchAll(/"([^"]+)"/g)].map((found) => found[1]);
	};

	it('a lista do JS é a mesma do Kotlin', () => {
		expect([...KNOWN_BANK_PACKAGES].sort()).toEqual(kotlinList().sort());
	});

	it('banco sim; carteira, mensageiro e o próprio Spendr não', () => {
		expect(isKnownBankPackage('com.nu.production')).toBe(true);
		expect(isKnownBankPackage('br.com.intermedium')).toBe(true);
		expect(isKnownBankPackage('com.whatsapp')).toBe(false);
		expect(isKnownBankPackage('com.google.android.apps.walletnfcrel')).toBe(false);
		expect(isKnownBankPackage('com.okazakee.spendr')).toBe(false);
		expect(isKnownBankPackage(null)).toBe(false);
	});
});
