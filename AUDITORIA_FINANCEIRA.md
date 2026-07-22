# Auditoria dos Cálculos Financeiros — Spendr

Revisão feita em 22/07/2026 sobre o branch `main-sql`.
Escopo: toda a lógica de valores, datas, agregações, orçamento, recorrências e exportação.

**Veredito original: o app não era confiável para planejamento financeiro.** Havia 4 erros
que produziam números silenciosamente errados na tela (não travavam, não avisavam — só mentiam).

---

## Status da correção (22/07/2026)

**Todos os 17 itens da auditoria foram corrigidos.**
`npm run typecheck` limpo (inclusive o erro pré-existente do i18n) e **101 testes**
cobrindo dinheiro, datas, recorrências e conversão de moeda.

| # | Item | Status |
|---|---|---|
| C1 | Vírgula decimal ×100 | ✅ `parseAmountToCents` |
| C2 | Sinal negativo apagado | ✅ `formatCents` via `formatToParts` |
| C3 | "Saldo" ignorava o período | ✅ resultado do mês × saldo acumulado, separados |
| C4 | Formatação `en-US` fixa | ✅ locale do dispositivo |
| A1 | Recorrência dia 31 pulava meses | ✅ `addMonthsClamped` / `buildClampedDate` |
| A2 | Sem catch-up de recorrências | ✅ `occurrencesBetween` |
| A3 | Recorrência com data de hoje | ✅ lançada na data de vencimento |
| A4 | `toISOString` → dia errado após 21h | ✅ `todayISO()` local em todo o app |
| A5 | Datas exibidas 1 dia antes | ✅ `parseISODate` local |
| M1 | "Renda mensal" somava periodicidades | ✅ `monthlyEquivalentCents` |
| M2 | Ponto flutuante | ✅ centavos em `INTEGER` + migração v1 |
| M3 | Gráfico de tendência desalinhado | ✅ 12 meses sempre preenchidos |
| M4 | CSV quebrava no Excel | ✅ escape + datas ISO |
| M5 | Import perdia categorias | ✅ categorias restauradas primeiro |
| M6 | Orçamentos fora do backup | ✅ incluídos no JSON |
| M7 | Sem categorias de receita | ✅ coluna `type` + 6 categorias semeadas |
| M8 | Moeda padrão Bitcoin, sem conversão | ✅ padrão do dispositivo + conversão por taxa |

### Arquivos novos
- `app/utils/money.ts` — centavos inteiros, parsing, formatação e conversão
- `app/utils/recurrence.ts` — agendamento puro, testável
- `app/utils/__tests__/` — 101 testes

### Migrações de schema
Versionadas por `PRAGMA user_version`, aplicadas uma etapa por vez antes de qualquer
`CREATE TABLE IF NOT EXISTS`. Ambas validadas contra um SQLite real:

- **v0 → v1** — `amount REAL` vira `amountCents INTEGER` (`ROUND(amount*100)`),
  reconstruindo as tabelas. Re-executar a inicialização é no-op.
- **v1 → v2** — `categories` ganha `type`; linhas existentes classificadas pela lista de
  IDs que o app usava hardcoded; categorias de receita que faltavam são semeadas.

`seedMissingDefaultCategories` roda em todo start, então seeds adicionados em versões
futuras alcançam instalações antigas sem tocar nas edições do usuário.

### Troca de moeda
`hasFinancialData()` decide se há o que converter. Havendo dados, o seletor pede a taxa
(`1 <atual> = X <nova>`) e reescala transações, recorrências e orçamentos numa única
transação SQL. A alternativa "trocar só o símbolo" existe, mas atrás de uma confirmação
que explica exatamente o que acontece com os valores.

### Achados pós-auditoria (encontrados testando no aparelho)

| # | Item | Status |
|---|---|---|
| P1 | Picker não trocava as categorias ao alternar Despesa/Receita | ✅ `isIncome` no comparador do `memo` |
| P2 | Erro "selecione uma categoria" não sumia após selecionar | ✅ `useCallback` + update funcional |

