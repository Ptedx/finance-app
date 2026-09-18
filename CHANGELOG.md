# Changelog

Versões do app Spendr. A versão de cada build é o `version` do `app.json`, e cada
versão lançada tem uma tag `vX.Y.Z` na `main`. Como lançar e como voltar atrás:
[docs/versionamento.md](docs/versionamento.md).

## [1.1.0] — em desenvolvimento (branch `develop`)

- Dívidas: financiamento e consórcio, saldo devedor, data de quitação, simulador de
  amortização e o veredito "amortizar ou investir".
- Ajustes mostram a versão real do app instalado.
- O sync guarda o cursor por versão do banco: voltar para a 1.0 e depois para a 1.1
  não perde as dívidas criadas em outro aparelho no meio-tempo.

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
