# Arquitetura Atual e Fluxo de Transações (Baseline Spendr)

Este documento mapeia de forma ultra-detalhada a arquitetura de banco de dados, regras de negócio e fluxo de código da plataforma Spendr na sua versão inicial (Foco exclusivo em Fluxo de Caixa). 

Seu objetivo é servir como documentação de referência (baseline) para futuras manutenções, debugs ou comparações com novas arquiteturas (como o Pilar 1 - Net Worth).

---

## 1. Arquitetura de Banco de Dados (SQLite)

O aplicativo utiliza o `expo-sqlite` para armazenamento local. O banco de dados chama-se `spendr.db` e opera em `journal_mode = WAL` para melhor performance em escritas simultâneas.

### 1.1 Tabelas e Schemas

#### Tabela `categories` (Categorias)
Armazena as categorias para classificação de gastos e ganhos.
*   `id` (TEXT PRIMARY KEY): UUID único gerado no app.
*   `name` (TEXT NOT NULL): Nome amigável (ex: Alimentação).
*   `color` (TEXT NOT NULL): Código Hex da cor.
*   `icon` (TEXT NOT NULL): Identificador do ícone (Ionicons).
*   **Regra de Negócio:** Existem categorias padrão (Default) criadas na inicialização do DB (ex: food, transport, salary). Existe uma categoria especial hardcoded chamada `uncategorized`.

#### Tabela `transactions` (Transações Pontuais)
Coração do fluxo de caixa. Registra todas as entradas e saídas.
*   `id` (TEXT PRIMARY KEY): UUID único.
*   `amount` (REAL NOT NULL): Valor financeiro (sempre salvo como número positivo, `> 0`).
*   `category` (TEXT NOT NULL): Referência cruzada para `categories(id)`. **[FOREIGN KEY]**
*   `date` (TEXT NOT NULL): Data da transação em string ISO (YYYY-MM-DD).
*   `note` (TEXT): Anotação opcional.
*   `isIncome` (INTEGER NOT NULL DEFAULT 0): Identificador de natureza. `1` significa Receita (Income). `0` significa Despesa (Expense). SQLite não tem boolean nativo.

#### Tabela `recurring_transactions` (Transações Recorrentes)
Gera transações automáticas com base no tempo.
*   `id` (TEXT PRIMARY KEY): UUID único.
*   `amount` (REAL NOT NULL), `isIncome` (INTEGER NOT NULL), `note` (TEXT), `category` (TEXT). **[FOREIGN KEY]**
*   `recurrenceType` (TEXT NOT NULL): Pode ser `weekly`, `monthly` ou `yearly`.
*   `day`, `month`, `weekday` (INTEGER): Parâmetros que definem exatamente quando a repetição ocorre, dependendo do `recurrenceType`.
*   `lastProcessed` (TEXT): A última vez que o script gerou a transação real.
*   `nextDue` (TEXT): A data calculada em que a próxima transação deve ser gerada.
*   `active` (INTEGER NOT NULL DEFAULT 1): Flag para pausar ou continuar a recorrência (1 = true, 0 = false).

---

## 2. Fluxo de Execução no Código (A Vida de uma Transação)

### Etapa A: Interface do Usuário (Entrada de Dados)
**Componente:** `app/components/TransactionForm.tsx`

1.  **Coleta:** O usuário insere o valor (convertido via `parseAmount`), escolhe a data (Modal próprio), nota e aciona o toggle de Receita/Despesa.
2.  **Toggle Inteligente:** Se o usuário escolher uma categoria tipicamente de "Receita" (ex: salary) e tentar trocar a chave de Despesa para Receita, o form reseta a categoria selecionada para evitar inconsistências.
3.  **Validação (`validateForm`):** Exige `amount > 0` e uma `category` não nula.
4.  **Submissão (`handleSubmit`):** Constrói o objeto e despacha para o contexto via `addNewTransaction`.

### Etapa B: Contexto Global (Gerenciamento de Estado)
**Arquivo:** `app/contexts/TransactionsContext.tsx`

1.  **O Hook `useTransactions`:** Concentra toda a inteligência da sessão. Quando a função de adicionar é chamada, ele aguarda o retorno do banco.
2.  **Sincronização Banco > Estado (`refreshData` -> `loadAllData`):** 
    Sempre que o banco de dados sofre qualquer alteração de C.R.U.D., o contexto **descarta** o estado atual da memória e puxa tudo novamente do SQLite.
    *   `getCategories()`: Puxa todas as categorias.
    *   `getTransactions()`: Puxa todo o histórico (ordenado `date DESC`).
    *   Separa a lista gigante em duas listas baseadas na flag booleana: `incomes` e `expenses`.
3.  **Cálculo Agregado para UI:**
    *   O contexto roda querys de soma (`getMonthlyTransactions`) para separar o valor mês a mês usado nos gráficos de linha (`monthlyData`).
    *   Chama `loadPeriodData()` com as datas da tela atual para calcular o total de despesas, receitas e net (saldo), que serão renderizados na tela inicial.
4.  **Re-render:** A tela inteira pisca/atualiza magicamente assim que as novas props são populadas.

### Etapa C: O Repositório (Queries Nativas)
**Arquivo:** `app/database/database.ts`

As queries de leitura mais pesadas não são feitas em JavaScript, mas diretamente no motor do SQLite para poupar RAM.
*   **Totais por Categoria:** Ao invés de usar `Array.reduce` em memória, usa-se a query:
    ```sql
    SELECT category AS categoryId, SUM(amount) AS total
    FROM transactions
    WHERE date BETWEEN ? AND ? AND isIncome = ?
    GROUP BY category
    ```
