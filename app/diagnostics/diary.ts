/**
 * Diário de diagnóstico no aparelho (SPD-013, DEC-03 opção B).
 *
 * A release não tem log que dure: o logcat some em minutos e o app não guarda nada. O
 * diário anota, em arquivos JSONL que giram, o que aconteceu e quando — para o usuário
 * exportar ("Exportar diagnóstico" nos Ajustes) e, na onda 3, para subir ao servidor.
 *
 * Quem registra nunca espera nem recebe exceção: `logEvent` corta o evento nos limites do
 * contrato (`contract.ts`), põe numa fila na memória e volta. A fila é gravada em lote,
 * depois de um instante ou quando enche; se o disco falhar, o lote volta para a fila e
 * espera a próxima vez.
 *
 * O que guarda: metadados. Texto cru só em `rawText`, e só de aviso de app de banco
 * conhecido que o parser descartou ou não entendeu (DEC-11 b) — escolher isso é de quem
 * chama. Nunca token, senha nem cabeçalho.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { STORAGE_KEYS } from '../utils/storageUtils';
import {
	DIAGNOSTIC_LIMITS,
	type DiagnosticArea,
	type DiagnosticEvent,
	type DiagnosticLevel,
	type DiagnosticValue,
} from './contract';

/** Pasta do diário dentro de `Paths.document` (não é apagada pelo sistema como o cache). */
export const DIARY_DIRECTORY = 'diagnostics';

/**
 * Tamanhos do diário.
 *
 * - Arquivo de até 256 KB: cabe inteiro num envio ao servidor (corpo até 512 KB), e ler um
 *   arquivo de cada vez não pesa na memória.
 * - Até 5 arquivos (~1,25 MB): um evento de metadados tem ~400 bytes, então são uns 3 mil
 *   eventos, ou ~550 se todos levarem os 2000 caracteres de texto cru. Dá dias de uso, que é
 *   o que importa para "a captura parou ontem"; o servidor guarda 30 dias.
 * - Fila de até 500 na memória: o disco fora do ar não faz o app crescer sem fim.
 */
export const DIARY_LIMITS = {
	maxFileBytes: 256 * 1024,
	maxFiles: 5,
	maxQueued: 500,
	/** Com isto na fila, grava na hora em vez de esperar o instante. */
	flushAtCount: 50,
	flushDelayMs: 2000,
} as const;

export interface LogOptions {
	level?: DiagnosticLevel;
	data?: Record<string, DiagnosticValue | undefined>;
	/** Só DEC-11 b (ver o cabeçalho). */
	rawText?: string | null;
}

/** Um evento a registrar. `id` e `at` só vêm de fora quando o evento nasceu no nativo. */
export interface DiaryEntry extends LogOptions {
	area: DiagnosticArea;
	event: string;
	id?: string;
	at?: string;
}

/** O evento na fila: tudo menos o id da instalação, que é lido do AsyncStorage na gravação. */
type QueuedEvent = Omit<DiagnosticEvent, 'installId'>;

const LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
const AREAS: readonly string[] = ['capture', 'native', 'sync', 'session', 'reminders', 'app'];

const FILE_PATTERN = /^diary-(\d+)\.jsonl$/;
const CURSOR_FILE = 'uploaded-until.txt';

// ---------------------------------------------------------------------------
// Corte nos limites do contrato
// ---------------------------------------------------------------------------

/** Corta sem deixar meio caractere (um emoji são duas unidades de UTF-16). */
const cut = (text: string, max: number): string => {
	if (text.length <= max) return text;
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return text.slice(0, end);
};

const cleanValue = (value: unknown): DiagnosticValue | undefined => {
	if (value === null) return null;
	switch (typeof value) {
		case 'string':
			return cut(value, DIAGNOSTIC_LIMITS.maxStringLength);
		case 'number':
			return Number.isFinite(value) ? value : null;
		case 'boolean':
			return value;
		default:
			// Objeto, função, undefined: o contrato só aceita escalar, e um objeto do app
			// no diário seria justamente o que pode levar dado que não devia.
			return undefined;
	}
};

