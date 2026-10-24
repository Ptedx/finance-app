# Changelog

Versões do app Spendr. A versão de cada build é o `version` do `app.json`, e cada
versão lançada tem uma tag `vX.Y.Z` na `main`. Como lançar e como voltar atrás:
[docs/versionamento.md](docs/versionamento.md).

## [1.2.8] — 2026-10-13

Logado numa conta, nada mais existe só no aparelho. A versão nasceu de uma perda real: o
app foi desinstalado e **duas semanas de compras foram embora** — elas estavam na caixa de
entrada, esperando revisão, e a caixa de entrada não sincronizava nem entrava no backup.

### A caixa de entrada vai para a nuvem

- **As capturas e as regras aprendidas passam a sincronizar.** Desinstalar o app e entrar
  na conta devolve a fila de revisão, e o app não esquece mais a categoria de cada
  estabelecimento. A identidade de uma captura entre aparelhos é a impressão digital da
  notificação, não o id local — é o que permite o mesmo aviso ter sido capturado em dois
  celulares sem conflito.
- **A tela da conta diz o que ainda não subiu**: "N itens ainda só existem neste aparelho",
  com o aviso de sincronizar antes de desinstalar ou trocar de celular. Quando não há nada
  pendente, ela diz isso também — a pergunta "o que existe aqui que não existe na minha
  conta?" passou a ter resposta na tela.
- A poda das capturas antigas virou lápide: apagar de verdade faria a linha voltar no
  próximo pull.

### O backup passa a ser a foto do aparelho

- **Formato 4**: o arquivo leva a caixa de entrada (com o texto cru da notificação, a conta
  resolvida e a decisão de cada item), as regras aprendidas e as preferências (moeda,
  idioma, taxa do CDI, avisos dispensados). Biometria não viaja: arquivo nenhum liga
  autenticação em aparelho nenhum.
- **Dois caminhos silenciosos para um arquivo vazio foram fechados.** O export lia as três
  maiores coleções do estado da tela, não do banco: se a carga falhasse — e ela falha em
  silêncio — ou se o toque viesse antes de ela terminar, o arquivo saía vazio **com aviso de
  sucesso**. E um arquivo truncado na escrita era compartilhado como se estivesse bom.
- **O aviso do export passou a dizer o que entrou, linha por linha.** Era o que teria
  mostrado a falta de outubro antes de desinstalar o app. Falha parcial nomeia a coleção que
  ficou de fora, no arquivo e na tela; e os avisos passaram pelo i18n — o mais importante
  deles, "não desinstale o app confiando neste arquivo", estava em inglês.
- A categoria "sem categoria", que a lista da tela esconde, e as lápides de categoria também
  viajam: a categoria apagada voltava a aparecer nos seletores depois de uma importação.

### Contas inventadas

- **A limpeza das contas fantasma virou reparo, e roda depois de sincronizar.** Ela era só
  migração, e migração roda antes de as tabelas existirem: numa instalação nova não achava
  nada e o login baixava as contas de volta do servidor. Agora roda quando o pull termina
  inteiro — nunca a cada página, senão uma conta cujos lançamentos ainda não chegaram
  pareceria vazia.

## [1.2.7] — 2026-10-11

Correções da revisão dos seis fluxos ([docs/revisao-fluxos-2026-10-11.md](docs/revisao-fluxos-2026-10-11.md)).

### Dinheiro que sumia ou aparecia

- **Apagar uma conta deixava as transferências dela vivas.** Apagar uma reserva que havia
  recebido R$ 40.000 da principal deixava a principal R$ 40.000 mais pobre para sempre, sem
  nada ter sido gasto. A lápide das transferências agora entra na mesma transação da conta.
- **Pagar a fatura em duas parcelas iguais perdia a segunda.** Qualquer pagamento de mesmo
  valor em ±5 dias, de qualquer conta, era tratado como duplicata e o app anunciava sucesso
  sem gravar nada. A identidade virou "mesma conta de origem, mesmo valor, no máximo um dia
  de diferença": R$ 500 pela Nubank no dia 1 e R$ 500 pelo Inter no dia 3 entram os dois.
