/**
 * O Mirai na tela (SPD-163c): o botão flutuante, a ativação (D6) e a conversa, com o
 * `MiraiProvider` de verdade, um servidor falso e as ferramentas falsas.
 *
 * - O botão aparece só com `GET /status` `enabled` e some com o teclado, durante uma trilha,
 *   fora das telas principais e depois de desligado.
 * - O primeiro toque abre a ativação; "Ativar" e "Agora não" ficam nas preferências locais.
 * - A conversa mostra o "consultando…" de cada ferramenta, a expressão da marca de tom, os
 *   erros com texto próprio e a cara `sorry`, e sem internet não envia.
 *
 * Nada chama servidor de verdade: as rotas são o `transport` falso, e o `apiRequest` lança.
 */

const mockStorage = new Map<string, string>();
const mockPath = { value: '/' };
const mockAccount: { value: { id: string } | null } = { value: { id: 'usuario-1' } };
const mockPush = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
}));

jest.mock('expo-router', () => ({
	usePathname: () => mockPath.value,
	router: { push: (...args: unknown[]) => mockPush(...args) },
}));

jest.mock('../../../contexts/AuthContext', () => ({
	useAuth: () => ({ account: mockAccount.value }),
}));

jest.mock('../../../contexts/LanguageContext', () => ({
	useLanguage: () => ({ currentLanguage: { code: 'pt' } }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-svg', () => {
	const React = require('react');
	const make = (name: string) => {
		const Part = (props: Record<string, unknown>) =>
			React.createElement(name, props, props.children);
		Part.displayName = name;
		return Part;
	};
	return {
		__esModule: true,
		default: make('Svg'),
		Circle: make('Circle'),
		Ellipse: make('Ellipse'),
		G: make('G'),
		Path: make('Path'),
	};
});

jest.mock('../../../utils/mirai/tools', () => ({
	executeMiraiTool: jest.fn(async (name: string) => JSON.stringify({ tool: name })),
}));

jest.mock('../../../api/client', () => ({
	...jest.requireActual('../../../api/client'),
	apiRequest: jest.fn(async () => {
		throw new Error('nenhum teste fala com o servidor de verdade');
	}),
}));

import { Keyboard, Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../../../api/client';
import { type MiraiContextValue, useMirai } from '../../../contexts/MiraiContext';
import { MiraiProvider } from '../../../contexts/MiraiProvider';
import type {
	MiraiContentBlock,
	MiraiStatusResponse,
	MiraiTurnRequest,
	MiraiTurnResponse,
} from '../../../utils/mirai/contract';
import type { MiraiTransport } from '../../../utils/mirai/loop';
import { MIRAI_STORAGE_KEYS } from '../../../utils/mirai/preferences';
import { executeMiraiTool } from '../../../utils/mirai/tools';
import { GuideOpenContext } from '../../tour/TourContext';
import MiraiLayer from '../MiraiLayer';

// A primeira montagem carrega os componentes do react-native; com a máquina ocupada, passa dos 5 s.
jest.setTimeout(30_000);

const keyboard: Record<string, () => void> = {};
let renderer: ReactTestRenderer | null = null;
const probe: { value: MiraiContextValue | null } = { value: null };
let ids = 0;
const newId = () => {
	ids += 1;
	return `id-${ids}`;
};

const Probe = () => {
	probe.value = useMirai();
	return null;
};

/** Um servidor falso: o status e as respostas do roteiro, com os pedidos guardados como chegaram. */
const fakeServer = (
	status: MiraiStatusResponse | Error,
	turns: Array<MiraiTurnResponse | Error | (() => Promise<MiraiTurnResponse>)> = []
) => {
	const requests: MiraiTurnRequest[] = [];
	const transport: MiraiTransport = {
		status: jest.fn(async () => {
			if (status instanceof Error) throw status;
			return status;
		}),
		turn: jest.fn(async (request: MiraiTurnRequest) => {
			requests.push(JSON.parse(JSON.stringify(request)));
			const step = turns[Math.min(requests.length - 1, turns.length - 1)];
			if (step instanceof Error) throw step;
			return typeof step === 'function' ? step() : step;
		}),
	};
	return { transport, requests };
};

const ENABLED: MiraiStatusResponse = { enabled: true, remainingToday: 50 };
const text = (value: string): MiraiContentBlock => ({ type: 'text', text: value });
const reply = (
	content: MiraiContentBlock[],
	stopReason: MiraiTurnResponse['stopReason']
): MiraiTurnResponse => ({
	content,
	stopReason,
	remainingToday: 49,
});

const flush = async () => {
	for (let i = 0; i < 5; i += 1)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
};

const render = async (transport: MiraiTransport, { guideOpen = false } = {}) => {
	await act(async () => {
		renderer = create(
			<GuideOpenContext.Provider value={guideOpen}>
				<MiraiProvider transport={transport} newId={newId}>
					<MiraiLayer />
					<Probe />
				</MiraiProvider>
			</GuideOpenContext.Provider>
		);
	});
	await flush();
};

const root = () => {
	if (!renderer) throw new Error('nada renderizado');
	return renderer.root;
};

/** O elemento com este testID que responde ao toque (o `Pressable`), ou qualquer um com ele. */
const byId = (id: string): ReactTestInstance[] =>
	root().findAll((node) => node.props.testID === id);
const exists = (id: string) => byId(id).length > 0;
const pressable = (id: string) => {
	const node = byId(id).find((candidate) => typeof candidate.props.onPress === 'function');
	if (!node) throw new Error(`sem ${id}`);
	return node;
};
const press = async (id: string) => {
	await act(async () => {
		pressable(id).props.onPress();
	});
	await flush();
};

const texts = (): string[] =>
	root()
		.findAll((node) => (node.type as unknown) === Text)
		.map((node) =>
			[node.props.children]
				.flat(Infinity)
				.filter((child) => typeof child === 'string')
				.join('')
		);

/** A expressão do avatar com este testID (as props do componente, não do SVG). */
const expressionOf = (testID: string) =>
	byId(testID).find((node) => typeof node.props.expression === 'string')?.props.expression;

const buttonExpression = () =>
	pressable('mirai-button').findAll((node) => typeof node.props.expression === 'string')[0]?.props
		.expression;

/** O campo da pergunta. */
const textInput = () => root().find((node) => (node.type as unknown) === TextInput);

const type = async (value: string) => {
	await act(async () => {
		textInput().props.onChangeText(value);
	});
};

beforeEach(() => {
	mockStorage.clear();
	mockPath.value = '/';
	mockAccount.value = { id: 'usuario-1' };
	mockPush.mockClear();
	(executeMiraiTool as jest.Mock).mockClear();
	probe.value = null;
	ids = 0;
	jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, handler: () => void) => {
		keyboard[event] = handler;
		return { remove: () => undefined };
	}) as unknown as typeof Keyboard.addListener);
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	jest.restoreAllMocks();
});

