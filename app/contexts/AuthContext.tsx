import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as authApi from '../api/auth';
import { ApiError, isApiConfigured, setSessionLostHandler } from '../api/client';
import { fetchSyncStatus } from '../api/sync';
import { loadTokens } from '../api/tokens';
import {
	clearSyncedData,
	clearSyncState,
	countLocalData,
	type LocalDataCounts,
	markEverythingDirty,
} from '../database/database';
import { pullAll, replaceAccountWithDevice } from '../sync/engine';
import type { SyncStatusResponse } from '../sync/types';
import * as syncQueue from '../sync/queue';

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

/** Os dois lados, para a tela mostrar o que está em jogo antes da escolha. */
export interface ClaimCounts {
	account: SyncStatusResponse['counts'];
	device: LocalDataCounts;
}

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

	const endSession = useCallback(() => {
		syncQueue.stop();
		setAccount(null);
		setPendingClaim(false);
		setClaimCounts(null);
		claimBlocking.current = false;
	}, []);

	// Restaura a sessão guardada na abertura. Uma falha aqui abre o app no modo anônimo
	// em vez de travar — ver o comentário em `api/tokens.ts` sobre backup restaurado.
	useEffect(() => {
		const restore = async () => {
			try {
				if (!isApiConfigured() || !(await loadTokens())) return;

				setAccount(await authApi.fetchProfile());
				syncQueue.start();
			} catch (error) {
				if (error instanceof ApiError && error.isOffline) {
					// Sem rede na abertura não significa sessão inválida. A fila liga e
					// tenta sozinha; o perfil chega quando a conexão voltar.
					syncQueue.start();
					return;
				}
				console.warn('Não foi possível restaurar a sessão:', error);
				endSession();
			} finally {
				setIsLoading(false);
			}
		};

		restore();
	}, [endSession]);

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
	const afterSignIn = useCallback(async () => {
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

		claimBlocking.current = true;
		setClaimCounts({ account: status.counts, device });
		setPendingClaim(true);
	}, []);

	const signIn = useCallback(
		async (params: { email: string; password: string }) => {
			setAccount(await authApi.login(params));
			await afterSignIn();
		},
		[afterSignIn]
	);

	const signUp = useCallback(
		async (params: { email: string; password: string; name: string }) => {
			setAccount(await authApi.register(params));
			// Conta recém-criada nunca tem histórico: o claim é sempre automático.
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
			// Limpa o local e o cursor, para o pull seguinte reconstruir do zero.
			await clearSyncedData();
			await clearSyncState();
			await pullAll();
		}

		claimBlocking.current = false;
		setPendingClaim(false);
		setClaimCounts(null);
		syncQueue.start();
	}, []);

	/**
	 * Sair preserva os dados locais e o app volta ao modo anônimo.
	 *
	 * O cursor é descartado junto: ele descreve o progresso naquela conta, e reaproveitá-lo
	 * num login seguinte faria o app achar que já tem o que nunca baixou.
	 */
	const signOut = useCallback(async () => {
		await authApi.logout();
		await clearSyncState();
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