- **"Acertar valor" do cartão zerava a fatura que ficasse em branco.** Quem tinha R$ 1.200
  de fatura fechada e R$ 450 na aberta, e preenchia só a fechada, recebia um estorno falso
  de R$ 450 e a fatura aberta zerada. Campo vazio passou a ser "não informei", a folha vem
  pré-preenchida com o que o app acha hoje, e só a fatura informada é ajustada.
- **Estorno na fatura aberta abatia a fatura fechada.** Fechada de R$ 1.000 com um estorno
  de R$ 200 na aberta mostrava "a pagar R$ 800" na face do cartão e R$ 1.000 na aba da
  fatura — e no Brasil o estorno credita a fatura seguinte. Quem pagasse os R$ 800 caía no
  rotativo.

### A renda de quem recebe pela PJ

- **O que uma conta marcada como "externa" transfere para uma conta sua agora é receita do
  mês.** O contrato estava escrito no código e nunca tinha sido implementado: quem recebe
  pela PJ via "Receita R$ 0,00" no mês em que ganhou R$ 12.000, porque o pró-labore chega
  como transferência. Com a receita errada, iam junto a taxa de poupança, a média de renda,
  a fatia de custo fixo, a grade de saúde e o "quanto a meta pede".
- **A conta externa saiu de "Em caixa"**: o dinheiro da empresa não é o seu caixa, e o
  quadro do mês já a ignorava.

### Reserva, envelope e histórico

- **Gasto dentro de uma conta de reserva é gasto do mês.** A compra no débito do Mercado
  Pago saía do saldo e não aparecia em "Gastos", inflando o "sobrou".
- **Só rendimento é anunciado como rendimento.** Toda receita que caísse numa conta de
  reserva — o Pix de um amigo, um reembolso — era somada como rendimento de investimento
  que não houve. Agora vale a categoria de rendimento.
- **Envelope com piso em zero**: devolver para a principal a sobra acumulada de meses
  anteriores reduzia o gasto do mês, num mês em que o dinheiro foi gasto de verdade.
- **Arquivar uma conta não reescreve mais o passado.** O papel da conta arquivada era
  trocado por "externa" em todos os meses: arquivar um cartão apagava as faturas dele do
  histórico e arquivar uma reserva zerava a poupança dos meses fechados.
- **"Guardado neste mês" por conta**: duas reservas que receberam R$ 1.000 e R$ 300
  mostravam R$ 1.300 nas duas linhas.
- **Trocar a natureza de uma categoria recalcula o mês na hora** — marcar "Repasse sócio"
  como repasse não tinha efeito até reabrir o app.
- **Uma base só para a taxa de poupança** nos Relatórios: a grade de saúde e a frase logo
  abaixo dela vinham de contas diferentes e se contradiziam no mesmo scroll.

### Parcelas e cartão

- **Parcela antiga não cai mais antes da âncora do cartão.** Num cartão cadastrado hoje, a
  parcela atual era datada no fechamento anterior, ficava antes da âncora e desaparecia da
  fatura. Agora ela é datada no maior entre o começo do ciclo e o dia seguinte à âncora.
- **"Pagar fatura" não vem mais pré-marcada numa conta de poupança do mesmo banco** — a
  fatura chegava a ser debitada da reserva de emergência. Quando o app não tem certeza de
  qual é a conta corrente, ele pergunta em vez de escolher.
- **A conversão de "débito cadastrado como crédito" parou de adivinhar a conta.** Com duas
  contas correntes no mesmo banco ela movia meses de gastos para a principal, sem volta e
  sem confirmação. Agora só converte quando não há dúvida.

### Capturas e transferências

- **Aplicação e resgate deixaram de ser ignorados.** "Aplicação de R$ 5.000,00 realizada"
  não gerava nada: o dinheiro saía da conta corrente, entrava na caixinha e o app seguia
  mostrando a conta R$ 5.000 mais cheia, indefinidamente. Agora viram transferência com o
  outro lado em branco — o app não chuta qual é a caixinha, mas o saldo fica certo. O
  resgate também passou a ser **entrada**; os dois eram tratados como saída.
- **Transferência não é mais engolida por outra de mesmo valor.** A busca casava qualquer
  transferência viva daquela conta com aquele valor em ±5 dias, ignorando o outro lado:
  dois aportes de R$ 200 no mesmo mês viravam um só, e um Pix de R$ 1.500 podia ser casado
  com o pagamento da fatura de dois dias antes — reverter o Pix apagava o pagamento. A
  janela virou um dia, a identidade dos dois lados passou a contar, e na dúvida o app cria
  uma transferência nova em vez de fundir duas.
