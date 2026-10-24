/**
 * Diário de diagnóstico (SPD-013): o que entra é cortado nos limites do contrato, os
 * arquivos giram sem crescer sem fim, quem registra nunca recebe exceção, a instalação
 * tem um id estável, o envio sabe o que já subiu e a exportação junta tudo num arquivo.
 *
 * O disco é o `mockFs` abaixo (caminho → conteúdo), o AsyncStorage é um Map e o
 * compartilhar do sistema é um mock.
 */

const mockFs = {
	files: new Map<string, string>(),
	dirs: new Set<string>(),
	/** Liga para simular disco cheio ou sem permissão: toda escrita lança. */
	failWrites: false,
};

const mockStorage = new Map<string, string>();
const mockStorageState = { fail: false };

// Sem `class` de propósito (ver `exportUtils.test.ts`): a fábrica do `jest.mock` não
// alcança as funções auxiliares que o babel gera para classe.
jest.mock('expo-file-system', () => {
	const join = (parts: unknown[]): string =>
		parts
			.map((part) => (typeof part === 'string' ? part : (part as { uri: string }).uri))
			.join('/')
			.replace(/\/+$/, '');
	const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

	function MockFile(...parts: unknown[]) {
		const uri = join(parts);
		return {
			uri,
			get name() {
				return uri.split('/').pop();
			},
			get exists() {
				return mockFs.files.has(uri);
			},
			get size() {
				return byteLength(mockFs.files.get(uri) ?? '');
			},
			create: () => {
				if (mockFs.failWrites) throw new Error('disco cheio');
				if (!mockFs.files.has(uri)) mockFs.files.set(uri, '');
			},
			write: (content: string, options?: { append?: boolean }) => {
				if (mockFs.failWrites) throw new Error('disco cheio');
				const before = options?.append ? (mockFs.files.get(uri) ?? '') : '';
				mockFs.files.set(uri, before + content);
			},
			text: async () => {
				const content = mockFs.files.get(uri);
				if (content === undefined) throw new Error(`não existe: ${uri}`);
				return content;
			},
			textSync: () => {
				const content = mockFs.files.get(uri);
				if (content === undefined) throw new Error(`não existe: ${uri}`);
				return content;
			},
			delete: () => {
				mockFs.files.delete(uri);
			},
		};
	}

	function MockDirectory(...parts: unknown[]) {
		const uri = join(parts);
		return {
			uri,
			get exists() {
				return mockFs.dirs.has(uri);
			},
			create: () => {
				if (mockFs.failWrites) throw new Error('disco cheio');
				mockFs.dirs.add(uri);
			},
			list: () => {
				if (!mockFs.dirs.has(uri)) throw new Error(`não existe: ${uri}`);
				return [...mockFs.files.keys()]
					.filter((path) => path.startsWith(`${uri}/`) && !path.slice(uri.length + 1).includes('/'))
					.map((path) => MockFile(path));
			},
		};
	}

	return {
		File: MockFile,
		Directory: MockDirectory,
		Paths: { document: { uri: 'file:///doc' }, cache: { uri: 'file:///cache' } },
	};
});

jest.mock('expo-sharing', () => ({
	isAvailableAsync: jest.fn(async () => true),
	shareAsync: jest.fn(async () => {}),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => {
		if (mockStorageState.fail) throw new Error('AsyncStorage fora do ar');
		return mockStorage.get(key) ?? null;
	}),
	setItem: jest.fn(async (key: string, value: string) => {
		if (mockStorageState.fail) throw new Error('AsyncStorage fora do ar');
		mockStorage.set(key, value);
	}),
}));

jest.mock('expo-constants', () => ({
	__esModule: true,
	default: { expoConfig: { version: '1.2.9' } },
}));

jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 34 } }));