`CategoryPicker` é memoizado com um comparador manual que listava apenas
`selectedCategoryId` e os ids das categorias. Ao introduzir a prop `isIncome` (Fase 6),
o comparador não foi atualizado: ele respondia "nada mudou" e o React pulava a
re-renderização, deixando as categorias do tipo anterior na tela.

O mesmo comparador também ignorava `name`, `color`, `icon` e `type`, então editar uma
categoria não se refletia no picker — agora todos são comparados.

P2 é da mesma família: o comparador não compara `onSelectCategory` (é uma closure nova a
cada render, compará-la anularia o memo). Mas a closure capturava `errors`, então o
picker guardava uma versão obsoleta e a mensagem de validação nunca era limpa. O callback
agora é estável e atualiza o estado de forma funcional.

**Lição:** ao adicionar uma prop a um componente memoizado com comparador manual, o
comparador é parte da assinatura. O teste `categoryPickerMemo.test.ts` trava isso — foi
verificado que ele falha sem a correção.

### Notas
- `TransactionManager.tsx` foi **removido**: era código morto com transações fictícias.
- Categorias que **você** criou antes da v2 são classificadas como **despesa** — a
  migração não tem como adivinhar. Se alguma era de receita, edite o tipo em
  *Gerenciar Categorias*.
- Traduções pt-BR não existem: o app tem apenas `en` e `it`. O i18n agora segue o idioma
  do aparelho e cai em inglês quando não há bundle. Formatação de números e datas,
  porém, já segue o locale do dispositivo.

---

---

## 🔴 CRÍTICO — corrija antes de lançar qualquer dado real

### C1. Vírgula decimal multiplica o valor por 100
`app/utils/currencyUtils.ts:22-33`

```js
const cleaned = input.replace(/[^0-9.]/g, '');   // remove a vírgula, não converte
```

O teclado `decimal-pad` em português mostra **vírgula**, não ponto. Resultado real:

| Você digita | App grava |
|---|---|
| `1500,50` | **150050,00** |
| `1.500,00` | **1,50** |
| `1500.50` | 1500,50 ✓ |

Um único lançamento errado desses destrói o saldo. É o bug mais perigoso do app.

**Correção:** normalizar separadores antes de parsear — remover separador de milhar e
converter vírgula em ponto:
```ts
const cleaned = input.replace(/[^0-9.,]/g, '').replace(/\.(?=.*[.,])/g, '').replace(',', '.');
```
E travar a entrada em 2 casas decimais.

---

### C2. Valores negativos são exibidos como positivos
`app/utils/currencyUtils.ts:19`

```js
.format(amount).replace(/^\D+/, currentCurrencySymbol)
```

`Intl` gera `-R$1,234.50`. O regex `^\D+` casa com `-R$` (o sinal é não-dígito!) e
substitui pelo símbolo → sai **`R$1,234.50`**. O saldo negativo aparece positivo.

Só a cor vermelha diferencia — e no CSV exportado nem isso. Verificado:
`formatCurrency(-1234.5)` → `R$1,234.50`.

**Correção:** tratar o sinal separadamente, ou usar `Intl` com `currencyDisplay: 'narrowSymbol'`
e locale correto em vez de substituir o símbolo na marra.

---

### C3. O "Saldo" da tela inicial ignora o mês selecionado
`app/contexts/TransactionsContext.tsx:156-180`

```ts
const allTransactionsToDate = await getTransactionsByDateRange('1970-01-01', hoje);
const cumulativeNet = totalIncomes - totalExpenses;
setMonthlyTotal({ expenses: periodExpenses, incomes: periodIncomes, net: cumulativeNet });
```

`expenses` e `incomes` são **do mês selecionado**; `net` é o **acumulado desde sempre**.
Os três ficam lado a lado no relatório (`ReportsScreen.tsx:365-389`) sob os rótulos
Receita / Despesa / Líquido — e **não fecham**:

> Receita R$ 8.000 − Despesa R$ 5.000 = "Líquido" R$ 41.320

E no card `Summary` esse número aparece como **"Saldo"** logo ao lado do seletor de mês,
sugerindo que é do mês. Trocar de mês não muda o valor.