describe('o botão', () => {
	it('aparece só com GET /status enabled', async () => {
		await render(fakeServer({ enabled: false, remainingToday: 0 }).transport);
		expect(exists('mirai-button')).toBe(false);

		act(() => renderer?.unmount());
		await render(fakeServer(ENABLED).transport);
		expect(exists('mirai-button')).toBe(true);
	});

	it('sem conta não aparece, e nem pergunta ao servidor', async () => {
		mockAccount.value = null;
		const { transport } = fakeServer(ENABLED);
		await render(transport);
		expect(exists('mirai-button')).toBe(false);
		expect(transport.status).not.toHaveBeenCalled();
	});

	it('sem rede vale o último status da conta (o botão continua, para avisar)', async () => {
		mockStorage.set(
			MIRAI_STORAGE_KEYS.status,
			JSON.stringify({ userId: 'usuario-1', enabled: true })
		);
		await render(fakeServer(new ApiError(0, 'Sem conexão com o servidor.', 'offline')).transport);
		expect(exists('mirai-button')).toBe(true);
	});

	it('o último status de outra conta não vale', async () => {
		mockStorage.set(MIRAI_STORAGE_KEYS.status, JSON.stringify({ userId: 'outra', enabled: true }));
		await render(fakeServer(new ApiError(0, 'Sem conexão com o servidor.', 'offline')).transport);
		expect(exists('mirai-button')).toBe(false);
	});

	it('conta tirada da lista (403 not_enabled) some', async () => {
		mockStorage.set(
			MIRAI_STORAGE_KEYS.status,
			JSON.stringify({ userId: 'usuario-1', enabled: true })
		);
		await render(fakeServer(new ApiError(403, 'Fora da lista.', 'not_enabled')).transport);
		expect(exists('mirai-button')).toBe(false);
	});

	it('some em formulário de edição', async () => {
		mockPath.value = '/transaction/edit/t-1';
		await render(fakeServer(ENABLED).transport);
		expect(exists('mirai-button')).toBe(false);
	});

	it('some com o teclado aberto e volta quando ele fecha', async () => {
		await render(fakeServer(ENABLED).transport);
		expect(exists('mirai-button')).toBe(true);
		await act(async () => keyboard.keyboardDidShow());
		expect(exists('mirai-button')).toBe(false);
		await act(async () => keyboard.keyboardDidHide());
		expect(exists('mirai-button')).toBe(true);
	});

	it('some durante uma trilha do tutorial', async () => {
		await render(fakeServer(ENABLED).transport, { guideOpen: true });
		expect(exists('mirai-button')).toBe(false);
	});

	it('normal no dia a dia e goal no dia em que a reserva completa', async () => {
		await render(fakeServer(ENABLED).transport);
		expect(buttonExpression()).toBe('normal');
		await act(async () => probe.value?.noteReserveReady(false));
		await flush();
		expect(buttonExpression()).toBe('normal');
		await act(async () => probe.value?.noteReserveReady(true));
		await flush();
		expect(buttonExpression()).toBe('goal');
	});
});