- **"Desfazer" apaga a regra que o toque acabou de criar.** Marcar um item como
  "Transferência" por engano criava uma regra permanente e invisível: aquele
  estabelecimento desaparecia das despesas para sempre, e nenhuma tela mostrava ou apagava
  regras aprendidas.
- **Duplicata de carteira passou a comparar identidade.** Valor e direção iguais em 12 horas
  bastavam para o app descartar uma compra: duas de R$ 20,00 no mesmo dia (uma pelo Google
  Wallet às 9h, outra no cartão às 18h) viravam uma só, sem perguntar. Agora estabelecimento,
  final do cartão e conta entram na conversa; sem certeza, o app **pergunta**.
- **Compra "no crédito" com dois cartões do mesmo banco não cai mais na conta corrente.**
  R$ 480 saíam do saldo e ficavam fora das duas faturas. Sem saber qual cartão, a captura
  fica **sem conta** e você atribui.
- **A caixa de entrada mostra para onde a compra vai e se é parcelada.** Eram as duas
  decisões invisíveis no único momento de revisão: uma compra em 3x aparecia como
  "− R$ 300,00" e ao confirmar virava três parcelas em três faturas.

### Reserva, rendimento e aposentadoria

- **"Rendeu 0% ao ano" não aparece mais num investimento que rende.** O acréscimo do CDI é
  estimado em memória e o indicador só somava rendimento lançado, então o app afirmava zero
  e sugeria trocar de investimento — num CDB de 120% do CDI. Agora o número diz de onde vem
  (lançado ou estimativa), e o alerta de rendimento baixo não dispara em cima de estimativa.
- **Rendimento lançado e estimado não se somam mais.** O estimador continuava acumulando
  por cima de um rendimento já lançado, e compondo sobre a duplicata: inflava reserva,
  capital, patrimônio e progresso da meta, e podia declarar a reserva cheia antes da hora.
  A estimativa passou a correr só a partir do último rendimento lançado.
- **"Quanto guardar por mês" respeita a reserva primeiro.** O aporte dos horizontes de
  5/10/15/20 anos era resolvido como se o dinheiro fosse para a meta desde o mês 1, enquanto
  o app diz — certo — que os primeiros meses vão para a reserva: o número saía baixo e a
  meta chegava anos depois do prometido.
- **O Patrimônio usa hoje, não o mês que você escolheu em outra tela.** Selecionar dezembro
  na tela inicial mudava a meta da reserva, "em quantos meses enche" e a data da
  aposentadoria, porque as médias passavam a terminar num mês futuro. Mês que ainda não
  começou deixou de contar como mês fechado em qualquer média.
- **Dívida paga até o fim é dívida quitada.** Quem terminou as 48 parcelas no prazo
  continuava vendo "Parcela R$ 1.234" e o chip verde "Amortize" numa dívida que não existe
  mais. Ela sai do comprometido do mês, dos vereditos e das recomendações — sem nada ser
  apagado nem arquivado por conta própria.
- **Resgate não é mais "R$ 0,00 por mês".** Quando a média dos últimos meses é negativa, a
  data de chegada, a frase do ritmo e a curva do gráfico vinham de três premissas
  diferentes e o card se contradizia. Agora é uma só, e o gráfico desce.

### Ainda sobre contar duas vezes

- **A assinatura cobrada no cartão e cadastrada como recorrente agora é avisada.** A
  recorrente lança no dia combinado, sem conta, e a notificação do banco lança a compra na
  fatura: o gasto do mês e o "já comprometido" ficam inflados pelo valor de toda assinatura.
  O app passa a apontar o par (mesmo valor, poucos dias, um dos dois lançado pela
  recorrente) em vez de somar os dois calado. Qual sai é decisão sua: o app não tem como
  saber se a cobrança daquele mês aconteceu de verdade.
- **Mover lançamentos "sem conta" avisa antes.** O saldo de uma conta só conta o que é
  datado depois da âncora dela, então mover lançamentos antigos para uma conta criada hoje
  fazia o "Em caixa" pular no instante do toque, sem aviso. Agora a confirmação diz quantos
  vão ficar invisíveis e o que fazer depois.

