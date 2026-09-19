import { useEffect, useRef } from 'react';
import * as syncQueue from '../sync/queue';

/**
 * Chama `reload` sempre que uma rodada de sync termina tendo **baixado** linhas da conta.
 *
 * Os contexts de dados leem o banco na abertura e depois de cada escrita local; sem isto,
 * o que o pull grava no SQLite não aparece na tela até o app ser reaberto. O caso que
 * mostrou o problema: aparelho novo, login numa conta com dados — o pull traz tudo, e a
 * tela continuava zerada.
 *
 * `reload` vai numa ref: o provider pode passar uma função nova a cada render sem
 * reinscrever o ouvinte.
 */
export const useAfterPull = (reload: () => unknown): void => {
	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	useEffect(() => {
		let seen = syncQueue.getState().pulledVersion;
		return syncQueue.subscribe((state) => {
			if (state.pulledVersion === seen) return;
			seen = state.pulledVersion;
			void reloadRef.current();
		});
	}, []);
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default useAfterPull;
