/**
 * Os apps que o app aprendeu a ignorar (SPD-022), no SQL **de verdade** de `captures.ts`.
 *
 * A regra mora em `merchant_rules` com a chave `app:<pacote>`, e o nome que a tela mostra
 * ("Avisos do WhatsApp estão sendo ignorados") vem da última captura daquele pacote. A
 * pergunta é o que a consulta devolve, e isso só um SQLite responde: o `expo-sqlite` vira
 * um banco em memória do próprio Node (`node:sqlite`), como em `accountSql.test.ts`. Sem
 * `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com um aviso.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync: (new (path: string) => {
		exec: (sql: string) => void;
		prepare: (sql: string) => {
			run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
			get: (...params: unknown[]) => unknown;
			all: (...params: unknown[]) => unknown[];
		};
	}) | null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value));
	return {
		mockSqliteAvailable: DatabaseSync !== null,
		openDatabaseSync: () => {
			if (!DatabaseSync) return {};
			const raw = new DatabaseSync(':memory:');
			return {
				execAsync: async (sql: string) => {
					raw.exec(sql);
				},
				runAsync: async (sql: string, params: unknown[] = []) => {
					const result = raw.prepare(sql).run(...normalise(params));
					return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...normalise(params)),
				withTransactionAsync: async (body: () => Promise<void>) => {
					raw.exec('BEGIN');
					try {
						await body();
						raw.exec('COMMIT');
					} catch (error) {
						raw.exec('ROLLBACK');
						throw error;
					}
				},
			};
		},
	};
});

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
	multiRemove: jest.fn(async () => undefined),
}));

import {
	countPendingCaptures,
	deleteMerchantRule,
	getIgnoredApps,
	getLastNotificationPostedAt,
	getPendingCaptures,
	getResolvedCaptures,
	insertCapture,
	saveMerchantRule,
} from '../captures';
import { db, initDatabase } from '../database';
import type { Capture } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('capturesSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const MAIL = 'com.google.android.gm';
const SMS = 'com.google.android.apps.messaging';
const WHATSAPP = 'com.whatsapp';

let counter = 0;
const capture = (overrides: Partial<Capture>): Omit<Capture, 'id' | 'createdAt' | 'updatedAt'> => {
	counter += 1;
	return {
		fingerprint: `fp-${counter}`,
		packageName: MAIL,
		appLabel: 'Gmail',
		title: 'Santander',
		text: 'Compra no cartão final 7890 aprovada: R$ 45,00 em LOJA ABC.',
		postedAt: '2026-10-23T15:00:00.000Z',
		amountCents: 4500,
		direction: 'out',
		kind: 'purchase',
		counterparty: null,
		merchantKey: null,
		cardLast4: null,
		status: 'dismissed',
		question: null,
		relatedId: null,
		suggestedCategory: null,
		transactionId: null,
		autoConfirmed: false,
		reason: 'manual',
		accountId: null,
		transferId: null,
		installments: null,
		...overrides,
	};
};

const appRule = (packageName: string, confirmations: number) =>
	saveMerchantRule({ merchantKey: `app:${packageName}`, categoryId: null, treatAs: 'ignore', confirmations });

describeSql('apps ignorados, SQL de verdade (SPD-022)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync('DELETE FROM captures; DELETE FROM merchant_rules;');
	});

	it('só a regra que já chegou a 3 descartes, com o nome mais recente do app', async () => {
		await insertCapture(capture({ appLabel: 'E-mail', postedAt: '2026-10-01T10:00:00.000Z' }));
		await insertCapture(capture({ appLabel: 'Gmail', postedAt: '2026-10-20T10:00:00.000Z' }));
		await insertCapture(capture({ packageName: WHATSAPP, appLabel: 'WhatsApp' }));
		await appRule(MAIL, 3);
		await appRule(WHATSAPP, 2);

		expect(await getIgnoredApps(3)).toEqual([{ packageName: MAIL, appLabel: 'Gmail' }]);
	});

	it('o SMS nunca aparece como ignorado, nem com uma regra gravada para ele (de outro aparelho)', async () => {
		await insertCapture(capture({ packageName: SMS, appLabel: 'Mensagens' }));
		await appRule(SMS, 5);
		await appRule('com.samsung.android.messaging', 4);

		expect(await getIgnoredApps(3)).toEqual([]);
	});

	it('regra de estabelecimento "ignorar" não é app, e regra esquecida não aparece', async () => {
		await saveMerchantRule({ merchantKey: 'loja abc', categoryId: null, treatAs: 'ignore', confirmations: 5 });
		await appRule(MAIL, 3);
		await deleteMerchantRule(`app:${MAIL}`);

		expect(await getIgnoredApps(3)).toEqual([]);
	});

	it('sem nenhuma captura do app (podadas, ou vinda de outro aparelho), mostra o pacote', async () => {
		await appRule(WHATSAPP, 4);

		expect(await getIgnoredApps(3)).toEqual([{ packageName: WHATSAPP, appLabel: WHATSAPP }]);
	});

	it('a captura podada (lápide) ainda empresta o nome', async () => {
		await insertCapture(capture({ packageName: WHATSAPP, appLabel: 'WhatsApp' }));
		await db.runAsync("UPDATE captures SET deletedAt = '2026-10-24T00:00:00.000Z'");
		await appRule(WHATSAPP, 3);

		expect(await getIgnoredApps(3)).toEqual([{ packageName: WHATSAPP, appLabel: 'WhatsApp' }]);
	});
});

/**
 * SPD-069 (DEC-29): o que já estava na caixa vindo do OnlineBanking sai da fila — também o
 * que chegar pelo sync de um aparelho que ainda não bloqueava.
 */