### Sincronização, backup e extrato

- **Um orçamento do mesmo mês vindo de dois lados travava o sync do aparelho para sempre.**
  Dois ids para o mesmo mês derrubavam a remessa inteira com erro 500 e a fila reenviava a
  mesma página eternamente: nada mais saía do aparelho — nem lançamento, nem conta. Agora o
  conflito é resolvido por data (o último editado fica) e um registro problemático volta
  sozinho, sem derrubar o resto.
- **A pergunta "puxar da conta / subir do aparelho / juntar" passou a ser guardada.** Ela só
  existia na memória: fechar o app no meio da escolha fazia a abertura seguinte **juntar**
  em silêncio, e quem queria descartar o aparelho ficava com os dois conjuntos somados.
- **Importar backup preserva o id de tudo.** Lançamentos, recorrentes e dívidas renasciam
  com id novo, então importar o mesmo arquivo em dois aparelhos podia dobrar o livro-caixa.
  A importação também perdia de qual cartão saiu cada compra e o relógio das recorrentes,
  que voltavam a lançar a assinatura do mês.
- **O cursor do sync é jogado fora quando a sessão cai ou troca de conta.** Só o "sair"
  explícito limpava, e entrar em outra conta com o cursor antigo escondia tudo o que ela
  tinha gravado antes.
- **No extrato OFX, o saldo contábil voltou a ser o saldo.** Em banco que manda os dois
  (Itaú, Bradesco, Santander), o limite do cheque especial entrava como saldo da conta,
  calado, e subia para todos os aparelhos.
- **A migração do banco grava a versão a cada passo.** Um crash no meio refazia os 18
  passos do zero na abertura seguinte, e no passo mais antigo a repetição falhava com
  "tabela já existe": o app não abria mais, em nenhuma tela.

### Por dentro

- Primeiras suítes de teste do **banco**, do **backend** e do **sync** — as três áreas que
  não tinham nenhuma: a escada de migrações, o conflito de orçamento, o claim persistido e
  a importação de backup.
- `EXPORT_FORMAT_VERSION` 3: o arquivo de backup passa a levar o id do orçamento.

## [1.2.6] — 2026-10-11

- **Notificação de compra com "Toque para ver o comprovante" não é mais descartada.** O
  filtro de propaganda tratava chamariz ("toque para", "clique", "saiba mais") como sinal
  de anúncio, então "Pix enviado: R$ 1.200,00 para JOAO SILVA. Toque para ver o
  comprovante." era jogado fora **sem deixar rastro**: não virava item para revisar, não
  entrava no histórico e não dava erro. Quem decide agora é o verbo de movimentação, e
  propaganda continua sendo descartada. Um movimento confirmado ("enviado", "debitado",
  "pago", "creditado") nunca é tratado como anúncio.

- **Só banco vira conta.** Qualquer notificação com um valor criava uma conta com o nome do
  app que avisou: nasceram contas "WhatsApp", "Gmail", "Messages", "Google" e "99" ao lado
  das de verdade, e a compra podia cair numa delas. Agora o app só cria conta quando
  reconhece o banco; sem isso a captura fica **sem conta** e você diz de onde saiu.
- **Aviso repassado cai no banco certo.** O SMS, o e-mail ou o mensageiro que repassa o
  aviso do banco agora entra na conta daquele banco, e o app do mensageiro nunca fica
  gravado como origem da conta.
- **As contas fantasma que já existiam saem sozinhas** na atualização — só as vazias. Com
  lançamento, transferência ou captura apontando para ela, a conta fica e você decide.
- **"Duas contas do mesmo banco"**: a tela de Contas avisa quando duas fichas parecem a
  mesma conta do banco (uma recebendo o que o banco avisa, a outra cadastrada à mão) e
  pergunta qual fica. Com três fichas do mesmo banco nada é sugerido.
- **"Compras do app do banco"**: a tela da conta mostra em qual conta entram as compras que
  o app daquele banco avisa, e deixa trazê-las para esta. Era o único vínculo invisível do
  app — e era ele que mandava a compra do Inter para a conta "errada".
- **Final de débito nomeado decide a conta.** O final que você nomeia numa conta corrente
  ("Débito Inter", final 0443) passa a levar a compra para aquela conta, mesmo quando o
  banco também tem cartão de crédito. Antes os nomes só valiam para cartões.