import * as Sharing from 'expo-sharing';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { DIAGNOSTIC_LIMITS, type DiagnosticEvent } from '../contract';
import {
	DIARY_DIRECTORY,
	DIARY_LIMITS,
	flushDiary,
	getInstallId,
	logEvent,
	markUploaded,
	pendingInQueue,
	readEvents,
	readUploadStamp,
	recordEvent,
	resetDiaryForTests,
	sanitizeEvent,
	utf8Length,
	writeUploadStamp,
} from '../diary';
import { exportDiagnostics } from '../export';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const diaryFiles = (): string[] =>
	[...mockFs.files.keys()]
		.filter((path) => path.startsWith(`file:///doc/${DIARY_DIRECTORY}/diary-`))
		.sort();

const allLines = (): DiagnosticEvent[] =>
	diaryFiles().flatMap((path) =>
		(mockFs.files.get(path) ?? '')
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as DiagnosticEvent)
	);

beforeEach(() => {
	mockFs.files.clear();
	mockFs.dirs.clear();
	mockFs.failWrites = false;
	mockStorage.clear();
	mockStorageState.fail = false;
	resetDiaryForTests();
	jest.clearAllMocks();
	jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	(console.warn as jest.Mock).mockRestore();
});

describe('o evento sai completo e dentro dos limites do contrato', () => {
	it('preenche id, instante, versão, plataforma e instalação', async () => {
		logEvent('app', 'app_start', { data: { osVersion: '34' } });
		await flushDiary();

		const [event] = allLines();
		expect(event).toMatchObject({
			level: 'info',
			area: 'app',
			event: 'app_start',
			data: { osVersion: '34' },
			appVersion: '1.2.9',
			platform: 'android',
		});
		expect(event.id).toMatch(UUID);
		expect(event.installId).toMatch(UUID);
		expect(new Date(event.at).toISOString()).toBe(event.at);
		expect(event).not.toHaveProperty('rawText');
	});

	it('corta nome, chaves, textos e texto cru; nunca lança', () => {
		const data: Record<string, string> = {};
		for (let i = 0; i < 30; i++) data[`chave_${i}`] = 'x';
		data['k'.repeat(60)] = 'y'.repeat(500);

		const event = sanitizeEvent({
			area: 'capture',
			event: 'e'.repeat(100),
			data,
			rawText: 'r'.repeat(5000),
		});

		expect(event.event).toHaveLength(DIAGNOSTIC_LIMITS.maxEventNameLength);
		expect(Object.keys(event.data ?? {})).toHaveLength(DIAGNOSTIC_LIMITS.maxDataKeys);
		expect(event.rawText).toHaveLength(DIAGNOSTIC_LIMITS.maxRawTextLength);

		const long = sanitizeEvent({
			area: 'app',
			event: 'x',
			data: { ['k'.repeat(60)]: 'y'.repeat(500) },
		});
		const [[key, value]] = Object.entries(long.data ?? {});
		expect(key).toHaveLength(DIAGNOSTIC_LIMITS.maxKeyLength);
		expect(value).toHaveLength(DIAGNOSTIC_LIMITS.maxStringLength);
	});

	it('valor que não é escalar some; número não finito vira null; nível e área inválidos caem no padrão', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		const event = sanitizeEvent({
			// biome-ignore lint/suspicious/noExplicitAny: entrada inválida de propósito
			area: 'qualquer' as any,
			event: 'x',
			// biome-ignore lint/suspicious/noExplicitAny: entrada inválida de propósito
			level: 'fatal' as any,
			data: {
				ok: 1,
				texto: 'a',
				sim: true,
				nada: null,
				infinito: Number.POSITIVE_INFINITY,
				nan: Number.NaN,
				// biome-ignore lint/suspicious/noExplicitAny: entrada inválida de propósito
				objeto: circular as any,
				indefinido: undefined,
			},
		});

		expect(event.area).toBe('app');
		expect(event.level).toBe('info');
		expect(event.data).toEqual({
			ok: 1,
			texto: 'a',
			sim: true,
			nada: null,
			infinito: null,
			nan: null,
		});
	});

	it('não deixa meio emoji no fim do texto cortado', () => {
		const text = `${'a'.repeat(DIAGNOSTIC_LIMITS.maxStringLength - 1)}😀`;
		const event = sanitizeEvent({ area: 'app', event: 'x', data: { t: text } });
		const cut = String(event.data?.t);
		expect(cut).toBe('a'.repeat(DIAGNOSTIC_LIMITS.maxStringLength - 1));
	});

	it('texto cru vazio ou que não é texto não entra', () => {
		expect(sanitizeEvent({ area: 'app', event: 'x', rawText: '' })).not.toHaveProperty('rawText');
		// biome-ignore lint/suspicious/noExplicitAny: entrada inválida de propósito
		expect(sanitizeEvent({ area: 'app', event: 'x', rawText: 42 as any })).not.toHaveProperty(
			'rawText'
		);
	});
});