const cleanData = (data: unknown): Record<string, DiagnosticValue> | undefined => {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;

	const clean: Record<string, DiagnosticValue> = {};
	// Chave cortada pode repetir outra: fica a primeira.
	const seen = new Set<string>();
	for (const [rawKey, rawValue] of Object.entries(data)) {
		if (seen.size >= DIAGNOSTIC_LIMITS.maxDataKeys) break;
		const value = cleanValue(rawValue);
		if (value === undefined) continue;
		const key = cut(rawKey, DIAGNOSTIC_LIMITS.maxKeyLength);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		clean[key] = value;
	}
	return seen.size > 0 ? clean : undefined;
};

const validInstant = (at: unknown): string | null => {
	if (typeof at !== 'string') return null;
	const millis = Date.parse(at);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

/** uuid v4. O gerador do app usa `crypto.getRandomValues`; sem ele, o aleatório comum basta. */
const newId = (): string => {
	try {
		return generateUniqueId();
	} catch {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
			const random = Math.floor(Math.random() * 16);
			return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
		});
	}
};

const currentPlatform = (): DiagnosticEvent['platform'] =>
	Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : 'web';

/** O evento pronto para a fila: limites aplicados, campos que faltam preenchidos. Lança se `entry` não é objeto. */
export const sanitizeEvent = (entry: DiaryEntry): QueuedEvent => {
	const event: QueuedEvent = {
		id:
			typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 64
				? entry.id
				: newId(),
		at: validInstant(entry.at) ?? new Date().toISOString(),
		level: LEVELS.includes(entry.level as string) ? (entry.level as DiagnosticLevel) : 'info',
		area: AREAS.includes(entry.area as string) ? entry.area : 'app',
		event: cut(String(entry.event ?? ''), DIAGNOSTIC_LIMITS.maxEventNameLength) || 'unnamed',
		appVersion: Constants.expoConfig?.version ?? 'unknown',
		platform: currentPlatform(),
	};

	const data = cleanData(entry.data);
	if (data) event.data = data;
	if (typeof entry.rawText === 'string' && entry.rawText.length > 0) {
		event.rawText = cut(entry.rawText, DIAGNOSTIC_LIMITS.maxRawTextLength);
	}
	return event;
};

// ---------------------------------------------------------------------------
// Id da instalação
// ---------------------------------------------------------------------------

let installIdPromise: Promise<string> | null = null;

const loadInstallId = async (): Promise<string> => {
	try {
		const stored = await AsyncStorage.getItem(STORAGE_KEYS.diagnosticsInstallId);
		if (stored) return stored;
	} catch {
		// Sem leitura não se grava: poderia sobrescrever o id que já existe. Esta sessão
		// usa um id só dela.
		return newId();
	}

	const created = newId();
	try {
		await AsyncStorage.setItem(STORAGE_KEYS.diagnosticsInstallId, created);
	} catch {
		// Fica só nesta sessão; a próxima tenta de novo.
	}
	return created;
};

/** Id aleatório desta instalação: gerado uma vez e guardado no AsyncStorage. */
export const getInstallId = (): Promise<string> => {
	if (!installIdPromise) installIdPromise = loadInstallId();
	return installIdPromise;
};

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------

const directory = (): Directory => new Directory(Paths.document, DIARY_DIRECTORY);

const fileName = (seq: number): string => `diary-${String(seq).padStart(6, '0')}.jsonl`;

/** Bytes em UTF-8, sem `Buffer` (não existe no React Native). */
const utf8Length = (text: string): number => {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i += 1;
		} else bytes += 3;
	}
	return bytes;
};