- **Juntar contas não perde mais nada**: os nomes dos cartões virtuais da ficha que sai, o
  final do plástico dela, o valor mensal do envelope e o rendimento combinado vão junto.
  Antes o nome do cartão era gravado e sobrescrito em seguida, e a notificação do virtual
  voltava a criar a duplicata.
- **Parcelamento longo passa a ter fatura.** As faturas futuras paravam no 12º mês: um
  parcelamento de 36 vezes somava no limite usado, mas as parcelas depois do 12º mês não
  apareciam em fatura nenhuma. Agora o horizonte vai até 48 — o maior parcelamento que o
  app aceita.
- **O mês das parcelas é o mês da fatura.** "3 parcelas de R$ 200, de ago a out" mostrava
  um mês antes da fatura que cobra cada uma, porque usava a data do lançamento (o começo
  do ciclo) e não o mês em que a fatura fecha. Valia para a prévia de "Compra parcelada
  antiga" e para "Parcelas em andamento", e fazia conferir com a fatura do banco dar um
  mês de diferença.

## [1.2.5] — 2026-09-20

- A primeira notificação de um banco passa a **adotar a conta que você cadastrou à mão**,
  em vez de criar uma segunda conta do mesmo banco ao lado dela (era assim só para contas
  vindas de extrato OFX). Com duas contas do mesmo banco, nada é adivinhado: a conta do app
  nasce como antes.
- **Juntar contas**: em Editar conta, "Juntar com outra conta" leva lançamentos, capturas e
  transferências para a conta escolhida e apaga esta. Serve para desfazer a duplicata que a
  regra antiga criou.

## [1.2.4] — 2026-09-20

- Lançamento manual num cartão de crédito: dá para dizer **qual cartão** fez a compra — o
  físico, um virtual já visto (pelo final ou pelo nome) ou um final novo digitado. Editar um
  lançamento também permite trocar o cartão. Todos caem na mesma fatura.

## [1.2.3] — 2026-09-19

- A tela inicial avisa quando a **captura está desligada** (o Android não está entregando
  notificações ao app) e leva direto à tela do sistema para ligar. O acesso se perde a cada
  reinstalação, e a captura parava em silêncio. O aviso pode ser dispensado.

## [1.2.2] — 2026-09-19

- Importar um backup num app que já tinha dados deixava **todas as contas apagadas**: a
  importação marca tudo como apagado e regravava as contas com o mesmo id, o que o banco
  ignorava. O app ficava em R$ 0,00, e o sync levava o "apagado" para a conta. Agora as
  contas e transferências do backup voltam à vida.
- "Puxar da conta" no login e a importação agora atualizam as telas na hora (a 1.2.1 só
  cobria o sync em segundo plano).
- Falhas de sync vão para o log do aparelho, com o motivo.
- Um app recém-instalado não sobrescreve mais as categorias da conta no primeiro login: as
  padrão nascem com a data mais antiga e limpas, e a versão da conta sempre vence (antes os
  nomes e as naturezas voltavam ao padrão).
- Importar um backup aplica o nome e a natureza das categorias que já existem no aparelho
  (antes as padrão eram puladas e o essencial/repasse ajustado se perdia).

## [1.2.1] — 2026-09-19

- Login num aparelho novo: os dados baixados da conta agora aparecem na hora. Antes, o sync
  gravava tudo no banco local, mas lançamentos, contas, orçamento, recorrências e a meta só
  eram relidos ao reabrir o app — a tela ficava zerada.
- Backup (Exportar/Importar dados) passa a levar as dívidas, a meta de aposentadoria e a
  meta da reserva de emergência. Antes, um backup restaurado voltava sem elas.

## [1.2.0] — 2026-09-19

- **Reserva de emergência** no Patrimônio: meta em meses de **custo essencial** (padrão 12),
  com o custo tirado dos meses fechados (gasto do mês × fatia essencial das categorias),
  do orçamento enquanto não há mês fechado, ou informado à mão.
- **Cascata**: o dinheiro guardado enche primeiro a reserva; só o que passa dela é capital da
  meta de aposentadoria. Uma conta de reserva pode ser marcada "só investimento" e fica fora.