**Decisão de produto necessária:** ou o card mostra o resultado do mês
(`periodIncomes - periodExpenses`), ou mostra patrimônio acumulado — mas com rótulo
próprio e fora do contexto do seletor de mês. Recomendo expor **os dois** campos
separados (`net` do período + `balance` acumulado).

---

### C4. Números formatados no padrão americano
`app/utils/currencyUtils.ts:10` — locale fixo `'en-US'`.

Sai `R$1,234.50` em vez de `R$ 1.234,50`. Ponto e vírgula invertidos num app financeiro
brasileiro é convite a erro de leitura. Deve seguir o locale do dispositivo
(`expo-localization` já está instalado).

---

## 🟠 ALTO — distorcem o histórico e o fechamento mensal

### A1. Recorrência em dia 29/30/31 pula meses inteiros
`app/database/database.ts:370-377`

```ts
nextDue.setDate(transaction.day || 1);  // setDate(31) em fevereiro → 3 de março
```

Verificado:

| Hoje | Dia configurado | App calcula | Correto seria |
|---|---|---|---|
| 15/02/2026 | 31 | 03/03/2026 | 28/02 ou 31/03 |
| 31/03/2026 | 31 | **01/05/2026** | 30/04 (ou 31/05) |

Um aluguel no dia 31 **desaparece de abril**. Toda conta de fim de mês fica errada.

**Correção:** clampar o dia ao último dia do mês:
`nextDue.setDate(Math.min(day, diasNoMes(ano, mes)))`.

---

### A2. Recorrências atrasadas são lançadas uma vez só (sem catch-up)
`app/database/database.ts:511-546`

O loop pega cada recorrência vencida, lança **uma** transação e já joga o `nextDue`
para o futuro. Se você ficar 3 meses sem abrir o app, o aluguel dos 3 meses vira
**um único lançamento**. Suas despesas ficam sistematicamente subestimadas.

**Correção:** loop interno `while (nextDue <= hoje)` gerando uma transação por ocorrência.

---

### A3. Recorrência é lançada com a data de hoje, não a data de vencimento
`app/database/database.ts:530` — `date: today`

Vencimento 30/06, você abre o app dia 02/07 → a despesa cai em **julho**.
Junho fecha melhor do que foi e julho pior. Os dois meses ficam errados.

**Correção:** usar a data de vencimento (`nextDue`) como data da transação.

---

### A4. Depois das 21h, tudo é lançado no dia seguinte
`app/database/database.ts:513` e `app/contexts/RecurringTransactionsContext.tsx:156`

```ts
const today = new Date().toISOString().split('T')[0];
```

`toISOString()` converte para **UTC**. Em UTC−3, às 22:30 do dia 22/07 isso retorna
`2026-07-23` (verificado). Recorrências entram com data errada e podem ser
disparadas um dia antes do devido.

Pior: o formulário manual usa `getISODate()` (correto, local) e o motor de recorrência
usa `toISOString()` (errado). **Duas noções de "hoje" convivendo no mesmo app.**

**Correção:** usar `getISODate(new Date())` em todos os lugares. Nunca `toISOString()` para data-calendário.

---

### A5. Toda data é exibida um dia antes
`app/utils/dateUtils.ts:1-16`

```ts
new Date("2026-07-22")   // parseado como meia-noite UTC
```

Em UTC−3 isso vira 21/07 às 21h → a tela mostra **"July 21, 2026"** (verificado).
Afeta a lista de transações, o detalhe da transação e **o CSV exportado**.

**Correção:** parsear componente a componente (`new Date(y, m-1, d)`) ou anexar `T00:00:00`.

---

## 🟡 MÉDIO — comprometem análise e portabilidade

### M1. "Renda mensal" soma semanal + mensal + anual sem normalizar
`app/components/IncomeSection.tsx:23-29`

Um seguro anual de R$ 3.000 conta como **R$ 3.000/mês**; uma faxina semanal de
R$ 150 conta como **R$ 150/mês** (o certo seriam ~R$ 650). O número rotulado
"Renda/Despesa mensal" não tem significado financeiro.

**Correção:** normalizar para base mensal — `semanal × 52/12`, `anual ÷ 12`.

