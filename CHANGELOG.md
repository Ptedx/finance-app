# Changelog

Versões do app Spendr. A versão de cada build é o `version` do `app.json`, e cada
versão lançada tem uma tag `vX.Y.Z` na `main`. Como lançar e como voltar atrás:
[docs/versionamento.md](docs/versionamento.md).

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
