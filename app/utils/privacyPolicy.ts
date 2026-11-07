import en from './privacyPolicyText/en';
import it from './privacyPolicyText/it';
import pt from './privacyPolicyText/pt';

/**
 * A política de privacidade em cada idioma do app (SPD-118).
 *
 * O texto é longo e é texto legal, então fica num arquivo por idioma em `privacyPolicyText/`
 * em vez de nos locales: assim cada versão se lê inteira, de uma vez, e se compara lado a lado
 * com o html dela (`docs/privacy-policy.html`, `.en.html` e `.it.html`). Mudar uma versão é
 * mudar as outras e os três html — o teste `privacyPolicy.test.ts` confere.
 */

export interface PolicySection {
	icon: string;
	title: string;
	body?: string[];
	/** Itens com um rótulo em negrito: [rótulo, texto]. */
	list?: [string, string][];
	after?: string[];
}

export interface PrivacyPolicy {
	/** A primeira linha do título; `accent` é a segunda, em destaque. */
	title: string;
	accent: string;
	intro: string;
	updated: string;
	pills: { icon: string; label: string }[];
	sections: PolicySection[];
	footer: string;
}

export const PRIVACY_POLICIES = { pt, en, it } satisfies Record<string, PrivacyPolicy>;

/**
 * A versão no idioma dado (o do i18next, "en" ou "en-US"). Um idioma sem versão fica com o
 * português, em que a política foi escrita.
 */
export const privacyPolicyFor = (language: string | null | undefined): PrivacyPolicy => {
	const code = (language ?? '').slice(0, 2).toLowerCase();
	return code in PRIVACY_POLICIES ? PRIVACY_POLICIES[code as keyof typeof PRIVACY_POLICIES] : PRIVACY_POLICIES.pt;
};