/** Os arquivos do diário, do mais velho ao mais novo. O número só cresce: nunca é reusado. */
const listDiaryFiles = (): { seq: number; file: File }[] => {
	const dir = directory();
	if (!dir.exists) return [];

	const found: { seq: number; file: File }[] = [];
	for (const item of dir.list()) {
		const name = item.uri.replace(/\/+$/, '').split('/').pop() ?? '';
		const match = FILE_PATTERN.exec(name);
		if (match) found.push({ seq: Number(match[1]), file: new File(item.uri) });
	}
	return found.sort((a, b) => a.seq - b.seq);
};

/**
 * Acrescenta as linhas ao arquivo mais novo, abrindo outro quando não cabem, e apaga os
 * mais velhos acima do máximo. Lança se a escrita falhar (quem chama devolve à fila).
 */
const appendLines = (lines: string[]): void => {
	if (lines.length === 0) return;

	const dir = directory();
	if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

	const files = listDiaryFiles();
	const newest = files[files.length - 1];
	let seq = newest?.seq ?? 0;
	let target: File | null = newest?.file ?? null;
	let size = target ? target.size : 0;
	let chunk = '';

	const writeChunk = () => {
		if (target && chunk) target.write(chunk, { append: true });
		chunk = '';
	};

	for (const line of lines) {
		const text = `${line}\n`;
		const bytes = utf8Length(text);
		if (!target || (size > 0 && size + bytes > DIARY_LIMITS.maxFileBytes)) {
			writeChunk();
			seq += 1;
			target = new File(dir, fileName(seq));
			if (!target.exists) target.create();
			files.push({ seq, file: target });
			size = 0;
		}
		chunk += text;
		size += bytes;
	}
	writeChunk();

	// Apagar o velho não pode devolver à fila o que já foi gravado: falhou, tenta na próxima.
	while (files.length > DIARY_LIMITS.maxFiles) {
		const oldest = files.shift();
		try {
			oldest?.file.delete();
		} catch {
			break;
		}
	}
};

const parseLine = (line: string): DiagnosticEvent | null => {
	if (!line.trim()) return null;
	try {
		const value = JSON.parse(line) as DiagnosticEvent | null;
		return value &&
			typeof value === 'object' &&
			typeof value.id === 'string' &&
			typeof value.event === 'string'
			? value
			: null;
	} catch {
		return null;
	}
};

/** Tudo o que está nos arquivos, na ordem de gravação. Linha corrompida fica de fora. */
const readStoredEvents = async (): Promise<DiagnosticEvent[]> => {
	const events: DiagnosticEvent[] = [];
	for (const { file } of listDiaryFiles()) {
		let text: string;
		try {
			text = await file.text();
		} catch {
			continue;
		}
		for (const line of text.split('\n')) {
			const event = parseLine(line);
			if (event) events.push(event);
		}
	}
	return events;
};

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

let queue: QueuedEvent[] = [];
/** Quantos a fila cheia descartou desde a última gravação; vira um evento quando grava. */
let droppedFromQueue = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let warnedWriteFailure = false;

const trimQueue = () => {
	const excess = queue.length - DIARY_LIMITS.maxQueued;
	if (excess > 0) {
		queue.splice(0, excess);
		droppedFromQueue += excess;
	}
};

const scheduleFlush = () => {
	if (timer) return;
	timer = setTimeout(() => {
		timer = null;
		void flushDiary();
	}, DIARY_LIMITS.flushDelayMs);
};

const enqueue = (event: QueuedEvent) => {
	queue.push(event);
	trimQueue();
	if (queue.length >= DIARY_LIMITS.flushAtCount && !flushing) void flushDiary();
	else scheduleFlush();
};

const writeQueued = async (): Promise<void> => {
	if (queue.length === 0 && droppedFromQueue === 0) return;

	const batch = queue;
	const dropped = droppedFromQueue;
	queue = [];
	droppedFromQueue = 0;

	const installId = await getInstallId();
	const events =
		dropped > 0
			? [
					sanitizeEvent({
						area: 'app',
						event: 'diary_queue_overflow',
						level: 'warn',
						data: { dropped },
					}),
					...batch,
				]
			: batch;

	try {
		appendLines(events.map((event) => JSON.stringify({ ...event, installId })));
	} catch (error) {
		// Volta para a frente da fila, na ordem; o que entrou enquanto isso fica atrás.
		queue = batch.concat(queue);
		droppedFromQueue += dropped;
		trimQueue();
		if (!warnedWriteFailure) {
			warnedWriteFailure = true;
			console.warn('Diagnostics diary write failed:', error);
		}
	}
};