- **Reserva primeiro** na projeção da aposentadoria: enquanto a reserva não enche, o aporte vai
  para ela, e a data de chegada conta esse atraso.
- **Por onde começar**: reserva mínima (3 meses) → dívida que custa mais que o investimento →
  reserva cheia → aposentadoria, com o que falta em cada degrau.
- O indicador "Reserva de emergência" da saúde financeira mede a reserva contra o custo
  essencial e a meta de meses (sem custo conhecido, segue como antes).
- Patrimônio separa "Reserva de emergência" de "Investimentos" (o total não muda).
- Banco local v17 (tabela `reserve_goals`, `accounts.reservePurpose`), sincronizado.
  Detalhes: [docs/reserva-de-emergencia.md](docs/reserva-de-emergencia.md).

## [1.1.0] — 2026-09-18

- Nova aba **Patrimônio** na barra de baixo (Ajustes sai dela e abre pela engrenagem do
  Início): patrimônio líquido — o que se tem menos o que se deve, com as parcelas futuras
  dos cartões — e as dívidas.
- Dívidas: financiamento (Price e SAC), consórcio e empréstimo. Cadastro
  pelo que está no boleto — a taxa ou o saldo saem da parcela —, saldo devedor projetado,
  data de quitação, juros que faltam, cronograma, simulador de amortização (reduzir prazo ou
  parcela) e o veredito "amortizar ou investir" contra o rendimento líquido da meta.
- Relatórios: seção de dívidas, parcelas no "Já comprometido" (sem somar de novo o que já é
  recorrência) e o cenário "se as parcelas virarem aporte ao quitar" na projeção.
- Dívidas: **taxa do contrato editável** (ao mês ou ao ano) junto com o saldo; o que a
  parcela cobra a mais vira "seguro e tarifas", e o veredito usa o custo efetivo.
- Contas que **rendem um % do CDI** (ex.: 120%): o saldo soma o rendimento estimado por dia
  útil, com a taxa CDI do Banco Central.
- Acertar o saldo de uma reserva/investimento: um campo só, sem lançar despesa (antes a
  folha recalculava um "gasto" e o lançava).
- Sync: só envia as coleções que o servidor conhece (antes, um servidor sem dívidas as
  descartava em silêncio e o app as marcava como enviadas); as dívidas voltam a ser
  enviadas. O servidor ganha o gatilho de `serverSeq` que faltava em `retirement_goals`
  e `debts` — sem ele, editar a meta ou uma dívida não chegava aos outros aparelhos.
- Banco local v15 (tabela `debts`) e v16 (CDI nas contas, encargos nas dívidas), sincronizados. Detalhes: [docs/dividas.md](docs/dividas.md).
- Ajustes mostram a versão real do app instalado.
- O sync guarda o cursor por versão do banco: voltar para a 1.0 e depois para a 1.1
  não perde as dívidas criadas em outro aparelho no meio-tempo.

## [1.0.2] — 2026-09-18 — hotfix do login

Branch `hotfix/1.0.2` sobre a v1.0.1. Instala por cima da 1.0 sem perder dados.

- Login numa conta que já tem dados: escolher entre **subir deste aparelho** (a conta passa
  a ter só o que está no aparelho), **puxar da conta** ou **juntar os dois**, vendo o que
  cada lado tem. Antes, só havia juntar (que trazia a história antiga da conta de volta)
  ou descartar o aparelho, e um aparelho já sincronizado era mesclado sem pergunta.
- Sem mudança no servidor.

## [1.0.1] — 2026-09-18 — a versão estável

Tag `v1.0.1`. APK: build EAS `preview` do commit `8ca0929`, cópia local em
`releases/spendr-v1.0.1.apk`. Banco local na versão 14.

- Captura de notificações dos bancos, com caixa de entrada para revisar.
- Contas e cartões: ciclo de fatura pelo dia de fechamento, vencimento em dia útil,
  vários cartões na mesma fatura, cartão de débito, envelope e reserva.
- Lançamentos com filtro de período, conta e tipo, incluindo transferências.
- Relatórios: meta de aposentadoria (+25% reinvestido), saúde financeira, histórico por
  mês, projeção, ranking de categorias e de origem do gasto, já comprometido.
- Repasse: dinheiro que só passou pela conta desconta da receita.
- Sync com o servidor em https://api-finance.valtre.com.br.
