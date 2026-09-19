# Reserva de emergência

A reserva responde "se a renda parar amanhã, por quantos meses eu me viro?" e, junto, separa
o dinheiro guardado em dois papéis: **reserva** (para imprevistos) e **capital de
investimento** (o que a meta de aposentadoria acompanha). Código: `app/utils/emergencyReserve.ts`
(puro, testado) e `app/utils/priorities.ts`; telas no Patrimônio.

## O tamanho: meses de custo essencial

```
fatia essencial do mês = essencial ÷ (essencial + discricionário)     [repasse fora]
custo essencial do mês = gasto do mês × fatia essencial
custo mensal           = média dos últimos 3 meses fechados com gasto
meta                   = custo mensal × meses (padrão 12)
```

- O **gasto do mês** é o mesmo da Home (`totalSpendCents`: fatura que fecha no mês, custo do
  envelope, repasse fora). Somar "custo fixo + categorias essenciais" contaria duas vezes a
  recorrência que já virou lançamento.
- A **natureza** de cada categoria (Essencial, Supérfluo, Repasse) decide a fatia. Uma
  parcela de financiamento entra pela categoria da dívida: se ela não for essencial, a reserva
  sai menor do que deveria.
- Um mês fechado **sem gasto** fica fora da média: é de antes do app estar em uso, não um mês
  sem custo.
- **De onde vem o custo**, nesta ordem: o valor informado à mão → a média dos meses fechados →
  o orçamento do mês × a fatia essencial do mês atual (até fechar o primeiro mês) → nenhum
  (o cartão pede o custo em vez de inventar um número).

A meta (meses e custo à mão) é a tabela sincronizada `reserve_goals`, uma linha de id fixo
`emergency`, como a meta de aposentadoria. O resto é derivado a cada leitura.

## A cascata: reserva × capital de investimento

```
pool       = Σ saldo das contas de reserva (menos as "só investimento")
reserva    = min(pool, meta)
capital    = (pool − reserva) + contas "só investimento" + capital fora do app
```

O dinheiro guardado enche **primeiro** a reserva; só o que passa da meta é capital da
aposentadoria. Funciona com uma conta só (a mesma conta é reserva até a meta e investimento
depois dela), sem precisar dividir o dinheiro em caixinhas.

Uma conta de reserva pode ser marcada **"só investimento"** (`accounts.reservePurpose =
'investment'`): o saldo vai inteiro para o capital, mesmo com a reserva incompleta — para o que
não dá para resgatar num imprevisto, como previdência.

Sem custo conhecido não há meta, e **tudo continua capital**, como antes da reserva existir.
O total do Patrimônio não muda: ele só passa a separar "Reserva de emergência" de
"Investimentos".

## Reserva primeiro

Enquanto a reserva não enche, o aporte médio (o mesmo que a meta usa) vai para ela. A
projeção da aposentadoria recebe aporte **zero** até o mês em que a reserva enche, e o aporte
inteiro a partir do seguinte (`retirementContributionPlan` em `utils/retirement.ts`). A data
de chegada conta esse atraso; se a reserva não enche no ritmo de hoje, a meta não recebe
aporte. O cenário "se as parcelas virarem aporte ao quitar" soma as parcelas por cima dessa
mesma regra.

"Em quantos meses enche" simula mês a mês com o aporte médio e o rendimento esperado da meta.

## Por onde começar

A ordem do que fazer com o próximo real que sobrar:

1. **Reserva mínima** — 3 meses de custo essencial. Sem ela, um imprevisto vira dívida cara.
2. **Dívida cara** — o saldo das dívidas com veredito "amortize" (custo efetivo acima do
   rendimento líquido do investimento; ver [dividas.md](dividas.md)). O degrau só aparece
   com dívida cadastrada.
3. **Reserva cheia** — a meta de meses.
4. **Aposentadoria** — o que falta de capital para a meta.

O primeiro degrau não cumprido é o de agora; os de baixo esperam. Um degrau que depende de
um dado que falta (custo essencial, meta de aposentadoria) pede o dado.

## Saúde financeira

Com custo essencial conhecido, o indicador "Reserva de emergência" mede **reserva ÷ custo
essencial**: bom a partir da meta de meses, atenção a partir de 3. Sem custo, segue o cálculo
anterior (caixa + guardado ÷ gasto médio).
