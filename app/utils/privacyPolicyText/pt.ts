import type { PrivacyPolicy } from '../privacyPolicy';

/** A política em português, a versão original (SPD-078). Igual a `docs/privacy-policy.html`. */
const pt: PrivacyPolicy = {
	title: 'Seus dados são seus.',
	accent: 'Nada é vendido.',
	intro:
		'O Spendr funciona no seu aparelho. Se você criar uma conta, uma cópia dos seus dados fica no servidor do Spendr para sincronizar e voltar num aparelho novo. Não há anúncios, rastreio nem venda de dados.',
	updated: 'Atualizada em 27 de outubro de 2026',
	pills: [
		{ icon: '📱', label: 'Funciona sem conta' },
		{ icon: '☁️', label: 'Conta opcional' },
		{ icon: '🚫', label: 'Sem rastreio' },
		{ icon: '🤝', label: 'Nada é vendido' },
	],
	sections: [
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
					'em Ajustes, apaga lançamentos, contas, cartões, contas a pagar, orçamentos, dívidas, metas e avisos capturados; ficam as categorias, o que o app aprendeu de cada loja e as configurações. Com conta, apaga de verdade também no servidor, e os outros aparelhos conectados a ela apagam na próxima sincronização. De cada aviso apagado fica neste aparelho só uma marca, sem texto nem valor, para que a mesma notificação não entre de novo.',
				],
				[
					'Apagar a conta',
					'em Ajustes, na seção Conta, apaga a conta e todos os dados dela no servidor e em todos os aparelhos conectados a ela — neste na hora; os outros saem da conta e apagam os dados na próxima vez que falarem com o servidor. Em cada aparelho ficam as categorias, o que o app aprendeu de cada loja e as configurações. Quem não tem mais o app pode pedir a exclusão da conta por e-mail: vinicosta37@gmail.com.',
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
	],
	footer: 'Spendr — feito a partir do projeto de código aberto de okazakee.',
};

export default pt;
