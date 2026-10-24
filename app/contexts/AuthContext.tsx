import AsyncStorage from '@react-native-async-storage/async-storage';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { isCaptureEnabled, isCaptureSupported } from '../../modules/spendr-captures';
import * as authApi from '../api/auth';
import { ApiError, isApiConfigured, setSessionLostHandler } from '../api/client';
import { fetchSyncStatus } from '../api/sync';
import { loadTokens } from '../api/tokens';
import { clearSyncedData, countLocalData, markEverythingDirty } from '../database/database';
import {
	beginSessionFor,
	type ClaimCounts,
	clearPendingClaim,
	endSyncSession,
	type PendingClaim,
	readPendingClaim,
	savePendingClaim,
} from '../sync/claim';
import { pullAll, replaceAccountWithDevice, resetCursor } from '../sync/engine';
import * as syncQueue from '../sync/queue';
import { STORAGE_KEYS } from '../utils/storageUtils';

/**
 * O acesso de leitura de notificações é do aparelho, não da conta: logar num celular novo
 * traz a caixa de entrada, as regras e as preferências, mas a captura só volta a funcionar
 * quando o usuário liga o acesso na tela do sistema — e nada no app dizia isso.
 *
 * O caminho até lá já existe: o aviso "Captura desligada" da tela inicial
 * (`CaptureReviewBanner`), que abre a tela do sistema. Ele só fica escondido quando foi
 * dispensado **neste** aparelho (a dispensa não viaja no sync, ver
 * `SYNCED_PREFERENCE_KEYS`) — ou num backup restaurado. No primeiro login nesta conta,
 * com a captura disponível e desligada, a dispensa é esquecida e o aviso volta a valer.
 *
 * Falhar aqui não pode atrapalhar o login: é um aviso.
 */
const rearmCaptureAccessPrompt = async (): Promise<void> => {
	try {
		if (!isCaptureSupported() || isCaptureEnabled()) return;
		await AsyncStorage.removeItem(STORAGE_KEYS.captureAccessDismissed);
	} catch (error) {
		console.warn('Não foi possível reativar o aviso de captura desligada:', error);
	}
};

/**
 * O que fazer quando este aparelho e a conta têm dados. Escolhido pelo usuário — ver
 * `AccountScreen`.
 *
 * - `upload`: este aparelho é a verdade; a conta passa a ter só o que está aqui.
 * - `discard`: a conta é a verdade; os dados daqui são trocados pelos dela.
 * - `merge`: os dois somados; onde a mesma linha existe dos dois lados, vence a edição
 *   mais recente.
 */
export type ClaimChoice = 'upload' | 'discard' | 'merge';

/**
 * Os dois lados, para a tela mostrar o que está em jogo antes da escolha. Mora em
 * `sync/claim.ts` junto com a gravação do claim, e é reexportado aqui porque é daqui
 * que as telas o leem.
 */
export type { ClaimCounts };

interface AuthContextType {
	/** Nulo enquanto carrega a sessão guardada, e no modo anônimo. */
	account: authApi.AccountProfile | null;
	isLoading: boolean;
	/** Se dá para sequer tentar entrar: falso quando falta EXPO_PUBLIC_API_URL. */
	isAvailable: boolean;

	signIn: (params: { email: string; password: string }) => Promise<void>;
	signUp: (params: { email: string; password: string; name: string }) => Promise<void>;
	signOut: () => Promise<void>;

	/**
	 * Se a conta recém-conectada já tinha dados. Enquanto for `true`, a UI precisa
	 * perguntar o que fazer com o que existe neste aparelho.
	 */
	pendingClaim: boolean;
	/** O que a conta e o aparelho têm, enquanto a escolha está pendente. */
	claimCounts: ClaimCounts | null;
	resolveClaim: (choice: ClaimChoice) => Promise<void>;

	/** Reflete no perfil uma mudança de moeda ou idioma feita nas Configurações. */
	syncProfilePreferences: (changes: { baseCurrency?: string; language?: string }) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [account, setAccount] = useState<authApi.AccountProfile | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [pendingClaim, setPendingClaim] = useState(false);
	const [claimCounts, setClaimCounts] = useState<ClaimCounts | null>(null);

