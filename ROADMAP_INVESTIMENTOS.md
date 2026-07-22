# Roadmap Spendr: Evolução para Gestão de Riqueza e Investimentos

Este documento detalha os pilares de evolução do aplicativo Spendr. O objetivo é transformar o app, que atualmente gerencia o fluxo de caixa (receitas e despesas), em uma ferramenta robusta para acumulação de riqueza, planejamento financeiro e controle de investimentos.

---

## 🏛️ 1. Pilar de Acumulação: Gestão de Patrimônio (Net Worth)

O foco sai de "quanto sobrou no mês" para "quão rico estou ficando ao longo do tempo". O Patrimônio Líquido é o principal indicador de saúde financeira a longo prazo.

### Objetivos
- Mudar a percepção psicológica do usuário: focar no acúmulo de bens e não apenas no corte de gastos.
- Visualizar o resultado prático de meses de economia e investimento.

### Funcionalidades Propostas
- **Módulo de Ativos e Passivos:** 
  - **Ativos:** Cadastro de saldos em corretoras, contas poupança, valor estimado de imóveis e veículos.
  - **Passivos:** Cadastro de financiamentos, dívidas de cartão de crédito pendentes e empréstimos.
- **Gráfico de Evolução Patrimonial (Net Worth Chart):** 
  - Um gráfico de linha temporal que subtrai os Passivos dos Ativos e plota a evolução do patrimônio líquido mês a mês.

---

## 🎯 2. Pilar de Foco: Metas Inteligentes (Sinking Funds)

Dar "nome e sobrenome" ao dinheiro poupado. Investir sem metas claras aumenta a chance de autossabotagem e gastos por impulso.

### Objetivos
- Manter o usuário motivado atrelando a economia de dinheiro a sonhos reais (viagens, casa própria, reserva de emergência).
- Integrar a meta com a realidade do fluxo de caixa atual.

### Funcionalidades Propostas
- **Cofres/Caixinhas de Objetivos:**
  - Criação de metas com Valor Alvo e Data Limite. (Ex: "Reserva de Emergência de R$ 10.000 até Dezembro").
- **Barra de Progresso com Previsão:**
  - O app analisa a "sobra" média mensal do fluxo de caixa e calcula dinamicamente: *"Nesse ritmo, você atingirá esta meta em X meses"*.
  - Alocação virtual de dinheiro: o usuário "move" o dinheiro do saldo principal para dentro das caixinhas, separando visualmente o dinheiro gasto do dinheiro guardado.

---

## 📈 3. Pilar de Multiplicação: Simulador de Juros Compostos

Ajudar o investidor iniciante a visualizar o poder dos juros sobre juros no longo prazo.

### Objetivos
- Mostrar matematicamente que pequenos aportes mensais se transformam em grandes fortunas no longo prazo.
- Definir expectativas realistas de tempo para a aposentadoria ou independência financeira.

### Funcionalidades Propostas
- **Projetor de Liberdade Financeira:**
  - Inputs: Idade atual, idade de aposentadoria desejada, rentabilidade média anual esperada (ex: 10%), e valor do aporte mensal (que o app pode sugerir baseado no fluxo de caixa).
  - Output: Um gráfico de área (Snowball Effect) separando visualmente quanto do montante final foi tirado do próprio bolso e quanto foi gerado puramente pelos juros.

---

## ⚖️ 4. Pilar de Estratégia: Alocação de Portfólio

Investidores mais maduros precisam diversificar. Esta funcionalidade foca na mitigação de risco através do rebalanceamento.

### Objetivos
- Evitar que o usuário corra riscos excessivos concentrando todo o patrimônio em um só ativo.
- Facilitar a decisão do "onde devo investir meu dinheiro este mês?".

### Funcionalidades Propostas
- **Pizza de Alocação de Ativos (Asset Allocation):**
  - Definição de porcentagens ideais para a carteira (Ex: 40% Renda Fixa, 30% Ações, 20% FIIs, 10% Exterior).
- **Alerta e Sugestão de Rebalanceamento:**
  - O app compara a carteira ideal com a carteira atual do usuário.
  - Se Ações subirem muito e passarem do limite estabelecido, o app gera um aviso: *"No seu próximo aporte, sugerimos comprar Renda Fixa para reequilibrar o risco da sua carteira."*

---

## 💸 5. Pilar da Renda Passiva: Rastreador de Dividendos

O estágio final da independência financeira, onde o dinheiro trabalha sozinho e paga as contas mensais.

### Objetivos
- Acompanhar o crescimento dos proventos (dinheiro gerado pelos investimentos sem esforço de trabalho).
- Calcular o quão próximo o usuário está da Independência Financeira.

### Funcionalidades Propostas
- **Radar de Renda Passiva:**
  - Aba exclusiva para registrar dividendos, rendimentos de CDBs/Tesouro, e aluguéis recebidos.
- **Métrica de Cobertura de Custo de Vida:**
  - O app cruza automaticamente os *gastos fixos* registrados no fluxo de caixa com a média da *renda passiva* recebida nos últimos meses.
  - Exibe um termômetro: *"Sua renda passiva atual já cobre 25% do seu custo de vida."*