*   **A Abstração do Contexto:** A UI raramente chama os métodos do `database.ts` diretamente. Ela chama os métodos do `TransactionsContext`, que serve como o intermediário (Controller) que gerencia quando o banco precisa ser consultado.

---

## 3. Visão de Produto: Regras de Negócio e Comportamento

Esta seção foca em como o Spendr se comporta do ponto de vista do usuário final (Produto). Como as engrenagens técnicas acima se traduzem em valor e regras visíveis:

### 3.1. Regime de Caixa Simples (O Dinheiro Não Muda de Bolso, Ele Nasce e Morre)
*   **Regra:** O aplicativo entende finanças apenas através de entradas e saídas. Não existe a ideia de transferir dinheiro do "Itaú" para o "Nubank" ou para a "Corretora". 
*   **Reflexo no Código:** Toda transação recebe obrigatoriamente a flag booleana `isIncome` (Receita ou Despesa). O saldo total (Net) que aparece na HomeScreen é simplesmente a diferença: `SUM(Receitas Totais desde o dia 1) - SUM(Despesas Totais desde o dia 1)`.

### 3.2. Categorização Inquebrável e Proteção de Histórico
*   **Regra:** O usuário é forçado a dizer "com o que" ele gastou ou ganhou. Nenhum dinheiro se move sem estar atrelado a uma Categoria.
*   **Reflexo no Código:** O componente `TransactionForm.tsx` bloqueia o salvamento se não houver categoria selecionada. 
*   **Proteção (Cascata Customizada):** O aplicativo é desenhado para não permitir buracos no fluxo de caixa. Se um usuário deletar a categoria "Alimentação", as transações passadas não são excluídas. A regra no `database.ts` (`deleteCategory`) captura essas transações "órfãs" e as move para uma categoria fantasma intransferível chamada `uncategorized`. Se o usuário tentar deletar a `uncategorized`, o sistema bloqueia.

### 3.3. Automação Preditiva (Transações Recorrentes)
*   **Regra:** O aplicativo prevê contas fixas mensais (ex: Netflix, Salário) para que o usuário não tenha trabalho braçal de logar todo mês.
*   **Reflexo no Código:** Existe uma tabela `recurring_transactions` que funciona como um "contrato". Toda vez que o aplicativo é aberto, uma rotina ("Cron Job" local na função `processRecurringTransactions`) verifica silenciosamente se a data de vencimento (`nextDue`) já chegou. Se sim, ele automaticamente injeta uma cópia real dessa transação na tabela `transactions` de fluxo de caixa (adicionando a tag `[Auto]` na anotação) e reprograma a próxima data (`nextDue`).

### 3.4. Mutação Conservadora (Sempre a Foto Mais Recente)
*   **Regra:** O usuário confia que os números vistos na tela são 100% reais, não existindo discrepância matemática de caches antigos.
*   **Reflexo no Código:** O Spendr prefere exatidão à economia extrema de processamento na hora de salvar. Ao adicionar ou excluir R$ 5,00, ele não faz uma continha simples de memória (`saldoAtual - 5`). O `TransactionsContext` joga o estado do app no lixo, vai até o banco de dados e recalcula o histórico inteiro de novo para ter a certeza absoluta matemática de que o painel mostrará a verdade (`refreshData -> loadAllData`).

---

## 4. Visão de Produto: Relatórios e Inteligência (Reports)

Os relatórios (`ReportsScreen.tsx` e `exportUtils.ts`) existem para entregar clareza retroativa ao usuário, respondendo à pergunta: "Para onde meu dinheiro foi e qual é o meu comportamento histórico?".

### 4.1. Resumo e Quebra Mensal (Onde Estou Gastando Mais)
*   **Motivo:** Evitar que o usuário gaste tempo caçando transação por transação. O valor está na consolidação visual da saúde do mês selecionado.
*   **Regra de Negócio:** Gráficos de pizza ("Expenses by Category" / "Income by Category") ocultam qualquer categoria que esteja zerada naquele mês. Apenas o dinheiro real movido ganha espaço gráfico.
*   **Reflexo no Código:** Antes de passar os dados para o `react-native-chart-kit`, o código filtra categorias (`item.total > 0`). Caso haja lixo histórico sem categoria atrelada, o sistema usa silenciosamente a cor `#9CA3AF` e a marca "Uncategorized" em tempo de execução para não quebrar a UI.

### 4.2. Gráfico de Tendências Temporais (Monthly Trends)
*   **Motivo:** Analisar comportamento de longo prazo. Respondendo a: "Estou gastando mais neste semestre do que no passado?".
*   **Regra de Negócio:** Um gráfico de linha cruzada (Receitas em Verde vs. Despesas em Vermelho) que evolui progressivamente. Ele pega as transações anuais do Contexto (não apenas do mês atual) e cria uma linha temporal contínua.
*   **Reflexo no Código:** O dado `monthlyData` é pré-processado pelo Contexto sempre que o banco de dados é recarregado, separando gastos totais do ano atual por mês (`month` de 1 a 12), servindo o Chart sem lentidão de cálculo pesado na UI.

### 4.3. Propriedade dos Dados (Exportações)
*   **Motivo:** O Spendr entende que o dado financeiro é privado e pertence ao usuário. Ele não prende os dados num servidor oculto.
*   **Regra de Negócio:** O usuário deve ser capaz de fazer backup total ou baixar sua planilha para um Contador avaliar.
*   **Reflexo no Código:** O módulo `exportUtils.ts` oferece funções como `exportFinancialReport` (gera um relatório amigável em CSV formatado) e `exportDatabaseData` (extrai o SQLite local cru e serializa para JSON). Isso delega para o OS do celular o poder de mandar o dado para onde ele quiser via `expo-sharing` (WhatsApp, E-mail, iCloud).
