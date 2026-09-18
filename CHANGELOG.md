# Changelog

Versões do app Spendr. A versão de cada build é o `version` do `app.json`, e cada
versão lançada tem uma tag `vX.Y.Z` na `main`. Como lançar e como voltar atrás:
[docs/versionamento.md](docs/versionamento.md).

## [1.1.0] — em desenvolvimento (branch `develop`)

- Dívidas (Ajustes → Dívidas): financiamento (Price e SAC), consórcio e empréstimo. Cadastro
  pelo que está no boleto — a taxa ou o saldo saem da parcela —, saldo devedor projetado,
  data de quitação, juros que faltam, cronograma, simulador de amortização (reduzir prazo ou
  parcela) e o veredito "amortizar ou investir" contra o rendimento líquido da meta.
- Relatórios: seção de dívidas, parcelas no "Já comprometido" (sem somar de novo o que já é
  recorrência) e o cenário "se as parcelas virarem aporte ao quitar" na projeção.
- Banco local v15 (tabela `debts`), sincronizada. Detalhes: [docs/dividas.md](docs/dividas.md).
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