### M2. Aritmética em ponto flutuante acumula erro
Valores são `REAL` no SQLite e somados com `+`. Verificado: `0.1` somado 10 vezes = `0.9999999999999999`.
Com centenas de lançamentos o erro chega a centavos visíveis, e comparações
como `spent > budget` viram loteria na fronteira.

**Correção (a mais robusta):** armazenar **centavos como INTEGER** e formatar na exibição.
Alternativa mínima: arredondar toda soma com `Math.round(x * 100) / 100`.

### M3. Gráfico de tendência desalinha receitas e despesas
`app/screens/ReportsScreen.tsx:93-143` + `getMonthlyTransactions`

A query só devolve **meses que têm dados**. Se houve despesa em jan/fev/mar mas receita
só em fev/mar, os rótulos vêm da série de despesas (Jan, Fev, Mar) e a série de receitas
tem 2 pontos — a receita de **fevereiro é plotada em janeiro**.

**Correção:** preencher os 12 meses com zero antes de montar o gráfico.

### M4. O CSV exportado quebra no Excel
`app/utils/exportUtils.ts:40, 140`

```ts
const date = formatFullDate(transaction.date);   // "July 22, 2026"  ← tem vírgula
return `${date},${type},${categoryName},${amount},${note}`;
```

A data contém vírgula e não está entre aspas → **todas as colunas deslocam**.
Nome de categoria com vírgula tem o mesmo problema.

**Correção:** exportar data em `YYYY-MM-DD` e aplicar aspas/escape em todos os campos.

### M5. Importar backup perde as categorias
`app/utils/exportUtils.ts:339-361`

O código lê as categorias existentes, chama `resetDatabase()` (que preserva categorias)
e **nunca insere as categorias do backup**. Transações importadas apontam para IDs
inexistentes → somem do relatório por categoria (viram "Unknown").
A variável `existingCategoryIds` é calculada e nunca usada.

### M6. Orçamentos ficam fora do backup
Orçamento vive no `AsyncStorage` (`BudgetContext`), transações no SQLite. O export JSON
(`exportDatabaseData`) não inclui os orçamentos — restaurar um backup perde todo o histórico deles.

### M7. Não existem categorias de receita
`app/database/schema.ts:74-85` — `DEFAULT_CATEGORIES` só tem despesas.
Mas `getCategoriesByType` (`database.ts:108`) e `TransactionForm.tsx:152-160` filtram
receita por uma lista fixa de IDs (`salary`, `freelance`, …) **que não existem no banco**.

Consequências: nenhuma categoria de receita vem por padrão; e qualquer categoria que você
criar será sempre tratada como despesa pelo toggle do formulário (que reseta sua seleção
ao alternar para Receita). `getCategoriesByType` é código morto.

**Correção:** adicionar uma coluna `type` na tabela `categories` em vez de lista hardcoded.

### M8. Trocar de moeda não converte nada
`app/contexts/CurrencyContext.tsx` — só troca o símbolo. R$ 100 vira $ 100.
Além disso o padrão é **Bitcoin** (`AVAILABLE_CURRENCIES[0]`), formatado com 2 casas decimais.

---

## Ordem de correção sugerida

1. **C1** (vírgula) e **C2** (negativo) — são os que corrompem/mascaram dinheiro. Uma tarde de trabalho.
2. **C3** — decidir o que é "Saldo" e separar período × acumulado.
3. **A4 + A5** — centralizar tudo em `getISODate`, banir `toISOString()` para datas.
4. **A1 + A2 + A3** — reescrever `calculateNextDueDate` e `processRecurringTransactions` juntos.
5. **M2** — migrar para centavos (INTEGER) enquanto a base ainda é pequena. Depois fica caro.
6. **C4, M1, M3, M4, M5** — polimento de relatório e exportação.

## Recomendação de processo

Não há **nenhum teste automatizado** no projeto (o preset `jest-expo` está configurado,
mas não existem arquivos de teste). Para um app onde um erro de sinal ou de arredondamento
passa despercebido, uma suíte pequena cobrindo `parseAmount`, `formatCurrency`,
`calculateNextDueDate` e as agregações de período pagaria por si só imediatamente.
