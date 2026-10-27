import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * A política de privacidade (SPD-078). O mesmo texto está em `docs/privacy-policy.html`:
 * mudar um é mudar o outro.
 */

interface PolicySection {
	icon: string;
	title: string;
	body?: string[];
	/** Itens com um rótulo em negrito: [rótulo, texto]. */
	list?: [string, string][];
	after?: string[];
}

const PILLS = [
	{ icon: '📱', label: 'Funciona sem conta' },
	{ icon: '☁️', label: 'Conta opcional' },
	{ icon: '🚫', label: 'Sem rastreio' },
	{ icon: '🤝', label: 'Nada é vendido' },
];

const SECTIONS: PolicySection[] = [
	{
		icon: '📱',
		title: 'O que fica no seu aparelho',
		body: [
			'Lançamentos, contas, cartões, contas a pagar, orçamentos, dívidas, metas, categorias e configurações ficam num banco de dados no próprio aparelho.',
			'Sem conta, nada disso sai do aparelho. O app só usa a internet para buscar a taxa do CDI e as atualizações do próprio app (veja "Serviços de terceiros").',
		],
	},
	{
		icon: '🔔',
		title: 'Avisos do banco (captura automática)',
		body: [
			'No Android, se você permitir o acesso às notificações, o Spendr lê as notificações que chegam para transformar compras, Pix e transferências em lançamentos.',
			'Só fica guardado o aviso que traz um valor em dinheiro e vem de um app de banco (ou de uma mensagem que cita um banco): o título, o texto, o app de origem e o horário. As outras notificações são descartadas sem ser gravadas.',
			'Você pode desligar esse acesso quando quiser, nas configurações do Android.',
		],
	},
	{
		icon: '☁️',
		title: 'Se você criar uma conta',
		body: [
			'A conta é opcional e serve para sincronizar os dados entre aparelhos e recuperá-los num aparelho novo. Com conta, o servidor do Spendr guarda:',
		],
		list: [
			[
				'Cadastro',
				'nome, e-mail, moeda e idioma. A senha nunca é guardada: só um resumo criptográfico dela (bcrypt).',
			],
			[
				'Seus dados do app',
				'lançamentos, contas e cartões (nome, banco, 4 últimos dígitos, limite e saldo), transferências, contas a pagar, orçamentos, dívidas, metas, as categorias que o app aprendeu para cada loja e suas preferências.',
			],
			[
				'Avisos do banco',
				'os avisos capturados, incluindo o texto da notificação, para que a revisão continue em outro aparelho.',
			],
		],
		after: [
			'A conexão com o servidor é criptografada (HTTPS). A sessão usa um acesso que vence em 15 minutos e uma chave de renovação guardada no armazenamento seguro do aparelho; no servidor fica só o resumo dessa chave.',
		],
	},
	{
		icon: '🩺',
		title: 'Diagnóstico',
		body: [
			'Para corrigir erros, o app mantém um registro técnico do que fez: o que decidiu sobre cada aviso, falhas de sincronização, a versão do app, o sistema e um identificador aleatório da instalação (não é o número do aparelho).',
			'Com conta, esse registro é enviado ao servidor no máximo a cada 6 horas e apagado depois de 30 dias. Quando um aviso de banco não é entendido, o texto dele vai junto, para que a leitura seja corrigida. O registro nunca leva e-mail, senha ou chave de acesso.',
			'O servidor também anota cada pedido que recebe (o caminho, o resultado, o tempo e o endereço IP sem os últimos dígitos), sem o conteúdo do pedido.',
			'Em Ajustes, "Exportar diagnóstico" gera esse registro num arquivo que só sai do aparelho se você compartilhar.',
		],
	},
	{
		icon: '🌐',
		title: 'Serviços de terceiros',
		list: [
			[
				'Banco Central do Brasil',
				'o app consulta a taxa do CDI para calcular o rendimento das contas. Nenhum dado seu é enviado.',
			],
			['Expo', 'entrega as atualizações do app.'],
		],
		after: [
			'O Spendr não usa anúncios, analytics, rastreamento nem relatórios de erro de terceiros, e não vende, aluga nem compartilha seus dados.',
		],
	},
	{
		icon: '🔐',
		title: 'Permissões',
		list: [
			['Acesso às notificações', 'para a captura automática dos avisos do banco. Opcional.'],
			['Notificações', 'para os lembretes das contas a pagar. Feitos no próprio aparelho.'],
			[
				'Biometria',
				'para travar o app com digital ou rosto, pelo próprio sistema. O app não recebe dados biométricos.',
			],
			['Arquivos', 'para exportar e importar backup, relatórios em CSV e extratos OFX.'],
			['Internet', 'para a conta, a sincronização e a taxa do CDI.'],
		],
	},
	{
		icon: '💾',
		title: 'Backup e exportação',
		body: [
			'O backup e os relatórios são arquivos que você gera e manda para onde escolher, pelo compartilhamento do sistema. Eles não são criptografados e o backup inclui o texto dos avisos do banco: guarde-os num lugar seguro.',
		],
	},
	{
		icon: '🗑️',
		title: 'Seus controles',
		list: [
			['Sair da conta', 'encerra a sessão no servidor e mantém tudo neste aparelho.'],
			[
				'Apagar todos os dados',
				'em Ajustes, apaga lançamentos, contas, cartões, contas a pagar, orçamentos, dívidas, metas e avisos capturados; as categorias e o que o app aprendeu de cada loja ficam. Com conta, os itens apagados ficam marcados como apagados no servidor, para que os outros aparelhos saibam.',
			],
			[
				'Apagar a conta',
				'para apagar a conta e todos os dados dela no servidor, escreva para vinicosta37@gmail.com.',
			],
		],
		after: [
			'Pela LGPD, você pode pedir acesso, correção ou exclusão dos seus dados. O backup em Ajustes já entrega uma cópia de tudo; o resto, peça pelo contato abaixo.',
		],
	},
	{
		icon: '👶',
		title: 'Crianças',
		body: ['O Spendr não é feito para menores de 13 anos e não coleta dados deles de propósito.'],
	},
	{
		icon: '🔄',
		title: 'Mudanças nesta política',
		body: [
			'Quando esta política mudar, a versão nova aparece aqui com a data de atualização. Recursos novos que usem seus dados são explicados antes de entrar no app.',
		],
	},
	{
		icon: '✉️',
		title: 'Contato',
		body: ['Dúvidas sobre esta política ou sobre seus dados: vinicosta37@gmail.com.'],
	},
];

