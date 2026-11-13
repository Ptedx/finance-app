import { AuthenticationType } from 'expo-local-authentication';

/**
 * A trava do app por biometria, como Ajustes e a primeira abertura a mostram (SPD-088).
 *
 * Qual nome aparece. O app dizia "Face ID" para qualquer aparelho com reconhecimento facial,
 * e Face ID é o nome da Apple: no Android a mesma opção virava "Autenticação por Face ID". No
 * Android o pedido do sistema aceita o que o aparelho tiver (digital ou rosto), então o nome é
 * biometria. No iPhone o tipo diz qual dos dois o aparelho tem.
 */
export type BiometricKind = 'faceId' | 'touchId' | 'biometric';

export const biometricKindOf = (
	types: readonly AuthenticationType[],
	os: string
): BiometricKind => {
	if (os !== 'ios') return 'biometric';
	if (types.includes(AuthenticationType.FACIAL_RECOGNITION)) return 'faceId';
	if (types.includes(AuthenticationType.FINGERPRINT)) return 'touchId';
	return 'biometric';
};

/**
 * O ícone da linha. Só nomes que o Ionicons tem: `scan-face` não existe nele, e o que
 * aparecia na tela era um "?" (o Metro avisava).
 */
export const biometricIcon = (kind: BiometricKind): 'scan-outline' | 'finger-print' =>
	kind === 'faceId' ? 'scan-outline' : 'finger-print';

/**
 * Liga ou desliga a trava passando pela biometria **nos dois sentidos** e devolve como ela
 * ficou. Desligar era um toque, sem autenticar: quem pegasse o celular com o app aberto
 * tirava a trava. Falhou ou cancelou, nada é gravado e ela fica como estava.
 *
 * `authenticate` é o mesmo pedido que o app faz ao abrir (`authenticateWithBiometrics`).
 */
export const changeBiometricLock = async (
	requested: boolean,
	current: boolean,
	deps: {
		authenticate: (reason: string) => Promise<boolean>;
		save: (enabled: boolean) => Promise<void>;
		reason: (enabling: boolean) => string;
	}
): Promise<boolean> => {
	if (requested === current) return current;
	const ok = await deps.authenticate(deps.reason(requested));
	if (!ok) return current;
	await deps.save(requested);
	return requested;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { biometricKindOf, biometricIcon, changeBiometricLock };
