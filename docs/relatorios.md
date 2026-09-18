# Relatórios: saúde financeira e liberdade financeira

A Home diz o que aconteceu neste mês. Relatórios responde "estou no caminho?": a meta de
viver de renda passiva, cinco indicadores de saúde, o histórico de meses, a projeção do
capital, onde o dinheiro foi e o que já está comprometido. Tudo vem de módulos puros e
testados; a tela (`app/screens/ReportsScreen.tsx`) só compõe.

## A meta de aposentadoria

A regra: a renda que os investimentos precisam gerar é a renda desejada **mais uma margem
reinvestida** (25% por padrão), para o capital acompanhar a inflação.

```
renda bruta        = renda desejada × (1 + margem)          R$ 10.000 → R$ 12.500
capital necessário = renda bruta × 12 ÷ rentabilidade a.a.  R$ 150.000 ÷ 10% → R$ 1.500.000
renda passiva hoje = capital × rentabilidade ÷ 12
capital            = contas de papel `reserve` + "investimentos fora do app"
```

A rentabilidade é a mensal simples (anual ÷ 12), de propósito: assim "renda passiva hoje"
e a projeção contam a mesma história. A meta fica em `retirement_goals`, uma linha por
usuário com id fixo `retirement`, sincronizada como as outras coleções (dois aparelhos
disputam a mesma linha e o "última escrita vence" resolve).

**Nesse ritmo, quando chego?** O aporte é a média de `savedCents` (o que entrou nas
reservas) dos últimos 6 meses fechados. Com juros compostos mensais:

```
n = ⌈ ln((capital_necessário·r + aporte) / (capital·r + aporte)) / ln(1 + r) ⌉
```

e um laço acerta o arredondamento do ponto flutuante. Sem aporte e sem rendimento, ou
além de 100 anos, é "nunca nesse ritmo". **Para chegar em N anos** é o inverso:

```
aporte = (capital_necessário − capital·(1+r)^n) · r / ((1+r)^n − 1)
```

mostrado para 5, 10, 15 e 20 anos. A projeção separa o que sai do bolso (capital inicial
mais aportes) do que os juros fazem sozinhos. Tudo em `app/utils/retirement.ts`.

O rendimento **observado** entra quando há histórico: o que as reservas renderam nos
últimos 12 meses sobre o saldo médio delas (andando para trás a partir do saldo de hoje).
Só é calculado com o mês de hoje selecionado.

## Saúde financeira (`app/utils/healthScore.ts`)

Cinco indicadores, cada um com status (bom / atenção / ruim / sem dados), valor, alvo e
uma frase por status. Os limiares são os mesmos de `insights.ts` onde já existiam.

| Indicador | Cálculo | Bom | Atenção |
|---|---|---|---|
| Taxa de poupança | `savingsRateBp` do mês (receita líquida − gasto) ÷ receita | ≥ 20% | ≥ 10% |
| Reserva de emergência | (caixa + guardado) ÷ gasto médio dos 3 meses fechados | ≥ 6 meses | ≥ 3 |
| Custo fixo | recorrências mensais ÷ renda | ≤ 40% | ≤ 50% |
| Peso do cartão | (fatura fechada por pagar + aberta) ÷ renda média; limite ≥ 80% rebaixa bom para atenção | ≤ 30% | ≤ 50% |
| Ritmo de gastos | gasto do mês vs. média × fração do mês decorrida; só a partir de 15% do mês | ≤ +5% | ≤ +15% |

A taxa de poupança também mostra "para a meta em 20 anos: N% da renda" — o aporte que
chegaria em 20 anos sobre a renda média.

## O histórico (`app/utils/reportSeries.ts`)

Um `MonthOverview` por mês, montado com a **mesma** `buildMonthOverview` da Home a partir
de três consultas agregadas por mês (`getMonthlyAccountActivity`, `getMonthlyTransferActivity`,
`getMonthlyCategoryTotals`) e das linhas dos cartões. O gasto de cartão num mês passado é
a **fatura que fecha nele** (`invoicesClosingBetween`), não as compras datadas nele — por
isso "Gastou" em setembro nos Relatórios é o mesmo número do "Este mês" de setembro.

Sempre se carregam 13 meses; os chips 3/6/12 só recortam. O mês em andamento fica fora
das médias.

- **Onde foi o dinheiro**: categorias do mês com fatia e variação contra o mês anterior
  (`categoryDeltas`). Repasse fica de fora.
- **Por onde saiu**: cada cartão de crédito (a fatura), cada cartão de débito pelo final,
  o Pix da conta principal (o que sobra depois do débito), os envelopes e o sem conta.
- **Já comprometido**: nos próximos 3 meses, as faturas cujo vencimento cai em cada um
  (`amountCents − paidCents`) mais o custo fixo das recorrências.

## Renda: repasse e duplicata

A renda chega em dois Pix e parte de um deles é repassada. Uma despesa numa categoria de
natureza **repasse** (`passthrough`) não é gasto: desconta da receita. R$ 5.000 + R$ 15.000
com R$ 6.000 repassados = renda de R$ 14.000, e os R$ 6.000 não aparecem no gasto. Vale
para a Home, para os totais da lista de lançamentos e para os relatórios (todas as somas
fazem `LEFT JOIN categories` e separam `passThroughCents`). Categorizar o Pix de repasse
uma vez ensina a regra da contraparte; os próximos caem sozinhos.

As projeções usam a **renda líquida média dos meses fechados** do livro — nunca uma
recorrência de receita somada ao livro. `findDuplicateIncomes` marca duas receitas de
mesmo valor, na mesma conta, com até 2 dias de distância (a partir de R$ 500) e vira o
insight `income-possibly-duplicated`, que abre a lista de entradas do mês.

## Onde mora cada coisa

| Arquivo | O quê |
|---|---|
| `app/utils/retirement.ts` | capital necessário, meses até a meta, aporte por horizonte, projeção |
| `app/utils/healthScore.ts` | os cinco indicadores e seus limiares |
| `app/utils/reportSeries.ts` | série de meses, rankings, comprometido, renda considerada, duplicatas |
| `app/utils/insights.ts` | `buildGoalInsights` (meta, saúde, duplicata) e `mergeInsights` |
| `app/utils/chartPaths.ts` | geometria do gráfico de projeção em SVG |
| `app/hooks/useReportsData.ts` | as consultas e os `useMemo` que alimentam a tela |
| `app/hooks/useRetirementGoal.ts` | ler, salvar e limpar a meta (com sync) |
| `app/components/reports/` | uma seção por componente |
| `app/database/database.ts` | agregados por mês, `retirement_goals` e sua fiação no sync |