describe('rotação', () => {
	const fill = async (count: number) => {
		for (let i = 0; i < count; i++) {
			logEvent('capture', 'capture_discarded', { data: { n: i }, rawText: 'z'.repeat(2000) });
			if (i % 40 === 39) await flushDiary();
		}
		await flushDiary();
	};

	it('nenhum arquivo passa do limite, e o mais velho é apagado quando passam do máximo', async () => {
		// ~2,2 KB por evento: 1200 eventos são ~2,6 MB, o dobro do que cabe.
		await fill(1200);

		const files = diaryFiles();
		expect(files).toHaveLength(DIARY_LIMITS.maxFiles);
		for (const path of files) {
			expect(Buffer.byteLength(mockFs.files.get(path) ?? '', 'utf8')).toBeLessThanOrEqual(
				DIARY_LIMITS.maxFileBytes
			);
		}

		// O que sobrou é o fim, em ordem e sem buraco.
		const kept = allLines().map((event) => Number(event.data?.n));
		expect(kept[kept.length - 1]).toBe(1199);
		expect(kept[0]).toBeGreaterThan(0);
		expect(kept).toEqual(kept.map((_, index) => kept[0] + index));
	});

	it('os nomes seguem uma sequência: o primeiro arquivo some, o último é o mais novo', async () => {
		await fill(1200);
		const names = diaryFiles().map((path) => path.split('/').pop());
		expect(names[0]).not.toBe('diary-000001.jsonl');
		const numbers = names.map((name) => Number(/diary-(\d+)\.jsonl/.exec(name ?? '')?.[1]));
		expect(numbers).toEqual(numbers.map((_, index) => numbers[0] + index));
	});
});

describe('a fila nunca lança nem trava quem registra', () => {
	it('disco falhando: logEvent e flush não lançam, e o evento espera a próxima vez', async () => {
		mockFs.failWrites = true;
		expect(() => logEvent('sync', 'sync_pull_done')).not.toThrow();
		await expect(flushDiary()).resolves.toBeUndefined();
		expect(pendingInQueue()).toBe(1);

		mockFs.failWrites = false;
		await flushDiary();
		expect(pendingInQueue()).toBe(0);
		expect(allLines().map((event) => event.event)).toEqual(['sync_pull_done']);
	});

	it('fila cheia descarta os mais velhos e deixa registrado quantos', async () => {
		mockFs.failWrites = true;
		for (let i = 0; i < DIARY_LIMITS.maxQueued + 25; i++)
			logEvent('app', 'tick', { data: { n: i } });
		await flushDiary();
		expect(pendingInQueue()).toBe(DIARY_LIMITS.maxQueued);

		mockFs.failWrites = false;
		await flushDiary();
		const events = allLines();
		const overflow = events.find((event) => event.event === 'diary_queue_overflow');
		expect(overflow).toMatchObject({ level: 'warn', area: 'app', data: { dropped: 25 } });
		const ticks = events.filter((event) => event.event === 'tick').map((event) => event.data?.n);
		expect(ticks[0]).toBe(25);
		expect(ticks).toHaveLength(DIARY_LIMITS.maxQueued);
	});

	it('entrada absurda não lança', () => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: entrada inválida de propósito
			logEvent(undefined as any, undefined as any, null as any)
		).not.toThrow();
		// biome-ignore lint/suspicious/noExplicitAny: entrada inválida de propósito
		expect(() => recordEvent(null as any)).not.toThrow();
	});

	it('AsyncStorage fora do ar: o evento sai mesmo assim, com um id de instalação válido', async () => {
		mockStorageState.fail = true;
		logEvent('app', 'app_start');
		await flushDiary();
		const [event] = allLines();
		expect(event.installId).toMatch(UUID);
	});

	it('o registro é síncrono e não escreve no disco na hora', () => {
		logEvent('app', 'app_foreground');
		expect(diaryFiles()).toHaveLength(0);
		expect(pendingInQueue()).toBe(1);
	});
});