describe('a ativação (D6)', () => {
	it('o primeiro toque abre a ativação, com o link da política', async () => {
		await render(fakeServer(ENABLED).transport);
		await press('mirai-button');
		expect(exists('mirai-activation')).toBe(true);
		expect(exists('mirai-chat')).toBe(false);
		expect(texts()).toEqual(
			expect.arrayContaining([
				'mirai.activation.points.onlyWhenAsked',
				'mirai.activation.points.noNames',
				'mirai.activation.points.noServerHistory',
				'mirai.activation.points.anthropic',
			])
		);
		await press('mirai-activation-policy');
		expect(mockPush).toHaveBeenCalledWith('/screens/PrivacyPolicyScreen');
		expect(exists('mirai-activation')).toBe(false);
	});

	it('"Ativar" grava a escolha e abre a conversa; o próximo toque vai direto para ela', async () => {
		await render(fakeServer(ENABLED).transport);
		await press('mirai-button');
		await press('mirai-activation-activate');
		expect(mockStorage.get(MIRAI_STORAGE_KEYS.choice)).toBe('on');
		expect(exists('mirai-chat')).toBe(true);

		await press('mirai-chat-close');
		await press('mirai-button');
		expect(exists('mirai-activation')).toBe(false);
		expect(exists('mirai-chat')).toBe(true);
	});

	it('"Agora não" grava a escolha e tira o botão', async () => {
		await render(fakeServer(ENABLED).transport);
		await press('mirai-button');
		await press('mirai-activation-later');
		expect(mockStorage.get(MIRAI_STORAGE_KEYS.choice)).toBe('off');
		expect(exists('mirai-activation')).toBe(false);
		expect(exists('mirai-button')).toBe(false);
	});

	it('a escolha vale na próxima abertura do app', async () => {
		mockStorage.set(MIRAI_STORAGE_KEYS.choice, 'on');
		await render(fakeServer(ENABLED).transport);
		await press('mirai-button');
		expect(exists('mirai-chat')).toBe(true);
	});

	it('Configurações: desligar tira o botão; ligar passa pela ativação', async () => {
		mockStorage.set(MIRAI_STORAGE_KEYS.choice, 'on');
		await render(fakeServer(ENABLED).transport);
		await act(async () => probe.value?.setTurnedOn(false));
		await flush();
		expect(mockStorage.get(MIRAI_STORAGE_KEYS.choice)).toBe('off');
		expect(exists('mirai-button')).toBe(false);

		await act(async () => probe.value?.setTurnedOn(true));
		await flush();
		expect(exists('mirai-activation')).toBe(true);
		await press('mirai-activation-activate');
		expect(mockStorage.get(MIRAI_STORAGE_KEYS.choice)).toBe('on');
	});
});