	// O sync não pode começar enquanto o usuário não decidir entre mesclar e descartar:
	// ligar a fila antes empurraria os dados locais para uma conta que talvez não os queira.
	const claimBlocking = useRef(false);

	/**
	 * Põe a pergunta de volta na tela e mantém a fila desligada. Usado tanto quando a
	 * pergunta nasce (`afterSignIn`) quanto quando ela é recuperada do banco na abertura.
	 */
	const resumeClaim = useCallback((claim: PendingClaim) => {
		claimBlocking.current = true;
		setClaimCounts(claim.counts);
		setPendingClaim(true);
	}, []);

	/**
	 * Fim de sessão: pelo "sair" ou porque o refresh foi recusado.
	 *
	 * O estado de sync vai junto — cursor, último sync e qualquer claim pendente. Ele
	 * descreve o progresso naquela conta, e sobreviver a ela era o que fazia um login em
	 * outra conta abrir sem nada: o cursor antigo escondia tudo o que a conta nova tinha
	 * gravado antes dele.
	 */
	const endSession = useCallback(() => {
		syncQueue.stop();
		setAccount(null);
		setPendingClaim(false);
		setClaimCounts(null);
		claimBlocking.current = false;

		// Sem `await`: quem chama é o cliente HTTP, que não espera ninguém. Falhar aqui
		// não pode impedir a volta ao modo anônimo.
		endSyncSession().catch((error) => {
			console.warn('Não foi possível limpar o estado de sync da sessão encerrada:', error);
		});
	}, []);

	// Restaura a sessão guardada na abertura. Uma falha aqui abre o app no modo anônimo
	// em vez de travar — ver o comentário em `api/tokens.ts` sobre backup restaurado.
	useEffect(() => {
		const restore = async () => {
			try {
				if (!isApiConfigured() || !(await loadTokens())) return;

				let accountId: string | null = null;
				try {
					const profile = await authApi.fetchProfile();
					setAccount(profile);
					accountId = profile.id;
				} catch (error) {
					if (!(error instanceof ApiError && error.isOffline)) throw error;
					// Sem rede na abertura não significa sessão inválida: o perfil chega
					// quando a conexão voltar.
				}

				// A escolha pendente é relida do banco, com rede ou sem ela: enquanto não
				// houver resposta a fila não liga. Era este o furo — a pergunta só existia
				// na memória, e quem fechava o app no meio dela (ou tinha o processo morto
				// pelo Android) voltava com os dois conjuntos **juntados**, em silêncio.
				const pending = await readPendingClaim();
				if (pending && (accountId === null || pending.accountId === accountId)) {
					resumeClaim(pending);
					return;
				}
				// Claim de outra conta: a sessão dele já acabou, a pergunta não é mais desta.
				if (pending) await clearPendingClaim();

				syncQueue.start();
			} catch (error) {
				console.warn('Não foi possível restaurar a sessão:', error);
				endSession();
			} finally {
				setIsLoading(false);
			}
		};

		restore();
	}, [endSession, resumeClaim]);

	// O cliente HTTP avisa quando a sessão morre de vez (refresh recusado).
	useEffect(() => {
		setSessionLostHandler(endSession);
		return () => setSessionLostHandler(null);
	}, [endSession]);