describe('id da instalação', () => {
	it('gerado uma vez, guardado e o mesmo depois de reabrir o app', async () => {
		const first = await getInstallId();
		expect(first).toMatch(UUID);
		expect(mockStorage.get(STORAGE_KEYS.diagnosticsInstallId)).toBe(first);

		resetDiaryForTests();
		expect(await getInstallId()).toBe(first);
	});

	it('a chave é nova e não viaja no backup nem no sync', () => {
		const { BACKED_UP_PREFERENCE_KEYS, SYNCED_PREFERENCE_KEYS } = jest.requireActual(
			'../../utils/storageUtils'
		) as typeof import('../../utils/storageUtils');
		expect(BACKED_UP_PREFERENCE_KEYS).not.toContain(STORAGE_KEYS.diagnosticsInstallId);
		expect(SYNCED_PREFERENCE_KEYS).not.toContain(STORAGE_KEYS.diagnosticsInstallId);
	});
});

describe('leitura e marcação do que já subiu', () => {
	const log = async (names: string[]) => {
		for (const name of names) logEvent('app', name);
		await flushDiary();
	};

	it('lê na ordem em que foi gravado, inclusive o que ainda estava na fila', async () => {
		await log(['a', 'b']);
		logEvent('app', 'c');
		expect((await readEvents()).map((event) => event.event)).toEqual(['a', 'b', 'c']);
	});

	it('limit e since', async () => {
		recordEvent({ area: 'app', event: 'velho', at: '2026-10-01T00:00:00.000Z' });
		recordEvent({ area: 'app', event: 'novo', at: '2026-10-20T00:00:00.000Z' });
		await log(['agora']);

		expect((await readEvents({ limit: 2 })).map((event) => event.event)).toEqual(['velho', 'novo']);
		expect(
			(await readEvents({ since: '2026-10-10T00:00:00.000Z' })).map((event) => event.event)
		).toEqual(['novo', 'agora']);
	});

	it('pendentes: só o que veio depois do último marcado, sem apagar nada', async () => {
		await log(['a', 'b', 'c']);
		const [, b] = await readEvents();
		await markUploaded(b.id);

		expect((await readEvents({ pendingOnly: true })).map((event) => event.event)).toEqual(['c']);
		expect(await readEvents()).toHaveLength(3);

		await log(['d']);
		expect((await readEvents({ pendingOnly: true })).map((event) => event.event)).toEqual([
			'c',
			'd',
		]);
	});

	it('marcado que já saiu pela rotação: tudo o que restou é posterior, e está pendente', async () => {
		await log(['a']);
		await markUploaded('00000000-0000-4000-8000-000000000000');
		expect((await readEvents({ pendingOnly: true })).map((event) => event.event)).toEqual(['a']);
	});

	it('linha corrompida não derruba as outras', async () => {
		await log(['a']);
		const [path] = diaryFiles();
		mockFs.files.set(path, `${mockFs.files.get(path)}{meia linha\n`);
		await log(['b']);
		expect((await readEvents()).map((event) => event.event)).toEqual(['a', 'b']);
	});

	it('sem diário ainda: lista vazia', async () => {
		expect(await readEvents()).toEqual([]);
		expect(await readEvents({ pendingOnly: true })).toEqual([]);
	});
});

