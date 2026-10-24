import {
	type CaptureHealthInput,
	captureWarning,
	isStalledDismissalActive,
	lastBankNotificationAt,
	parseStalledDismissedAt,
} from '../captureHealth';

/**
 * O aviso de captura (SPD-021, AUTO-02): "desligada" quando o acesso foi tirado, "parada"
 * quando o acesso continua ligado mas nenhum aviso de banco chega há 3 dias. Os instantes
 * são fixos em UTC e as contas usam milissegundos, então o fuso não muda nada.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-24T15:00:00.000Z');

const bank = { packageName: 'com.nu.production', archived: false };
const manual = { packageName: null, archived: false };

const captureAgo = (days: number, packageName = 'com.nu.production') => ({
	packageName,
	postedAt: new Date(NOW - days * DAY).toISOString(),
});

const input = (patch: Partial<CaptureHealthInput> = {}): CaptureHealthInput => ({
	supported: true,
	enabled: true,
	offDismissed: false,
	stalledDismissedAt: null,
	accounts: [bank],
	captures: [captureAgo(1)],
	now: NOW,
	...patch,
});

describe('captura parada', () => {
	it('3 dias sem aviso de banco: avisa com os dias', () => {
		expect(captureWarning(input({ captures: [captureAgo(3)] }))).toEqual({
			kind: 'stalled',
			days: 3,
		});
		expect(captureWarning(input({ captures: [captureAgo(9.5)] }))).toEqual({
			kind: 'stalled',
			days: 9,
		});
	});

	it('menos de 3 dias: nada', () => {
		expect(captureWarning(input({ captures: [captureAgo(2.99)] }))).toBeNull();
		expect(captureWarning(input({ captures: [captureAgo(0)] }))).toBeNull();
	});

	it('conta a partir do aviso mais recente, em qualquer ordem', () => {
		const captures = [captureAgo(10), captureAgo(1), captureAgo(5)];
		expect(captureWarning(input({ captures }))).toBeNull();
		expect(lastBankNotificationAt(captures)).toBe(NOW - DAY);
	});

	it('linha de extrato OFX não conta como aviso de banco', () => {
		const captures = [captureAgo(4), captureAgo(0, 'ofx:341-1234')];
		expect(captureWarning(input({ captures }))).toEqual({ kind: 'stalled', days: 4 });
	});

	it('sem conta ligada a app de banco: nada', () => {
		const captures = [captureAgo(10)];
		expect(captureWarning(input({ accounts: [], captures }))).toBeNull();
		expect(captureWarning(input({ accounts: [manual], captures }))).toBeNull();
		// Arquivada não recebe captura (SPD-002), e conta de extrato não é app de banco.
		expect(captureWarning(input({ accounts: [{ ...bank, archived: true }], captures }))).toBeNull();
		expect(
			captureWarning(
				input({ accounts: [{ packageName: 'ofx:341-1234', archived: false }], captures })
			)
		).toBeNull();
	});

	it('sem nenhum aviso guardado não há de onde contar: nada', () => {
		expect(captureWarning(input({ captures: [] }))).toBeNull();
		expect(
			captureWarning(input({ captures: [{ packageName: 'com.nu.production', postedAt: 'lixo' }] }))
		).toBeNull();
	});

	it('a dispensa vale por 7 dias, não para sempre', () => {
		const captures = [captureAgo(20)];
		expect(captureWarning(input({ captures, stalledDismissedAt: NOW - 6.9 * DAY }))).toBeNull();
		expect(captureWarning(input({ captures, stalledDismissedAt: NOW - 7 * DAY }))).toEqual({
			kind: 'stalled',
			days: 20,
		});
	});

	it('a dispensa de um relógio que andou para trás também vence', () => {
		expect(isStalledDismissalActive(NOW + 1000, NOW)).toBe(true);
		expect(isStalledDismissalActive(NOW + 30 * DAY, NOW)).toBe(false);
		expect(isStalledDismissalActive(null, NOW)).toBe(false);
	});

	it('o valor guardado da dispensa: ausente ou ilegível é "não dispensado"', () => {
		expect(parseStalledDismissedAt(null)).toBeNull();
		expect(parseStalledDismissedAt('abc')).toBeNull();
		expect(parseStalledDismissedAt(String(NOW))).toBe(NOW);
	});
});

describe('captura desligada', () => {
	it('acesso desligado: avisa "desligada", não "parada"', () => {
		expect(captureWarning(input({ enabled: false, captures: [captureAgo(10)] }))).toEqual({
			kind: 'off',
		});
	});

	it('desligada e dispensada: nada, nem o aviso de parada', () => {
		expect(
			captureWarning(input({ enabled: false, offDismissed: true, captures: [captureAgo(10)] }))
		).toBeNull();
	});

	it('a dispensa da parada não esconde a desligada', () => {
		expect(captureWarning(input({ enabled: false, stalledDismissedAt: NOW }))).toEqual({
			kind: 'off',
		});
	});

	it('sem o serviço nativo (iOS, Expo Go): nada', () => {
		expect(captureWarning(input({ supported: false, enabled: false }))).toBeNull();
		expect(captureWarning(input({ supported: false, captures: [captureAgo(10)] }))).toBeNull();
	});
});
