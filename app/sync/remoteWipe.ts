import i18next from 'i18next';
import { Alert } from 'react-native';
import { wipeDevice } from '../utils/dataWipe';
import { setAccountWipedHandler } from './engine';

/**
 * O "Apagar todos os dados" que chegou de outro aparelho (SPD-083, DEC-35).
 *
 * O motor do sync decide que este aparelho tem de ser apagado (`sync/accountWipe.ts`) e
 * chama isto: o mesmo `wipeDevice` do botão das Configurações — com a marca do servidor,
 * gravada na mesma transação —, e depois um aviso. Fica fora do motor porque
 * `utils/dataWipe.ts` importa a fila, que importa o motor; o `SyncProvider` registra.
 *
 * O aviso é um `Alert` comum, que não segura nada: o apagar já aconteceu e o sync segue.
 * Aparece uma vez porque o apagar acontece uma vez — com a marca guardada, o mesmo
 * `dataWipedAt` não apaga de novo. Se o apagar falhar, não há aviso: a falha sobe para o
 * sync, que tenta de novo na rodada seguinte.
 */
export const applyRemoteWipe = async (dataWipedAt: string): Promise<void> => {
	await wipeDevice(dataWipedAt);
	Alert.alert(
		i18next.t('dataWipe.wipedElsewhereTitle'),
		i18next.t('dataWipe.wipedElsewhereMessage')
	);
};

/** Registra o apagar no motor do sync; devolve como desfazer o registro. */
export const startRemoteWipes = (): (() => void) => {
	setAccountWipedHandler(applyRemoteWipe);
	return () => setAccountWipedHandler(null);
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { applyRemoteWipe, startRemoteWipes };