/** Registra um evento. Síncrono, nunca lança; a gravação vem depois, em lote. */
export const logEvent = (area: DiagnosticArea, event: string, options: LogOptions = {}): void => {
	try {
		const { level, data, rawText } = options ?? {};
		enqueue(sanitizeEvent({ area, event, level, data, rawText }));
	} catch {
		// Diário nunca derruba quem registra.
	}
};

/** Como `logEvent`, mas guardando `id` e `at` de quem já os tem (o serviço nativo). */
export const recordEvent = (entry: DiaryEntry): void => {
	try {
		enqueue(sanitizeEvent(entry));
	} catch {
		// Idem.
	}
};

/** Grava a fila agora. Nunca rejeita; o que não gravou continua na fila. */
export const flushDiary = (): Promise<void> => {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	const run = (flushing ?? Promise.resolve()).then(writeQueued).catch(() => {});
	flushing = run;
	void run.then(() => {
		if (flushing === run) flushing = null;
	});
	return run;
};

/** Quantos eventos esperam gravação. */
export const pendingInQueue = (): number => queue.length;

// ---------------------------------------------------------------------------
// Leitura e envio (onda 3)
// ---------------------------------------------------------------------------

const cursorFile = (): File => new File(directory(), CURSOR_FILE);

const readCursor = async (): Promise<string | null> => {
	try {
		const file = cursorFile();
		if (!file.exists) return null;
		const id = (await file.text()).trim();
		return id || null;
	} catch {
		return null;
	}
};

export interface ReadEventsOptions {
	/** Só eventos com `at` neste instante ou depois (ISO). */
	since?: string;
	/** No máximo tantos, a partir do mais velho. */
	limit?: number;
	/** Só o que veio depois do último `markUploaded`. */
	pendingOnly?: boolean;
}

/**
 * Os eventos do diário, do mais velho ao mais novo; antes, grava a fila. Nunca lança: sem
 * diário ou com erro de leitura, devolve o que conseguiu.
 */
export const readEvents = async (options: ReadEventsOptions = {}): Promise<DiagnosticEvent[]> => {
	await flushDiary();

	let events: DiagnosticEvent[];
	try {
		events = await readStoredEvents();
	} catch {
		return [];
	}

	if (options.pendingOnly) {
		const cursor = await readCursor();
		if (cursor) {
			// Marcado que não está mais nos arquivos saiu pela rotação, que apaga do mais
			// velho para o mais novo: tudo o que restou é posterior a ele.
			const index = events.findIndex((event) => event.id === cursor);
			if (index >= 0) events = events.slice(index + 1);
		}
	}

	const since = validInstant(options.since);
	if (since) events = events.filter((event) => event.at >= since);

	if (typeof options.limit === 'number' && options.limit >= 0) {
		events = events.slice(0, Math.floor(options.limit));
	}
	return events;
};

/**
 * Anota que tudo até `untilId` (inclusive, na ordem de `readEvents`) já subiu. Não apaga
 * nada: o usuário ainda pode exportar. Devolve falso se não conseguiu gravar (o próximo
 * envio repete, e o servidor ignora id repetido).
 */
export const markUploaded = async (untilId: string): Promise<boolean> => {
	try {
		const dir = directory();
		if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
		cursorFile().write(String(untilId));
		return true;
	} catch {
		return false;
	}
};

/** Zera o estado do módulo (fila, id em memória). Só para testes. */
export const resetDiaryForTests = (): void => {
	if (timer) clearTimeout(timer);
	timer = null;
	queue = [];
	droppedFromQueue = 0;
	flushing = null;
	installIdPromise = null;
	warnedWriteFailure = false;
};
