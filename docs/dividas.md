# Dívidas: financiamento, consórcio e empréstimo

Aba **Patrimônio** (na barra de baixo). Para cada dívida, o app mostra quanto se deve hoje, quando quita,
quanto ainda vai de juros e responde **"vale a pena amortizar?"**. Nos Relatórios, as
dívidas aparecem com o veredito, entram no "Já comprometido" e mudam a projeção da
aposentadoria.

## A aba Patrimônio

A barra de baixo fica **Início · Lançamentos · (+) · Patrimônio · Relatórios**; Ajustes saiu
dela e abre pela engrenagem do Início. Cada aba responde uma pergunta: como está hoje, o
que aconteceu, quanto eu valho e o que me prende, e se estou no caminho.

No topo, o **patrimônio líquido**: o que se tem (contas, reservas e investimentos, e o
capital fora do app informado na meta) menos o que se deve (cartões — faturas **e parcelas
que ainda vão cair** — e o saldo das dívidas). Bens como carro e imóvel não entram, porque o
app não sabe quanto valem; a tela diz isso. Embaixo, as dívidas com o veredito de cada uma.
A reserva de emergência entra aqui quando o módulo existir.

## Cadastro: só o que está no boleto

A parcela, quantas faltam, o dia do vencimento e **o saldo devedor ou a taxa**, o que se
souber. O outro sai da mesma conta:

| sistema | parcela | taxa a partir do saldo |
|---|---|---|
| **Price** (carro, empréstimo) | fixa: `P·i / (1 − (1+i)^−n)` | bissecção: a parcela cresce com a taxa |
| **SAC** (imóvel) | amortização fixa `P/n` + juros do saldo | direto: `(parcela − P/n) / P` |
| **Consórcio** | fixa, sobe com o reajuste no aniversário | sem juros: a "taxa" é o reajuste informado |

A taxa aceita "ao mês" ou "ao ano" (financiamento de carro costuma ser cotado ao mês). A
tela mostra na hora a taxa, a data de quitação e os juros que faltam, para conferir com o
banco. Se os valores não fecham (parcela que não paga o saldo), ela avisa antes de salvar.

### Taxa do contrato e encargos

A parcela que o banco cobra quase sempre traz **seguro e tarifas** além de juros e
amortização. Por isso a taxa estimada só pela parcela sai **mais alta** que a do contrato
(o caso real: contrato a 1,8% ao mês, estimativa de 2,43%). Com saldo **e** taxa
informados, o app separa as duas coisas:

```
encargos = parcela cobrada − parcela que a taxa do contrato daria
```

O cronograma usa a taxa do contrato para os juros e soma os encargos a cada parcela (eles
não amortizam). Só com o saldo, a taxa é estimada e a tela diz que é estimativa; só com a
taxa, o saldo é que é estimado.

O **veredito** compara o investimento com o **custo efetivo** — a taxa que iguala o saldo
de hoje às parcelas que faltam, com os encargos —, porque antecipar deixa de pagar juros
**e** encargos. Sem encargos, é a própria taxa do contrato.

## O saldo é uma âncora

Como o saldo das contas, a dívida guarda o saldo **logo depois da última parcela paga**
numa data (`openingBalanceCents` em `openingBalanceDate`), e o saldo de hoje é projetado
pelo cronograma: cada vencimento que passa sai do saldo sozinho. Salvar a dívida ancora em
hoje; amortizar move a âncora.

A taxa mensal é a **equivalente composta** da anual — `(1 + anual)^(1/12) − 1` —, porque a
dívida capitaliza de verdade. (A meta de aposentadoria usa anual÷12 de propósito; a
comparação entre as duas é sempre em taxa anual.)

Consórcio não tem juros: no aniversário do contrato, saldo e parcela sobem o reajuste
(INCC, IPCA). O custo de não antecipar é esse reajuste.

## Vale a pena amortizar?

Antecipar uma dívida "rende" exatamente o custo dela, e sem imposto. Investir rende o
esperado **menos o IR** (15%, a alíquota mínima da renda fixa longa). O rendimento é o da
meta de aposentadoria, ou 10% ao ano sem meta.

```
líquido  = rendimento × (1 − 15%)
spread   = custo da dívida − líquido
veredito = amortizar se spread > 0,5 p.p.; investir se < −0,5 p.p.; senão, tanto faz
```

Com 10% de rendimento (8,5% líquido): um financiamento de carro a ~22% ao ano dá
**amortize** (cada R$ 1.000 antecipados valem ~R$ 135 por ano a mais); um consórcio com
reajuste de 5% dá **invista**.

O **simulador** (detalhe da dívida → Simular amortização) mostra, para um valor, reduzindo
o prazo ou a parcela: parcelas a menos, nova data de quitação ou nova parcela, quanto se
deixa de pagar de juros (total pago antes − total pago depois − o valor antecipado), e
quanto o mesmo valor renderia investido pelo mesmo prazo. "Registrar esta amortização"
move a âncora para hoje; o débito no banco continua chegando como um lançamento qualquer.

## Efeito no mês e no futuro

- **Já comprometido** (Relatórios): as parcelas dos próximos 3 meses aparecem por dívida.
  Se já existe uma recorrência mensal de despesa com o mesmo valor (1% ou R$ 1 de folga),
  a parcela já está no custo fixo: aparece marcada e **não soma de novo**.
- **Quitação**: a seção de dívidas diz quando a primeira parcela deixa de sair.
- **Aposentadoria**: um cenário — "se as parcelas virarem aporte quando quitar" — com o
  aporte subindo no mês seguinte a cada quitação. Aparece como linha tracejada na projeção
  e como uma frase no hero ("você chega em X, N anos antes"). É cenário, não promessa: a
  linha principal segue o aporte de hoje.
- **Insights**: uma frase por dívida em que o veredito é claro.

## Sync e volta de versão

Tabela `debts` (banco local v15), sincronizada como as outras coleções e **opcional** nos
dois lados: a API nova atende o app 1.0, e o app 1.0 abre um banco v15 sem migrar nada.
Como a 1.0 grava o cursor inteiro do servidor (inclusive o de `debts`, cujas linhas ela
descarta), a 1.1 guarda o cursor numa chave própria (`pullCursor@15`) e, na primeira vez,
herda da 1.0 só as coleções que ela conhecia. Ver [versionamento.md](versionamento.md).

## Onde mora cada coisa

| arquivo | o quê |
|---|---|
| `app/utils/debt.ts` | cronograma (Price, SAC, consórcio), saldo de hoje, taxa implícita, simulação, veredito, parcelas por mês, resumo |
| `app/utils/retirement.ts` | `projectCapitalStepped` e `monthsToReachStepped` (aporte em degraus) |
| `app/contexts/DebtsContext.tsx` | a lista, o resumo e as ações (criar, salvar, apagar, registrar amortização) |
| `app/screens/WealthScreen.tsx`, `app/components/wealth/` | a aba Patrimônio: patrimônio líquido e o painel de dívidas |
| `app/screens/Debt*.tsx`, `app/components/debts/` | cadastro, detalhe e simulador |
| `app/components/reports/DebtsSection.tsx` | a seção nos Relatórios |
| `app/sync/types.ts` | `WireDebt`, `COLLECTION_SINCE_SCHEMA`, `inheritCursor` |
| `backend/prisma/migrations/20260918150000_debts` | a tabela no Postgres |
