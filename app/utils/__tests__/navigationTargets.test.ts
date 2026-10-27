import fs from 'node:fs';
import path from 'node:path';
import { getStateFromPath } from 'expo-router/build/fork/getStateFromPath';
import { getMockConfig } from 'expo-router/build/testing-library/mock-config';

/**
 * Todo destino de navegação escrito no código precisa abrir a tela que diz abrir (SPD-070).
 *
 * O expo-router não trata `/accounts/index` como a lista: o `index` vira o `id` da rota
 * irmã `accounts/[id]` (abria "Nova conta" e "Cartão não encontrado"), e em `bills/`, que
 * não tem `[id]`, cai em "Unmatched Route". Este teste lê os destinos do próprio código e
 * resolve cada um com as rotas de verdade, como o app faz ao tocar.
 */

const APP_DIR = path.resolve(__dirname, '../..');

/** Os arquivos de `app/`, menos as pastas de teste. */
const walk = (dir: string, onFile: (file: string) => void): void => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('__')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, onFile);
		else onFile(full);
	}
};

/**
 * A raiz do expo-router é `app/` inteira: `screens/` e `components/` também viram rota, e
 * há links que contam com isso (`/screens/PrivacyPolicyScreen`). As rotas do teste são as
 * mesmas do app: todo `.tsx` fora das pastas de teste.
 */
const routeFiles = (): string[] => {
	const files: string[] = [];
	walk(APP_DIR, (file) => {
		if (file.endsWith('.tsx')) files.push(path.relative(APP_DIR, file).split(path.sep).join('/'));
	});
	return files;
};

/** `router.push('/x')`, `router.replace('/x')`, `pathname: '/x'` e `href="/x"` do código do app. */
const navigationTargets = (): { file: string; target: string }[] => {
	const patterns = [/router\.(?:push|replace|navigate)\(\s*'([^']+)'/g, /pathname:\s*'([^']+)'/g, /href="([^"]+)"/g];
	const found: { file: string; target: string }[] = [];
	walk(APP_DIR, (file) => {
		if (!/\.tsx?$/.test(file)) return;
		const source = fs.readFileSync(file, 'utf8');
		for (const pattern of patterns) {
			for (const match of source.matchAll(pattern)) {
				if (match[1].startsWith('/')) found.push({ file: path.relative(APP_DIR, file), target: match[1] });
			}
		}
	});
	return found;
};

/** A rota que a tela mostra no fim do caminho resolvido. */
interface RouteState {
	index?: number;
	routes?: { name: string; state?: RouteState }[];
}

const leafRoute = (state: ReturnType<typeof getStateFromPath>): string => {
	let current = state as RouteState | undefined;
	let name = '';
	while (current?.routes) {
		const route = current.routes[current.index ?? current.routes.length - 1];
		name = route.name;
		current = route.state;
	}
	return name;
};

const config = getMockConfig(routeFiles());
const resolve = (target: string): string =>
	// Parâmetro de rota dinâmica vira um valor qualquer, como no toque de verdade.
	leafRoute(getStateFromPath(target.replace(/\[[^\]]+\]/g, 'x'), config as never));

describe('destinos de navegação do app', () => {
	it('acha os destinos no código', () => {
		expect(navigationTargets().length).toBeGreaterThan(10);
	});

	it('a lista de contas, a de cartões e a de contas a pagar abrem pela pasta, não por /index', () => {
		expect(resolve('/accounts')).toBe('accounts/index');
		expect(resolve('/cards')).toBe('cards/index');
		expect(resolve('/bills')).toBe('bills/index');
		// O motivo do SPD-070: `index` no caminho vira parâmetro ou "não encontrada".
		expect(resolve('/accounts/index')).toBe('accounts/[id]');
		expect(resolve('/bills/index')).toBe('+not-found');
	});

	it.each(navigationTargets().map(({ file, target }) => [target, file]))(
		'%s (%s) abre uma tela que existe, e um caminho fixo nunca cai numa rota de parâmetro',
		(target) => {
			const leaf = resolve(target);
			expect(leaf).not.toBe('+not-found');
			if (!target.includes('[')) expect(leaf).not.toMatch(/\[/);
		}
	);
});