describe('a conversa', () => {
	beforeEach(() => {
		mockStorage.set(MIRAI_STORAGE_KEYS.choice, 'on');
	});

	it('vazia: aviso fixo de IA, 3 sugestões e "Limpar conversa"', async () => {
		await render(fakeServer(ENABLED).transport);
		await press('mirai-button');
		expect(texts()).toEqual(expect.arrayContaining(['mirai.chat.disclaimer', 'mirai.chat.clear']));
		expect(['1', '2', '3'].every((key) => exists(`mirai-suggestion-${key}`))).toBe(true);
	});

	it('mostra o que está consultando, e a resposta com a expressão da marca de tom', async () => {
		let finishTool: (value: string) => void = () => undefined;
		(executeMiraiTool as jest.Mock).mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finishTool = resolve;
				})
		);
		const { transport, requests } = fakeServer(ENABLED, [
			reply([{ type: 'tool_use', id: 'tu-1', name: 'list_transactions', input: {} }], 'tool_use'),
			reply([text('Você gastou R$ 50,00 a menos com mercado. [tom: feliz]')], 'end_turn'),
		]);
		await render(transport);
		await press('mirai-button');
		await type('Quanto gastei com mercado?');
		await press('mirai-chat-send');

		expect(texts()).toContain('mirai.progress.list_transactions');
		expect(expressionOf('mirai-chat-avatar')).toBe('thinking');
		expect(texts()).toContain('Quanto gastei com mercado?');

		await act(async () => finishTool('{"total":5000}'));
		await flush();

		expect(texts()).toContain('Você gastou R$ 50,00 a menos com mercado.');
		expect(texts().some((value) => value.includes('[tom:'))).toBe(false);
		expect(exists('mirai-entry-avatar-happy')).toBe(true);
		expect(expressionOf('mirai-chat-avatar')).toBe('happy');
		expect(exists('mirai-chat-progress')).toBe(false);
		expect(requests[0]).toMatchObject({ screen: 'home', locale: 'pt' });
	});

	it('uma sugestão é perguntada com um toque', async () => {
		const { transport, requests } = fakeServer(ENABLED, [
			reply([text('Sobrou R$ 10,00.')], 'end_turn'),
		]);
		await render(transport);
		await press('mirai-button');
		await press('mirai-suggestion-1');
		expect(requests[0].messages).toEqual([{ role: 'user', content: 'mirai.suggestions.1' }]);
		// Sem marca de tom, a expressão é normal.
		expect(exists('mirai-entry-avatar-normal')).toBe(true);
	});

	it.each([
		'daily_limit',
		'monthly_cap',
		'unavailable',
	] as const)('o erro %s tem texto próprio, a cara sorry, e a pergunta volta para o campo', async (code) => {
		const status = code === 'unavailable' ? 503 : 429;
		await render(fakeServer(ENABLED, [new ApiError(status, 'Recusado.', code)]).transport);
		await press('mirai-button');
		await type('Dá para pagar a fatura?');
		await press('mirai-chat-send');

		expect(texts()).toContain(`mirai.errors.${code}`);
		expect(exists('mirai-entry-avatar-sorry')).toBe(true);
		expect(expressionOf('mirai-chat-avatar')).toBe('sorry');
		expect(textInput().props.value).toBe('Dá para pagar a fatura?');
		expect(exists('mirai-entry-user')).toBe(false);
	});

	it('sem internet: abre com o aviso, e a pergunta não é enviada', async () => {
		mockStorage.set(
			MIRAI_STORAGE_KEYS.status,
			JSON.stringify({ userId: 'usuario-1', enabled: true })
		);
		const offline = new ApiError(0, 'Sem conexão com o servidor.', 'offline');
		const { transport } = fakeServer(offline, [offline]);
		await render(transport);
		await press('mirai-button');
		expect(texts()).toContain('mirai.errors.offline');

		await type('Quanto tenho na conta?');
		await press('mirai-chat-send');
		expect(texts().filter((value) => value === 'mirai.errors.offline')).toHaveLength(1);
		expect(textInput().props.value).toBe('Quanto tenho na conta?');
		expect(executeMiraiTool).not.toHaveBeenCalled();
	});

	it('a recusa do modelo vira uma mensagem amigável', async () => {
		await render(fakeServer(ENABLED, [reply([], 'refusal')]).transport);
		await press('mirai-button');
		await type('Compro a ação X?');
		await press('mirai-chat-send');
		expect(texts()).toContain('mirai.chat.refusal');
	});

	it('"Limpar conversa" apaga as mensagens e começa outra conversa', async () => {
		const { transport, requests } = fakeServer(ENABLED, [reply([text('Oi.')], 'end_turn')]);
		await render(transport);
		await press('mirai-button');
		await type('Primeira');
		await press('mirai-chat-send');
		expect(texts()).toContain('Oi.');

		await press('mirai-chat-clear');
		expect(texts()).not.toContain('Oi.');
		expect(exists('mirai-suggestion-1')).toBe(true);

		await type('Segunda');
		await press('mirai-chat-send');
		expect(requests[1].messages).toEqual([{ role: 'user', content: 'Segunda' }]);
		expect(requests[1].conversationId).not.toBe(requests[0].conversationId);
	});

	it('fechar (o voltar) apaga a conversa', async () => {
		const { transport, requests } = fakeServer(ENABLED, [reply([text('Oi.')], 'end_turn')]);
		await render(transport);
		await press('mirai-button');
		await type('Primeira');
		await press('mirai-chat-send');

		// O voltar do Android chega como o onRequestClose da folha.
		const sheet = root().findAll(
			(node) => typeof node.props.onRequestClose === 'function' && node.props.visible === true
		)[0];
		await act(async () => sheet.props.onRequestClose());
		await flush();
		expect(exists('mirai-chat')).toBe(false);

		await press('mirai-button');
		expect(texts()).not.toContain('Oi.');
		await type('De novo');
		await press('mirai-chat-send');
		expect(requests[1].messages).toEqual([{ role: 'user', content: 'De novo' }]);
	});
});