	// Voltar ao foreground é o gatilho natural: é quando o usuário vai olhar os números,
	// e portanto quando eles precisam estar certos.
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
			if (next === 'active' && account && !claimBlocking.current) {
				syncQueue.syncImmediately();
			}
		});

		return () => subscription.remove();
	}, [account]);

	/**
	 * Decide o que acontece com os dados locais assim que a conta é conectada.
	 *
	 * Conta vazia recebe tudo sem perguntar — é o caso de quem usou o app anônimo e
	 * acabou de criar a conta. Aparelho vazio recebe a conta sem perguntar. Os dois com
	 * dados: para tudo e pergunta, mostrando o que cada lado tem.
	 *
	 * "Aparelho com dados" é medido pelas linhas vivas, não pelas que faltam subir: um
	 * aparelho que já sincronizou com outra conta e saiu tem tudo limpo, e antes era
	 * mesclado sem pergunta nenhuma.
	 */
	const afterSignIn = useCallback(
		async (accountId: string) => {
			// Conta diferente da última: cursor, último sync e claim velho vão embora
			// antes de qualquer coisa subir ou descer.
			const firstSession = await beginSessionFor(accountId);
			if (firstSession) await rearmCaptureAccessPrompt();

			const [status, device] = await Promise.all([fetchSyncStatus(), countLocalData()]);

			if (!status.hasData) {
				await markEverythingDirty();
				syncQueue.start();
				return;
			}

			if (device.total === 0) {
				syncQueue.start();
				return;
			}

			// Gravado **antes** de a pergunta ir para a tela: se o app morrer agora, a
			// próxima abertura refaz a pergunta em vez de juntar por conta própria.
			const claim: PendingClaim = { accountId, counts: { account: status.counts, device } };
			await savePendingClaim(claim);
			resumeClaim(claim);
		},
		[resumeClaim]
	);

	const signIn = useCallback(
		async (params: { email: string; password: string }) => {
			const profile = await authApi.login(params);
			setAccount(profile);
			await afterSignIn(profile.id);
		},
		[afterSignIn]
	);

	const signUp = useCallback(
		async (params: { email: string; password: string; name: string }) => {
			const profile = await authApi.register(params);
			setAccount(profile);
			// Conta recém-criada nunca tem histórico: o claim é sempre automático. O
			// estado de sync de qualquer conta anterior sai de cena do mesmo jeito.
			if (await beginSessionFor(profile.id)) await rearmCaptureAccessPrompt();
			await markEverythingDirty();
			syncQueue.start();
		},
		[]
	);

	const resolveClaim = useCallback(async (choice: ClaimChoice) => {
		if (choice === 'upload') {
			// A conta passa a ter exatamente o que está aqui.
			const result = await replaceAccountWithDevice();
			if (result.notRemoved > 0) {
				console.warn(`Substituição: ${result.notRemoved} linha(s) antigas da conta não puderam ser apagadas.`);
			}
		} else if (choice === 'merge') {
			// Tudo sobe; o last-write-wins resolve as sobreposições linha a linha.
			await markEverythingDirty();
		} else {
			// Limpa o local e o cursor, para o pull seguinte reconstruir do zero. Só o
			// cursor: zerar a tabela de estado inteira levaria junto o vínculo com esta
			// conta, e o próximo login nela refaria o pull completo sem motivo.
			await clearSyncedData();
			await resetCursor();
			await pullAll();
		}

		// A escolha só é apagada depois de cumprida: interromper no meio faz a pergunta
		// voltar, que é o que se quer — a alternativa é o aparelho decidir sozinho.
		await clearPendingClaim();

		// Qualquer das três escolhas mexeu no banco por fora da fila: as telas releem.
		syncQueue.notifyDataChanged();
		claimBlocking.current = false;
		setPendingClaim(false);
		setClaimCounts(null);
		syncQueue.start();
	}, []);

	/**
	 * Sair preserva os dados locais e o app volta ao modo anônimo.
	 *
	 * O estado de sync é descartado em `endSession`, junto com o da sessão que cai
	 * sozinha: ele descreve o progresso naquela conta, e reaproveitá-lo num login
	 * seguinte faria o app achar que já tem o que nunca baixou.
	 */
	const signOut = useCallback(async () => {
		await authApi.logout();
		endSession();
	}, [endSession]);

	const syncProfilePreferences = useCallback(
		(changes: { baseCurrency?: string; language?: string }) => {
			if (!account) return;

			setAccount((current) => (current ? { ...current, ...changes } : current));

			// Silencioso de propósito: a preferência já valeu localmente, e um alerta
			// por falha de rede numa troca de idioma seria ruído.
			authApi.updateProfile(changes).catch((error) => {
				console.warn('Não foi possível salvar a preferência no perfil:', error);
			});
		},
		[account]
	);

	const value: AuthContextType = {
		account,
		isLoading,
		isAvailable: isApiConfigured(),
		signIn,
		signUp,
		signOut,
		pendingClaim,
		claimCounts,
		resolveClaim,
		syncProfilePreferences,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
	const context = useContext(AuthContext);
	if (context === undefined) {
		throw new Error('useAuth must be used within an AuthProvider');
	}
	return context;
};

export default AuthContext;
