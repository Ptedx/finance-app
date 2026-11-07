import { Stack } from 'expo-router';

/**
 * O navegador da raiz do app (E2E-46): uma pilha, não um `<Slot />`.
 *
 * O `<Slot />` só desenha a rota em foco. Abrir uma tela da raiz (editar lançamento, cartão,
 * conta) desmontava as abas, e o React Navigation apaga o estado de um navegador desmontado:
 * no voltar, as abas renasciam em Início, mesmo quem tinha vindo de Lançamentos, Patrimônio ou
 * Relatórios, e perdiam filtro e rolagem. Na pilha, as abas ficam montadas por baixo.
 *
 * Sem cabeçalho (cada tela desenha o seu) e sem animação, para abrir como antes.
 */
const RootStack = () => <Stack screenOptions={{ headerShown: false, animation: 'none' }} />;

export default RootStack;