describe('instante do último envio (SPD-016)', () => {
	it('sem envio ainda: null; gravado, volta igual', async () => {
		expect(await readUploadStamp()).toBeNull();
		expect(await writeUploadStamp(1_761_300_000_000)).toBe(true);
		expect(await readUploadStamp()).toBe(1_761_300_000_000);
	});

	it('arquivo ilegível ou disco fora do ar: null e false, sem lançar', async () => {
		await writeUploadStamp(1_761_300_000_000);
		const [path] = [...mockFs.files.keys()].filter((key) => key.includes('last-upload'));
		mockFs.files.set(path, 'lixo');
		expect(await readUploadStamp()).toBeNull();

		mockFs.failWrites = true;
		expect(await writeUploadStamp(1)).toBe(false);
	});

	it('não aparece como evento do diário', async () => {
		logEvent('app', 'a');
		await writeUploadStamp(1_761_300_000_000);
		expect((await readEvents()).map((event) => event.event)).toEqual(['a']);
	});
});

describe('tamanho em UTF-8', () => {
	it('conta acento, emoji e ASCII como o servidor recebe', () => {
		for (const text of ['abc', 'ação', '💳 cartão', '{"a":"ç"}', '']) {
			expect(utf8Length(text)).toBe(Buffer.byteLength(text, 'utf8'));
		}
	});
});

describe('exportar diagnóstico', () => {
	it('junta os arquivos num .jsonl e abre o compartilhar do sistema', async () => {
		for (let i = 0; i < 300; i++)
			logEvent('capture', 'x', { data: { n: i }, rawText: 'z'.repeat(2000) });
		await flushDiary();
		expect(diaryFiles().length).toBeGreaterThan(1);
		logEvent('app', 'ultimo');

		const result = await exportDiagnostics();

		expect(result).toEqual({ status: 'shared', count: 301 });
		expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
		const [uri, options] = (Sharing.shareAsync as jest.Mock).mock.calls[0];
		expect(uri).toMatch(/^file:\/\/\/cache\/spendr-diagnostico-\d{8}-\d{6}\.jsonl$/);
		expect(options).toMatchObject({ mimeType: 'text/plain' });

		const lines = (mockFs.files.get(uri) ?? '').split('\n').filter(Boolean);
		expect(lines).toHaveLength(301);
		expect(lines.map((line) => (JSON.parse(line) as DiagnosticEvent).data?.n).slice(0, 3)).toEqual([
			0, 1, 2,
		]);
		expect((JSON.parse(lines[300]) as DiagnosticEvent).event).toBe('ultimo');
	});

	it('não leva linha corrompida para o arquivo', async () => {
		logEvent('app', 'a');
		await flushDiary();
		const [path] = diaryFiles();
		mockFs.files.set(path, `${mockFs.files.get(path)}{meia linha\n`);

		const result = await exportDiagnostics();
		expect(result.count).toBe(1);
	});

	it('diário vazio: não abre o compartilhar', async () => {
		expect(await exportDiagnostics()).toEqual({ status: 'empty', count: 0 });
		expect(Sharing.shareAsync).not.toHaveBeenCalled();
	});

	it('sem compartilhar no aparelho: avisa em vez de falhar', async () => {
		logEvent('app', 'a');
		(Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
		expect(await exportDiagnostics()).toEqual({ status: 'unavailable', count: 1 });
		expect(Sharing.shareAsync).not.toHaveBeenCalled();
	});
});
