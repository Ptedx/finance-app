# Changelog

Versões do app Spendr. A versão de cada build é o `version` do `app.json`, e cada
versão lançada tem uma tag `vX.Y.Z` na `main`. Como lançar e como voltar atrás:
[docs/versionamento.md](docs/versionamento.md).

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