export default function PrivacyPolicyScreen() {
	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<Stack.Screen
				options={{
					title: 'Política de privacidade',
					headerStyle: { backgroundColor: '#1A1A1A' },
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
				<Text style={styles.title}>
					Seus dados são seus.
					{'\n'}
					<Text style={styles.accent}>Nada é vendido.</Text>
				</Text>
				<Text style={styles.intro}>
					O Spendr funciona no seu aparelho. Se você criar uma conta, uma cópia dos seus dados fica
					no servidor do Spendr para sincronizar e voltar num aparelho novo. Não há anúncios,
					rastreio nem venda de dados.
				</Text>
				<Text style={styles.updated}>Atualizada em 27 de outubro de 2026</Text>

				<View style={styles.pillRow}>
					{PILLS.map(({ icon, label }) => (
						<View key={label} style={styles.pill}>
							<Text style={styles.pillIcon}>{icon}</Text>
							<Text style={styles.pillLabel}>{label}</Text>
						</View>
					))}
				</View>

				{SECTIONS.map((section) => (
					<Section key={section.title} section={section} />
				))}

				<Text style={styles.footer}>
					Spendr — feito a partir do projeto de código aberto de okazakee.
				</Text>
			</ScrollView>
		</SafeAreaView>
	);
}

function Section({ section }: { section: PolicySection }) {
	// Cada parágrafo é único na seção, então o próprio texto (ou o rótulo) serve de chave.
	const paragraphs = [
		...(section.body ?? []).map((text) => ({ key: text, node: text })),
		...(section.list ?? []).map(([label, text]) => ({
			key: label,
			node: (
				<>
					<Text style={styles.bold}>{label}</Text> — {text}
				</>
			),
		})),
		...(section.after ?? []).map((text) => ({ key: text, node: text })),
	];
	return (
		<View style={styles.section}>
			<View style={styles.sectionHeader}>
				<View style={styles.sectionIcon}>
					<Text style={styles.sectionIconText}>{section.icon}</Text>
				</View>
				<Text style={styles.sectionTitle}>{section.title}</Text>
			</View>
			<Text style={styles.sectionBody}>
				{paragraphs.map(({ key, node }, index) => (
					<Text key={key}>
						{index > 0 ? '\n\n' : ''}
						{node}
					</Text>
				))}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	scroll: {
		flex: 1,
	},
	content: {
		padding: 20,
		paddingBottom: 48,
	},
	title: {
		fontSize: 28,
		fontWeight: '800',
		color: '#FFFFFF',
		lineHeight: 34,
		marginBottom: 12,
		marginTop: 8,
	},
	accent: {
		color: '#15E8FE',
	},
	intro: {
		fontSize: 14,
		color: '#9CA3AF',
		lineHeight: 22,
		marginBottom: 12,
	},
	updated: {
		fontSize: 12,
		color: '#9CA3AF',
		marginBottom: 20,
	},
	pillRow: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
		marginBottom: 24,
	},
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		backgroundColor: '#1A1A1A',
		borderWidth: 1,
		borderColor: '#3e3e3e',
		borderRadius: 999,
		paddingVertical: 6,
		paddingHorizontal: 12,
	},
	pillIcon: {
		fontSize: 13,
	},
	pillLabel: {
		fontSize: 12,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	section: {
		backgroundColor: '#1A1A1A',
		borderWidth: 1,
		borderColor: '#3e3e3e',
		borderRadius: 16,
		overflow: 'hidden',
		marginBottom: 12,
	},
	sectionHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: '#3e3e3e',
	},
	sectionIcon: {
		width: 34,
		height: 34,
		borderRadius: 9,
		backgroundColor: 'rgba(21, 232, 254, 0.12)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	sectionIconText: {
		fontSize: 16,
	},
	sectionTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	sectionBody: {
		fontSize: 13.5,
		color: '#9CA3AF',
		lineHeight: 22,
		padding: 16,
	},
	bold: {
		fontWeight: '700',
		color: '#FFFFFF',
	},
	footer: {
		fontSize: 12,
		color: '#9CA3AF',
		textAlign: 'center',
		marginTop: 24,
	},
});