describeSql('app bloqueado fora da fila, SQL de verdade (SPD-069)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync('DELETE FROM captures; DELETE FROM merchant_rules;');
	});

	it('a fila e a contagem não trazem o pendente do OnlineBanking', async () => {
		await insertCapture(capture({ status: 'pending', reason: null }));
		await insertCapture(capture({ packageName: 'com.mobileapp.basasuperapp', appLabel: 'OnlineBanking', status: 'pending', reason: null }));

		expect((await getPendingCaptures()).map((item) => item.packageName)).toEqual([MAIL]);
		expect(await countPendingCaptures()).toBe(1);
	});
});

/**
 * SPD-112: o aviso de captura parada contava o silêncio a partir das pendentes e das 60
 * resolvidas mais recentes por `updatedAt`. Um extrato OFX grande enche as 60 com linhas
 * `ofx:`, o último aviso de verdade sai da lista e o aviso nunca aparece. A consulta nova
 * olha a tabela inteira.
 */
describeSql('último aviso de notificação, SQL de verdade (SPD-112)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync('DELETE FROM captures; DELETE FROM merchant_rules;');
	});

	const NUBANK = 'com.nu.production';

	it('70 linhas de extrato recentes não escondem a notificação de 5 dias atrás', async () => {
		const notice = await insertCapture(
			capture({ packageName: NUBANK, appLabel: 'Nubank', postedAt: '2026-10-19T12:00:00.000Z', status: 'confirmed' })
		);
		// A notificação foi resolvida antes do import: o `updatedAt` dela é o mais antigo.
		await db.runAsync('UPDATE captures SET updatedAt = ? WHERE id = ?', ['2026-10-19T12:05:00.000Z', notice.id]);
		for (let line = 0; line < 70; line += 1) {
			await insertCapture(
				capture({
					packageName: 'ofx:260-12345',
					appLabel: 'Extrato',
					postedAt: `2026-10-${String(20 + (line % 4)).padStart(2, '0')}T12:00:00.000Z`,
					status: 'confirmed',
				})
			);
		}

		// O que o aviso via antes: nenhuma notificação entre as 60 mais recentes.
		const resolved = await getResolvedCaptures(60);
		expect(resolved.some((item) => !item.packageName.startsWith('ofx:'))).toBe(false);
		// A consulta nova acha a notificação.
		expect(await getLastNotificationPostedAt()).toBe('2026-10-19T12:00:00.000Z');
	});

	it('a mais recente entre as notificações, pendentes ou não; linha apagada (lápide) não conta', async () => {
		await insertCapture(capture({ packageName: NUBANK, postedAt: '2026-10-18T12:00:00.000Z', status: 'pending', reason: null }));
		await insertCapture(capture({ postedAt: '2026-10-21T09:30:00.000Z' }));
		const gone = await insertCapture(capture({ packageName: NUBANK, postedAt: '2026-10-22T12:00:00.000Z' }));
		await db.runAsync('UPDATE captures SET deletedAt = ? WHERE id = ?', ['2026-10-23T00:00:00.000Z', gone.id]);
		await insertCapture(capture({ packageName: 'ofx:260-12345', postedAt: '2026-10-23T12:00:00.000Z' }));

		expect(await getLastNotificationPostedAt()).toBe('2026-10-21T09:30:00.000Z');
	});

	it('só extrato, ou nada: nulo', async () => {
		expect(await getLastNotificationPostedAt()).toBeNull();
		await insertCapture(capture({ packageName: 'ofx:260-12345', postedAt: '2026-10-23T12:00:00.000Z' }));
		expect(await getLastNotificationPostedAt()).toBeNull();
	});
});
